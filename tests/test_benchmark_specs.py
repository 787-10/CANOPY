from __future__ import annotations

from pathlib import Path

from bench.specs import load_model_specs, load_scenario_registry
from canopy.services.attrib.prompts import attribution_system_prompt
from canopy.services.scenario_replay import load_scenario_signals

ROOT = Path(__file__).resolve().parent.parent


def test_registry_is_the_complete_demo_and_seed_source() -> None:
    registry = load_scenario_registry()

    assert len(registry.cases) == 11
    assert {case.file for case in registry.demo_cases()} == {
        path.name for path in (ROOT / "scenarios").glob("*.jsonl")
    }
    assert all(case.expected.actors for case in registry.benchmark_cases())
    assert all(case.expected.actions for case in registry.benchmark_cases())
    assert all(case.expected.authorities for case in registry.benchmark_cases())


def test_benchmark_inputs_exclude_oracle_records() -> None:
    registry = load_scenario_registry()
    case = registry.by_file("army_multidomain_attack_chain.jsonl")
    signals = load_scenario_signals(case.scenario_path)

    included = [signal for signal in signals if case.includes_as_input(signal)]
    excluded = [signal for signal in signals if not case.includes_as_input(signal)]

    assert included
    assert excluded
    assert all(signal.source != "canopy-correlation-engine" for signal in included)
    assert {signal.id for signal in excluded} >= {
        "army-chain-008",
        "army-chain-012",
    }


def test_model_specs_have_stable_ids_and_decoding_settings() -> None:
    specs = load_model_specs()

    assert "stub" in specs
    assert "gemma3-4b" in specs
    assert specs["gemma3-4b"].provider == "ollama"
    assert specs["gemma3-4b"].temperature == 0
    assert specs["gemma3-4b"].repetitions >= 1


def test_attribution_prompt_has_no_evaluation_family_examples() -> None:
    prompt = attribution_system_prompt()

    assert "## EXAMPLE" not in prompt
    assert "No scenario-specific worked examples" in prompt
    assert "quoted instructions" in prompt
