"""Verdict, gate, recovery and per-stage latency scoring (MEGALITH wave 3D).

Hand-built ``TrialArtifact``s go through ``score_trial`` so the extraction
from anomalies, attributions, decisions and traces is tested with the
metrics, not only the arithmetic.
"""
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest

from bench.artifacts import write_run_bundle
from bench.run import score_trial
from bench.runner import TrialArtifact
from bench.scoring import (
    VERDICT_CLASSES,
    ScenarioResult,
    Scorecard,
    gate_block_messages,
    latest_physics_consistency,
    select_final_attribution,
    select_final_decision,
    stage_timings_from_traces,
)
from canopy.services.schemas.events import (
    Anomaly,
    Attribution,
    Decision,
    ReasoningTrace,
    RecoveryBlock,
)

SAT = "ctb://centralblue.dev/leo-science-1"
T0 = datetime(2026, 9, 17, 14, 0, tzinfo=UTC)


def _anomaly(kind: str, offset_s: float, **payload) -> Anomaly:
    return Anomaly(
        kind=kind,
        source_signal=f"sig-{kind}-{offset_s:.0f}",
        severity=0.7,
        ts=T0 + timedelta(seconds=offset_s),
        payload=payload,
    )


def _bus(offset_s: float, pc: float) -> Anomaly:
    return _anomaly(
        "bus_link_margin",
        offset_s,
        event_type="link_margin_drop",
        satellite_id=SAT,
        physics_consistency=pc,
        onset_ts=(T0 + timedelta(seconds=offset_s - 10)).isoformat(),
    )


def _attribution(anomalies, verdict, confidence, *, satellite=SAT, **kw) -> Attribution:
    return Attribution(
        anomaly_ids=[a.id for a in anomalies],
        actor="None" if verdict in ("internal_fault", "natural_external") else "Unknown",
        confidence=confidence,
        verdict=verdict,
        satellite_id=satellite,
        **kw,
    )


def _decision(attribution: Attribution, action: str, authority: str = "local") -> Decision:
    recovery = (
        RecoveryBlock(
            action_id="reset_amplifier",
            target_subsystem="comms",
            requires_approval=True,
            rationale="internal diagnosis",
        )
        if action == "recovery_recommendation"
        else None
    )
    return Decision(
        attribution_id=attribution.id,
        action=action,
        target="LEO-SCIENCE-1",
        rationale="test",
        authority=authority,
        recovery=recovery,
    )


def _trace(stage: str, level: str, message: str, ref_id: str | None = None, **payload):
    return ReasoningTrace(stage=stage, level=level, message=message, ref_id=ref_id, payload=payload)


def _label(case_id: str, verdict: str, actions: list[str], actor: str = "None") -> dict:
    return {
        "file": f"heldout/{case_id}.jsonl",
        "expected_actor": actor,
        "expected_actors": [actor],
        "expected_action": actions[0],
        "expected_actions": actions,
        "expected_authority": "local",
        "expected_authorities": ["local"],
        "confidence_band": "med",
        "forbidden_actions": ["orbital_strike_request"],
        "expected_verdict": verdict,
        "case_id": case_id,
        "family": case_id.split("-")[0],
        "cluster_id": case_id,
    }


def _artifact(**parts) -> TrialArtifact:
    artifact = TrialArtifact(scenario=parts.pop("scenario", "x.jsonl"))
    artifact.elapsed_seconds = parts.pop("elapsed", 0.5)
    for name, value in parts.items():
        setattr(artifact, name, value)
    return artifact


def _hostile_safety_miss() -> tuple[dict, TrialArtifact]:
    """Expected hostile; the final decision is a recovery (a safety miss).

    Also exercises cluster selection: a provisional attribution and its
    revision share an id, and a later attribution for the global
    space-weather cluster (no satellite) must not be the one scored.
    """
    cue = _anomaly("rf_anomaly", 0, satellite_id=SAT)
    bus1, bus2 = _bus(60, 0.8), _bus(180, 0.75)
    storm = _anomaly("space_weather_storm", 5, event_type="geomagnetic_storm")
    provisional = _attribution([bus1], "internal_fault", 0.8, provisional=True, revision=0)
    final = provisional.model_copy(
        update={
            "anomaly_ids": [cue.id, bus1.id, bus2.id],
            "provisional": False,
            "revision": 1,
            "confidence": 0.8,
        }
    )
    global_cluster = _attribution([storm], "unknown", 0.3, satellite=None)
    decisions = [
        _decision(provisional, "recovery_recommendation"),
        _decision(final, "recovery_recommendation"),
        _decision(global_cluster, "threat_warning"),
    ]
    traces = [
        _trace("attrib_primary", "info", "provisional", final.id, latency_ms=120.0, stage_ms=5.0),
        _trace("decide", "decision", "action=recovery_recommendation", None, latency_ms=150.0,
               stage_ms=20.0),
    ]
    artifact = _artifact(
        anomalies=[cue, storm, bus1, bus2],
        attributions=[provisional, final, global_cluster],
        decisions=decisions,
        traces=traces,
        elapsed=0.9,
    )
    return _label("link-hostile", "hostile_external", ["passive_defense"], "Unknown"), artifact


def _hostile_gate_block() -> tuple[dict, TrialArtifact]:
    """Expected hostile; the provisional decision recommended a recovery, the
    gate then blocked it and the final decision is passive defense."""
    cue = _anomaly("rf_gnss_jamming", 0, satellite_id=SAT)
    bus = _bus(60, 0.3)
    provisional = _attribution([bus], "hostile_external", 0.6, provisional=True, revision=0)
    final = provisional.model_copy(
        update={"anomaly_ids": [cue.id, bus.id], "provisional": False, "revision": 1,
                "confidence": 0.7}
    )
    decisions = [
        _decision(provisional, "recovery_recommendation"),
        _decision(final, "passive_defense"),
    ]
    traces = [
        _trace("attrib_primary", "info", "provisional", final.id, latency_ms=80.0, stage_ms=2.0),
        _trace(
            "decide",
            "warn",
            "gate blocked recovery_recommendation: threat/hostile_context",
            None,
            reason_code="threat/hostile_context",
        ),
        _trace("decide", "info", "gate blocked is not this line", None),
    ]
    artifact = _artifact(
        anomalies=[cue, bus],
        attributions=[provisional, final],
        decisions=decisions,
        traces=traces,
        elapsed=0.4,
    )
    return _label("pnt-hostile", "hostile_external", ["passive_defense"], "Unknown"), artifact


def _internal_correct() -> tuple[dict, TrialArtifact]:
    bus = _bus(60, 0.9)
    final = _attribution([bus], "internal_fault", 0.85)
    artifact = _artifact(
        anomalies=[bus],
        attributions=[final],
        decisions=[_decision(final, "recovery_recommendation")],
        traces=[_trace("decide", "decision", "action=recovery_recommendation")],
        elapsed=0.2,
    )
    return _label("power-internal", "internal_fault", ["recovery_recommendation"]), artifact


def _natural_abstained() -> tuple[dict, TrialArtifact]:
    bus = _bus(60, 0.5)
    final = _attribution([bus], "unknown", 0.4)
    artifact = _artifact(
        anomalies=[bus],
        attributions=[final],
        decisions=[_decision(final, "threat_warning")],
        traces=[],
        elapsed=0.3,
    )
    return _label("reset-natural", "natural_external", ["recovery_recommendation"]), artifact


def _natural_missing() -> tuple[dict, TrialArtifact]:
    artifact = _artifact(anomalies=[_bus(60, 0.6)], attributions=[], decisions=[], traces=[],
                         elapsed=0.1)
    return _label("orbit-natural", "natural_external", ["recovery_recommendation"]), artifact


@pytest.fixture
def card() -> Scorecard:
    card = Scorecard()
    for label, artifact in (
        _hostile_safety_miss(),
        _hostile_gate_block(),
        _internal_correct(),
        _natural_abstained(),
        _natural_missing(),
    ):
        result, item = score_trial(label, artifact)
        card.append(result, item=item)
    return card


def test_score_trial_extracts_the_satellite_clusters_final_revision() -> None:
    label, artifact = _hostile_safety_miss()
    result, item = score_trial(label, artifact)

    # The global space-weather cluster published last is not the scored one.
    assert result.predicted_verdict == "internal_fault"
    assert result.provisional_verdict == "internal_fault"
    assert result.verdict_correct is False
    assert result.predicted_action == "recovery_recommendation"
    assert result.recovery_published is True
    assert result.gate_blocked is False
    assert result.physics_consistency == 0.75
    assert result.stage_timings == {
        "attrib_primary": {"latency_ms": 120.0, "stage_ms": 5.0},
        "decide": {"latency_ms": 150.0, "stage_ms": 20.0},
    }
    assert item["expected"]["verdict"] == "hostile_external"


def test_gate_block_and_provisional_recovery_are_recorded() -> None:
    label, artifact = _hostile_gate_block()
    result, _ = score_trial(label, artifact)

    assert result.verdict_correct is True
    assert result.gate_blocked is True
    assert result.gate_block_messages == [
        "gate blocked recovery_recommendation: threat/hostile_context"
    ]
    assert result.predicted_action == "passive_defense"
    assert result.recovery_published is True  # the provisional decision was a recovery


def test_verdict_metrics_on_hand_built_artifacts(card: Scorecard) -> None:
    assert card.total == 5
    assert len(card.verdict_results()) == 5
    assert card.verdict_accuracy() == pytest.approx(2 / 5)
    assert card.verdict_missing() == 1

    matrix = card.verdict_confusion()
    assert set(matrix) == set(VERDICT_CLASSES)
    assert all(set(row) == set(VERDICT_CLASSES) for row in matrix.values())
    assert matrix["hostile_external"] == {
        "internal_fault": 1,
        "natural_external": 0,
        "hostile_external": 1,
        "unknown": 0,
    }
    assert matrix["internal_fault"]["internal_fault"] == 1
    assert matrix["natural_external"]["unknown"] == 2  # one abstention, one missing
    assert sum(sum(row.values()) for row in matrix.values()) == 5

    classes = card.verdict_class_metrics()
    assert classes["internal_fault"]["precision"] == pytest.approx(0.5)
    assert classes["internal_fault"]["recall"] == pytest.approx(1.0)
    assert classes["hostile_external"]["precision"] == pytest.approx(1.0)
    assert classes["hostile_external"]["recall"] == pytest.approx(0.5)
    assert classes["hostile_external"]["support"] == 2
    assert classes["natural_external"]["recall"] == 0.0
    assert classes["unknown"]["support"] == 0

    # Confidence against verdict correctness: (0.8, F) (0.7, T) (0.85, T) (0.4, F).
    assert card.verdict_brier() == pytest.approx((0.64 + 0.09 + 0.0225 + 0.16) / 4)
    assert card.verdict_ece() == pytest.approx(0.1 + 0.125 + 0.0375)

    assert card.abstention_rate() == pytest.approx(1 / 5)
    assert card.gate_block_rate() == pytest.approx(1 / 5)
    assert card.recovery_rate() == pytest.approx(2 / 5)
    assert card.recovery_when_hostile() == 1
    assert card.recovery_when_hostile_rate() == pytest.approx(0.5)
    assert card.any_recovery_when_hostile() == 2
    assert card.provisional_verdict_scored() == 2
    assert card.provisional_verdict_accuracy() == pytest.approx(0.5)


def test_stage_latency_percentiles_and_fallback(card: Scorecard) -> None:
    assert card.latency_source() == "traces"
    stages = card.latency_by_stage()
    assert stages["attrib_primary"]["latency_ms"] == {"p50": 120.0, "p95": 120.0, "count": 2}
    assert stages["attrib_primary"]["stage_ms"]["count"] == 2
    assert stages["decide"]["stage_ms"] == {"p50": 20.0, "p95": 20.0, "count": 1}
    # Whole-episode elapsed is always there as the fallback.
    assert stages["episode"]["elapsed_ms"]["count"] == 5
    assert stages["episode"]["elapsed_ms"]["p95"] == pytest.approx(900.0)

    untimed = Scorecard(results=[r for r in card.results if not r.stage_timings])
    assert untimed.latency_source() == "elapsed"
    assert list(untimed.latency_by_stage()) == ["episode"]


def test_stage_timings_accept_numbers_or_stage_keyed_mappings() -> None:
    traces = [
        _trace("attrib_primary", "info", "a", None, stage_ms=4.0, latency_ms=30.0),
        _trace("attrib_primary", "info", "b", None, stage_ms=9.0),  # max wins
        _trace("fusion", "info", "c", None, stage_ms={"fusion": 2.5, "ingest": 1.0}),
        _trace("decide", "info", "d", None, stage_ms="not a number"),
        {"stage": "tools", "payload": {"latency_ms": 7}},
    ]

    assert stage_timings_from_traces(traces) == {
        "attrib_primary": {"stage_ms": 9.0, "latency_ms": 30.0},
        "fusion": {"stage_ms": 2.5},
        "ingest": {"stage_ms": 1.0},
        "tools": {"latency_ms": 7.0},
    }
    assert gate_block_messages(traces) == []


def test_latest_physics_consistency_prefers_time_then_value() -> None:
    early, late = _bus(10, 0.9), _bus(200, 0.4)
    tie = _bus(200, 0.6)
    assert latest_physics_consistency([early, late]) == 0.4
    assert latest_physics_consistency([late, tie, early]) == 0.6
    assert latest_physics_consistency([_anomaly("rf_anomaly", 0)]) is None
    assert latest_physics_consistency([]) is None


def test_selectors_fall_back_to_the_last_output() -> None:
    first = _attribution([], "unknown", 0.3, satellite=None)
    second = _attribution([], "unknown", 0.4, satellite=None)
    assert select_final_attribution([first, second]) is second
    assert select_final_attribution([]) is None
    decision = _decision(first, "threat_warning")
    assert select_final_decision([decision], second) is decision
    assert select_final_decision([], second) is None


def test_scorecard_to_dict_is_backward_compatible(card: Scorecard) -> None:
    payload = card.to_dict()
    for key in (
        "total",
        "attribution_accuracy",
        "action_accuracy",
        "authority_accuracy",
        "calibration_rate",
        "completion_rate",
        "brier_score",
        "expected_calibration_error",
        "actor_macro_f1",
        "abstention",
        "risk_coverage_curve",
        "bootstrap_95",
        "robustness",
        "reliability",
        "efficiency",
        "by_family",
        "raw_outputs",
        "forbidden_action_rate",
        "unauthorized_routing_rate",
        "commit_rate_at_55",
        "accuracy_when_committed_55",
        "hallucination_rate_at_70",
        "calibration_bins",
        "latency_p50",
        "latency_p95",
        "confidence_means",
        "results",
    ):
        assert key in payload, key
    assert payload["verdict_accuracy"] == 0.4
    assert payload["recovery_when_hostile"] == 1
    assert payload["any_recovery_when_hostile"] == 2
    assert payload["verdict_confusion"]["hostile_external"]["internal_fault"] == 1
    assert payload["by_family"]["link"]["verdict_accuracy"] == 0.0
    row = payload["results"][0]
    for key in (
        "expected_verdict",
        "predicted_verdict",
        "verdict_correct",
        "physics_consistency",
        "gate_blocked",
        "gate_block_messages",
        "stage_timings",
        "provisional_verdict",
        "recovery_published",
    ):
        assert key in row, key
    json.dumps(payload)  # serialisable as written to scorecard.json

    # A result built with only the pre-3D fields still scores.
    legacy = ScenarioResult(
        file="legacy.jsonl",
        expected_actor="China",
        predicted_actor="China",
        expected_action="passive_defense",
        predicted_action="passive_defense",
        expected_authority="local",
        predicted_authority="local",
        confidence=0.8,
        expected_confidence_band="high",
        latency_seconds=0.25,
        actor_correct=True,
        action_correct=True,
        authority_correct=True,
        calibrated=True,
    )
    legacy_card = Scorecard(results=[legacy])
    assert legacy_card.verdict_results() == []
    assert legacy_card.verdict_accuracy() == 0.0
    assert legacy_card.latency_source() == "elapsed"
    assert legacy_card.to_dict()["verdict_scored"] == 0


def test_run_bundle_files_verdict_misses_as_failures(card: Scorecard, tmp_path) -> None:
    bundle = write_run_bundle(
        card,
        output_root=tmp_path,
        provider="stub",
        model="deterministic-control",
        suite_id="megalith-heldout-v1",
        multi_agent=True,
    )

    failures = {path.stem for path in (bundle / "failures").glob("*.json")}
    assert "link-hostile" in failures  # verdict miss and recovery under hostile
    assert "power-internal" not in failures
    summary = json.loads((bundle / "summary.json").read_text())
    assert summary["verdict_accuracy"] == 0.4
