"""Withheld recovery in the decide stage (docs/INTERFACE-SPEC.md §6, wave 4B).

When the cluster carries an internal-diagnosis ``recommended_recovery`` and
the decision that leaves the gate is not a recovery, DecideService annotates
it with ``Decision.withheld_recovery`` and emits a warn trace
``recovery withheld: <action_id>: <reason_code>``. These tests drive the
service on an in-process bus: the verdict reasons (which CANOPY reports on
its own), the injected and fallback reason callables, the invariants, the
re-evaluation on every revision, the UI clause, and the wire round trip. The
reason codes themselves are unit-tested in ``megalith/tests/test_withheld.py``.
"""
from __future__ import annotations

import asyncio
import importlib.util
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from canopy.services.bus import InProcessBus, codec
from canopy.services.decide import (
    REASON_VERDICT_HOSTILE,
    REASON_VERDICT_UNKNOWN,
    DecideService,
    default_withheld_reason,
    verdict_withheld_reason,
)
from canopy.services.decide.tools import GateContext, policy_gate
from canopy.services.kb import KB
from canopy.services.llm.stub import StubLLMClient
from canopy.services.llm.validation import validate_and_repair_decision
from canopy.services.schemas.events import (
    Anomaly,
    Attribution,
    Decision,
    ReasoningTrace,
    RecoveryBlock,
    WithheldRecovery,
)
from canopy.services.traces import Tracer
from canopy.services.ui_events import UIEventService, withheld_reason_label

MEGALITH_AVAILABLE = importlib.util.find_spec("megalith") is not None

SAT = "ctb://centralblue.dev/leo-science-1"
T0 = datetime(2026, 9, 17, 14, 30, tzinfo=UTC)
UPLINK_JAMMING = "threat/uplink_jamming_active"

RECOVERY = {
    "action_id": "switch_redundant_amplifier",
    "target_subsystem": "comms",
    "requires_approval": True,
    "rationale": "Primary amplifier output trending down; redundant unit nominal.",
}


def _anomaly(kind: str, sid: str, *, offset_s: float = 0.0, **payload: Any) -> Anomaly:
    return Anomaly(
        id=f"anom-{kind}-{sid}",
        ts=T0 + timedelta(seconds=offset_s),
        kind=kind,
        source_signal=sid,
        source_signal_ids=[sid],
        severity=0.81,
        payload={"asset": "LEO-SCIENCE-1", "satellite_id": SAT, **payload},
    )


def _bus_anomaly(**overrides: Any) -> Anomaly:
    payload = {
        "subsystem": "comms",
        "symptom": "link_margin_db_drop",
        "physics_consistency": 0.31,
        "recommended_recovery": dict(RECOVERY),
    }
    payload.update(overrides)
    return _anomaly("bus_link_margin", "sig-bus-1", **payload)


def _attribution(
    anomalies: list[Anomaly], *, verdict: str | None, revision: int = 0, aid: str = "attr-1"
) -> Attribution:
    positive = verdict in ("internal_fault", "natural_external")
    return Attribution(
        id=aid,
        anomaly_ids=[a.id for a in anomalies],
        actor="None" if positive else "Unknown",
        confidence=0.83 if positive else 0.45,
        evidence=["step-shaped margin loss coincident with an RF interference report"],
        kb_citations=["kb-attribution-uncertainty-001"],
        source_signal_ids=[a.source_signal for a in anomalies],
        verdict=verdict,
        verdict_basis="rule" if verdict else None,
        satellite_id=SAT,
        provisional=revision == 0,
        revision=revision,
    )


async def _run(
    *,
    cached: list[Anomaly],
    attributions: list[Attribution],
    withheld_reason: Any = None,
    gate: Any = policy_gate,
) -> tuple[list[Decision], list[ReasoningTrace]]:
    bus = InProcessBus()
    tracer = Tracer(bus)
    service = DecideService(
        bus,
        StubLLMClient(KB(entries=[])),
        tracer=tracer,
        gate=gate,
        withheld_reason=withheld_reason,
    )
    decisions: list[Decision] = []
    traces: list[ReasoningTrace] = []

    async def sniff(pattern: str, target: list, kind: type) -> None:
        async for _, event in bus.subscribe(pattern):
            if isinstance(event, kind):
                target.append(event)

    tasks = [
        asyncio.create_task(service.run()),
        asyncio.create_task(sniff("decisions.*", decisions, Decision)),
        asyncio.create_task(sniff("traces.*", traces, ReasoningTrace)),
    ]
    try:
        for _ in range(3):
            await asyncio.sleep(0)
        for anomaly in cached:
            await bus.publish(f"anomalies.{anomaly.kind}", anomaly)
        await bus.drain()
        for attribution in attributions:
            await bus.publish("attributions.none", attribution)
            await bus.drain()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        bus.close()
    return decisions, traces


def _withheld_traces(traces: list[ReasoningTrace]) -> list[ReasoningTrace]:
    return [
        t
        for t in traces
        if t.stage == "decide" and t.level == "warn" and t.message.startswith("recovery withheld:")
    ]


EXPECTED_BLOCK = WithheldRecovery(
    action_id="switch_redundant_amplifier",
    target_subsystem="comms",
    reason_code=REASON_VERDICT_HOSTILE,
)


# ---- Verdict reasons: what CANOPY reports on its own -----------------------------------


async def test_hostile_verdict_withholds_the_recommended_recovery_with_a_trace() -> None:
    bus_anom = _bus_anomaly()
    attribution = _attribution([bus_anom], verdict="hostile_external")
    decisions, traces = await _run(cached=[bus_anom], attributions=[attribution])

    assert len(decisions) == 1
    decision = decisions[0]
    assert decision.action != "recovery_recommendation"
    assert decision.recovery is None
    assert decision.withheld_recovery == EXPECTED_BLOCK
    assert decision.withheld_recovery.source == "internal-diagnosis"

    withheld = _withheld_traces(traces)
    assert [t.message for t in withheld] == [
        f"recovery withheld: switch_redundant_amplifier: {REASON_VERDICT_HOSTILE}"
    ]
    trace = withheld[0]
    assert trace.ref_id == decision.id
    assert trace.payload["reason_code"] == REASON_VERDICT_HOSTILE
    assert trace.payload["action_id"] == "switch_redundant_amplifier"
    assert trace.payload["target_subsystem"] == "comms"
    assert trace.payload["verdict"] == "hostile_external"
    assert trace.payload["satellite_id"] == SAT
    assert trace.payload["attribution_id"] == attribution.id
    assert trace.payload["revision"] == 0
    assert bus_anom.id in trace.payload["context_anomaly_ids"]


async def test_unknown_verdict_withholds_with_its_own_code() -> None:
    bus_anom = _bus_anomaly()
    decisions, traces = await _run(
        cached=[bus_anom], attributions=[_attribution([bus_anom], verdict="unknown")]
    )
    assert decisions[0].withheld_recovery is not None
    assert decisions[0].withheld_recovery.reason_code == REASON_VERDICT_UNKNOWN
    assert _withheld_traces(traces)[0].message.endswith(REASON_VERDICT_UNKNOWN)


async def test_recovery_decision_carries_no_withheld_block_and_no_trace() -> None:
    bus_anom = _bus_anomaly()
    decisions, traces = await _run(
        cached=[bus_anom], attributions=[_attribution([bus_anom], verdict="internal_fault")]
    )
    assert decisions[0].action == "recovery_recommendation"
    assert decisions[0].recovery is not None
    assert decisions[0].withheld_recovery is None
    assert not _withheld_traces(traces)


async def test_nothing_withheld_when_the_cluster_recommends_nothing() -> None:
    bare = _bus_anomaly(recommended_recovery=None)
    decisions, traces = await _run(
        cached=[bare], attributions=[_attribution([bare], verdict="hostile_external")]
    )
    assert decisions[0].withheld_recovery is None
    assert not _withheld_traces(traces)


async def test_strongest_anomaly_with_a_valid_block_is_the_one_withheld() -> None:
    weak = _bus_anomaly().model_copy(
        update={
            "id": "anom-bus-weak",
            "severity": 0.4,
            "payload": {**_bus_anomaly().payload, "recommended_recovery": {**RECOVERY, "action_id": "weak_reset"}},
        }
    )
    malformed = _bus_anomaly().model_copy(
        update={
            "id": "anom-bus-bad",
            "severity": 0.99,
            "payload": {**_bus_anomaly().payload, "recommended_recovery": {"action_id": "no_fields"}},
        }
    )
    strong = _bus_anomaly()
    decisions, _ = await _run(
        cached=[weak, malformed, strong],
        attributions=[_attribution([weak, malformed, strong], verdict="hostile_external")],
    )
    assert decisions[0].withheld_recovery is not None
    assert decisions[0].withheld_recovery.action_id == "switch_redundant_amplifier"


# ---- The reason callable: injection, fallback, default ----------------------------------


async def test_injected_reason_callable_sees_decision_context_and_recommended_block() -> None:
    seen: list[tuple[Decision, GateContext, RecoveryBlock]] = []

    def scripted(decision: Decision, ctx: GateContext, recommended: RecoveryBlock) -> str | None:
        seen.append((decision, ctx, recommended))
        return "test/scripted_reason"

    bus_anom = _bus_anomaly()
    jam = _anomaly("rf_anomaly", "sig-rf-1", offset_s=300)
    decisions, traces = await _run(
        cached=[bus_anom, jam],
        attributions=[_attribution([bus_anom], verdict="hostile_external")],
        withheld_reason=scripted,
    )
    assert decisions[0].withheld_recovery is not None
    assert decisions[0].withheld_recovery.reason_code == "test/scripted_reason"
    assert _withheld_traces(traces)[0].message == (
        "recovery withheld: switch_redundant_amplifier: test/scripted_reason"
    )
    decision, ctx, recommended = seen[0]
    assert decision.action != "recovery_recommendation" and decision.recovery is None
    assert ctx.verdict == "hostile_external" and ctx.satellite_id == SAT
    assert {a.id for a in ctx.anomalies} == {bus_anom.id, jam.id}
    assert recommended == RecoveryBlock(**RECOVERY, satellite_id=SAT)


async def test_reason_callable_returning_none_leaves_the_decision_unannotated() -> None:
    bus_anom = _bus_anomaly()
    decisions, traces = await _run(
        cached=[bus_anom],
        attributions=[_attribution([bus_anom], verdict="hostile_external")],
        withheld_reason=lambda decision, ctx, recommended: None,
    )
    assert decisions[0].withheld_recovery is None
    assert not _withheld_traces(traces)


async def test_verdict_only_fallback_ignores_jamming_in_context() -> None:
    # What CANOPY reports without the MEGALITH package, even under jamming.
    bus_anom = _bus_anomaly()
    jam = _anomaly("rf_anomaly", "sig-rf-1", offset_s=300)
    decisions, _ = await _run(
        cached=[bus_anom, jam],
        attributions=[_attribution([bus_anom], verdict="hostile_external")],
        withheld_reason=verdict_withheld_reason,
    )
    assert decisions[0].withheld_recovery is not None
    assert decisions[0].withheld_recovery.reason_code == REASON_VERDICT_HOSTILE


def test_default_reason_callable_follows_the_environment() -> None:
    service = DecideService(InProcessBus(), StubLLMClient(KB(entries=[])))
    if MEGALITH_AVAILABLE:
        from megalith.gate import withheld_reason

        assert service.withheld_reason is withheld_reason
        assert default_withheld_reason() is withheld_reason
    else:
        assert service.withheld_reason is verdict_withheld_reason


async def test_full_helper_names_the_jamming_in_a_hostile_run() -> None:
    gate_pkg = pytest.importorskip("megalith.gate")
    bus_anom = _bus_anomaly()
    jam = _anomaly("rf_anomaly", "sig-rf-1", offset_s=300)
    decisions, traces = await _run(
        cached=[bus_anom, jam],
        attributions=[_attribution([bus_anom], verdict="hostile_external")],
        gate=gate_pkg.threat_context_gate,
        withheld_reason=gate_pkg.withheld_reason,
    )
    decision = decisions[0]
    # The gate never fired: the verdict kept the recovery off the decision.
    assert not decision.rationale.startswith("[gate:")
    assert decision.withheld_recovery is not None
    assert decision.withheld_recovery.reason_code == UPLINK_JAMMING
    assert _withheld_traces(traces)[0].message == (
        f"recovery withheld: switch_redundant_amplifier: {UPLINK_JAMMING}"
    )


# ---- Revisions: re-evaluated every time ---------------------------------------------------


async def test_annotation_is_recomputed_on_every_revision() -> None:
    bus_anom = _bus_anomaly()
    provisional = _attribution([bus_anom], verdict="hostile_external", revision=0)
    revised = _attribution([bus_anom], verdict="internal_fault", revision=1)
    revised_again = _attribution([bus_anom], verdict="unknown", revision=2)
    decisions, traces = await _run(
        cached=[bus_anom], attributions=[provisional, revised, revised_again]
    )

    assert [d.revision for d in decisions] == [0, 1, 2]
    assert len({d.id for d in decisions}) == 1  # one decision id across revisions
    first, second, third = decisions
    assert first.withheld_recovery is not None
    assert first.withheld_recovery.reason_code == REASON_VERDICT_HOSTILE
    assert second.action == "recovery_recommendation" and second.withheld_recovery is None
    assert third.action != "recovery_recommendation"
    assert third.withheld_recovery is not None
    assert third.withheld_recovery.reason_code == REASON_VERDICT_UNKNOWN

    withheld = _withheld_traces(traces)
    assert [(t.payload["revision"], t.payload["reason_code"]) for t in withheld] == [
        (0, REASON_VERDICT_HOSTILE),
        (2, REASON_VERDICT_UNKNOWN),
    ]
    assert all(t.ref_id == first.id for t in withheld)


# ---- Invariants ------------------------------------------------------------------------


def _raw(action: str, **overrides: Any) -> dict[str, Any]:
    base = {
        "action": action,
        "target": "LEO-SCIENCE-1",
        "rationale": "r",
        "authority": "local",
        "request_packet": None,
    }
    base.update(overrides)
    return base


WITHHELD_RAW = {
    "action_id": "switch_redundant_amplifier",
    "target_subsystem": "comms",
    "reason_code": REASON_VERDICT_HOSTILE,
}


def test_validator_clears_withheld_from_a_recovery_decision() -> None:
    repaired = validate_and_repair_decision(
        _raw("recovery_recommendation", recovery=dict(RECOVERY), withheld_recovery=dict(WITHHELD_RAW))
    )
    assert repaired["action"] == "recovery_recommendation"
    assert repaired["recovery"] is not None
    assert repaired["withheld_recovery"] is None
    assert "withheld_recovery cleared" in repaired["rationale"]


def test_validator_keeps_a_well_formed_withheld_block_and_fixes_its_source() -> None:
    repaired = validate_and_repair_decision(
        _raw("threat_warning", withheld_recovery={**WITHHELD_RAW, "source": "somewhere-else"})
    )
    assert repaired["withheld_recovery"] == {**WITHHELD_RAW, "source": "internal-diagnosis"}
    assert repaired["rationale"] == "r"
    assert "_validation_notes" not in repaired
    WithheldRecovery.model_validate(repaired["withheld_recovery"])


@pytest.mark.parametrize(
    "withheld",
    [{}, {"action_id": "x"}, {**WITHHELD_RAW, "reason_code": " "}, "not-a-dict", 42],
)
def test_validator_drops_a_malformed_withheld_block(withheld: Any) -> None:
    repaired = validate_and_repair_decision(_raw("threat_warning", withheld_recovery=withheld))
    assert repaired["withheld_recovery"] is None
    assert "malformed withheld_recovery block dropped" in repaired["rationale"]


def test_validator_never_lets_recovery_and_withheld_coexist() -> None:
    # A stray recovery block on a non-recovery action is cleared and the
    # withheld block stays; the two never survive together.
    repaired = validate_and_repair_decision(
        _raw("passive_defense", recovery=dict(RECOVERY), withheld_recovery=dict(WITHHELD_RAW))
    )
    assert repaired["recovery"] is None
    assert repaired["withheld_recovery"] is not None
    # A recovery decision whose block is invalid is downgraded; its withheld
    # block, if any, is then judged as on any non-recovery decision.
    repaired = validate_and_repair_decision(
        _raw("recovery_recommendation", recovery=None, withheld_recovery=dict(WITHHELD_RAW))
    )
    assert repaired["action"] == "threat_warning"
    assert repaired["recovery"] is None
    assert repaired["withheld_recovery"] is not None


def test_validator_leaves_decisions_without_the_block_untouched() -> None:
    raw = _raw("threat_warning")
    assert validate_and_repair_decision(raw) == raw
    raw = _raw("threat_warning", withheld_recovery=None)
    assert validate_and_repair_decision(raw) == raw


async def test_service_strips_a_withheld_block_a_client_put_on_a_recovery() -> None:
    class WithheldOnRecovery:
        async def decide(self, attribution: Attribution) -> Decision:
            return Decision(
                attribution_id=attribution.id,
                action="recovery_recommendation",
                target="LEO-SCIENCE-1",
                rationale="client set both blocks",
                authority="local",
                recovery=RecoveryBlock(**RECOVERY, satellite_id=SAT),
                withheld_recovery=WithheldRecovery(**WITHHELD_RAW),
            )

    bus = InProcessBus()
    service = DecideService(bus, WithheldOnRecovery(), gate=policy_gate)
    bus_anom = _bus_anomaly()
    decisions: list[Decision] = []

    async def sniff() -> None:
        async for _, event in bus.subscribe("decisions.*"):
            if isinstance(event, Decision):
                decisions.append(event)

    tasks = [asyncio.create_task(service.run()), asyncio.create_task(sniff())]
    try:
        for _ in range(3):
            await asyncio.sleep(0)
        await bus.publish("anomalies.bus_link_margin", bus_anom)
        await bus.drain()
        await bus.publish("attributions.none", _attribution([bus_anom], verdict="internal_fault"))
        await bus.drain()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        bus.close()
    assert decisions[0].action == "recovery_recommendation"
    assert decisions[0].withheld_recovery is None


# ---- UI event and wire format ---------------------------------------------------------


def test_ui_event_message_names_the_withheld_recovery_and_keeps_the_decision_type() -> None:
    service = UIEventService(InProcessBus())
    attribution = _attribution([_bus_anomaly()], verdict="hostile_external")
    decision = Decision(
        attribution_id=attribution.id,
        action="threat_warning",
        target="brigade_commander",
        rationale="Precautionary threat warning on an unattributed anomaly cluster.",
        authority="local",
        withheld_recovery=WithheldRecovery(
            action_id="radio_reset", target_subsystem="comms", reason_code=UPLINK_JAMMING
        ),
    )
    event = service._build_ui_event(decision, attribution)
    assert event.type == "threat_updated"
    assert event.recommendation is None
    assert event.title == "Threat warning"
    assert "Recovery withheld: radio_reset on comms: active jamming detected." in event.message
    assert event.message.startswith(decision.rationale)
    assert "Attributed actor: Unknown" in event.message

    escort = decision.model_copy(
        update={
            "action": "active_defense_escort",
            "authority": "request",
            "request_packet": {"to": "CJFSCC"},
        }
    )
    event = service._build_ui_event(escort, attribution)
    assert event.type == "recommendation_created"
    assert "Recovery withheld: radio_reset on comms: active jamming detected." in event.message


@pytest.mark.parametrize(
    "code,label",
    [
        ("threat/uplink_jamming_active", "active jamming detected"),
        ("threat/hostile_close_approach", "hostile close approach in progress"),
        ("verdict/hostile_external", "verdict is hostile external"),
        ("verdict/unknown", "verdict is unknown"),
        ("policy/some_future_rule", "some future rule"),
    ],
)
def test_withheld_reason_labels(code: str, label: str) -> None:
    assert withheld_reason_label(code) == label


def test_withheld_block_survives_the_bus_envelope() -> None:
    decision = Decision(
        attribution_id="attr-1",
        action="threat_warning",
        target="brigade_commander",
        rationale="r",
        authority="local",
        withheld_recovery=WithheldRecovery(**WITHHELD_RAW),
    )
    envelope = codec.envelope("decisions.local", decision)
    assert envelope["kind"] == "decision"
    assert envelope["data"]["withheld_recovery"] == {**WITHHELD_RAW, "source": "internal-diagnosis"}
    assert envelope["data"]["recovery"] is None
    _, decoded = codec.decode(codec.encode("decisions.local", decision))
    assert isinstance(decoded, Decision)
    assert decoded.withheld_recovery == decision.withheld_recovery
