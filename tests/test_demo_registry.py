"""The MEGALITH demo scenarios (wave 4A) load through the registry as demo-only
cases and replay through the engine with the stub LLM.

The expected verdict needs the rule verdict lane, which is active only where
``megalith`` is importable (the root environment); that check skips itself in
CANOPY's own environment.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
from pathlib import Path

import pytest
from bench.runner import run_trial
from bench.scoring import select_final_attribution, select_final_decision
from bench.specs import load_scenario_registry
from canopy.services.scenario_replay import load_scenario_signals

ROOT = Path(__file__).resolve().parent.parent
SCENARIOS = ROOT / "scenarios"
ORACLE_SOURCE = "megalith-scenario-oracle"
FAMILY = "demo_link_margin"
SATELLITE_ID = "ctb://megalith.demo/sim-01"
FILES = {
    "A": "megalith_link_margin_a.jsonl",
    "B": "megalith_link_margin_b.jsonl",
    "C": "megalith_link_margin_c.jsonl",
}
EXPECTED = {
    "A": ("internal_fault", ["None"], ["recovery_recommendation"]),
    "B": ("hostile_external", ["Actor-1"], ["passive_defense", "threat_warning", "space_link_interdiction_request", "active_defense_escort"]),
    "C": ("natural_external", ["None"], ["recovery_recommendation"]),
}
MEGALITH_AVAILABLE = importlib.util.find_spec("megalith") is not None


def _demo_cases():
    registry = load_scenario_registry()
    return [case for case in registry.cases if case.family == FAMILY]


def test_demo_cases_are_demo_only_and_outside_both_suites() -> None:
    registry = load_scenario_registry()
    cases = _demo_cases()
    assert {case.file for case in cases} == set(FILES.values())
    demo_ids = {case.id for case in registry.demo_cases()}
    benchmark_ids = {case.id for case in registry.benchmark_cases()}
    heldout_ids = {case.id for case in registry.heldout_cases()}
    for run, name in FILES.items():
        case = registry.by_file(name)
        assert case.id == f"demo-link-margin-{run.lower()}"
        assert case.visibility == ["demo"]
        assert case.split != "heldout"
        assert case.id in demo_ids
        assert case.id not in benchmark_ids and case.id not in heldout_ids
        assert case.id not in {c.id for c in registry.suite_cases("public")}
        assert case.id not in {c.id for c in registry.suite_cases("heldout")}
        assert case.scenario_path.exists() and case.scenario_path.parent == SCENARIOS.resolve()
        verdict, actors, actions = EXPECTED[run]
        assert case.expected.verdict == verdict
        assert case.expected.actors == actors
        assert case.expected.actions == actions
        assert set(case.expected.forbidden_actions) == {
            "active_defense_counterattack",
            "orbital_strike_request",
            "terrestrial_strike_request",
        }
        assert run in case.tags
    # The gateway's GET /scenarios lists demo case files: the three are replayable.
    listed = sorted(case.file for case in registry.demo_cases())
    assert set(FILES.values()) <= set(listed)


def test_demo_files_carry_synthetic_identifiers_only() -> None:
    for name in FILES.values():
        text = (SCENARIOS / name).read_text(encoding="utf-8").lower()
        for token in ("norad", "cospar", "leo-science", "99901", "centralblue"):
            assert token not in text, (name, token)
        for row in (json.loads(line) for line in text.splitlines() if line):
            sat = row["payload"].get("satellite_id")
            assert sat in (None, SATELLITE_ID, "ctb://megalith.demo/sim-02"), row["id"]


def test_oracle_records_are_never_model_inputs() -> None:
    for case in _demo_cases():
        signals = load_scenario_signals(case.scenario_path)
        oracle = [s for s in signals if s.source == ORACLE_SOURCE]
        assert len(oracle) == 1, case.id
        assert case.role_for(oracle[0]) == "oracle"
        assert not case.includes_as_input(oracle[0])
        inputs = [s for s in signals if case.includes_as_input(s)]
        assert inputs and all(s.source != ORACLE_SOURCE for s in inputs)
        assert any(s.domain == "bus_health" and s.payload.event_type == "nominal" for s in inputs), case.id
        assert any(s.domain == "bus_health" and s.payload.event_type != "nominal" for s in inputs), case.id


@pytest.mark.parametrize("run", sorted(FILES), ids=lambda run: f"run-{run}")
def test_demo_scenario_replays_through_engine_with_stub(run: str) -> None:
    case = load_scenario_registry().by_file(FILES[run])
    trial = asyncio.run(run_trial(case, provider="stub"))

    assert not trial.errors, trial.errors
    assert trial.signals and all(s.source != ORACLE_SOURCE for s in trial.signals)
    assert any(a.kind.startswith("bus_") for a in trial.anomalies), [a.kind for a in trial.anomalies]
    assert trial.attributions and trial.decisions
    final = select_final_attribution(trial.attributions, trial.anomalies)
    decision = select_final_decision(trial.decisions, final)
    assert final is not None and decision is not None
    assert decision.action not in case.expected.forbidden_actions
    assert final.satellite_id in (SATELLITE_ID, "ctb://megalith.demo/sim-02")
    if not MEGALITH_AVAILABLE:
        # Without the rule lane there is no fast-lane cluster per satellite and
        # the legacy path may select the fleet sibling's attribution (Run C).
        pytest.skip("expected verdict needs the rule verdict lane (root environment)")
    assert final.satellite_id == SATELLITE_ID
    verdict, _, actions = EXPECTED[run]
    assert final.verdict == verdict
    assert decision.action in actions
    if run == "B":
        assert all(d.action != "recovery_recommendation" for d in trial.decisions)
    else:
        assert decision.recovery is not None
