"""DecideService's gate plumbing (docs/INTERFACE-SPEC.md §7) and recovery routing (§6).

Runs DecideService on an in-process bus with scripted LLM clients. The rule
logic itself is covered in ``megalith/tests/test_gate_rules.py``; here the
concern is what the service does with a gate's answer: a block is republished
as a local threat_warning with the reason in the rationale and a warn trace,
an offensive action never reaches the bus, an authority mismatch is repaired,
and the recovery rule holds whatever the model returned. Cases that need the
real threat-context rules skip when the MEGALITH package is not installed
(CANOPY's own environment); they run from the repository root.
"""
from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from canopy.services.bus import InProcessBus
from canopy.services.decide import DecideService
from canopy.services.decide.tools import (
    REASON_AUTHORITY_MISMATCH,
    REASON_UNSELECTABLE_ACTION,
    GateContext,
    GateResult,
    ToolContext,
    policy_gate,
)
from canopy.services.kb import KB
from canopy.services.llm.stub import StubLLMClient
from canopy.services.schemas.events import (
    Anomaly,
    Attribution,
    Decision,
    ReasoningTrace,
    RecoveryBlock,
)
from canopy.services.traces import Tracer

SAT = "ctb://centralblue.dev/leo-science-1"
OTHER_SAT = "ctb://centralblue.dev/leo-science-2"
T0 = datetime(2026, 9, 17, 14, 30, tzinfo=UTC)
UPLINK_JAMMING = "threat/uplink_jamming_active"

RECOVERY = {
    "action_id": "switch_redundant_amplifier",
    "target_subsystem": "comms",
    "requires_approval": True,
    "rationale": "Primary amplifier output trending down; redundant unit nominal.",
}


def _anomaly(
    kind: str,
    sid: str,
    *,
    offset_s: float = 0.0,
    satellite_id: str | None = SAT,
    **payload: Any,
) -> Anomaly:
    data: dict[str, Any] = {"asset": "LEO-SCIENCE-1", **payload}
    if satellite_id:
        data["satellite_id"] = satellite_id
    return Anomaly(
        id=f"anom-{kind}-{sid}",
        ts=T0 + timedelta(seconds=offset_s),
        kind=kind,
        source_signal=sid,
        source_signal_ids=[sid],
        severity=0.81,
        payload=data,
    )


def _bus_anomaly(**overrides: Any) -> Anomaly:
    payload = {
        "subsystem": "comms",
        "symptom": "link_margin_db_drop",
        "physics_consistency": 0.83,
        "recommended_recovery": dict(RECOVERY),
    }
    payload.update(overrides)
    return _anomaly("bus_link_margin", "sig-bus-1", **payload)


def _attribution(anomalies: list[Anomaly], *, verdict: str | None = "internal_fault") -> Attribution:
    actor = "None" if verdict in ("internal_fault", "natural_external") else "Unknown"
    return Attribution(
        id="attr-1",
        anomaly_ids=[a.id for a in anomalies],
        actor=actor,
        confidence=0.83 if actor == "None" else 0.45,
        evidence=["ramp-shaped margin loss consistent with amplifier degradation"],
        kb_citations=["kb-attribution-uncertainty-001"],
        source_signal_ids=[a.source_signal for a in anomalies],
        verdict=verdict,
        verdict_basis="rule" if verdict else None,
        satellite_id=SAT,
    )


class ScriptedLLM:
    """An LLMClient whose decide() is a function of the attribution it is handed."""

    def __init__(self, script: Callable[[Attribution], Decision]) -> None:
        self._script = script
        self.seen: list[Attribution] = []

    async def decide(self, attribution: Attribution) -> Decision:
        self.seen.append(attribution)
        return self._script(attribution)


class RecordingGate:
    """Wraps a gate and records the contexts it was shown."""

    def __init__(self, inner: Callable[[Decision, GateContext], GateResult]) -> None:
        self._inner = inner
        self.calls: list[tuple[Decision, GateContext]] = []

    def __call__(self, decision: Decision, ctx: GateContext) -> GateResult:
        self.calls.append((decision, ctx))
        return self._inner(decision, ctx)


def _block_recoveries(decision: Decision, ctx: GateContext) -> GateResult:
    if decision.recovery is not None:
        return GateResult(False, UPLINK_JAMMING, "threat_warning", "scripted block")
    return policy_gate(decision, ctx)


async def _run(
    llm: Any,
    *,
    cached: list[Anomaly],
    attribution: Attribution,
    gate: Any = None,
    tools: list | None = None,
    lookback_s: float = 600.0,
) -> tuple[list[Decision], list[ReasoningTrace]]:
    bus = InProcessBus()
    tracer = Tracer(bus)
    tool_ctx = ToolContext(kb=KB(entries=[]), orbit=None, tracer=tracer) if tools is not None else None
    service = DecideService(
        bus, llm, tracer=tracer, gate=gate, tools=tools, tool_ctx=tool_ctx, lookback_s=lookback_s
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
        await bus.publish("attributions.none", attribution)
        await bus.drain()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        bus.close()
    return decisions, traces


def _warn_traces(traces: list[ReasoningTrace]) -> list[ReasoningTrace]:
    return [t for t in traces if t.stage == "decide" and t.level == "warn"]


# ---- Block → threat_warning + warn trace ----------------------------------------


async def test_blocked_decision_is_republished_as_threat_warning_with_warn_trace() -> None:
    bus_anom = _bus_anomaly()
    jam = _anomaly("rf_anomaly", "sig-rf-1", offset_s=-200)  # cached, not in the attribution
    attribution = _attribution([bus_anom])
    gate = RecordingGate(_block_recoveries)

    decisions, traces = await _run(
        StubLLMClient(KB(entries=[])), cached=[bus_anom, jam], attribution=attribution, gate=gate
    )

    assert len(decisions) == 1
    decision = decisions[0]
    assert decision.action == "threat_warning"
    assert decision.authority == "local"
    assert decision.recovery is None
    assert decision.request_packet is None
    assert decision.rationale.startswith(f"[gate:{UPLINK_JAMMING}] ")
    assert decision.attribution_id == attribution.id

    warns = _warn_traces(traces)
    assert warns[0].message == f"gate blocked recovery_recommendation: {UPLINK_JAMMING}"
    assert warns[0].ref_id == decision.id
    assert warns[0].payload["reason_code"] == UPLINK_JAMMING
    # Where the MEGALITH helper is installed the blocked recovery is also
    # reported as withheld (wave 4B); nothing else warns.
    assert [t.message for t in warns[1:]] in (
        [],
        [f"recovery withheld: switch_redundant_amplifier: {UPLINK_JAMMING}"],
    )

    # The gate saw the stub's recovery decision and the satellite's context:
    # the cluster plus the cached same-satellite anomaly inside the look-back.
    gated, ctx = gate.calls[0]
    assert gated.action == "recovery_recommendation"
    assert gated.recovery is not None and gated.recovery.action_id == "switch_redundant_amplifier"
    assert ctx.satellite_id == SAT
    assert ctx.verdict == "internal_fault"
    assert {a.id for a in ctx.anomalies} == {bus_anom.id, jam.id}


async def test_gate_context_honours_lookback_and_satellite() -> None:
    bus_anom = _bus_anomaly()
    stale = _anomaly("rf_anomaly", "sig-rf-old", offset_s=-7200)
    elsewhere = _anomaly("rf_anomaly", "sig-rf-other", offset_s=-60, satellite_id=OTHER_SAT)
    gate = RecordingGate(policy_gate)

    decisions, _ = await _run(
        StubLLMClient(KB(entries=[])),
        cached=[bus_anom, stale, elsewhere],
        attribution=_attribution([bus_anom]),
        gate=gate,
    )

    _, ctx = gate.calls[0]
    assert [a.id for a in ctx.anomalies] == [bus_anom.id]
    assert decisions[0].action == "recovery_recommendation"


async def test_real_gate_blocks_radio_recovery_under_active_jamming() -> None:
    gate_pkg = pytest.importorskip("megalith.gate")
    bus_anom = _bus_anomaly()
    jam = _anomaly("rf_anomaly", "sig-rf-1", offset_s=300)

    decisions, traces = await _run(
        StubLLMClient(KB(entries=[])),
        cached=[bus_anom, jam],
        attribution=_attribution([bus_anom]),
        gate=gate_pkg.threat_context_gate,
    )
    assert decisions[0].action == "threat_warning"
    assert decisions[0].rationale.startswith(f"[gate:{UPLINK_JAMMING}] ")
    assert _warn_traces(traces)[0].message == f"gate blocked recovery_recommendation: {UPLINK_JAMMING}"

    # Same recovery with the jamming outside the look-back: allowed.
    decisions, traces = await _run(
        StubLLMClient(KB(entries=[])),
        cached=[bus_anom, _anomaly("rf_anomaly", "sig-rf-old", offset_s=-7200)],
        attribution=_attribution([bus_anom]),
        gate=gate_pkg.threat_context_gate,
    )
    assert decisions[0].action == "recovery_recommendation"
    assert decisions[0].recovery is not None
    assert not _warn_traces(traces)


async def test_default_gate_is_threat_context_gate_when_megalith_is_installed() -> None:
    gate_pkg = pytest.importorskip("megalith.gate")
    service = DecideService(InProcessBus(), StubLLMClient(KB(entries=[])))
    assert service.gate is gate_pkg.threat_context_gate


# ---- R3: an offensive action from the model never reaches the bus --------------


async def test_offensive_action_from_model_is_blocked_by_r3() -> None:
    def strike(attribution: Attribution) -> Decision:
        return Decision(
            attribution_id=attribution.id,
            action="orbital_strike_request",
            target="inspector",
            rationale="model went off the menu",
            authority="request",
            request_packet={"to": "CJFSCC"},
        )

    bus_anom = _bus_anomaly(recommended_recovery=None)
    decisions, traces = await _run(
        ScriptedLLM(strike), cached=[bus_anom], attribution=_attribution([bus_anom], verdict="unknown")
    )

    assert [d.action for d in decisions] == ["threat_warning"]
    assert decisions[0].authority == "local"
    assert decisions[0].request_packet is None
    assert decisions[0].rationale.startswith(f"[gate:{REASON_UNSELECTABLE_ACTION}] ")
    assert _warn_traces(traces)[-1].message == (
        f"gate blocked orbital_strike_request: {REASON_UNSELECTABLE_ACTION}"
    )


# ---- R4: an authority mismatch is repaired, not discarded ----------------------


def _escort_local(attribution: Attribution) -> Decision:
    return Decision(
        attribution_id=attribution.id,
        action="active_defense_escort",
        target="LEO-SCIENCE-1",
        rationale="escort the asset",
        authority="local",
    )


async def test_authority_mismatch_is_repaired_by_the_gate_r4() -> None:
    # No routing.validate tool in the registry: the gate's R4 does the repair.
    bus_anom = _bus_anomaly(recommended_recovery=None)
    decisions, traces = await _run(
        ScriptedLLM(_escort_local), cached=[bus_anom], attribution=_attribution([bus_anom], verdict="unknown"), tools=[]
    )

    decision = decisions[0]
    assert decision.action == "active_defense_escort"
    assert decision.authority == "request"
    assert decision.request_packet is not None and decision.request_packet["to"] == "CJFSCC"
    assert "authority repaired to request" in decision.rationale
    assert not decision.rationale.startswith("[gate:")
    warns = _warn_traces(traces)
    assert warns and warns[-1].payload["reason_code"] == REASON_AUTHORITY_MISMATCH
    assert "gate repaired active_defense_escort" in warns[-1].message


async def test_routing_validate_result_is_acted_on_for_every_decision() -> None:
    # Default registry: routing.validate runs first and repairs; its tools
    # trace shows the disagreement instead of being discarded.
    bus_anom = _bus_anomaly(recommended_recovery=None)
    decisions, traces = await _run(
        ScriptedLLM(_escort_local), cached=[bus_anom], attribution=_attribution([bus_anom], verdict="unknown")
    )

    decision = decisions[0]
    assert decision.authority == "request"
    assert decision.request_packet is not None
    tool_traces = [t for t in traces if t.stage == "tools" and "routing.validate" in t.message]
    assert tool_traces and "valid=False" in tool_traces[0].message
    assert any("routing repaired active_defense_escort" in t.message for t in _warn_traces(traces))


async def test_request_authority_on_a_local_action_is_repaired_to_local() -> None:
    def warning_as_request(attribution: Attribution) -> Decision:
        return Decision(
            attribution_id=attribution.id,
            action="threat_warning",
            target="brigade-c2",
            rationale="precautionary",
            authority="request",
            request_packet={"to": "CJFSCC"},
        )

    bus_anom = _bus_anomaly(recommended_recovery=None)
    decisions, _ = await _run(
        ScriptedLLM(warning_as_request), cached=[bus_anom], attribution=_attribution([bus_anom], verdict="unknown")
    )
    assert decisions[0].authority == "local"
    assert decisions[0].request_packet is None


# ---- Recovery routing (§6) holds whatever the model returned -------------------


async def test_model_receives_the_recovery_block_and_the_rule_overrides_its_choice() -> None:
    def passive(attribution: Attribution) -> Decision:
        return Decision(
            attribution_id=attribution.id,
            action="passive_defense",
            target="LEO-SCIENCE-1",
            rationale="model ignored the recovery",
            authority="local",
        )

    llm = ScriptedLLM(passive)
    bus_anom = _bus_anomaly()
    decisions, traces = await _run(llm, cached=[bus_anom], attribution=_attribution([bus_anom]), gate=policy_gate)

    # The attribution handed to the model carried the block as context.
    handed = llm.seen[0]
    assert handed.model_extra["recommended_recovery"]["action_id"] == "switch_redundant_amplifier"
    assert handed.model_extra["recovery_target"] == "LEO-SCIENCE-1"
    assert handed.id == "attr-1"

    decision = decisions[0]
    assert decision.action == "recovery_recommendation"
    assert decision.authority == "local"
    assert decision.request_packet is None
    assert decision.target == "LEO-SCIENCE-1"
    assert decision.recovery == RecoveryBlock(**RECOVERY, satellite_id=SAT)
    assert any(t.message.startswith("recovery routed: switch_redundant_amplifier") for t in traces)


async def test_recovery_block_is_restored_when_the_client_drops_it() -> None:
    def recovery_without_block(attribution: Attribution) -> Decision:
        # What the live clients emit: action from the tool payload, no block.
        return Decision(
            attribution_id=attribution.id,
            action="recovery_recommendation",
            target="LEO-SCIENCE-1",
            rationale="switch to the redundant amplifier",
            authority="request",
            request_packet={"to": "CJFSCC"},
        )

    bus_anom = _bus_anomaly()
    decisions, _ = await _run(
        ScriptedLLM(recovery_without_block), cached=[bus_anom], attribution=_attribution([bus_anom]), gate=policy_gate
    )
    decision = decisions[0]
    assert decision.action == "recovery_recommendation"
    assert decision.recovery == RecoveryBlock(**RECOVERY, satellite_id=SAT)
    assert decision.authority == "local"
    assert decision.request_packet is None


async def test_recovery_without_any_block_is_downgraded() -> None:
    def invented(attribution: Attribution) -> Decision:
        return Decision(
            attribution_id=attribution.id,
            action="recovery_recommendation",
            target="LEO-SCIENCE-1",
            rationale="model invented a recovery",
            authority="local",
        )

    bus_anom = _bus_anomaly(recommended_recovery=None)
    decisions, traces = await _run(
        ScriptedLLM(invented), cached=[bus_anom], attribution=_attribution([bus_anom]), gate=policy_gate
    )
    assert decisions[0].action == "threat_warning"
    assert decisions[0].recovery is None
    assert "downgraded to threat_warning" in decisions[0].rationale
    assert any(t.message.startswith("recovery downgraded") for t in _warn_traces(traces))


async def test_hostile_verdict_never_routes_to_recovery_even_with_a_block() -> None:
    bus_anom = _bus_anomaly()
    decisions, _ = await _run(
        StubLLMClient(KB(entries=[])),
        cached=[bus_anom],
        attribution=_attribution([bus_anom], verdict="hostile_external"),
        gate=policy_gate,
    )
    assert decisions[0].action != "recovery_recommendation"
    assert decisions[0].recovery is None


# ---- Withheld recovery rides along with the gate (§6, wave 4B) ------------------


async def test_real_gate_block_is_also_reported_as_withheld_with_the_same_reason() -> None:
    gate_pkg = pytest.importorskip("megalith.gate")
    bus_anom = _bus_anomaly()
    jam = _anomaly("rf_anomaly", "sig-rf-1", offset_s=300)

    decisions, traces = await _run(
        StubLLMClient(KB(entries=[])),
        cached=[bus_anom, jam],
        attribution=_attribution([bus_anom]),
        gate=gate_pkg.threat_context_gate,
    )
    decision = decisions[0]
    assert decision.action == "threat_warning"
    assert decision.recovery is None
    assert decision.withheld_recovery is not None
    assert decision.withheld_recovery.action_id == "switch_redundant_amplifier"
    assert decision.withheld_recovery.target_subsystem == "comms"
    assert decision.withheld_recovery.reason_code == UPLINK_JAMMING
    assert [t.message for t in _warn_traces(traces)] == [
        f"gate blocked recovery_recommendation: {UPLINK_JAMMING}",
        f"recovery withheld: switch_redundant_amplifier: {UPLINK_JAMMING}",
    ]


async def test_scripted_gate_block_under_an_internal_verdict_has_no_verdict_reason() -> None:
    # CANOPY on its own reports verdict reasons only; a gate block under an
    # internal verdict therefore carries the gate's rationale prefix and trace
    # but no withheld block. With the MEGALITH helper the threat rule names it.
    bus_anom = _bus_anomaly()
    jam = _anomaly("rf_anomaly", "sig-rf-1", offset_s=300)
    decisions, traces = await _run(
        StubLLMClient(KB(entries=[])),
        cached=[bus_anom, jam],
        attribution=_attribution([bus_anom]),
        gate=RecordingGate(_block_recoveries),
    )
    decision = decisions[0]
    assert decision.action == "threat_warning"
    assert decision.rationale.startswith(f"[gate:{UPLINK_JAMMING}] ")
    try:
        import megalith.gate  # noqa: F401
    except ImportError:
        assert decision.withheld_recovery is None
        assert [t.message for t in _warn_traces(traces)] == [
            f"gate blocked recovery_recommendation: {UPLINK_JAMMING}"
        ]
    else:
        assert decision.withheld_recovery is not None
        assert decision.withheld_recovery.reason_code == UPLINK_JAMMING


async def test_hostile_verdict_with_a_block_is_withheld_not_gated() -> None:
    bus_anom = _bus_anomaly()
    gate = RecordingGate(policy_gate)
    decisions, traces = await _run(
        StubLLMClient(KB(entries=[])),
        cached=[bus_anom],
        attribution=_attribution([bus_anom], verdict="hostile_external"),
        gate=gate,
    )
    decision = decisions[0]
    assert decision.action != "recovery_recommendation"
    assert decision.recovery is None
    assert not decision.rationale.startswith("[gate:")
    assert decision.withheld_recovery is not None
    assert decision.withheld_recovery.reason_code == "verdict/hostile_external"
    # The gate saw the decision before the annotation was added.
    gated, _ = gate.calls[0]
    assert gated.withheld_recovery is None
    assert [t.message for t in _warn_traces(traces)] == [
        "recovery withheld: switch_redundant_amplifier: verdict/hostile_external"
    ]
