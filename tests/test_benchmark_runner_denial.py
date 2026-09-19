"""``bench.runner.run_trial`` keyword parameters ``blocked_domains`` and
``bus_health_registry`` (MEGALITH pre-submission item C2, single-view baselines).

An engine built with a denial set drops those domains' signals in fusion, so
no anomaly forms from them; the registry makes a satellite with no bus
telemetry take the section 5.2 haircut. Nothing here depends on the rule
lane, so the file runs in CANOPY's own environment and in the root one.
"""

from __future__ import annotations

import asyncio

import pytest
from bench.runner import run_trial
from bench.specs import load_scenario_registry

EXTERNAL_DOMAINS = {"cyber", "orbit", "pnt", "rf_ew", "satcom", "sda", "space_weather"}
SATELLITE = "ctb://centralblue.dev/leo-science-1"
MISSING_TELEMETRY_PREFIX = "internal diagnosis telemetry missing for"


def _case(case_id: str):
    return next(case for case in load_scenario_registry().cases if case.id == case_id)


@pytest.fixture(scope="module")
def hostile_case():
    return _case("heldout-link-margin-hostile")


def _signal_domains(trial, signal_ids: set[str]) -> set[str]:
    by_id = {s.id: s for s in trial.signals}
    return {by_id[sid].domain for sid in signal_ids if sid in by_id}


def test_default_run_is_unchanged_and_sees_bus_health(hostile_case) -> None:
    trial = asyncio.run(run_trial(hostile_case, provider="stub"))

    assert not trial.errors, trial.errors
    assert any(a.kind.startswith("bus_") for a in trial.anomalies)
    assert not [t for t in trial.traces if t.stage == "stress"]


def test_blocked_domains_drops_those_signals_before_fusion(hostile_case) -> None:
    trial = asyncio.run(run_trial(hostile_case, provider="stub", blocked_domains={"bus_health"}))

    # The signals were still replayed on the bus; fusion dropped them.
    assert any(s.domain == "bus_health" for s in trial.signals)
    assert not any(a.kind.startswith("bus_") for a in trial.anomalies)
    assert "bus_health" not in _signal_domains(trial, set(trial.anomaly_source_signal_ids))
    dropped = [t for t in trial.traces if t.stage == "stress" and "input dropped" in t.message]
    assert dropped and all("bus_health" in t.message for t in dropped)
    # The external cues still attribute on their own.
    assert trial.attributions
    assert not any(e["type"] == "missing_output" for e in trial.errors)


def test_blocked_external_domains_leaves_bus_only_clusters(hostile_case) -> None:
    trial = asyncio.run(run_trial(hostile_case, provider="stub", blocked_domains=EXTERNAL_DOMAINS))

    assert trial.anomalies
    assert all(a.kind.startswith("bus_") for a in trial.anomalies), [a.kind for a in trial.anomalies]
    assert not (_signal_domains(trial, set(trial.anomaly_source_signal_ids)) & EXTERNAL_DOMAINS)


def test_blocking_every_input_domain_produces_no_output(hostile_case) -> None:
    trial = asyncio.run(
        run_trial(hostile_case, provider="stub", blocked_domains=EXTERNAL_DOMAINS | {"bus_health"})
    )

    assert trial.anomalies == []
    assert trial.attributions == []
    assert {e["type"] for e in trial.errors} == {"missing_output"}


def test_bus_health_registry_marks_missing_telemetry_and_lowers_confidence(hostile_case) -> None:
    without = asyncio.run(run_trial(hostile_case, provider="stub", blocked_domains={"bus_health"}))
    with_registry = asyncio.run(
        run_trial(
            hostile_case,
            provider="stub",
            blocked_domains={"bus_health"},
            bus_health_registry=lambda: {SATELLITE},
        )
    )

    plain = without.attributions[-1]
    haircut = with_registry.attributions[-1]
    assert not any(line.startswith(MISSING_TELEMETRY_PREFIX) for line in plain.evidence)
    assert any(line == f"{MISSING_TELEMETRY_PREFIX} {SATELLITE}" for line in haircut.evidence)
    assert any(line.startswith("Stress:") for line in haircut.evidence)
    assert haircut.confidence < plain.confidence
    lowering = [t for t in with_registry.traces if t.stage == "stress" and "lowering" in t.message]
    assert lowering and lowering[0].payload.get("missing_bus_telemetry") == SATELLITE


def test_registry_for_another_satellite_changes_nothing(hostile_case) -> None:
    trial = asyncio.run(
        run_trial(
            hostile_case,
            provider="stub",
            blocked_domains={"bus_health"},
            bus_health_registry=lambda: {"ctb://centralblue.dev/leo-science-9"},
        )
    )

    assert trial.attributions
    assert not any(
        line.startswith(MISSING_TELEMETRY_PREFIX) for line in trial.attributions[-1].evidence
    )
