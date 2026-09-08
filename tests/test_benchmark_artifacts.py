from __future__ import annotations

import json

import pytest

from bench.artifacts import write_run_bundle
from bench.scoring import ScenarioResult, Scorecard


def _result(*, correct: bool, confidence: float, action: str = "passive_defense"):
    return ScenarioResult(
        file="case.jsonl",
        expected_actor="China",
        predicted_actor="China" if correct else "Russia",
        expected_action="passive_defense",
        predicted_action=action,
        expected_authority="local",
        predicted_authority="local",
        confidence=confidence,
        expected_confidence_band="med",
        latency_seconds=0.25,
        actor_correct=correct,
        action_correct=action == "passive_defense",
        authority_correct=True,
        calibrated=True,
    )


def test_scorecard_reports_statistical_calibration_and_policy_metrics() -> None:
    card = Scorecard()
    card.append(_result(correct=True, confidence=0.8))
    card.append(
        _result(
            correct=False,
            confidence=0.6,
            action="active_defense_escort",
        )
    )

    assert card.brier_score() == pytest.approx(0.2)
    assert card.expected_calibration_error() == pytest.approx(0.4)
    assert card.completion_rate() == 1.0
    assert card.unauthorized_routing_rate() == 0.5
    assert card.to_dict()["bootstrap_95"]["attribution_accuracy"] == {
        "low": 0.5,
        "high": 0.5,
    }


def test_run_bundle_is_immutable_and_rescoreable(tmp_path) -> None:
    card = Scorecard()
    result = _result(correct=True, confidence=0.8)
    card.append(result, item={"case_id": "case-1", "traces": [{"stage": "fusion"}]})

    bundle = write_run_bundle(
        card,
        output_root=tmp_path,
        provider="stub",
        model="deterministic-control",
        suite_id="test-suite",
        multi_agent=True,
    )

    run = json.loads((bundle / "run.json").read_text())
    summary = json.loads((bundle / "summary.json").read_text())
    items = [json.loads(line) for line in (bundle / "items.jsonl").read_text().splitlines()]

    assert run["provider"] == "stub"
    assert run["suite_id"] == "test-suite"
    assert run["git_sha"]
    assert summary["brier_score"] == 0.04
    assert items == [{"case_id": "case-1", "traces": [{"stage": "fusion"}]}]

    second = write_run_bundle(
        card,
        output_root=tmp_path,
        provider="stub",
        model="deterministic-control",
        suite_id="test-suite",
        multi_agent=True,
    )
    assert second != bundle


def test_robustness_metrics_score_parent_variant_relations() -> None:
    parent = _result(correct=True, confidence=0.8)
    parent.case_id = "parent"
    invariant = _result(correct=True, confidence=0.8)
    invariant.case_id = "variant-1"
    invariant.parent_id = "parent"
    invariant.transformation = "duplicate_signal"
    invariant.relation = "invariant"
    degraded = _result(correct=True, confidence=0.7)
    degraded.case_id = "variant-2"
    degraded.parent_id = "parent"
    degraded.transformation = "drop_domain"
    degraded.relation = "confidence_nonincrease"

    card = Scorecard(results=[parent, invariant, degraded])

    assert card.robustness_metrics() == {
        "eligible": 2,
        "passed": 2,
        "pass_rate": 1.0,
        "by_transformation": {
            "drop_domain": {"eligible": 1, "passed": 1, "pass_rate": 1.0},
            "duplicate_signal": {"eligible": 1, "passed": 1, "pass_rate": 1.0},
        },
    }
