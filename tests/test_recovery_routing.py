"""Recovery routing end to end (docs/INTERFACE-SPEC.md §6).

A ``bus_health`` signal carrying ``recommended_recovery`` goes through the real
engine with the stub LLM; an Attribution with verdict internal_fault is
published for its anomaly (the attrib stage's verdict is another wave's
work, so the test publishes its own); the decision that comes out is a
``recovery_recommendation`` carrying the RecoveryBlock, and the UI event names
it. The unit tests below pin the stub, the prompt, the validator and the UI
builder individually.
"""
from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from canopy._engine import build_engine, start_engine_tasks
from canopy.services.bus import InProcessBus
from canopy.services.decide.prompts import (
    DECISION_TOOL,
    decision_user_prompt,
    recovery_context,
    with_recovery_context,
)
from canopy.services.kb import KB
from canopy.services.llm.stub import StubLLMClient, _select_decision
from canopy.services.llm.validation import validate_and_repair_decision
from canopy.services.schemas.events import (
    Anomaly,
    Attribution,
    Decision,
    ReasoningTrace,
    RecoveryBlock,
    Signal,
    UIEvent,
)
from canopy.services.ui_events import UIEventService

ROOT = Path(__file__).resolve().parent.parent
KB_FILE = ROOT / "data" / "kb_seed_entries.json"
SAT = "ctb://centralblue.dev/leo-science-1"
T0 = datetime(2026, 9, 17, 14, 30, tzinfo=UTC)
RECOVERY = {
    "action_id": "switch_redundant_amplifier",
    "target_subsystem": "comms",
    "requires_approval": True,
    "rationale": "Primary amplifier output trending down; redundant unit nominal.",
}


def _bus_signal(*, requires_approval: bool = True) -> Signal:
    onset = T0 + timedelta(seconds=120)
    return Signal.model_validate(
        {
            "id": "sig-bus-1",
            "ts": (onset + timedelta(seconds=2)).isoformat(),
            "domain": "bus_health",
            "source": "internal-diagnosis",
            "realism": "mock_operational",
            "confidence": 0.81,
            "location": {"label": "LEO-SCIENCE-1"},
            "payload": {
                "event_type": "link_margin_drop",
                "summary": "LEO-SCIENCE-1 downlink margin falling 0.42 dB/s since 14:32:00Z.",
                "asset": "LEO-SCIENCE-1",
                "satellite_id": SAT,
                "observables": {
                    "subsystem": "comms",
                    "symptom": "link_margin_db_drop",
                    "onset_ts": onset.isoformat(),
                    "onset_clock_domain": "utc",
                    "rate_of_change": -0.42,
                    "rate_unit": "dB/s",
                    "physics_consistency": 0.83,
                    "physics_basis": "belief:pa_degradation=0.79;shape=ramp",
                    "shape": "ramp",
                    "recommended_recovery": {**RECOVERY, "requires_approval": requires_approval},
                },
            },
            "provenance": {
                "source_id": "internal-diagnosis",
                "collector": "megalith-bus-health-adapter",
                "method": "rule_fdir+belief",
            },
        }
    )


def _rf_signal(ts: datetime) -> Signal:
    return Signal.model_validate(
        {
            "id": "sig-rf-1",
            "ts": ts.isoformat(),
            "domain": "rf_ew",
            "source": "ew-sensor-3",
            "realism": "mock_operational",
            "confidence": 0.7,
            "location": {"lat": 34.4, "lng": 36.3, "label": "Ridge 4"},
            "payload": {
                "event_type": "rf_interference",
                "summary": "Directional interference overlapping the LEO-SCIENCE-1 downlink.",
                "asset": "LEO-SCIENCE-1",
                "satellite_id": SAT,
                "observables": {"band": "X", "bearing_deg": 212},
            },
            "provenance": {"source_id": "mock-ew-sensor", "method": "operator_seeded_demo"},
        }
    )


async def _run(signals: list[Signal], *, verdict: str = "internal_fault") -> dict[str, list]:
    engine = build_engine(
        provider="stub", kb_path=KB_FILE, attrib_window_s=0.2, enable_osint=False
    )
    collected: dict[str, list] = {
        "anomaly": [], "attribution": [], "decision": [], "ui_event": [], "trace": []
    }

    async def consume(pattern: str, key: str, kind: type) -> None:
        async for _, event in engine.bus.subscribe(pattern):
            if isinstance(event, kind):
                collected[key].append(event)

    capture = [
        asyncio.create_task(consume("anomalies.*", "anomaly", Anomaly)),
        asyncio.create_task(consume("attributions.*", "attribution", Attribution)),
        asyncio.create_task(consume("decisions.*", "decision", Decision)),
        asyncio.create_task(consume("ui_events.*", "ui_event", UIEvent)),
        asyncio.create_task(consume("traces.*", "trace", ReasoningTrace)),
    ]
    services = start_engine_tasks(engine)
    try:
        for _ in range(3):
            await asyncio.sleep(0)
        for signal in signals:
            await engine.bus.publish(f"signals.{signal.domain}", signal)
        await engine.bus.drain()
        await engine.attrib.flush()
        await engine.bus.drain()

        # Our own attribution for the cluster, with the verdict set.
        anomalies = collected["anomaly"]
        attribution = Attribution(
            id="attr-recovery-1",
            anomaly_ids=[a.id for a in anomalies],
            actor="None",
            confidence=0.83,
            evidence=["ramp-shaped margin loss consistent with amplifier degradation"],
            kb_citations=["kb-attribution-uncertainty-001"],
            source_signal_ids=[s.id for s in signals],
            verdict=verdict,
            verdict_basis="rule",
            physics_consistency=0.83,
            satellite_id=SAT,
        )
        await engine.bus.publish("attributions.none", attribution)
        await engine.bus.drain()
        collected["ours"] = [attribution]
    finally:
        for task in services + capture:
            task.cancel()
        await asyncio.gather(*services, *capture, return_exceptions=True)
        engine.bus.close()
    return collected


def _our_decision(collected: dict[str, list]) -> Decision:
    ours = [d for d in collected["decision"] if d.attribution_id == "attr-recovery-1"]
    assert len(ours) == 1, [(d.attribution_id, d.action) for d in collected["decision"]]
    return ours[0]


# ---- End to end ---------------------------------------------------------------------


async def test_bus_health_recovery_becomes_a_recovery_recommendation_with_ui_event() -> None:
    collected = await _run([_bus_signal()])

    bus_anom = next(a for a in collected["anomaly"] if a.kind == "bus_link_margin")
    assert bus_anom.payload["recommended_recovery"]["action_id"] == "switch_redundant_amplifier"

    decision = _our_decision(collected)
    assert decision.action == "recovery_recommendation"
    assert decision.authority == "local"
    assert decision.request_packet is None
    assert decision.target == "LEO-SCIENCE-1"
    assert decision.recovery == RecoveryBlock(**RECOVERY, satellite_id=SAT)
    assert decision.recovery.source == "internal-diagnosis"
    assert "switch_redundant_amplifier" in decision.rationale
    assert "CJFSCC" not in decision.rationale
    assert decision.source_signal_ids == ["sig-bus-1"]

    ui = next(e for e in collected["ui_event"] if e.id == f"uievt-{decision.id}")
    assert ui.title == "Recovery recommendation"
    assert ui.type == "recommendation_created"  # requires_approval → approve control
    assert ui.severity == "medium"
    assert ui.recommendation is not None and ui.recommendation.id == f"rec-{decision.id}"
    assert "switch_redundant_amplifier" in ui.message
    assert "comms" in ui.message
    assert "requires operator approval" in ui.message
    assert "Verdict: internal fault" in ui.message
    assert "Attributed actor: None" not in ui.message
    assert ui.confidence == 0.83

    # Published, not blocked: no warn trace from the decide stage.
    assert not [t for t in collected["trace"] if t.stage == "decide" and t.level == "warn"]


async def test_recovery_not_needing_approval_is_a_threat_update() -> None:
    collected = await _run([_bus_signal(requires_approval=False)])
    decision = _our_decision(collected)
    assert decision.action == "recovery_recommendation"
    ui = next(e for e in collected["ui_event"] if e.id == f"uievt-{decision.id}")
    assert ui.type == "threat_updated"
    assert ui.recommendation is None
    assert "no approval required" in ui.message


async def test_natural_external_verdict_also_routes_to_recovery() -> None:
    collected = await _run([_bus_signal()], verdict="natural_external")
    decision = _our_decision(collected)
    assert decision.action == "recovery_recommendation"
    assert "natural external cause" in decision.rationale


async def test_recovery_under_active_jamming_is_gated_end_to_end() -> None:
    pytest.importorskip("megalith.gate")
    bus = _bus_signal()
    collected = await _run([bus, _rf_signal(bus.ts + timedelta(seconds=400))])

    kinds = {a.kind for a in collected["anomaly"]}
    assert {"bus_link_margin", "rf_anomaly"} <= kinds
    decision = _our_decision(collected)
    assert decision.action == "threat_warning"
    assert decision.authority == "local"
    assert decision.recovery is None
    assert decision.rationale.startswith("[gate:threat/uplink_jamming_active] ")
    warns = [t for t in collected["trace"] if t.stage == "decide" and t.level == "warn"]
    assert any(
        t.message == "gate blocked recovery_recommendation: threat/uplink_jamming_active" for t in warns
    )


# ---- Stub -------------------------------------------------------------------------------


def _anomaly(kind: str, **payload) -> Anomaly:
    return Anomaly(
        id=f"anom-{kind}", kind=kind, source_signal=f"sig-{kind}", source_signal_ids=[f"sig-{kind}"],
        severity=0.8, payload={"satellite_id": SAT, "asset": "LEO-SCIENCE-1", **payload},
    )


def _attribution(verdict: str | None) -> Attribution:
    return Attribution(
        anomaly_ids=["anom-bus_link_margin"], actor="None" if verdict else "Unknown", confidence=0.83,
        kb_citations=["kb-attribution-uncertainty-001"], verdict=verdict, satellite_id=SAT,
    )


BUS_WITH_RECOVERY = _anomaly("bus_link_margin", subsystem="comms", recommended_recovery=dict(RECOVERY))


def test_stub_selects_recovery_from_the_cluster_anomalies() -> None:
    template = _select_decision(_attribution("internal_fault"), [BUS_WITH_RECOVERY])
    assert template.action == "recovery_recommendation"
    assert template.authority == "local"
    assert template.target == "LEO-SCIENCE-1"
    assert template.recovery == RecoveryBlock(**RECOVERY, satellite_id=SAT)


def test_stub_selects_recovery_from_attached_context_without_anomalies() -> None:
    context = recovery_context(_attribution("internal_fault"), [BUS_WITH_RECOVERY])
    assert context is not None
    handed = with_recovery_context(_attribution("internal_fault"), context)
    template = _select_decision(handed)
    assert template.action == "recovery_recommendation"
    assert template.recovery == context.block


@pytest.mark.parametrize("verdict", [None, "unknown", "hostile_external"])
def test_stub_does_not_route_recovery_for_other_verdicts(verdict: str | None) -> None:
    template = _select_decision(_attribution(verdict), [BUS_WITH_RECOVERY])
    assert template.action != "recovery_recommendation"
    assert template.recovery is None


def test_stub_without_a_block_stays_passive() -> None:
    bare = _anomaly("bus_link_margin", subsystem="comms", recommended_recovery=None)
    template = _select_decision(_attribution("internal_fault"), [bare])
    assert template.action in ("passive_defense", "threat_warning")


async def test_stub_decide_emits_a_valid_recovery_decision() -> None:
    llm = StubLLMClient(KB.load_from_json(KB_FILE))
    decision = await llm.decide(_attribution("internal_fault"), [BUS_WITH_RECOVERY])
    assert decision.action == "recovery_recommendation"
    assert decision.recovery is not None and decision.recovery.requires_approval is True
    assert decision.request_packet is None


# ---- Live prompt ------------------------------------------------------------------------


def test_submit_decision_schema_has_an_optional_recovery_object() -> None:
    props = DECISION_TOOL["input_schema"]["properties"]
    assert "recovery" not in DECISION_TOOL["input_schema"]["required"]
    recovery = props["recovery"]
    assert recovery["type"] == ["object", "null"]
    assert set(recovery["properties"]) == set(RecoveryBlock.model_fields)
    assert set(recovery["required"]) == {"action_id", "target_subsystem", "requires_approval", "rationale"}
    assert recovery["properties"]["source"]["enum"] == ["internal-diagnosis"]


def test_user_prompt_includes_the_recovery_block_when_present() -> None:
    attribution = _attribution("internal_fault")
    context = recovery_context(attribution, [BUS_WITH_RECOVERY])
    assert context is not None
    prompt = decision_user_prompt(with_recovery_context(attribution, context))
    assert "## Recovery recommendation (internal diagnosis)" in prompt
    assert '"action_id": "switch_redundant_amplifier"' in prompt
    assert "target='LEO-SCIENCE-1'" in prompt
    # The block is rendered once, in its own section, not inside the attribution dump.
    assert prompt.count("switch_redundant_amplifier") == 1
    assert "## Recovery recommendation" not in decision_user_prompt(attribution)


# ---- Validator invariants (§6) ------------------------------------------------------------


def _raw(action: str, **overrides) -> dict:
    base = {"action": action, "target": "LEO-SCIENCE-1", "rationale": "r", "authority": "local", "request_packet": None}
    base.update(overrides)
    return base


def test_validator_recovery_decision_is_local_with_no_packet() -> None:
    repaired = validate_and_repair_decision(
        _raw("recovery_recommendation", authority="request", request_packet={"to": "CJFSCC"}, recovery=dict(RECOVERY))
    )
    assert repaired["authority"] == "local"
    assert repaired["request_packet"] is None
    assert repaired["recovery"]["source"] == "internal-diagnosis"
    assert repaired["recovery"]["satellite_id"] is None
    assert "[validator:" in repaired["rationale"]
    RecoveryBlock.model_validate(repaired["recovery"])


def test_validator_downgrades_recovery_without_a_block() -> None:
    for recovery in (None, {}, {"action_id": "x"}, {"action_id": " ", "target_subsystem": "comms", "requires_approval": True, "rationale": "r"}):
        repaired = validate_and_repair_decision(_raw("recovery_recommendation", recovery=recovery))
        assert repaired["action"] == "threat_warning", recovery
        assert repaired["recovery"] is None
        assert repaired["authority"] == "local"
        assert "downgraded to threat_warning" in repaired["rationale"]


def test_validator_clears_a_stray_block_on_other_actions() -> None:
    repaired = validate_and_repair_decision(_raw("passive_defense", recovery=dict(RECOVERY)))
    assert repaired["action"] == "passive_defense"
    assert repaired["recovery"] is None
    assert "cleared" in repaired["rationale"]


def test_validator_leaves_a_well_formed_decision_alone() -> None:
    raw = _raw("recovery_recommendation", recovery={**RECOVERY, "satellite_id": SAT})
    repaired = validate_and_repair_decision(raw)
    assert repaired["rationale"] == "r"
    assert "_validation_notes" not in repaired
    raw = _raw("threat_warning")
    assert validate_and_repair_decision(raw) == raw


# ---- UI builder ----------------------------------------------------------------------------


def test_ui_event_for_recovery_names_the_action_and_approval() -> None:
    service = UIEventService(InProcessBus())
    attribution = _attribution("internal_fault")
    decision = Decision(
        attribution_id=attribution.id, action="recovery_recommendation", target="LEO-SCIENCE-1",
        rationale="Switch to the redundant amplifier.", authority="local",
        recovery=RecoveryBlock(**RECOVERY, satellite_id=SAT),
    )
    event = service._build_ui_event(decision, attribution)
    assert event.type == "recommendation_created"
    assert event.severity == "medium"
    assert event.recommendation is not None
    assert "switch_redundant_amplifier" in event.recommendation.summary
    assert "switch_redundant_amplifier on the comms subsystem (requires operator approval)" in event.message
    assert json.loads(event.model_dump_json())["recommendation"]["approveLabel"] == "APPROVE"

    no_approval = decision.model_copy(
        update={"recovery": decision.recovery.model_copy(update={"requires_approval": False})}
    )
    event = service._build_ui_event(no_approval, attribution)
    assert event.type == "threat_updated"
    assert event.recommendation is None
    assert "no approval required" in event.message
