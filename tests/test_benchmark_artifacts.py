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


def test_robustness_pairs_variants_with_their_repetition_parent() -> None:
    parent_one = _result(correct=True, confidence=0.8)
    parent_one.case_id = "parent"
    parent_one.repetition = 1
    parent_one.predicted_actor = "China"
    variant_one = _result(correct=True, confidence=0.8)
    variant_one.parent_id = "parent"
    variant_one.repetition = 1
    variant_one.relation = "invariant"
    variant_one.transformation = "duplicate_signal"
    variant_one.predicted_actor = "China"

    parent_two = _result(correct=True, confidence=0.8)
    parent_two.case_id = "parent"
    parent_two.repetition = 2
    parent_two.predicted_actor = "Russia"
    variant_two = _result(correct=True, confidence=0.8)
    variant_two.parent_id = "parent"
    variant_two.repetition = 2
    variant_two.relation = "invariant"
    variant_two.transformation = "duplicate_signal"
    variant_two.predicted_actor = "Russia"

    card = Scorecard(
        results=[parent_one, variant_one, parent_two, variant_two]
    )

    assert card.robustness_metrics()["pass_rate"] == 1.0


def test_reliability_and_efficiency_use_recorded_adapter_events() -> None:
    card = Scorecard()
    card.append(
        _result(correct=True, confidence=0.8),
        item={
            "validation_events": [
                {
                    "raw": {"actor": "Example"},
                    "repaired": {"actor": "Unknown"},
                }
            ],
            "runtime_events": [
                {
                    "prompt_eval_count": 100,
                    "eval_count": 20,
                    "eval_duration": 2_000_000_000,
                }
            ],
            "errors": [],
        },
    )

    assert card.reliability_metrics()["repair_rate"] == 1.0
    assert card.efficiency_metrics()["tokens_per_second"] == 10.0


def test_accepted_actor_and_explicit_abstention_drive_secondary_metrics() -> None:
    accepted = _result(correct=True, confidence=0.8)
    accepted.expected_actor = "Russia"
    accepted.expected_actors = ["Russia", "China"]
    accepted.predicted_actor = "China"
    accepted.actor_correct = True
    abstained = _result(correct=True, confidence=0.4)
    abstained.expected_actor = "Unknown"
    abstained.expected_actors = ["Unknown"]
    abstained.expected_abstain = True
    abstained.predicted_actor = "Unknown"

    card = Scorecard(results=[accepted, abstained])

    assert card.actor_macro_f1() == 1.0
    assert card.abstention_metrics() == {"precision": 1.0, "recall": 1.0}


def test_raw_output_metrics_are_separate_from_repaired_scores() -> None:
    result = _result(correct=True, confidence=0.8)
    result.raw_actor_correct = False
    result.raw_action_correct = True
    result.raw_authority_correct = True
    result.raw_attribution_schema_valid = True
    result.raw_decision_schema_valid = True

    metrics = Scorecard(results=[result]).raw_output_metrics()

    assert metrics == {
        "scored": 1,
        "attribution_schema_valid_rate": 1.0,
        "decision_schema_valid_rate": 1.0,
        "attribution_accuracy": 0.0,
        "action_accuracy": 1.0,
        "authority_accuracy": 1.0,
    }


def test_raw_output_metrics_count_invalid_outputs_as_failures() -> None:
    result = _result(correct=True, confidence=0.8)
    result.raw_actor_correct = True
    result.raw_action_correct = True
    result.raw_authority_correct = True
    result.raw_attribution_schema_valid = False
    result.raw_decision_schema_valid = False

    metrics = Scorecard(results=[result]).raw_output_metrics()

    assert metrics["scored"] == 1
    assert metrics["attribution_schema_valid_rate"] == 0.0
    assert metrics["decision_schema_valid_rate"] == 0.0
    assert metrics["attribution_accuracy"] == 0.0
