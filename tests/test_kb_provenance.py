"""Knowledge-base provenance on attributions (docs/INTERFACE-SPEC.md §5.3).

Every published attribution carries ``kb_ref``: the path, SHA-256 and entry
counts of the knowledge base the engine loaded. When that knowledge base has
no actor entries (nothing beyond the uncertainty anchor) the attrib stage
withholds a named adversary at publish: actor ``Unknown``, confidence at most
0.49, a note in ``evidence``. Positive findings and attributions reasoned
against a populated knowledge base are untouched.

``megalith.verdict`` is not importable from CANOPY's own environment, so the
fast-lane case uses a toy rule, as ``tests/test_fast_lane.py`` does.
"""
from __future__ import annotations

import asyncio
import hashlib
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import pytest

from canopy.services.attrib import NO_ACTOR_ENTRIES_NOTE, AttribService
from canopy.services.bus import InProcessBus
from canopy.services.kb import KB, load_kb_json
from canopy.services.llm.stub import StubLLMClient
from canopy.services.schemas.events import Anomaly, Attribution, KBRef, ReasoningTrace
from canopy.services.traces import Tracer

ROOT = Path(__file__).resolve().parent.parent
SEED_KB = ROOT / "data" / "kb_seed_entries.json"
DEMO_KB = ROOT / "data" / "kb_megalith_demo.json"
ANCHOR = "kb-attribution-uncertainty-001"
SAT = "ctb://centralblue.dev/leo-science-1"
T0 = datetime(2026, 9, 17, 14, 30, tzinfo=UTC)


# ---- Fixtures ---------------------------------------------------------------------


def _rf(sid: str = "sig-rf") -> Anomaly:
    return Anomaly(
        ts=T0, kind="rf_anomaly", source_signal=sid, source_signal_ids=[sid], severity=0.85
    )


def _bus(pc: float = 0.83) -> Anomaly:
    return Anomaly(
        ts=T0,
        kind="bus_link_margin",
        source_signal="sig-bus",
        source_signal_ids=["sig-bus"],
        severity=0.81,
        payload={
            "satellite_id": SAT,
            "physics_consistency": pc,
            "onset_ts": T0.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "subsystem": "comms",
            "symptom": "link_margin_db_drop",
        },
    )


@dataclass(frozen=True)
class _Rule:
    verdict: str
    confidence: float
    basis: tuple[str, ...]
    satellite_id: str | None
    pc: float | None


def _toy_rule(batch, context, *, kind_domains=None) -> _Rule:
    """Rule 2 of spec §5.1 for a bus-only batch; enough to open the fast lane."""
    sat = next((a.payload.get("satellite_id") for a in batch if a.payload.get("satellite_id")), None)
    bus = [a for a in batch if a.kind.startswith("bus_")]
    pc = bus[-1].payload.get("physics_consistency") if bus else None
    if pc is not None and pc >= 0.7:
        return _Rule("internal_fault", float(pc), (f"rule 2: internal_fault pc={pc:.2f}",), sat, pc)
    return _Rule("unknown", min(0.49, pc or 0.3), ("rule 6: unknown",), sat, pc)


class _NamingLLM:
    """A reasoning lane that names an actor whatever the knowledge base holds.

    Stands in for a model that hallucinates an adversary and citations that
    resolve to nothing. Used with ``multi_agent=False`` so the primary is
    published directly.
    """

    def __init__(self, actor: str = "Actor-9", confidence: float = 0.81) -> None:
        self.actor = actor
        self.confidence = confidence

    async def attribute_primary(self, anomalies, kb_context=(), *, rule_verdict=None) -> Attribution:
        return Attribution(
            anomaly_ids=[a.id for a in anomalies],
            actor=self.actor,
            confidence=self.confidence,
            evidence=["Emitter geometry matches the actor's published doctrine."],
            kb_citations=["kb-actor9-doctrine-001"],
            source_signal_ids=[sid for a in anomalies for sid in a.source_signal_ids],
        )

    async def attribute_redteam(self, primary, anomalies, kb_context=()):  # pragma: no cover
        raise AssertionError("multi_agent is off in these tests")

    async def reconcile(self, primary, challenge, anomalies, kb_context=(), *, rule_verdict=None):  # pragma: no cover
        raise AssertionError("multi_agent is off in these tests")

    async def decide(self, attribution, anomalies=()):  # pragma: no cover
        raise AssertionError("no decide stage in these tests")


async def _wait_for(target: list, count: int, *, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while len(target) < count:
        if time.monotonic() > deadline:
            raise AssertionError(f"expected {count} events, got {len(target)}")
        await asyncio.sleep(0.005)


async def _publish_batch(
    kb: KB, llm, batch: list[Anomaly], *, multi_agent: bool = True
) -> tuple[list[tuple[str, Attribution]], list[ReasoningTrace]]:
    """Run the reasoning lane on one batch; return (topic, attribution) pairs and traces."""
    bus = InProcessBus()
    tracer = Tracer(bus)
    attrib = AttribService(
        bus, llm, kb, window_s=0.05, tracer=tracer, rule_verdict=None, multi_agent=multi_agent
    )
    published: list[tuple[str, Attribution]] = []
    traces: list[ReasoningTrace] = []

    async def sniff_attributions() -> None:
        async for topic, event in bus.subscribe("attributions.*"):
            if isinstance(event, Attribution):
                published.append((topic, event))

    async def sniff_traces() -> None:
        async for _, event in bus.subscribe("traces.*"):
            if isinstance(event, ReasoningTrace):
                traces.append(event)

    tasks = [asyncio.create_task(sniff_attributions()), asyncio.create_task(sniff_traces())]
    for _ in range(3):
        await asyncio.sleep(0)
    try:
        await attrib._process(batch)
        await _wait_for(published, 1)
        await asyncio.sleep(0.01)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        bus.close()
    return published, traces


# ---- kb_ref on every published attribution ---------------------------------------


def test_kb_source_is_the_loader_record() -> None:
    kb = KB.load_from_json(DEMO_KB)
    assert isinstance(kb.source, KBRef)
    assert kb.source.path == str(DEMO_KB)
    assert kb.source.sha256 == hashlib.sha256(DEMO_KB.read_bytes()).hexdigest()
    assert kb.source.entry_count == len(kb)
    assert kb.source.actor_entry_count == len(kb) - 1  # the anchor is not an actor entry


@pytest.mark.asyncio
async def test_provisional_and_every_revision_carry_the_kb_reference() -> None:
    """The fast lane stamps the provisional; the reasoning lane stamps the final."""
    bus = InProcessBus()
    kb = KB.load_from_json(SEED_KB)
    attrib = AttribService(
        bus, StubLLMClient(kb), kb, window_s=0.2, tracer=Tracer(bus), rule_verdict=_toy_rule
    )
    published: list[Attribution] = []

    async def sniff() -> None:
        async for _, event in bus.subscribe("attributions.*"):
            if isinstance(event, Attribution):
                published.append(event)

    tasks = [asyncio.create_task(sniff()), asyncio.create_task(attrib.run())]
    for _ in range(3):
        await asyncio.sleep(0)
    try:
        await bus.publish("anomalies.bus_link_margin", _bus(0.83))
        await _wait_for(published, 2)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        bus.close()

    provisional, final = published[0], published[1]
    assert provisional.provisional is True and final.provisional is False
    assert provisional.id == final.id
    assert provisional.kb_ref == kb.source
    assert final.kb_ref == kb.source
    assert final.kb_ref is not None
    assert final.kb_ref.path == str(SEED_KB)
    assert final.kb_ref.sha256 == hashlib.sha256(SEED_KB.read_bytes()).hexdigest()
    assert final.kb_ref.actor_entry_count == len(kb) - 1
    # A positive finding on a populated knowledge base is untouched by §5.3.
    assert final.verdict == "internal_fault" and final.actor == "None"
    assert NO_ACTOR_ENTRIES_NOTE not in final.evidence
    # The reference survives the wire: it is part of the JSON dump.
    assert final.model_dump(mode="json")["kb_ref"]["sha256"] == kb.source.sha256


# ---- The empty-KB rule -------------------------------------------------------------


@pytest.mark.asyncio
async def test_empty_kb_withholds_the_stub_actor() -> None:
    """The stub names an adversary for an RF batch regardless of the knowledge base."""
    kb = KB(entries=[])
    published, traces = await _publish_batch(kb, StubLLMClient(kb), [_rf()])

    topic, attribution = published[0]
    assert attribution.actor == "Unknown"
    assert attribution.confidence <= 0.49
    assert attribution.kb_ref is not None
    assert attribution.kb_ref.actor_entry_count == 0
    assert attribution.kb_ref.entry_count == 0
    assert attribution.kb_ref.path is None
    assert NO_ACTOR_ENTRIES_NOTE in attribution.evidence
    assert attribution.evidence[-1] == NO_ACTOR_ENTRIES_NOTE
    assert topic == "attributions.unknown"
    warns = [t for t in traces if t.stage == "attrib_reconcile" and t.level == "warn"]
    assert any("withheld" in t.message and "no actor entries" in t.message for t in warns)
    assert any(t.payload.get("actor") == "Russia" and t.payload.get("after") <= 0.49 for t in warns)


@pytest.mark.asyncio
async def test_empty_kb_withholds_a_hallucinated_actor_and_keeps_its_claimed_citations() -> None:
    kb = KB(entries=[])
    published, _ = await _publish_batch(kb, _NamingLLM("Actor-9", 0.81), [_rf()], multi_agent=False)

    _, attribution = published[0]
    assert attribution.actor == "Unknown"
    assert attribution.confidence == pytest.approx(0.49)
    assert NO_ACTOR_ENTRIES_NOTE in attribution.evidence
    # What the model claimed stays on the record for audit; the reference
    # says which knowledge base it could not have come from.
    assert attribution.kb_citations == ["kb-actor9-doctrine-001"]
    assert attribution.kb_ref is not None and attribution.kb_ref.actor_entry_count == 0


@pytest.mark.asyncio
async def test_anchor_only_kb_counts_as_having_no_actor_entries() -> None:
    anchor = [e for e in load_kb_json(DEMO_KB) if e.id == ANCHOR]
    kb = KB(entries=anchor)
    assert kb.source.entry_count == 1 and kb.source.actor_entry_count == 0

    published, _ = await _publish_batch(kb, _NamingLLM("Actor-9", 0.81), [_rf()], multi_agent=False)
    _, attribution = published[0]
    assert attribution.actor == "Unknown"
    assert attribution.confidence <= 0.49
    assert NO_ACTOR_ENTRIES_NOTE in attribution.evidence


@pytest.mark.asyncio
async def test_low_confidence_named_actor_is_still_withheld_without_lifting_confidence() -> None:
    kb = KB(entries=[])
    published, _ = await _publish_batch(kb, _NamingLLM("Actor-9", 0.35), [_rf()], multi_agent=False)
    _, attribution = published[0]
    assert attribution.actor == "Unknown"
    assert attribution.confidence == pytest.approx(0.35)  # min(confidence, 0.49)


@pytest.mark.asyncio
@pytest.mark.parametrize("actor", ["Unknown", "Multi-actor", "None"])
async def test_empty_kb_leaves_non_adversary_actors_alone(actor: str) -> None:
    kb = KB(entries=[])
    published, _ = await _publish_batch(kb, _NamingLLM(actor, 0.6), [_rf()], multi_agent=False)
    _, attribution = published[0]
    assert attribution.actor == actor
    assert attribution.confidence == pytest.approx(0.6)
    assert NO_ACTOR_ENTRIES_NOTE not in attribution.evidence
    assert attribution.kb_ref is not None and attribution.kb_ref.actor_entry_count == 0


@pytest.mark.asyncio
async def test_populated_kb_leaves_a_named_actor_alone() -> None:
    kb = KB.load_from_json(SEED_KB)
    published, traces = await _publish_batch(kb, StubLLMClient(kb), [_rf()])

    topic, attribution = published[0]
    assert attribution.actor == "Russia"
    assert attribution.confidence > 0.49
    assert NO_ACTOR_ENTRIES_NOTE not in attribution.evidence
    assert topic == "attributions.russia"
    assert attribution.kb_ref == kb.source
    assert attribution.kb_ref is not None and attribution.kb_ref.actor_entry_count > 0
    assert not any("withheld" in t.message for t in traces)


# ---- Gateway and bench -----------------------------------------------------------


def test_health_reports_the_kb_reference(monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi.testclient import TestClient

    from canopy.api import app

    monkeypatch.setenv("CANOPY_KB_PATH", str(DEMO_KB))
    monkeypatch.setenv("CANOPY_LLM", "stub")
    monkeypatch.setenv("CANOPY_DISABLE_OSINT", "1")
    monkeypatch.delenv("CANOPY_LIVE", raising=False)
    monkeypatch.setenv("CANOPY_BUS", "memory")  # .env may select NATS; the lifespan loads it first
    with TestClient(app) as client:
        body = client.get("/health").json()
    assert body["kb_entries"] == 5
    assert body["kb"] == {
        "path": str(DEMO_KB),
        "resolved": str(DEMO_KB.resolve()),
        "sha256": hashlib.sha256(DEMO_KB.read_bytes()).hexdigest(),
        "entry_count": 5,
        "actor_entry_count": 4,
    }


def test_bench_artifact_carries_the_kb_reference() -> None:
    import sys

    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from bench.runner import TrialArtifact

    artifact = TrialArtifact(scenario=Path("x.jsonl"))
    assert "kb_ref" in artifact.to_dict() and artifact.to_dict()["kb_ref"] is None
    artifact.kb_ref = KB.load_from_json(DEMO_KB).source.model_dump(mode="json")
    assert artifact.to_dict()["kb_ref"]["actor_entry_count"] == 4
