"""The attribution service's verdict lane (docs/INTERFACE-SPEC.md §5.2).

The rule itself lives in ``megalith/verdict`` (not importable from CANOPY's
own environment), so these tests inject hand-made rule verdicts and check
what ``AttribService`` does with them: the provisional verdict reaches the
LLM client, the §5.2 bounds are enforced after reconcile, the actor
convention holds, the traces carry the verdict, the recent-anomaly context
is bounded, and missing internal-diagnosis telemetry takes the stress
haircut. The real-rule fixtures run in ``megalith/tests/test_verdict_lane.py``.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from canopy.services.attrib import (
    CONTEXT_MAX_PER_SATELLITE,
    CONTEXT_HORIZON_S,
    AttribService,
)
from canopy.services.bus import InProcessBus
from canopy.services.kb import KB
from canopy.services.llm.stub import StubLLMClient, StubVerdictOverride
from canopy.services.schemas.events import Anomaly, Attribution, ReasoningTrace
from canopy.services.traces import Tracer

ROOT = Path(__file__).resolve().parent.parent
KB_FILE = ROOT / "data" / "kb_seed_entries.json"
SAT = "ctb://centralblue.dev/leo-science-1"
T0 = datetime(2026, 9, 17, 14, 30, tzinfo=UTC)


@dataclass(frozen=True)
class _Rule:
    verdict: str
    confidence: float
    basis: tuple[str, ...] = ("rule 0: hand-made verdict for the test",)
    satellite_id: str | None = SAT
    pc: float | None = None


def _fixed(rule: _Rule):
    def fn(batch, context, *, kind_domains=None):
        return rule

    return fn


class _Recorder:
    def __init__(self, rule: _Rule) -> None:
        self.rule = rule
        self.calls: list[tuple[list[Anomaly], list[Anomaly]]] = []

    def __call__(self, batch, context, *, kind_domains=None):
        self.calls.append((list(batch), list(context)))
        return self.rule


def _bus(pc: float = 0.83, *, sat: str | None = SAT, ts: datetime = T0) -> Anomaly:
    return Anomaly(
        ts=ts,
        kind="bus_link_margin",
        source_signal="sig-bus",
        source_signal_ids=["sig-bus"],
        severity=0.81,
        payload={
            "satellite_id": sat,
            "physics_consistency": pc,
            "onset_ts": ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "subsystem": "comms",
            "symptom": "link_margin_db_drop",
        },
    )


def _rf(*, sat: str | None = SAT, ts: datetime = T0, severity: float = 0.85) -> Anomaly:
    return Anomaly(
        ts=ts,
        kind="rf_anomaly",
        source_signal="sig-rf",
        source_signal_ids=["sig-rf"],
        severity=severity,
        payload={"satellite_id": sat} if sat else {},
    )


async def _attribute(
    groups: list[list[Anomaly]], **kwargs
) -> tuple[list[Attribution], list[ReasoningTrace], AttribService]:
    """Publish each group as one batch through a live service; collect outputs."""
    bus = InProcessBus()
    kb = KB.load_from_json(KB_FILE)
    llm = kwargs.pop("llm", None) or StubLLMClient(kb)
    tracer = Tracer(bus)
    attrib = AttribService(bus, llm, kb, window_s=0.2, tracer=tracer, **kwargs)
    attributions: list[Attribution] = []
    traces: list[ReasoningTrace] = []

    async def sniff(pattern: str, target: list) -> None:
        async for _, event in bus.subscribe(pattern):
            target.append(event)

    tasks = [
        asyncio.create_task(sniff("attributions.*", attributions)),
        asyncio.create_task(sniff("traces.*", traces)),
        asyncio.create_task(attrib.run()),
    ]
    for _ in range(3):
        await asyncio.sleep(0)
    for group in groups:
        for anomaly in group:
            await bus.publish(f"anomalies.{anomaly.kind}", anomaly)
        await bus.drain()
        await attrib.flush()
        await bus.drain()
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    return attributions, traces, attrib


# ---- Filling the verdict from the rule ----------------------------------------


@pytest.mark.asyncio
async def test_rule_verdict_fills_the_attribution() -> None:
    rule = _Rule("internal_fault", 0.83, pc=0.83)
    attributions, traces, _ = await _attribute([[_bus(0.83)]], rule_verdict=_fixed(rule))

    assert len(attributions) == 1
    final = attributions[0]
    assert final.verdict == "internal_fault"
    assert final.verdict_basis == "rule"
    assert final.actor == "None"
    assert final.satellite_id == SAT
    # physics_consistency comes from the batch's bus anomaly.
    assert final.physics_consistency == pytest.approx(0.83)
    # Stub bus template 0.66 - 0.04 = 0.62, clamped up to rule - 0.15.
    assert final.confidence == pytest.approx(0.68)
    assert final.verdict_evidence == []
    assert any(line.startswith("Verdict (rule): internal_fault") for line in final.evidence)


@pytest.mark.asyncio
async def test_positive_finding_publishes_on_the_none_topic() -> None:
    bus = InProcessBus()
    kb = KB.load_from_json(KB_FILE)
    attrib = AttribService(
        bus, StubLLMClient(kb), kb, window_s=0.0, rule_verdict=_fixed(_Rule("natural_external", 0.6))
    )
    topics: list[str] = []

    async def sniff() -> None:
        async for topic, _ in bus.subscribe("attributions.*"):
            topics.append(topic)
            break

    consumer = asyncio.create_task(sniff())
    runner = asyncio.create_task(attrib.run())
    await asyncio.sleep(0)
    await bus.publish("anomalies.bus_orbit_decay", _bus())
    await asyncio.wait_for(consumer, timeout=2.0)
    runner.cancel()
    await asyncio.gather(runner, return_exceptions=True)
    assert topics == ["attributions.none"]


@pytest.mark.asyncio
async def test_single_pass_path_gets_the_same_treatment() -> None:
    rule = _Rule("internal_fault", 0.83, pc=0.83)
    attributions, _, _ = await _attribute(
        [[_bus(0.83)]], rule_verdict=_fixed(rule), multi_agent=False
    )
    final = attributions[0]
    assert final.verdict == "internal_fault"
    assert final.verdict_basis == "rule"
    assert final.actor == "None"
    # Stub primary 0.66 clamped up to 0.68.
    assert final.confidence == pytest.approx(0.68)


@pytest.mark.asyncio
async def test_hostile_verdict_keeps_the_attributed_actor() -> None:
    rule = _Rule("hostile_external", 0.72)
    attributions, _, _ = await _attribute([[_rf()]], rule_verdict=_fixed(rule))
    final = attributions[0]
    assert final.verdict == "hostile_external"
    assert final.actor == "Russia"
    # Stub rf template 0.74 - 0.05 = 0.69, inside [0.57, 0.87].
    assert final.confidence == pytest.approx(0.69)


@pytest.mark.asyncio
async def test_hostile_verdict_with_actorless_template_is_unknown_actor_and_capped() -> None:
    rule = _Rule("hostile_external", 0.7, pc=0.3)
    attributions, _, _ = await _attribute([[_bus(0.3)]], rule_verdict=_fixed(rule))
    final = attributions[0]
    assert final.verdict == "hostile_external"
    assert final.actor == "Unknown"
    assert final.confidence == pytest.approx(0.49)


@pytest.mark.asyncio
async def test_unknown_verdict_forces_unknown_actor_at_cap() -> None:
    rule = _Rule("unknown", 0.49, pc=0.83)
    attributions, _, _ = await _attribute([[_bus(0.83), _rf()]], rule_verdict=_fixed(rule))
    final = attributions[0]
    assert final.verdict == "unknown"
    assert final.actor == "Unknown"
    assert final.confidence == pytest.approx(0.49)


# ---- Reasoning-lane changes ------------------------------------------------------


@pytest.mark.asyncio
async def test_cited_change_keeps_reasoning_basis_within_bounds() -> None:
    kb = KB.load_from_json(KB_FILE)
    llm = StubLLMClient(
        kb,
        verdict_overrides={
            "rf_anomaly": StubVerdictOverride(
                "hostile_external",
                ("anom-rf rf_anomaly on the same satellite 40 s before onset",),
            )
        },
    )
    rule = _Rule("internal_fault", 0.83, pc=0.83)
    attributions, traces, _ = await _attribute(
        [[_rf()]], llm=llm, rule_verdict=_fixed(rule)
    )
    final = attributions[0]
    assert final.verdict == "hostile_external"
    assert final.verdict_basis == "reasoning"
    assert final.actor == "Russia"
    assert final.verdict_evidence == [
        "anom-rf rf_anomaly on the same satellite 40 s before onset"
    ]
    # 0.69 is inside the reasoning band [0.30, 0.85].
    assert final.confidence == pytest.approx(0.69)
    assert any(line.startswith("Verdict (reasoning): hostile_external") for line in final.evidence)
    assert not any(line.startswith("Verdict repair:") for line in final.evidence)
    assert not any(t.level == "warn" and "verdict repair" in t.message for t in traces)


@pytest.mark.asyncio
async def test_uncited_change_is_repaired_to_the_rule_verdict() -> None:
    kb = KB.load_from_json(KB_FILE)
    llm = StubLLMClient(
        kb, verdict_overrides={"rf_anomaly": StubVerdictOverride("hostile_external")}
    )
    rule = _Rule("internal_fault", 0.83, pc=0.83)
    attributions, traces, _ = await _attribute(
        [[_rf()]], llm=llm, rule_verdict=_fixed(rule)
    )
    final = attributions[0]
    assert final.verdict == "internal_fault"
    assert final.verdict_basis == "rule"
    assert final.actor == "None"
    assert final.verdict_evidence == []
    assert any(line.startswith("Verdict repair:") for line in final.evidence)
    assert final.confidence == pytest.approx(0.69)  # inside [0.68, 0.98]
    repairs = [t for t in traces if t.stage == "attrib_reconcile" and t.level == "warn"]
    assert repairs and "verdict repair" in repairs[0].message
    assert repairs[0].payload["verdict"] == "internal_fault"


@pytest.mark.asyncio
async def test_cited_change_to_unknown_is_capped() -> None:
    kb = KB.load_from_json(KB_FILE)
    llm = StubLLMClient(
        kb, verdict_overrides={"rf_anomaly": StubVerdictOverride("unknown", ("contradictory",))}
    )
    attributions, _, _ = await _attribute(
        [[_rf()]], llm=llm, rule_verdict=_fixed(_Rule("hostile_external", 0.72))
    )
    final = attributions[0]
    assert final.verdict == "unknown"
    assert final.verdict_basis == "reasoning"
    assert final.actor == "Unknown"
    assert final.confidence == pytest.approx(0.49)


# ---- Traces --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_traces_carry_verdict_physics_and_basis() -> None:
    rule = _Rule("internal_fault", 0.83, basis=("rule 2: internal_fault", "pc=0.83"), pc=0.83)
    _, traces, _ = await _attribute([[_bus(0.83)]], rule_verdict=_fixed(rule))
    by_stage = {t.stage: t for t in traces if t.level == "info"}

    primary = by_stage["attrib_primary"]
    assert primary.payload["verdict"] == "internal_fault"
    assert primary.payload["verdict_basis"] == "rule"
    assert primary.payload["physics_consistency"] == pytest.approx(0.83)
    assert primary.payload["basis"] == ["rule 2: internal_fault", "pc=0.83"]
    assert "verdict=internal_fault" in primary.message and "pc=0.83" in primary.message

    final = by_stage["attrib_reconcile"]
    assert final.payload["verdict"] == "internal_fault"
    assert final.payload["verdict_basis"] == "rule"
    assert final.payload["physics_consistency"] == pytest.approx(0.83)
    assert final.payload["basis"] == ["rule 2: internal_fault", "pc=0.83"]
    assert "verdict=internal_fault" in final.message


# ---- Lane off / degraded ------------------------------------------------------------


@pytest.mark.asyncio
async def test_lane_off_leaves_verdict_unset_but_fills_identity() -> None:
    attributions, traces, attrib = await _attribute([[_bus(0.83)]], rule_verdict=None)
    assert not attrib.verdict_lane_enabled
    final = attributions[0]
    assert final.verdict is None
    assert final.verdict_basis is None
    assert final.actor == "None"
    assert final.confidence == pytest.approx(0.62)  # stub 0.66 - 0.04, no clamp
    assert final.satellite_id == SAT
    assert final.physics_consistency == pytest.approx(0.83)
    primary = next(t for t in traces if t.stage == "attrib_primary")
    assert primary.payload["verdict"] is None


@pytest.mark.asyncio
async def test_rule_failure_is_recorded_and_attribution_still_published() -> None:
    def broken(batch, context, *, kind_domains=None):
        raise RuntimeError("rule blew up")

    attributions, _, attrib = await _attribute([[_rf()]], rule_verdict=broken)
    assert len(attributions) == 1
    assert attributions[0].verdict is None
    assert attrib.errors and attrib.errors[0]["stage"] == "rule_verdict"


@pytest.mark.asyncio
async def test_clients_without_the_rule_keyword_are_called_as_before() -> None:
    class _Legacy:
        """An LLMClient predating the verdict lane: no ``rule_verdict`` kwarg."""

        def __init__(self, inner: StubLLMClient) -> None:
            self._inner = inner

        async def attribute_primary(self, anomalies, kb_context=()):
            return await self._inner.attribute_primary(anomalies, kb_context)

        async def attribute_redteam(self, primary, anomalies, kb_context=()):
            return await self._inner.attribute_redteam(primary, anomalies, kb_context)

        async def reconcile(self, primary, challenge, anomalies, kb_context=()):
            return await self._inner.reconcile(primary, challenge, anomalies, kb_context)

        async def decide(self, attribution):
            return await self._inner.decide(attribution)

    kb = KB.load_from_json(KB_FILE)
    attributions, _, attrib = await _attribute(
        [[_rf()]], llm=_Legacy(StubLLMClient(kb)), rule_verdict=_fixed(_Rule("hostile_external", 0.72))
    )
    assert attrib.errors == []
    assert attributions[0].verdict == "hostile_external"


# ---- Recent-anomaly context ---------------------------------------------------------


@pytest.mark.asyncio
async def test_rule_sees_the_batch_plus_recent_same_satellite_and_global_context() -> None:
    recorder = _Recorder(_Rule("unknown", 0.3))
    earlier_same = _rf(ts=T0 - timedelta(seconds=300))
    earlier_other = _rf(sat="ctb://centralblue.dev/other", ts=T0 - timedelta(seconds=200))
    storm = Anomaly(
        ts=T0 - timedelta(seconds=100),
        kind="space_weather_storm",
        source_signal="sig-sw",
        source_signal_ids=["sig-sw"],
        severity=0.8,
        payload={"kp": 6.0, "severity": 0.6},
    )
    batch = [_bus(0.5)]
    await _attribute([[earlier_same], [earlier_other], [storm], batch], rule_verdict=recorder)

    seen_batch, seen_context = recorder.calls[-1]
    assert [a.id for a in seen_batch] == [batch[0].id]
    context_ids = {a.id for a in seen_context}
    assert batch[0].id in context_ids  # the batch is its own context
    assert earlier_same.id in context_ids
    assert storm.id in context_ids  # identity-less (global) anomalies are visible
    assert earlier_other.id not in context_ids  # other satellites are not


@pytest.mark.asyncio
async def test_context_is_bounded_per_satellite_and_in_time() -> None:
    recorder = _Recorder(_Rule("unknown", 0.3))
    groups: list[list[Anomaly]] = []
    stale = _rf(ts=T0 - timedelta(seconds=CONTEXT_HORIZON_S + 60))
    groups.append([stale])
    for i in range(CONTEXT_MAX_PER_SATELLITE + 10):
        groups.append([_rf(ts=T0 + timedelta(seconds=i))])
    await _attribute(groups, rule_verdict=recorder)

    _, seen_context = recorder.calls[-1]
    assert stale.id not in {a.id for a in seen_context}
    assert len(seen_context) == CONTEXT_MAX_PER_SATELLITE


@pytest.mark.asyncio
async def test_storm_stays_in_context_while_its_validity_window_is_open() -> None:
    # A storm is stamped at valid_from, hours before the symptom it may
    # explain; it must outlive the ts-based horizon until valid_to passes.
    recorder = _Recorder(_Rule("unknown", 0.3))
    storm = Anomaly(
        ts=T0 - timedelta(hours=3),
        kind="space_weather_storm",
        source_signal="sig-sw",
        source_signal_ids=["sig-sw"],
        severity=0.8,
        payload={
            "kp": 6.0,
            "severity": 0.6,
            "valid_from": (T0 - timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "valid_to": (T0 + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        },
    )
    expired = Anomaly(
        ts=T0 - timedelta(hours=3),
        kind="space_weather_radiation",
        source_signal="sig-sw2",
        source_signal_ids=["sig-sw2"],
        severity=0.8,
        payload={
            "severity": 0.2,
            "valid_from": (T0 - timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "valid_to": (T0 - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        },
    )
    await _attribute([[storm], [expired], [_bus(0.5)]], rule_verdict=recorder)

    context_ids = {a.id for _, ctx in recorder.calls[-1:] for a in ctx}
    assert storm.id in context_ids
    assert expired.id not in context_ids


# ---- Missing internal-diagnosis telemetry ----------------------------------------------


@pytest.mark.asyncio
async def test_missing_bus_telemetry_takes_the_stress_haircut() -> None:
    attributions, traces, _ = await _attribute(
        [[_rf()]], rule_verdict=None, bus_health_registry=lambda: {SAT}
    )
    final = attributions[0]
    assert f"internal diagnosis telemetry missing for {SAT}" in final.evidence
    assert any(line.startswith("Stress: input domains ['bus_health']") for line in final.evidence)
    # Stub rf 0.74 - 0.05 = 0.69, minus the 0.15 haircut.
    assert final.confidence == pytest.approx(0.54)
    stress = next(t for t in traces if t.stage == "stress")
    assert stress.payload["missing_bus_telemetry"] == SAT
    assert stress.payload["blocked"] == ["bus_health"]


@pytest.mark.asyncio
async def test_missing_bus_telemetry_haircut_is_bounded_by_the_verdict_band() -> None:
    # Haircut first, then the rule band: the band floor is rule - 0.15.
    attributions, _, _ = await _attribute(
        [[_rf()]],
        rule_verdict=_fixed(_Rule("hostile_external", 0.72)),
        bus_health_registry=lambda: {SAT},
    )
    final = attributions[0]
    assert f"internal diagnosis telemetry missing for {SAT}" in final.evidence
    assert final.confidence == pytest.approx(0.57)


@pytest.mark.asyncio
async def test_recent_bus_anomaly_means_telemetry_is_not_missing() -> None:
    recent_bus = _bus(0.83, ts=T0 - timedelta(seconds=120))
    attributions, traces, _ = await _attribute(
        [[recent_bus], [_rf()]], rule_verdict=None, bus_health_registry=lambda: {SAT}
    )
    final = attributions[-1]
    assert final.anomaly_ids != [recent_bus.id]
    assert not any("telemetry missing" in line for line in final.evidence)
    assert final.confidence == pytest.approx(0.69)
    assert not any(t.stage == "stress" for t in traces)


@pytest.mark.asyncio
async def test_satellites_outside_the_registry_are_not_haircut() -> None:
    attributions, _, _ = await _attribute(
        [[_rf()]], rule_verdict=None, bus_health_registry=lambda: {"ctb://centralblue.dev/other"}
    )
    assert not any("telemetry missing" in line for line in attributions[0].evidence)


@pytest.mark.asyncio
async def test_batch_with_its_own_bus_anomaly_is_not_haircut() -> None:
    attributions, _, _ = await _attribute(
        [[_bus(0.3), _rf()]], rule_verdict=None, bus_health_registry=lambda: {SAT}
    )
    assert not any("telemetry missing" in line for line in attributions[0].evidence)


@pytest.mark.asyncio
async def test_missing_telemetry_combines_with_blocked_domains() -> None:
    attributions, _, _ = await _attribute(
        [[_rf()]],
        rule_verdict=None,
        bus_health_registry=lambda: {SAT},
        blocked_domains=lambda: {"rf_ew"},
    )
    final = attributions[0]
    assert any(
        line.startswith("Stress: input domains ['bus_health', 'rf_ew']") for line in final.evidence
    )
    assert f"internal diagnosis telemetry missing for {SAT}" in final.evidence
    # One haircut, not two.
    assert final.confidence == pytest.approx(0.54)


# ---- Live-client paths pass the verdict fields through ---------------------------------

import json  # noqa: E402
from types import SimpleNamespace  # noqa: E402

import httpx  # noqa: E402

from canopy.services.llm.ollama_client import OllamaLLMClient  # noqa: E402


class _FakeOllamaTransport(httpx.AsyncBaseTransport):
    def __init__(self, response_payload: dict) -> None:
        self.response_payload = response_payload
        self.requests: list[dict] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(json.loads(request.content))
        body = {"message": {"content": json.dumps(self.response_payload)}}
        return httpx.Response(200, json=body)


_CANNED_CHANGE = {
    "actor": "Russia",
    "confidence": 0.9,
    "doctrine_match": "kb-gps-jamming-001",
    "evidence": ["Directional interference on the downlink 40 s before the margin drop."],
    "predicted_next": None,
    "kb_citations": ["kb-gps-jamming-001", "kb-attribution-uncertainty-001"],
    "verdict": "hostile_external",
    "verdict_evidence": ["anom-rf rf_anomaly on the same satellite 40 s before onset"],
}


@pytest.mark.asyncio
async def test_ollama_path_prefills_and_passes_verdict_fields_through() -> None:
    transport = _FakeOllamaTransport(_CANNED_CHANGE)
    client = OllamaLLMClient(KB.load_from_json(KB_FILE), base_url="http://fake:11434", transport=transport)
    rule = _Rule("internal_fault", 0.83, pc=0.83)

    attribution = await client.attribute_primary([_bus(0.83)], rule_verdict=rule)

    assert attribution.verdict == "hostile_external"
    assert attribution.verdict_basis == "reasoning"
    assert attribution.verdict_evidence == _CANNED_CHANGE["verdict_evidence"]
    assert attribution.actor == "Russia"
    assert attribution.confidence == pytest.approx(0.85)  # reasoning-lane ceiling
    request = transport.requests[0]
    assert request["format"]["properties"]["verdict"]["default"] == "internal_fault"
    assert "## Provisional Verdict (rule lane)" in request["messages"][1]["content"]
    assert "verdict: internal_fault" in request["messages"][1]["content"]


@pytest.mark.asyncio
async def test_ollama_path_repairs_an_uncited_change() -> None:
    canned = {**_CANNED_CHANGE, "verdict_evidence": []}
    transport = _FakeOllamaTransport(canned)
    client = OllamaLLMClient(KB.load_from_json(KB_FILE), base_url="http://fake:11434", transport=transport)

    attribution = await client.attribute_primary([_bus(0.83)], rule_verdict=_Rule("internal_fault", 0.83))

    assert attribution.verdict == "internal_fault"
    assert attribution.verdict_basis == "rule"
    assert attribution.actor == "None"
    assert any(line.startswith("Verdict repair:") for line in attribution.evidence)
    assert client.validation_events[-1]["raw"]["verdict"] == "hostile_external"


@pytest.mark.asyncio
async def test_ollama_path_without_rule_is_unchanged() -> None:
    canned = {k: v for k, v in _CANNED_CHANGE.items() if k not in ("verdict", "verdict_evidence")}
    transport = _FakeOllamaTransport(canned)
    client = OllamaLLMClient(KB.load_from_json(KB_FILE), base_url="http://fake:11434", transport=transport)

    attribution = await client.attribute_primary([_rf()])

    assert attribution.verdict is None
    assert attribution.verdict_basis is None
    assert attribution.verdict_evidence == []
    assert "default" not in transport.requests[0]["format"]["properties"]["verdict"]


@pytest.mark.asyncio
async def test_anthropic_path_prefills_and_passes_verdict_fields_through(monkeypatch) -> None:
    pytest.importorskip("anthropic")
    from canopy.services.llm.anthropic_client import AnthropicLLMClient

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    client = AnthropicLLMClient(KB.load_from_json(KB_FILE))
    calls: list[dict] = []

    async def fake_create(**kwargs):
        calls.append(kwargs)
        block = SimpleNamespace(type="tool_use", name="submit_attribution", input=dict(_CANNED_CHANGE))
        return SimpleNamespace(content=[block], usage=None)

    monkeypatch.setattr(client._client.messages, "create", fake_create)
    rule = _Rule("internal_fault", 0.83, pc=0.83)

    primary = await client.attribute_primary([_bus(0.83)], rule_verdict=rule)
    assert primary.verdict == "hostile_external"
    assert primary.verdict_basis == "reasoning"
    assert primary.verdict_evidence == _CANNED_CHANGE["verdict_evidence"]
    assert calls[0]["tools"][0]["input_schema"]["properties"]["verdict"]["default"] == "internal_fault"
    assert "## Provisional Verdict (rule lane)" in calls[0]["messages"][0]["content"]

    challenge = SimpleNamespace(
        primary_attribution_id=primary.id,
        alternative_actor=None,
        objections=[],
        confidence_delta=0.0,
        rationale="endorse",
        model_dump=lambda mode="json": {"rationale": "endorse"},
    )
    final = await client.reconcile(primary, challenge, [_bus(0.83)], rule_verdict=rule)
    assert final.verdict == "hostile_external"
    assert final.verdict_basis == "reasoning"
    assert calls[1]["tools"][0]["input_schema"]["properties"]["verdict"]["default"] == "internal_fault"
    assert "## Provisional Verdict (rule lane)" in calls[1]["messages"][0]["content"]


# ---- Recovery block round trip on the live decide path ------------------------------


@pytest.mark.asyncio
async def test_ollama_decide_keeps_an_echoed_recovery_block() -> None:
    canned = {
        "action": "recovery_recommendation",
        "target": "LEO-SCIENCE-1 comms",
        "rationale": "Switching to the redundant amplifier; primary output trending down.",
        "authority": "local",
        "request_packet": None,
        "recovery": {
            "action_id": "switch_redundant_amplifier",
            "target_subsystem": "comms",
            "requires_approval": True,
            "rationale": "Primary amplifier output trending down.",
            "satellite_id": SAT,
        },
    }
    transport = _FakeOllamaTransport(canned)
    client = OllamaLLMClient(KB.load_from_json(KB_FILE), base_url="http://fake:11434", transport=transport)
    attribution = Attribution(
        anomaly_ids=["anom-1"],
        actor="None",
        confidence=0.83,
        evidence=["test"],
        kb_citations=["kb-attribution-uncertainty-001"],
        verdict="internal_fault",
        verdict_basis="rule",
        satellite_id=SAT,
        source_signal_ids=["sig-bus"],
    )

    decision = await client.decide(attribution)

    assert decision.action == "recovery_recommendation"
    assert decision.authority == "local"
    assert decision.request_packet is None
    assert decision.recovery is not None
    assert decision.recovery.action_id == "switch_redundant_amplifier"
    assert decision.recovery.target_subsystem == "comms"
    assert decision.recovery.requires_approval is True
    assert decision.recovery.satellite_id == SAT


@pytest.mark.asyncio
async def test_anthropic_decide_keeps_an_echoed_recovery_block(monkeypatch) -> None:
    pytest.importorskip("anthropic")
    from canopy.services.llm.anthropic_client import AnthropicLLMClient

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    client = AnthropicLLMClient(KB.load_from_json(KB_FILE))
    canned = {
        "action": "recovery_recommendation",
        "target": "LEO-SCIENCE-1 comms",
        "rationale": "Switching to the redundant amplifier; primary output trending down.",
        "authority": "local",
        "request_packet": None,
        "recovery": {
            "action_id": "switch_redundant_amplifier",
            "target_subsystem": "comms",
            "requires_approval": True,
            "rationale": "Primary amplifier output trending down.",
        },
    }

    async def fake_create(**kwargs):
        block = SimpleNamespace(type="tool_use", name="submit_decision", input=dict(canned))
        return SimpleNamespace(content=[block], usage=None)

    monkeypatch.setattr(client._client.messages, "create", fake_create)
    attribution = Attribution(
        anomaly_ids=["anom-1"],
        actor="None",
        confidence=0.83,
        evidence=["test"],
        kb_citations=["kb-attribution-uncertainty-001"],
        verdict="internal_fault",
        verdict_basis="rule",
        source_signal_ids=["sig-bus"],
    )

    decision = await client.decide(attribution)

    assert decision.action == "recovery_recommendation"
    assert decision.recovery is not None
    assert decision.recovery.action_id == "switch_redundant_amplifier"
    assert decision.recovery.source == "internal-diagnosis"
