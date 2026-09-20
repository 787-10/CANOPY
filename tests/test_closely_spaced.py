"""Closely-spaced objects (MEGALITH pre-submission C10, docs/INTERFACE-SPEC.md §5.4).

A cue that names no ``satellite_id`` but a ``candidate_satellite_ids`` set is
keyed by fusion to a bus signal on any candidate, stays on the attrib stage's
legacy path, and its attribution carries the candidate set. Which candidate
it counts for is the rule lane's decision, so the end-to-end checks on the
three held-out arms (hostile on the symptomatic object, unknown naming both,
natural on both) need the MEGALITH package and skip in CANOPY's own
environment; run them with ``uv run --project /Users/jeewoo/MEGALITH``.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from bench.runner import run_trial
from bench.scoring import (
    select_final_attribution,
    select_final_decision,
    select_provisional_attribution,
)
from bench.specs import load_scenario_registry
from canopy.services.attrib import AttribService
from canopy.services.bus import InProcessBus
from canopy.services.fusion import FusionService
from canopy.services.kb import KB
from canopy.services.llm.stub import StubLLMClient
from canopy.services.schemas.events import (
    Anomaly,
    Attribution,
    Location,
    Payload,
    Provenance,
    Signal,
)

ROOT = Path(__file__).resolve().parent.parent
KB_FILE = ROOT / "data" / "kb_seed_entries.json"
SAT1 = "ctb://centralblue.dev/leo-science-1"
SAT2 = "ctb://centralblue.dev/leo-science-2"
T0 = datetime(2026, 9, 17, 14, 30, tzinfo=UTC)
LEGACY_FAMILIES = {
    "link_margin",
    "sensor_saturation",
    "attitude_disturbance",
    "unexpected_reset",
    "power_thermal",
    "orbit_decay",
}


def _signal(
    *,
    domain: str,
    event_type: str,
    ts: datetime,
    satellite_id: str | None = None,
    candidates: list[str] | None = None,
    observables: dict | None = None,
    confidence: float = 0.8,
) -> Signal:
    return Signal(
        ts=ts,
        domain=domain,
        source="test",
        realism="mock_operational",
        confidence=confidence,
        location=Location(label="t"),
        payload=Payload(
            event_type=event_type,
            summary="test",
            satellite_id=satellite_id,
            candidate_satellite_ids=candidates,
            observables=observables or {},
        ),
        provenance=Provenance(source_id="t"),
    )


def _bus(satellite_id: str, ts: datetime, pc: float = 0.2) -> Signal:
    return _signal(
        domain="bus_health",
        event_type="link_margin_drop",
        ts=ts,
        satellite_id=satellite_id,
        observables={"physics_consistency": pc, "onset_ts": ts.isoformat(), "subsystem": "comms"},
    )


def _cue(ts: datetime, candidates: list[str] | None = None) -> Signal:
    return _signal(
        domain="rf_ew",
        event_type="rf_interference",
        ts=ts,
        candidates=[SAT1, SAT2] if candidates is None else candidates,
    )


async def _collect(bus: InProcessBus, pattern: str, kind: type, n: int, timeout: float = 2.0) -> list:
    out: list = []

    async def sub() -> None:
        async for _, event in bus.subscribe(pattern):
            if isinstance(event, kind):
                out.append(event)
                if len(out) >= n:
                    return

    try:
        await asyncio.wait_for(sub(), timeout)
    except TimeoutError:
        pass
    return out


# ---- Schema ------------------------------------------------------------------------


def test_candidate_fields_default_to_none_and_never_serialise_for_existing_data() -> None:
    payload = Payload(event_type="x", summary="y")
    assert payload.candidate_satellite_ids is None
    assert "candidate_satellite_ids" not in payload.model_dump(exclude_none=True)
    attribution = Attribution(anomaly_ids=[], actor="None", confidence=0.5)
    assert attribution.candidate_satellite_ids is None
    assert "candidate_satellite_ids" not in attribution.model_dump(exclude_none=True)
    keyed = Payload(event_type="x", summary="y", candidate_satellite_ids=[SAT1, SAT2])
    assert keyed.candidate_satellite_ids == [SAT1, SAT2]


# ---- Fusion ------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("cue_first", [True, False])
async def test_fusion_keys_a_candidate_cue_to_a_bus_signal_on_any_candidate(cue_first: bool) -> None:
    bus = InProcessBus()
    fusion = FusionService(bus)
    task = asyncio.create_task(fusion.run())
    collector = asyncio.create_task(_collect(bus, "anomalies.*", Anomaly, 2))
    await asyncio.sleep(0)
    cue = _cue(T0 - timedelta(seconds=120))
    symptom = _bus(SAT2, T0)
    for signal in ([cue, symptom] if cue_first else [symptom, cue]):
        await bus.publish(f"signals.{signal.domain}", signal)
    anomalies = await collector
    task.cancel()
    by_kind = {a.kind: a for a in anomalies}
    assert set(by_kind) == {"rf_anomaly", "bus_link_margin"}
    rf, link = by_kind["rf_anomaly"], by_kind["bus_link_margin"]
    # The candidate set rides on the cue's anomaly; the cue never gains a satellite.
    assert rf.payload["candidate_satellite_ids"] == [SAT1, SAT2]
    assert "satellite_id" not in rf.payload
    # Keyed both ways: the later arrival lists the earlier one and is boosted.
    later = link if cue_first else rf
    earlier = cue if cue_first else symptom
    assert earlier.id in later.source_signal_ids
    assert later.payload["correlated_events"][0]["id"] == earlier.id
    assert later.severity == pytest.approx(min(1.0, later.payload["confidence"] + 0.15), abs=1e-6)


@pytest.mark.asyncio
async def test_fusion_ignores_a_candidate_cue_naming_other_objects() -> None:
    bus = InProcessBus()
    fusion = FusionService(bus)
    task = asyncio.create_task(fusion.run())
    collector = asyncio.create_task(_collect(bus, "anomalies.*", Anomaly, 2))
    await asyncio.sleep(0)
    await bus.publish("signals.rf_ew", _cue(T0 - timedelta(seconds=60), ["ctb://centralblue.dev/other-a"]))
    await bus.publish("signals.bus_health", _bus(SAT1, T0))
    anomalies = await collector
    task.cancel()
    link = next(a for a in anomalies if a.kind == "bus_link_margin")
    assert link.source_signal_ids == [link.source_signal]
    assert "correlated_events" not in link.payload


# ---- Attribution -----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_recent_context_returns_the_other_candidates_bus_anomalies() -> None:
    bus = InProcessBus()
    attrib = AttribService(bus, StubLLMClient(KB.load_from_json(KB_FILE)), KB.load_from_json(KB_FILE))
    cue = Anomaly(
        ts=T0 - timedelta(seconds=60),
        kind="rf_anomaly",
        source_signal="s-rf",
        severity=0.8,
        payload={"candidate_satellite_ids": [SAT1, SAT2]},
    )
    other_bus = Anomaly(
        ts=T0, kind="bus_link_margin", source_signal="s-b2", severity=0.8,
        payload={"satellite_id": SAT2, "physics_consistency": 0.2},
    )
    other_rf = Anomaly(
        ts=T0, kind="rf_anomaly", source_signal="s-rf2", severity=0.8, payload={"satellite_id": SAT2}
    )
    unrelated = Anomaly(
        ts=T0, kind="bus_link_margin", source_signal="s-b3", severity=0.8,
        payload={"satellite_id": "ctb://centralblue.dev/third", "physics_consistency": 0.2},
    )
    for anomaly in (cue, other_bus, other_rf, unrelated):
        attrib._remember(anomaly)
    context = attrib.recent_context(SAT1)
    ids = [a.id for a in context]
    # The identity-less cue, then SAT2's bus anomaly (not its RF cue, not a third satellite's bus).
    assert cue.id in ids and other_bus.id in ids
    assert other_rf.id not in ids and unrelated.id not in ids
    # An identity-less batch sees every candidate's bus anomalies.
    assert other_bus.id in [a.id for a in attrib.recent_context(None)]
    # Without a candidate cue nothing new is returned.
    attrib._recent.clear()
    attrib._remember(other_bus)
    assert attrib.recent_context(SAT1) == []


@pytest.mark.asyncio
async def test_unresolved_batch_attribution_carries_the_candidate_set_with_the_lane_off() -> None:
    """Even without the rule lane the attribution says which objects the cue could belong to."""
    bus = InProcessBus()
    kb = KB.load_from_json(KB_FILE)
    attrib = AttribService(bus, StubLLMClient(kb), kb, window_s=0, rule_verdict=None)
    collector = asyncio.create_task(_collect(bus, "attributions.*", Attribution, 1))
    await asyncio.sleep(0)
    cue = Anomaly(
        ts=T0, kind="rf_anomaly", source_signal="s-rf", severity=0.8,
        payload={"candidate_satellite_ids": [SAT2, SAT1, SAT1]},
    )
    await attrib._process([cue])
    (attribution,) = await collector
    assert attribution.satellite_id is None
    assert attribution.candidate_satellite_ids == [SAT1, SAT2]
    # A keyed batch never carries the field.
    collector = asyncio.create_task(_collect(bus, "attributions.*", Attribution, 1))
    await asyncio.sleep(0)
    keyed = Anomaly(
        ts=T0, kind="bus_link_margin", source_signal="s-b", severity=0.8,
        payload={"satellite_id": SAT1, "physics_consistency": 0.2},
    )
    await attrib._process([keyed])
    (attribution,) = await collector
    assert attribution.satellite_id == SAT1 and attribution.candidate_satellite_ids is None


# ---- End to end on the held-out row (needs the MEGALITH rule lane) -----------------------


def _case(case_id: str):
    return next(c for c in load_scenario_registry().cases if c.id == case_id)


def _run(case_id: str):
    return asyncio.run(run_trial(_case(case_id), provider="stub"))


@pytest.fixture(scope="module")
def closely_spaced_trials() -> dict[str, object]:
    pytest.importorskip("megalith.verdict")
    return {arm: _run(f"heldout-closely-spaced-{arm}") for arm in ("hostile", "unknown", "natural")}


def test_hostile_arm_resolves_the_cue_to_the_symptomatic_object(closely_spaced_trials) -> None:
    artifact = closely_spaced_trials["hostile"]
    final = select_final_attribution(artifact.attributions, artifact.anomalies)
    provisional = select_provisional_attribution(artifact.attributions, final)
    assert final.verdict == "hostile_external" and final.satellite_id == SAT1
    assert final.candidate_satellite_ids is None
    assert provisional is not None and provisional.verdict == "hostile_external"
    assert any(
        "candidate cue:" in line and f"counts for {SAT1}: unique symptomatic candidate" in line
        for line in final.evidence
    )
    # The cue's own batch stays unresolved and names both objects.
    unresolved = [a for a in artifact.attributions if a.satellite_id is None]
    assert [a.candidate_satellite_ids for a in unresolved] == [[SAT1, SAT2]]
    assert unresolved[0].verdict == "unknown" and unresolved[0].confidence <= 0.49
    # LEO-SCIENCE-2 was nominal only: no anomaly, no cluster.
    assert not any(a.satellite_id == SAT2 for a in artifact.attributions)
    decision = select_final_decision(artifact.decisions, final)
    assert decision.action in {"passive_defense", "threat_warning"}


def test_unknown_arm_abstains_naming_both_candidates(closely_spaced_trials) -> None:
    artifact = closely_spaced_trials["unknown"]
    assert [a.kind for a in artifact.anomalies] == ["rf_anomaly"]
    final = select_final_attribution(artifact.attributions, artifact.anomalies)
    assert final.verdict == "unknown" and final.confidence <= 0.49
    assert final.actor == "Unknown"
    assert final.satellite_id is None
    assert final.candidate_satellite_ids == [SAT1, SAT2]
    assert any("candidate cue unresolved among" in line for line in final.evidence)
    assert select_provisional_attribution(artifact.attributions, final) is None
    decision = select_final_decision(artifact.decisions, final)
    assert decision.action != "recovery_recommendation"
    assert decision.action not in {
        "active_defense_counterattack",
        "orbital_strike_request",
        "terrestrial_strike_request",
    }


def test_natural_arm_lets_the_storm_explain_both_objects(closely_spaced_trials) -> None:
    artifact = closely_spaced_trials["natural"]
    final = select_final_attribution(artifact.attributions, artifact.anomalies)
    assert final.verdict == "natural_external" and final.satellite_id == SAT1
    finals = {
        a.satellite_id: a
        for a in artifact.attributions
        if a.satellite_id is not None and not a.provisional
    }
    assert set(finals) == {SAT1, SAT2}
    assert all(a.verdict == "natural_external" for a in finals.values())
    assert any("counts for neither: two or more candidates symptomatic" in line for line in final.evidence)
    decision = select_final_decision(artifact.decisions, final)
    assert decision.action == "recovery_recommendation"


def test_legacy_cases_are_unchanged_by_the_candidate_rule() -> None:
    """The eighteen single-object cases carry no candidate field and take the old path."""
    pytest.importorskip("megalith.verdict")
    registry = load_scenario_registry()
    cases = [c for c in registry.heldout_cases() if c.family in LEGACY_FAMILIES]
    assert len(cases) == 18
    for case in cases:
        artifact = asyncio.run(run_trial(case, provider="stub"))
        final = select_final_attribution(artifact.attributions, artifact.anomalies)
        assert final.verdict == case.expected.verdict, case.id
        assert final.candidate_satellite_ids is None, case.id
        assert not any("candidate cue" in line for line in final.evidence), case.id
        assert all(
            "candidate_satellite_ids" not in a.payload for a in artifact.anomalies
        ), case.id
