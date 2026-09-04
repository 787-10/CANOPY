"""Smoke tests for the benchmark harness (Phase 5).

The bench module replays scenarios through the engine and produces a
scorecard. The tests assert the *shape* of the scorecard (not specific
numbers) to avoid brittleness against stub-template changes.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from bench.run import _label_outputs, _run, _seed_labels
from bench.runner import run_trial
from bench.specs import load_scenario_registry
from canopy._engine import build_engine, build_llm
from canopy.services.kb import KB

ROOT = Path(__file__).resolve().parent.parent
from bench.scoring import (
    Scorecard,
    actor_match,
    authority_match,
    confidence_band,
    confidence_band_match,
    action_match,
)


def test_actor_match_handles_actor_head():
    assert actor_match("Russia / GRU", "russia")
    assert actor_match("CHINA / PLA SSF", "China")
    assert actor_match("China / PLA SSF", ["Russia", "China"])
    assert not actor_match("Iran", "Russia")


def test_action_authority_match_any_wildcard():
    assert action_match("active_defense_escort", "any")
    assert not action_match("threat_warning", "*")
    assert authority_match("local", "any")


def test_confidence_band_buckets():
    assert confidence_band(0.30) == "low"
    assert confidence_band(0.60) == "med"
    assert confidence_band(0.85) == "high"
    assert confidence_band_match(0.60, "med")
    assert not confidence_band_match(0.30, "high")


def test_seed_labels_loads_at_least_eleven():
    labels = _seed_labels()
    assert len(labels) >= 11
    for label in labels:
        for required in (
            "file",
            "expected_actor",
            "expected_action",
            "expected_authority",
        ):
            assert required in label, f"label missing {required}"


def test_unknown_provider_fails_closed():
    with pytest.raises(ValueError, match="unknown LLM provider"):
        build_engine(provider="stbu")


def test_engine_accepts_an_injected_llm_client():
    kb = KB.load_from_json(ROOT / "data" / "kb_seed_entries.json")
    client = build_llm(provider="stub", kb=kb)

    engine = build_engine(llm=client, enable_osint=False)

    assert engine.llm is client


def test_missing_outputs_are_always_failures():
    result = _label_outputs(
        {
            "file": "missing.jsonl",
            "expected_actor": "Unknown",
            "expected_action": "any",
            "expected_authority": "any",
            "confidence_band": "low",
        },
        {"attribution": [], "decision": []},
        0.1,
    )

    assert not result.actor_correct
    assert not result.action_correct
    assert not result.authority_correct
    assert not result.calibrated


def test_trial_scores_one_scenario_level_assessment():
    trial = asyncio.run(
        run_trial(
            ROOT / "scenarios" / "beat2.jsonl",
            provider="stub",
            multi_agent=True,
        )
    )

    assert len(trial.attributions) == 1
    assert len(trial.decisions) == 1
    assert set(trial.attributions[0].source_signal_ids) == set(
        trial.anomaly_source_signal_ids
    )


def test_trials_are_isolated_and_repeatable():
    first = asyncio.run(
        run_trial(ROOT / "scenarios" / "beat2.jsonl", provider="stub")
    )
    second = asyncio.run(
        run_trial(ROOT / "scenarios" / "beat2.jsonl", provider="stub")
    )

    assert len(first.signals) == len(second.signals)
    assert len(first.anomalies) == len(second.anomalies)
    assert [item.actor for item in first.attributions] == [
        item.actor for item in second.attributions
    ]


def test_trial_publishes_only_manifest_input_roles():
    case = load_scenario_registry().by_file(
        "army_multidomain_attack_chain.jsonl"
    )
    trial = asyncio.run(run_trial(case, provider="stub"))

    assert trial.signals
    assert all(
        signal.source != "canopy-correlation-engine"
        for signal in trial.signals
    )
    assert "army-chain-008" not in {signal.id for signal in trial.signals}


def test_bench_run_against_subset_produces_scorecard():
    """Run the harness against the first 3 seeds; assert scorecard shape."""
    card: Scorecard = asyncio.run(
        _run(provider="stub", seeds_only=True, limit=3)
    )

    assert card.total == 3
    payload = card.to_dict()

    for key in (
        "total",
        "attribution_accuracy",
        "action_accuracy",
        "authority_accuracy",
        "calibration_rate",
        "latency_p50",
        "latency_p95",
        "confidence_means",
        "results",
    ):
        assert key in payload, f"scorecard missing {key}"

    assert payload["total"] == 3
    assert isinstance(payload["results"], list)
    assert len(payload["results"]) == 3
    for r in payload["results"]:
        assert "file" in r
        assert "actor_correct" in r
        assert "action_correct" in r
        assert "authority_correct" in r
        assert "latency_seconds" in r

    # The stub is deterministic — action + authority should always be
    # routed somewhere (no Nones) for these seeds because every scenario
    # produces at least one anomaly that triggers a decision.
    for r in payload["results"]:
        assert r["predicted_action"] is not None
        assert r["predicted_authority"] is not None

    # Latency budget is generous — even the heaviest seed should clear.
    assert payload["latency_p95"] < 30.0
