"""The held-out paired suite (MEGALITH wave 2C) loads through the registry and
replays through the engine with the stub LLM.

Verdict correctness is gate 2 with the real scorer; here every scenario must
simply run end to end, produce an attribution, and never see its oracle record.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from bench.runner import run_trial
from bench.specs import load_scenario_registry
from canopy.services.scenario_replay import load_scenario_signals

ROOT = Path(__file__).resolve().parent.parent
HELDOUT_DIR = ROOT / "scenarios" / "heldout"
ORACLE_SOURCE = "megalith-scenario-oracle"
ARMS = ("internal", "natural", "hostile")
# The closely-spaced row (MEGALITH pre-submission C10, spec 1.4 §5.4) has its
# own three arms: two objects on one pass and a cue that fits either.
CLOSELY_SPACED_FAMILY = "closely_spaced"
CLOSELY_SPACED_ARMS = ("hostile", "unknown", "natural")


def _heldout_cases():
    registry = load_scenario_registry()
    return [case for case in registry.cases if "heldout" in case.visibility]


def test_registry_loads_twenty_one_heldout_cases_outside_demo_and_benchmark() -> None:
    registry = load_scenario_registry()
    heldout = _heldout_cases()
    assert len(heldout) == 21
    assert {case.file for case in heldout} == {
        f"heldout/{path.name}" for path in HELDOUT_DIR.glob("*.jsonl")
    }
    demo_ids = {case.id for case in registry.demo_cases()}
    bench_ids = {case.id for case in registry.benchmark_cases()}
    for case in heldout:
        assert case.visibility == ["heldout"]
        assert case.split == "heldout"
        assert case.id not in demo_ids
        assert case.id not in bench_ids
        assert case.expected.verdict is not None
        assert case.scenario_path.exists()
        assert case.scenario_path.parent == HELDOUT_DIR.resolve()
    # Six symptom families with three arms each, plus the closely-spaced row.
    families = {case.family for case in heldout}
    assert len(families) == 7 and CLOSELY_SPACED_FAMILY in families
    for family in families:
        wanted = CLOSELY_SPACED_ARMS if family == CLOSELY_SPACED_FAMILY else ARMS
        arms = {next(tag for tag in case.tags if tag in wanted) for case in heldout if case.family == family}
        assert arms == set(wanted), family


def test_oracle_records_are_never_model_inputs() -> None:
    for case in _heldout_cases():
        signals = load_scenario_signals(case.scenario_path)
        oracle = [s for s in signals if s.source == ORACLE_SOURCE]
        assert len(oracle) == 1, case.id
        assert case.role_for(oracle[0]) == "oracle"
        assert not case.includes_as_input(oracle[0])
        inputs = [s for s in signals if case.includes_as_input(s)]
        assert inputs and all(s.source != ORACLE_SOURCE for s in inputs)
        assert any(s.domain == "bus_health" for s in inputs), case.id


@pytest.mark.parametrize("case", _heldout_cases(), ids=lambda case: case.id)
def test_heldout_scenario_replays_through_engine_with_stub(case) -> None:
    trial = asyncio.run(run_trial(case, provider="stub"))

    assert not trial.errors, trial.errors
    assert trial.signals
    assert all(signal.source != ORACLE_SOURCE for signal in trial.signals)
    if case.expected.verdict == "unknown":
        # The closely-spaced row's unresolved arm (spec 1.4 §5.4): two nominal
        # buses and one cue that fits either, so no bus anomaly by design.
        assert [anomaly.kind for anomaly in trial.anomalies] == ["rf_anomaly"]
    else:
        assert any(anomaly.kind.startswith("bus_") for anomaly in trial.anomalies), [
            anomaly.kind for anomaly in trial.anomalies
        ]
    assert trial.attributions
    assert trial.decisions
    satellite = trial.signals[0].payload.satellite_id or next(
        s.payload.satellite_id for s in trial.signals if s.payload.satellite_id
    )
    assert satellite == "ctb://centralblue.dev/leo-science-1" or satellite.endswith("leo-science-2")
