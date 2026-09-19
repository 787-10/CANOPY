"""Wave-1 vocabulary propagation for the MEGALITH domains and the recovery action.

docs/INTERFACE-SPEC.md §3 (bus_health kinds), §4 (space_weather kinds), §6
(recovery_recommendation), §12 (vocabulary sites and owners). Every Python and
JSON Schema site that enumerates domains must agree with the ``Domain``
literal; every anomaly kind fusion can emit must have a ``_KIND_DOMAINS``
entry and stub templates; and a batch made only of bus or space-weather
anomalies must still produce a valid Decision through the stub client.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import get_args

import pytest

from canopy.api import _ALLOWED_DOMAINS
from canopy.services.attrib import _KIND_DOMAINS
from canopy.services.bus import InProcessBus
from canopy.services.fusion import DOMAIN_PATTERN_MAP
from canopy.services.kb import KB
from canopy.services.llm.stub import (
    _KIND_TO_ATTRIBUTION,
    _KIND_TO_REDTEAM,
    StubLLMClient,
)
from canopy.services.schemas.events import (
    ACTION_AUTHORITY,
    SELECTABLE_ACTIONS,
    Anomaly,
    Attribution,
    Decision,
    Domain,
)
from canopy.services.ui_events import UIEventService

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import validate_scenarios  # noqa: E402
from services.ingest import common as ingest_common  # noqa: E402

KB_FILE = ROOT / "data" / "kb_seed_entries.json"
SIGNAL_SCHEMA = ROOT / "services" / "bus" / "schemas" / "signal.schema.json"

DOMAINS = set(get_args(Domain))

BUS_KINDS = {
    "bus_link_margin",
    "bus_sensor_saturation",
    "bus_attitude_disturbance",
    "bus_unexpected_reset",
    "bus_power_thermal",
    "bus_orbit_decay",
    "bus_safe_mode",
}
SPACE_WEATHER_KINDS = {
    "space_weather_storm",
    "space_weather_radio_burst",
    "space_weather_radiation",
    "space_weather_density",
}
# Emitted by the orbital correlator and the osint_cluster service rather than
# the pattern map, so they cannot be derived from DOMAIN_PATTERN_MAP.
NON_PATTERN_KINDS = {
    "orbital_collection_risk",
    "orbital_collection_overlap",
    "orbital_collection_correlated",
    "orbital_rpo_risk",
    "osint_semantic_cluster",
}


# ---- Domain vocabulary ------------------------------------------------------


def test_gateway_allowed_domains_derive_from_domain_literal() -> None:
    assert _ALLOWED_DOMAINS == set(get_args(Domain))
    assert {"bus_health", "space_weather"} <= _ALLOWED_DOMAINS


@pytest.mark.parametrize(
    ("site", "domains"),
    [
        ("services/ingest/common.py", ingest_common.ALLOWED_DOMAINS),
        ("scripts/validate_scenarios.py", validate_scenarios.ALLOWED_DOMAINS),
        (
            "services/bus/schemas/signal.schema.json",
            json.loads(SIGNAL_SCHEMA.read_text())["properties"]["domain"]["enum"],
        ),
    ],
    ids=["ingest", "validate_scenarios", "signal_schema"],
)
def test_domain_sites_match_domain_literal(site: str, domains) -> None:
    assert set(domains) == DOMAINS, site


# ---- _KIND_DOMAINS ----------------------------------------------------------


def test_every_fusion_kind_has_a_kind_domains_entry() -> None:
    expected = set(DOMAIN_PATTERN_MAP.values()) | NON_PATTERN_KINDS
    missing = sorted(expected - set(_KIND_DOMAINS))
    assert not missing, f"anomaly kinds without a _KIND_DOMAINS entry: {missing}"


def test_new_kinds_map_to_their_own_domain() -> None:
    for kind in BUS_KINDS:
        assert _KIND_DOMAINS[kind] == {"bus_health"}, kind
    for kind in SPACE_WEATHER_KINDS:
        assert _KIND_DOMAINS[kind] == {"space_weather"}, kind
    assert _KIND_DOMAINS["osint_semantic_cluster"] == {"osint"}


def test_kind_domains_values_are_real_domains() -> None:
    for kind, domains in _KIND_DOMAINS.items():
        assert domains, kind
        assert domains <= DOMAINS, (kind, domains)


# ---- Stub templates ---------------------------------------------------------


@pytest.mark.parametrize("kind", sorted(BUS_KINDS | SPACE_WEATHER_KINDS))
def test_stub_templates_exist_for_new_kinds(kind: str) -> None:
    attrib = _KIND_TO_ATTRIBUTION[kind]
    redteam = _KIND_TO_REDTEAM[kind]
    # Internal and natural findings carry no actor (docs/INTERFACE-SPEC.md §5).
    assert attrib.actor == "None"
    assert attrib.evidence
    assert attrib.capability_lookups
    assert redteam.alternative_actor is None
    assert redteam.objections
    assert redteam.confidence_delta <= 0.0
    if kind in BUS_KINDS:
        assert 0.55 <= attrib.confidence <= 0.70, (kind, attrib.confidence)


def test_bus_evidence_is_neutral_and_names_the_subsystem() -> None:
    subsystem_words = (
        "comms",
        "sensor",
        "adcs",
        "attitude",
        "command-and-data-handling",
        "power",
        "thermal",
        "orbit",
        "safe mode",
    )
    banned = ("confirmed", "proves", "definitively", "known hostile", "russia", "china", "iran")
    for kind in BUS_KINDS | SPACE_WEATHER_KINDS:
        text = " ".join(_KIND_TO_ATTRIBUTION[kind].evidence).lower()
        if kind in BUS_KINDS:
            assert any(word in text for word in subsystem_words), kind
        for phrase in banned:
            assert phrase not in text, (kind, phrase)


# ---- Stub end to end --------------------------------------------------------


def _anomaly(kind: str, sid: str, **payload) -> Anomaly:
    return Anomaly(
        id=f"anom-{kind}-{sid}",
        kind=kind,
        source_signal=sid,
        source_signal_ids=[sid],
        severity=0.8,
        payload=payload,
    )


SATELLITE = "ctb://centralblue.dev/leo-science-1"

BUS_BATCH = [
    _anomaly(
        "bus_link_margin",
        "sig-bus-1",
        satellite_id=SATELLITE,
        subsystem="comms",
        symptom="link_margin_db_drop",
        physics_consistency=0.83,
    ),
    _anomaly(
        "bus_safe_mode",
        "sig-bus-2",
        satellite_id=SATELLITE,
        subsystem="cdh",
        symptom="safe_mode",
        physics_consistency=0.5,
    ),
]
STORM_BATCH = [
    _anomaly("space_weather_storm", "sig-sw-1", kp=6.33, severity=0.4),
    _anomaly("space_weather_density", "sig-sw-2", kp=6.33, severity=0.4),
]


@pytest.mark.parametrize(
    "batch", [BUS_BATCH, STORM_BATCH], ids=["bus_only", "space_weather_only"]
)
async def test_stub_batch_of_new_kinds_yields_valid_attribution_and_decision(
    batch: list[Anomaly],
) -> None:
    llm = StubLLMClient(KB.load_from_json(KB_FILE))

    primary = await llm.attribute_primary(batch)
    assert primary.actor == "None"
    assert primary.kb_citations  # at least the uncertainty anchor
    challenge = await llm.attribute_redteam(primary, batch)
    final = await llm.reconcile(primary, challenge, batch)
    assert final.actor == "None"
    assert 0.49 <= final.confidence <= 1.0
    # Wave 2A owns the verdict; wave 1 templates leave it unset.
    assert final.verdict is None

    decision = await llm.decide(final)
    assert isinstance(decision, Decision)
    assert decision.action in SELECTABLE_ACTIONS
    assert decision.authority == ACTION_AUTHORITY[decision.action]
    # Wave 2B routes recoveries; until then a bus or storm batch stays passive.
    assert decision.action in ("passive_defense", "threat_warning")
    assert decision.request_packet is None
    assert set(decision.source_signal_ids) == {a.source_signal for a in batch}


@pytest.mark.parametrize(
    "batch", [BUS_BATCH, STORM_BATCH], ids=["bus_only", "space_weather_only"]
)
async def test_stub_batch_of_new_kinds_on_an_empty_kb_keeps_the_no_actor_value(
    batch: list[Anomaly],
) -> None:
    """An empty knowledge base changes nothing for a positive finding.

    The empty-KB rule (docs/INTERFACE-SPEC.md §5.3) withholds a named
    adversary; the ``None`` actor of a bus or storm batch is not one, and the
    stub still yields a valid decision. The adversary case is in
    ``tests/test_kb_provenance.py``.
    """
    kb = KB(entries=[])
    assert kb.source.path is None
    assert kb.source.entry_count == 0 and kb.source.actor_entry_count == 0
    llm = StubLLMClient(kb)

    primary = await llm.attribute_primary(batch)
    assert primary.actor == "None"
    assert primary.kb_citations == []  # nothing to cite, not even the anchor
    challenge = await llm.attribute_redteam(primary, batch)
    final = await llm.reconcile(primary, challenge, batch)
    assert final.actor == "None"
    assert 0.49 <= final.confidence <= 1.0

    decision = await llm.decide(final)
    assert isinstance(decision, Decision)
    assert decision.action in ("passive_defense", "threat_warning")
    assert decision.authority == ACTION_AUTHORITY[decision.action]


# ---- UI events --------------------------------------------------------------


def test_recovery_recommendation_ui_event_is_medium_and_titled() -> None:
    service = UIEventService(InProcessBus())
    attribution = Attribution(
        anomaly_ids=["anom-1"],
        actor="None",
        confidence=0.83,
        verdict="internal_fault",
        verdict_basis="rule",
        satellite_id=SATELLITE,
        source_signal_ids=["sig-bus-1"],
    )
    decision = Decision(
        attribution_id=attribution.id,
        action="recovery_recommendation",
        target="LEO-SCIENCE-1 comms",
        rationale="Switching to the redundant amplifier; primary output trending down.",
        authority="local",
        source_signal_ids=["sig-bus-1"],
    )
    event = service._build_ui_event(decision, attribution)
    # Actor "None" is never appended to a title.
    assert event.title == "Recovery recommendation"
    # Medium even though the attribution is confident: a recovery is not an
    # escalation (docs/INTERFACE-SPEC.md §6).
    assert event.severity == "medium"
    assert event.type == "threat_updated"
    assert event.recommendation is None
    assert event.confidence == 0.83
