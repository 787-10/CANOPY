"""The attribution fast lane (docs/MEGALITH-Integration-Plan.md §4, wave 3A).

A satellite-keyed batch with a ``bus_*`` anomaly gets a provisional
attribution from the rule lane at once, with no LLM call and no window wait;
the reasoning lane runs in its own task and republishes the same id as
revision 1, and anomalies that join meanwhile become revision 2. Legacy
batches (no ``satellite_id``, no bus anomaly, or rule lane off) keep the
windowed synchronous path. Decide keeps one decision id per attribution id,
UI event ids are therefore stable, and every attrib / decide / ui trace
carries ``latency_ms`` and ``stage_ms``.

``megalith.verdict`` is not importable from CANOPY's own environment, so a
toy rule stands in for it; the real rule runs through the same service in
``megalith/tests/test_verdict_lane.py``.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from canopy.services.attrib import PROVISIONAL_NOTE, AttribService
from canopy.services.bus import InProcessBus
from canopy.services.decide import DecideService
from canopy.services.kb import KB
from canopy.services.llm.stub import StubLLMClient
from canopy.services.schemas.events import (
    Anomaly,
    Attribution,
    Decision,
    ReasoningTrace,
    UIEvent,
)
from canopy.services.traces import Tracer
from canopy.services.ui_events import UIEventService

ROOT = Path(__file__).resolve().parent.parent
KB_FILE = ROOT / "data" / "kb_seed_entries.json"
SAT = "ctb://centralblue.dev/leo-science-1"
T0 = datetime(2026, 9, 17, 14, 30, tzinfo=UTC)

# The brief's acceptance bound: a provisional attribution within 0.1 s of
# the anomaly, with an LLM that takes 0.5 s per call.
PROVISIONAL_BOUND_S = 0.1
LLM_DELAY_S = 0.5


# ---- Fixtures ---------------------------------------------------------------------


@dataclass(frozen=True)
class _Rule:
    verdict: str
    confidence: float
    basis: tuple[str, ...]
    satellite_id: str | None
    pc: float | None


def _toy_rule(batch, context, *, kind_domains=None) -> _Rule:
    """A stand-in for ``megalith.verdict.rule_verdict`` (spec §5.1, rules 1/2/3/6)."""
    sat = next((a.payload.get("satellite_id") for a in batch if a.payload.get("satellite_id")), None)
    bus = [a for a in batch if a.kind.startswith("bus_")]
    pc = bus[-1].payload.get("physics_consistency") if bus else None
    hostile = [a for a in batch if a.kind == "rf_anomaly"]
    hostile_ctx = bool(hostile)
    if pc is None and hostile_ctx:
        severity = max(a.severity for a in hostile)
        return _Rule("hostile_external", min(0.72, severity), ("rule 1: hostile_external",), sat, None)
    if pc is not None and pc >= 0.7 and not hostile_ctx:
        return _Rule("internal_fault", float(pc), (f"rule 2: internal_fault pc={pc:.2f}",), sat, pc)
    if pc is not None and pc < 0.5 and hostile_ctx:
        return _Rule("hostile_external", min(0.85, 1 - pc), ("rule 3: hostile_external",), sat, pc)
    return _Rule("unknown", min(0.49, pc or 0.3), ("rule 6: unknown",), sat, pc)


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


def _rf(*, sat: str | None = SAT, ts: datetime = T0, sid: str = "sig-rf") -> Anomaly:
    return Anomaly(
        ts=ts,
        kind="rf_anomaly",
        source_signal=sid,
        source_signal_ids=[sid],
        severity=0.85,
        payload={"satellite_id": sat} if sat else {},
    )


class _SlowLLM:
    """The stub with a wall-clock cost per reasoning call.

    Records the order of calls and the highest number of concurrent calls so
    a test can show the reasoning lane is serialised per satellite.
    """

    def __init__(self, inner: StubLLMClient, delay_s: float = LLM_DELAY_S, *, decide_delay_s: float = 0.0) -> None:
        self._inner = inner
        self._delay = delay_s
        self._decide_delay = decide_delay_s
        self.calls: list[str] = []
        self.completed: list[str] = []
        self.in_flight = 0
        self.max_in_flight = 0

    async def _cost(self, name: str, delay: float) -> None:
        self.calls.append(name)
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            await asyncio.sleep(delay)
        finally:
            self.in_flight -= 1
        self.completed.append(name)

    async def attribute_primary(self, anomalies, kb_context=(), *, rule_verdict=None):
        await self._cost("primary", self._delay)
        return await self._inner.attribute_primary(anomalies, kb_context, rule_verdict=rule_verdict)

    async def attribute_redteam(self, primary, anomalies, kb_context=()):
        await self._cost("redteam", self._delay)
        return await self._inner.attribute_redteam(primary, anomalies, kb_context)

    async def reconcile(self, primary, challenge, anomalies, kb_context=(), *, rule_verdict=None):
        await self._cost("reconcile", self._delay)
        return await self._inner.reconcile(
            primary, challenge, anomalies, kb_context, rule_verdict=rule_verdict
        )

    async def decide(self, attribution):
        await self._cost("decide", self._decide_delay)
        return await self._inner.decide(attribution)


@dataclass
class _Run:
    bus: InProcessBus
    attrib: AttribService
    tracer: Tracer
    llm: _SlowLLM
    attributions: list[tuple[float, Attribution]] = field(default_factory=list)
    decisions: list[tuple[float, Decision]] = field(default_factory=list)
    ui_events: list[tuple[float, UIEvent]] = field(default_factory=list)
    traces: list[ReasoningTrace] = field(default_factory=list)
    tasks: list[asyncio.Task] = field(default_factory=list)

    async def publish(self, anomaly: Anomaly) -> float:
        await self.bus.publish(f"anomalies.{anomaly.kind}", anomaly)
        return time.monotonic()

    async def wait_for(self, target: list, count: int, *, timeout: float = 5.0) -> None:
        deadline = time.monotonic() + timeout
        while len(target) < count:
            if time.monotonic() > deadline:
                raise AssertionError(f"expected {count} events, got {len(target)}")
            await asyncio.sleep(0.005)

    async def stop(self) -> None:
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.bus.close()


async def _start(
    *,
    delay_s: float = LLM_DELAY_S,
    window_s: float = 0.2,
    rule=_toy_rule,
    with_decide: bool = False,
    with_ui: bool = False,
    **attrib_kwargs,
) -> _Run:
    bus = InProcessBus()
    kb = KB.load_from_json(KB_FILE)
    llm = _SlowLLM(StubLLMClient(kb), delay_s)
    tracer = Tracer(bus)
    attrib = AttribService(
        bus, llm, kb, window_s=window_s, tracer=tracer, rule_verdict=rule, **attrib_kwargs
    )
    run = _Run(bus=bus, attrib=attrib, tracer=tracer, llm=llm)

    async def sniff(pattern: str, target: list, kind: type, stamped: bool) -> None:
        async for _, event in bus.subscribe(pattern):
            if isinstance(event, kind):
                target.append((time.monotonic(), event) if stamped else event)

    run.tasks = [
        asyncio.create_task(sniff("attributions.*", run.attributions, Attribution, True)),
        asyncio.create_task(sniff("decisions.*", run.decisions, Decision, True)),
        asyncio.create_task(sniff("ui_events.*", run.ui_events, UIEvent, True)),
        asyncio.create_task(sniff("traces.*", run.traces, ReasoningTrace, False)),
        asyncio.create_task(attrib.run()),
    ]
    if with_decide:
        decide = DecideService(bus, llm, tracer=tracer, kb=kb)
        run.tasks.append(asyncio.create_task(decide.run()))
    if with_ui:
        run.tasks.append(asyncio.create_task(UIEventService(bus, tracer=tracer).run()))
    for _ in range(3):
        await asyncio.sleep(0)
    return run


# ---- Provisional first, final later, same id -------------------------------------------


@pytest.mark.asyncio
async def test_provisional_attribution_arrives_before_the_reasoning_lane() -> None:
    run = await _start()
    try:
        published = await run.publish(_bus(0.83))
        await run.wait_for(run.attributions, 1, timeout=PROVISIONAL_BOUND_S * 5)
        seen_at, provisional = run.attributions[0]
        provisional_after = seen_at - published

        assert provisional_after < PROVISIONAL_BOUND_S, f"provisional took {provisional_after:.3f}s"
        assert provisional.provisional is True
        assert provisional.revision == 0
        assert provisional.verdict == "internal_fault"
        assert provisional.verdict_basis == "rule"
        assert provisional.actor == "None"
        assert provisional.confidence == pytest.approx(0.83)
        assert provisional.physics_consistency == pytest.approx(0.83)
        assert provisional.satellite_id == SAT
        assert provisional.kb_citations == []
        assert PROVISIONAL_NOTE in provisional.evidence
        assert any(line.startswith("Verdict (rule): internal_fault. rule 2:") for line in provisional.evidence)
        # The fast lane is the rule lane only: no LLM call had finished (the
        # reasoning task may already be inside its first 0.5 s call).
        assert run.llm.completed == []
        assert run.llm.calls in ([], ["primary"])

        await run.wait_for(run.attributions, 2)
        final_at, final = run.attributions[1]
        final_after = final_at - published
        print(
            f"\nfast lane: provisional after {provisional_after * 1000:.1f} ms, "
            f"final after {final_after * 1000:.1f} ms (LLM {LLM_DELAY_S}s x 3 calls)"
        )
        assert final.id == provisional.id
        assert final.provisional is False
        assert final.revision == 1
        assert final.verdict == "internal_fault"
        assert final.actor == "None"
        # The reasoning lane ran the full loop: three calls, in order.
        assert run.llm.calls == ["primary", "redteam", "reconcile"]
        assert final_after >= 3 * LLM_DELAY_S
        # The reasoning lane's own output (stub 0.62 clamped up to rule - 0.15).
        assert final.confidence == pytest.approx(0.68)
        assert any("Red-team review" in line for line in final.evidence)
        assert run.attrib.errors == []
    finally:
        await run.stop()


@pytest.mark.asyncio
async def test_provisional_hostile_verdict_carries_unknown_actor_at_the_cap() -> None:
    # No actor has been attributed yet, so a hostile provisional follows §5:
    # actor Unknown, confidence capped; the reasoning lane then names the actor.
    run = await _start(delay_s=0.0, window_s=0.5)
    try:
        rf, bus = _rf(), _bus(0.3)
        await run.publish(rf)
        await run.publish(bus)
        await run.wait_for(run.attributions, 1)
        _, provisional = run.attributions[0]
        assert provisional.provisional is True
        assert provisional.anomaly_ids == [rf.id, bus.id]
        assert provisional.verdict == "hostile_external"
        assert provisional.actor == "Unknown"
        assert provisional.confidence == pytest.approx(0.49)
        await run.attrib.flush()
        await run.bus.drain()
        _, final = run.attributions[-1]
        assert final.id == provisional.id and final.revision >= 1
        assert final.verdict == "hostile_external"
        assert final.actor == "Russia"
        assert final.confidence > provisional.confidence
    finally:
        await run.stop()


# ---- Revisions ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_second_anomaly_joining_the_cluster_becomes_the_next_revision() -> None:
    run = await _start()
    try:
        bus, rf = _bus(0.3), _rf()
        await run.publish(bus)
        await run.wait_for(run.attributions, 1)
        # The reasoning task is inside its first (0.5 s) call when the RF
        # cue joins the same satellite's cluster.
        await asyncio.sleep(0.2)
        await run.publish(rf)
        await run.wait_for(run.attributions, 3, timeout=8.0)
        await run.attrib.flush()
        await run.bus.drain()

        events = [a for _, a in run.attributions]
        assert len(events) == 3
        assert len({a.id for a in events}) == 1
        assert [a.revision for a in events] == [0, 1, 2]
        assert [a.provisional for a in events] == [True, False, False]
        assert events[1].anomaly_ids == [bus.id]
        assert events[2].anomaly_ids == [bus.id, rf.id]
        assert events[2].verdict == "hostile_external"
        assert events[2].actor == "Russia"
        # One reasoning task per satellite: the passes never overlapped.
        assert run.llm.max_in_flight == 1
        assert run.llm.calls == ["primary", "redteam", "reconcile"] * 2
        assert run.attrib.open_clusters == {}
    finally:
        await run.stop()


@pytest.mark.asyncio
async def test_joins_during_one_pass_coalesce_into_a_single_revision() -> None:
    run = await _start()
    try:
        bus = _bus(0.3)
        await run.publish(bus)
        await run.wait_for(run.attributions, 1)
        await asyncio.sleep(0.1)
        cues = [_rf(sid=f"sig-rf-{i}") for i in range(3)]
        for cue in cues:
            await run.publish(cue)
        await run.attrib.flush()
        await run.bus.drain()

        events = [a for _, a in run.attributions]
        assert [a.revision for a in events] == [0, 1, 2]
        assert events[-1].anomaly_ids == [bus.id, *(c.id for c in cues)]
    finally:
        await run.stop()


@pytest.mark.asyncio
async def test_pending_same_satellite_anomalies_join_the_new_cluster() -> None:
    # An RF cue on the satellite is waiting in the window when the bus
    # anomaly lands: the provisional attribution covers both.
    run = await _start(window_s=0.5)
    try:
        rf, bus = _rf(), _bus(0.3)
        await run.publish(rf)
        await asyncio.sleep(0.05)
        assert run.attributions == []  # still inside the legacy window
        published = await run.publish(bus)
        await run.wait_for(run.attributions, 1)
        seen_at, provisional = run.attributions[0]
        assert seen_at - published < PROVISIONAL_BOUND_S
        assert provisional.anomaly_ids == [rf.id, bus.id]
        assert provisional.verdict == "hostile_external"
        await run.attrib.flush()
        await run.bus.drain()
        # The RF cue was not attributed a second time by the window flush.
        assert len(run.attributions) == 2
        assert run.attributions[1][1].anomaly_ids == [rf.id, bus.id]
    finally:
        await run.stop()


@pytest.mark.asyncio
async def test_a_new_batch_after_the_cluster_closed_gets_a_new_id() -> None:
    run = await _start(delay_s=0.0, window_s=0.05)
    try:
        await run.publish(_bus(0.83))
        await run.wait_for(run.attributions, 2)
        await asyncio.sleep(0.15)  # past the window: the cluster has closed
        assert run.attrib.open_clusters == {}
        await run.publish(_bus(0.83, ts=T0 + timedelta(seconds=30)))
        await run.wait_for(run.attributions, 4)
        ids = [a.id for _, a in run.attributions]
        assert ids[0] == ids[1] and ids[2] == ids[3] and ids[0] != ids[2]
        assert [a.revision for _, a in run.attributions] == [0, 1, 0, 1]
    finally:
        await run.stop()


# ---- Legacy batches are unchanged --------------------------------------------------


@pytest.mark.asyncio
async def test_legacy_batch_without_satellite_id_is_unchanged() -> None:
    run = await _start(delay_s=0.1, window_s=0.2)
    try:
        published = await run.publish(_rf(sat=None))
        await run.wait_for(run.attributions, 1)
        await asyncio.sleep(0.2)
        assert len(run.attributions) == 1
        seen_at, attribution = run.attributions[0]
        assert attribution.provisional is False
        assert attribution.revision == 0
        assert attribution.satellite_id is None
        assert attribution.actor == "Russia"
        # Window wait plus three synchronous calls, exactly as before.
        assert seen_at - published >= 0.2 + 3 * 0.1
        assert run.llm.calls == ["primary", "redteam", "reconcile"]
        assert not any("provisional" in t.message for t in run.traces)
        assert run.attrib.open_clusters == {}
    finally:
        await run.stop()


@pytest.mark.asyncio
async def test_satellite_batch_without_a_bus_anomaly_stays_on_the_legacy_path() -> None:
    run = await _start(delay_s=0.0, window_s=0.1)
    try:
        await run.publish(_rf())
        await run.wait_for(run.attributions, 1)
        await asyncio.sleep(0.15)
        assert len(run.attributions) == 1
        _, attribution = run.attributions[0]
        assert attribution.provisional is False and attribution.revision == 0
        assert attribution.satellite_id == SAT
    finally:
        await run.stop()


@pytest.mark.asyncio
async def test_fast_lane_needs_the_rule_lane() -> None:
    run = await _start(delay_s=0.0, window_s=0.1, rule=None)
    try:
        assert not run.attrib.fast_lane_enabled
        await run.publish(_bus(0.83))
        await run.wait_for(run.attributions, 1)
        await asyncio.sleep(0.15)
        assert len(run.attributions) == 1
        _, attribution = run.attributions[0]
        assert attribution.provisional is False and attribution.revision == 0
        assert attribution.verdict is None
    finally:
        await run.stop()


@pytest.mark.asyncio
async def test_fast_lane_can_be_switched_off_explicitly() -> None:
    run = await _start(delay_s=0.0, window_s=0.1, fast_lane=False)
    try:
        assert run.attrib.verdict_lane_enabled and not run.attrib.fast_lane_enabled
        await run.publish(_bus(0.83))
        await run.wait_for(run.attributions, 1)
        await asyncio.sleep(0.15)
        assert len(run.attributions) == 1
        assert run.attributions[0][1].verdict == "internal_fault"
        assert run.attributions[0][1].provisional is False
    finally:
        await run.stop()


@pytest.mark.asyncio
async def test_a_failing_rule_falls_back_to_the_legacy_path() -> None:
    def broken(batch, context, *, kind_domains=None):
        raise RuntimeError("rule blew up")

    run = await _start(delay_s=0.0, window_s=0.1, rule=broken)
    try:
        await run.publish(_bus(0.83))
        await run.wait_for(run.attributions, 1)
        await asyncio.sleep(0.15)
        assert len(run.attributions) == 1
        assert run.attributions[0][1].provisional is False
        assert run.attrib.errors and run.attrib.errors[0]["stage"] == "rule_verdict"
    finally:
        await run.stop()


# ---- flush() and cancellation ------------------------------------------------------------


@pytest.mark.asyncio
async def test_flush_waits_for_the_reasoning_lane_and_closes_the_cluster() -> None:
    run = await _start(delay_s=0.2)
    try:
        await run.publish(_bus(0.83))
        await run.wait_for(run.attributions, 1)
        assert list(run.attrib.open_clusters) == [SAT]
        started = time.monotonic()
        await run.attrib.flush()
        assert time.monotonic() - started >= 3 * 0.2 - 0.05
        await run.bus.drain()
        assert len(run.attributions) == 2
        assert run.attributions[1][1].revision == 1
        assert run.attrib.open_clusters == {}
    finally:
        await run.stop()


@pytest.mark.asyncio
async def test_stopping_the_service_cancels_in_flight_reasoning() -> None:
    run = await _start()
    await run.publish(_bus(0.83))
    await run.wait_for(run.attributions, 1)
    reasoning = [t for t in asyncio.all_tasks() if t.get_name().startswith("attrib-reasoning-")]
    assert len(reasoning) == 1 and not reasoning[0].done()
    await run.stop()
    await asyncio.sleep(0)
    assert reasoning[0].cancelled() or reasoning[0].done()
    assert len(run.attributions) == 1


# ---- Timing on every trace, stable ids downstream ---------------------------------------


def _timed(traces: list[ReasoningTrace], stage: str) -> list[ReasoningTrace]:
    return [t for t in traces if t.stage == stage]


@pytest.mark.asyncio
async def test_traces_carry_latency_and_stage_ms_on_attrib_and_decide() -> None:
    run = await _start(delay_s=0.05, with_decide=True, with_ui=True)
    try:
        await run.publish(_bus(0.83))
        await run.wait_for(run.attributions, 2)
        await run.wait_for(run.decisions, 2)
        await run.wait_for(run.ui_events, 2)
        await run.bus.drain()

        stages = {"attrib_primary", "attrib_redteam", "attrib_reconcile", "decide"}
        timed = [t for t in run.traces if t.stage in stages]
        assert timed, [t.stage for t in run.traces]
        for trace in timed:
            assert isinstance(trace.payload.get("latency_ms"), float), (trace.stage, trace.payload)
            assert isinstance(trace.payload.get("stage_ms"), float), (trace.stage, trace.payload)
            assert trace.payload["latency_ms"] >= trace.payload["stage_ms"] >= 0.0

        provisional = next(t for t in _timed(run.traces, "attrib_primary") if t.level == "decision")
        assert provisional.payload["provisional"] is True
        assert provisional.payload["revision"] == 0
        assert provisional.payload["latency_ms"] < PROVISIONAL_BOUND_S * 1000
        primary = next(t for t in _timed(run.traces, "attrib_primary") if t.level == "info")
        assert primary.payload["stage_ms"] >= 50.0  # the primary call itself
        final = next(t for t in _timed(run.traces, "attrib_reconcile") if t.level == "info")
        assert final.payload["revision"] == 1 and final.payload["provisional"] is False
        assert final.payload["latency_ms"] >= 3 * 50.0

        decide = [t for t in _timed(run.traces, "decide") if t.level == "decision"]
        assert [t.payload["revision"] for t in decide] == [0, 1]
        assert [t.payload["provisional"] for t in decide] == [True, False]
        # Decide's latency is measured from the same origin as attrib's.
        assert decide[1].payload["latency_ms"] >= final.payload["latency_ms"]
        ui = [t for t in _timed(run.traces, "decide") if t.message.startswith("ui event")]
        assert [t.payload["update"] for t in ui] == [False, True]
        assert all("latency_ms" in t.payload and "stage_ms" in t.payload for t in ui)
    finally:
        await run.stop()


@pytest.mark.asyncio
async def test_decision_and_ui_event_ids_are_stable_across_revisions() -> None:
    run = await _start(delay_s=0.0, with_decide=True, with_ui=True)
    try:
        await run.publish(_bus(0.83))
        await run.wait_for(run.attributions, 2)
        await run.wait_for(run.decisions, 2)
        await run.wait_for(run.ui_events, 2)
        await run.bus.drain()

        attributions = [a for _, a in run.attributions]
        decisions = [d for _, d in run.decisions]
        ui_events = [u for _, u in run.ui_events]
        assert len({a.id for a in attributions}) == 1
        assert len(decisions) == 2 and len({d.id for d in decisions}) == 1
        assert [d.revision for d in decisions] == [0, 1]
        assert all(d.attribution_id == attributions[0].id for d in decisions)
        assert len(ui_events) == 2 and len({u.id for u in ui_events}) == 1
        assert ui_events[0].id == f"uievt-{decisions[0].id}"
        # The update reflects the revised attribution (the reasoning lane's
        # confidence), not the provisional one.
        assert ui_events[0].confidence == pytest.approx(attributions[0].confidence)
        assert ui_events[1].confidence == pytest.approx(attributions[1].confidence)
    finally:
        await run.stop()


@pytest.mark.asyncio
async def test_legacy_decisions_keep_a_fresh_id_and_revision_zero() -> None:
    run = await _start(delay_s=0.0, window_s=0.05, with_decide=True, with_ui=True)
    try:
        await run.publish(_rf(sat=None, sid="sig-a"))
        await run.wait_for(run.decisions, 1)
        await asyncio.sleep(0.1)
        await run.publish(_rf(sat=None, sid="sig-b"))
        await run.wait_for(run.decisions, 2)
        await run.bus.drain()
        decisions = [d for _, d in run.decisions]
        assert decisions[0].id != decisions[1].id
        assert [d.revision for d in decisions] == [0, 0]
        assert len({u.id for _, u in run.ui_events}) == 2
    finally:
        await run.stop()
