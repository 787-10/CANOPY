"""The stub's counterspace-context template cites no RPO entry (MEGALITH plan item C5).

A cluster of a bus symptom and an ``sda_counterspace_context`` cue whose signal
ids index no KB entry falls back to the template's capability lookups. With an
RPO lookup there, the stub cited the RPO ambiguity entry and ``_select_decision``
routed the cluster to ``active_defense_escort`` with no RPO anomaly present
(the held-out sensor-saturation hostile case). Escorts stay keyed on
``orbital_rpo_risk``, whose own template cites the RPO entry.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from canopy.services.kb import KB
from canopy.services.llm.stub import StubLLMClient
from canopy.services.schemas.events import Anomaly

ROOT = Path(__file__).resolve().parent.parent
KB_FILE = ROOT / "data" / "kb_seed_entries.json"
SAT = "ctb://centralblue.dev/leo-science-1"
RPO_ENTRY = "kb-rpo-ambiguity-001"


def _anomaly(kind: str, signal_id: str, **payload: object) -> Anomaly:
    return Anomaly(
        id=f"anom-{kind}-{signal_id}",
        kind=kind,
        source_signal=signal_id,
        source_signal_ids=[signal_id],
        severity=0.74,
        payload={"satellite_id": SAT, **payload},
    )


def _attribute_and_decide(batch: list[Anomaly]):
    kb = KB.load_from_json(KB_FILE)
    llm = StubLLMClient(kb)

    async def go():
        attribution = await llm.attribute_primary(batch, kb.all_entries())
        attribution = attribution.model_copy(update={"verdict": "hostile_external"})
        return attribution, await llm.decide(attribution, batch)

    return asyncio.run(go())


def test_counterspace_context_without_rpo_anomaly_is_not_an_escort() -> None:
    batch = [
        _anomaly("bus_sensor_saturation", "unindexed-001", physics_consistency=0.23),
        _anomaly("sda_counterspace_context", "unindexed-003"),
    ]
    attribution, decision = _attribute_and_decide(batch)
    assert RPO_ENTRY not in attribution.kb_citations
    assert decision.action != "active_defense_escort"
    assert decision.action in {"passive_defense", "threat_warning"}
    assert decision.authority == "local"


def test_rpo_anomaly_still_routes_to_the_escort_request() -> None:
    batch = [
        _anomaly("bus_attitude_disturbance", "unindexed-001", physics_consistency=0.2),
        _anomaly("orbital_rpo_risk", "unindexed-003"),
    ]
    attribution, decision = _attribute_and_decide(batch)
    assert RPO_ENTRY in attribution.kb_citations
    assert decision.action == "active_defense_escort"
    assert decision.authority == "request"
