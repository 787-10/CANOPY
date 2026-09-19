from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from canopy.services.schemas.events import (
    Anomaly,
    Attribution,
    Decision,
    Location,
    Provenance,
    Recommendation,
    Signal,
    UIEvent,
)

ROOT = Path(__file__).resolve().parent.parent


def _signal_kwargs(**overrides) -> dict:
    base = {
        "domain": "rf_ew",
        "source": "spectrum-monitor-guam",
        "realism": "mock_operational",
        "confidence": 0.86,
        "location": Location(label="Guam RF site", lat=13.5, lng=144.8),
        "payload": {
            "event_type": "rf_interference",
            "summary": "RF interference",
        },
        "provenance": Provenance(source_id="canopy-demo-feed-worker"),
    }
    base.update(overrides)
    return base


def test_canonical_scenario_signals_validate() -> None:
    paths = sorted((ROOT / "scenarios").glob("*.jsonl"))
    assert paths, "expected checked-in scenario files"
    total = 0
    for path in paths:
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            sig = Signal.model_validate_json(line)
            assert sig.payload.event_type
            assert sig.realism in (
                "real_source",
                "mock_operational",
                "synthetic_orbital_overlay",
            )
            assert sig.provenance.source_id
            total += 1
    assert total > 0


def test_signal_minimum_required_fields() -> None:
    s = Signal(**_signal_kwargs())
    data = s.model_dump_json()
    parsed = Signal.model_validate_json(data)
    assert parsed.domain == s.domain
    assert parsed.payload.event_type == "rf_interference"


def test_signal_rejects_bad_domain() -> None:
    with pytest.raises(ValidationError):
        Signal(**_signal_kwargs(domain="not_a_real_domain"))


def test_signal_rejects_oob_confidence() -> None:
    with pytest.raises(ValidationError):
        Signal(**_signal_kwargs(confidence=1.5))


def test_location_requires_localizer() -> None:
    Location(label="abstract")
    Location(lat=10.0, lng=20.0)
    Location(mgrs="42SXG12345678")
    with pytest.raises(ValidationError):
        Location()


def test_provenance_source_id_required() -> None:
    Provenance(source_id="x")
    with pytest.raises(ValidationError):
        Provenance(source_id="")


def test_anomaly_canonical_shape() -> None:
    a = Anomaly(
        kind="rf_anomaly",
        source_signal="sig-1",
        source_signal_ids=["sig-1"],
        severity=0.82,
        payload={"summary": "RF interference"},
    )
    blob = a.model_dump_json()
    parsed = Anomaly.model_validate_json(blob)
    assert parsed.kind == "rf_anomaly"
    assert 0.0 <= parsed.severity <= 1.0


def test_anomaly_severity_bounds() -> None:
    with pytest.raises(ValidationError):
        Anomaly(
            kind="x",
            source_signal="s",
            source_signal_ids=["s"],
            severity=1.5,
            payload={},
        )


def test_attribution_carries_source_signal_ids() -> None:
    a = Attribution(
        anomaly_ids=["anom-1"],
        actor="Russia",
        confidence=0.78,
        evidence=["consistent with Russian EW"],
        kb_citations=["kb-gps-jamming-001"],
        source_signal_ids=["canopy-beat2-001"],
    )
    assert a.source_signal_ids == ["canopy-beat2-001"]


def test_decision_action_and_authority() -> None:
    d = Decision(
        attribution_id="attr-1",
        action="active_defense_escort",
        target="threatened_geo_asset",
        rationale="Test",
        authority="request",
        request_packet={"to": "CJFSCC"},
        source_signal_ids=["canopy-beat47-002"],
    )
    assert d.authority == "request"
    with pytest.raises(ValidationError):
        Decision(
            attribution_id="x",
            action="not_a_valid_action",  # type: ignore[arg-type]
            target="x",
            rationale="x",
            authority="local",
        )


def test_uievent_validates_against_data_fixture() -> None:
    fixture = json.loads((ROOT / "data" / "expected_ui_events.json").read_text())
    parsed = [UIEvent.model_validate(e) for e in fixture["events"]]
    assert len(parsed) == len(fixture["events"])
    rec_types = {e.type for e in parsed}
    assert "threat_updated" in rec_types
    assert "recommendation_created" in rec_types


def test_recommendation_default_label() -> None:
    r = Recommendation(id="rec-1", summary="x")
    assert r.approveLabel == "APPROVE"


# ---- MEGALITH domains (docs/INTERFACE-SPEC.md §3, §4) ---------------------

SCHEMA_EXAMPLES = ROOT / "services" / "bus" / "schemas" / "examples"

_BUS_HEALTH_PAYLOAD = {
    "event_type": "link_margin_drop",
    "summary": "LEO-SCIENCE-1 downlink margin falling 0.42 dB/s since 14:32:10Z.",
    "asset": "LEO-SCIENCE-1",
    "satellite_id": "ctb://centralblue.dev/leo-science-1",
    "observables": {
        "subsystem": "comms",
        "symptom": "link_margin_db_drop",
        "onset_ts": "2026-09-17T14:32:10Z",
        "onset_clock_domain": "simulation",
        "sim_time_s": 812.0,
        "rate_of_change": -0.42,
        "rate_unit": "dB/s",
        "physics_consistency": 0.83,
        "physics_basis": "belief:pa_degradation=0.79;shape=ramp",
        "shape": "ramp",
        "recommended_recovery": {
            "action_id": "switch_redundant_amplifier",
            "target_subsystem": "comms",
            "requires_approval": True,
            "rationale": "Primary amplifier output trending down; redundant unit nominal.",
        },
        "norad_cat_id": "99901",
        "sim_identity": "ctb://sim.centralblue.dev/leo-science-1",
    },
}

_SPACE_WEATHER_PAYLOAD = {
    "event_type": "geomagnetic_storm",
    "summary": "Geomagnetic storm in progress (G2): Kp 6.33.",
    "observables": {
        "kp": 6.33,
        "dst_nt": -112,
        "f107": 158.4,
        "severity": 0.4,
        "valid_from": "2026-09-17T14:00:00Z",
        "valid_to": "2026-09-17T20:00:00Z",
    },
}


def test_bus_health_signal_validates() -> None:
    s = Signal(
        **_signal_kwargs(
            domain="bus_health",
            source="internal-diagnosis",
            confidence=0.81,
            location=Location(label="LEO-SCIENCE-1"),
            payload=_BUS_HEALTH_PAYLOAD,
            provenance=Provenance(
                source_id="internal-diagnosis",
                collector="megalith-bus-health-adapter",
                method="rule_fdir+belief",
                notes="epoch=2026-09-17T14:18:38Z",
            ),
        )
    )
    parsed = Signal.model_validate_json(s.model_dump_json())
    assert parsed.domain == "bus_health"
    assert parsed.source == "internal-diagnosis"
    assert parsed.payload.satellite_id == "ctb://centralblue.dev/leo-science-1"
    obs = parsed.payload.observables
    assert obs is not None
    assert obs["subsystem"] == "comms"
    assert obs["recommended_recovery"]["action_id"] == "switch_redundant_amplifier"
    assert obs["sim_identity"] == "ctb://sim.centralblue.dev/leo-science-1"


def test_bus_health_recovery_may_be_null() -> None:
    payload = json.loads(json.dumps(_BUS_HEALTH_PAYLOAD))
    payload["observables"].update(
        {"recommended_recovery": None, "rate_of_change": None, "rate_unit": None, "shape": None}
    )
    s = Signal(**_signal_kwargs(domain="bus_health", source="internal-diagnosis", payload=payload))
    assert s.payload.observables is not None
    assert s.payload.observables["recommended_recovery"] is None


def test_bus_health_example_file_validates() -> None:
    example = json.loads((SCHEMA_EXAMPLES / "bus_health.json").read_text())
    sig = Signal.model_validate(example)
    assert sig.domain == "bus_health"
    assert sig.payload.satellite_id == "ctb://centralblue.dev/leo-science-1"
    assert sig.provenance.notes == "epoch=2026-09-17T14:18:38Z"


def test_space_weather_signal_validates() -> None:
    s = Signal(
        **_signal_kwargs(
            domain="space_weather",
            source="noaa-swpc",
            confidence=0.9,
            location=Location(label="geospace"),
            payload=_SPACE_WEATHER_PAYLOAD,
            provenance=Provenance(source_id="noaa-swpc", collector="megalith-space-weather-adapter"),
        )
    )
    parsed = Signal.model_validate_json(s.model_dump_json())
    assert parsed.domain == "space_weather"
    # Space weather is global: no satellite identity, location is geospace.
    assert parsed.payload.satellite_id is None
    assert parsed.location.label == "geospace"
    assert parsed.payload.observables is not None
    assert parsed.payload.observables["kp"] == 6.33


def test_space_weather_example_file_validates() -> None:
    example = json.loads((SCHEMA_EXAMPLES / "space_weather.json").read_text())
    sig = Signal.model_validate(example)
    assert sig.domain == "space_weather"
    assert sig.payload.event_type == "geomagnetic_storm"
    assert sig.payload.satellite_id is None


# ---- Bounded response (docs/INTERFACE-SPEC.md §6, spec 1.4) -------------------


def _plain_decision(**overrides) -> Decision:
    data = {
        "attribution_id": "attr-1",
        "action": "threat_warning",
        "target": "brigade-c2",
        "rationale": "watch it",
        "authority": "local",
    }
    data.update(overrides)
    return Decision(**data)


def test_decision_selection_fields_default_to_none_and_serialise_nothing_for_old_data() -> None:
    plain = _plain_decision()
    assert plain.selectable_set is None
    assert plain.selection_basis is None
    dumped = plain.model_dump(mode="json", exclude_none=True)
    assert "selectable_set" not in dumped and "selection_basis" not in dumped
    # A pre-1.4 wire record without the keys still validates.
    assert Decision.model_validate(dumped).selectable_set is None


def test_decision_selection_fields_round_trip_through_json() -> None:
    menu = ["passive_defense", "threat_warning", "sda_tasking", "active_defense_escort", "space_link_interdiction_request"]
    decision = _plain_decision(selectable_set=menu, selection_basis="model-within-set")
    again = Decision.model_validate_json(decision.model_dump_json())
    assert again.selectable_set == menu
    assert again.selection_basis == "model-within-set"
    gated = _plain_decision(
        rationale="[gate:threat/uplink_jamming_active] r",
        selectable_set=["threat_warning"], selection_basis="gate-withheld:threat/uplink_jamming_active",
    )
    assert Decision.model_validate(gated.model_dump(mode="json")) == gated


def test_decision_selectable_set_is_typed_over_the_action_vocabulary() -> None:
    with pytest.raises(ValidationError):
        _plain_decision(selectable_set=["not_an_action"])  # type: ignore[list-item]
