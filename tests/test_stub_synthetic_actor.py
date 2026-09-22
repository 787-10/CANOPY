"""The stub names the knowledge base's actor, never a real state, when the
knowledge base carries only synthetic actors (demo plan section 6)."""

from __future__ import annotations

import asyncio
from pathlib import Path

from canopy.services.kb import KB
from canopy.services.llm.stub import StubLLMClient
from canopy.services.schemas.events import Anomaly

ROOT = Path(__file__).resolve().parent.parent
REAL = ("Russia", "Russian", "China", "Chinese", "Iran")


def _rf_anomaly() -> Anomaly:
    return Anomaly(
        id="a-rf",
        kind="rf_anomaly",
        source_signal="sig-1",
        source_signal_ids=["sig-1"],
        severity=0.8,
        payload={"satellite_id": "ctb://megalith.demo/sim-01", "domain": "rf_ew"},
    )


def test_demo_kb_gets_actor_1_and_no_real_name_in_the_evidence() -> None:
    kb = KB.load_from_json(ROOT / "data" / "kb_megalith_demo.json")
    assert kb.actors() == ["Actor-1"]
    client = StubLLMClient(kb)
    primary = asyncio.run(client.attribute_primary([_rf_anomaly()]))
    assert primary.actor == "Actor-1"
    text = " ".join(primary.evidence)
    assert not any(name in text for name in REAL), text
    challenge = asyncio.run(client.attribute_redteam(primary, [_rf_anomaly()]))
    assert challenge.alternative_actor in (None, "Actor-1")
    joined = " ".join([*challenge.objections, challenge.rationale])
    assert not any(name in joined for name in REAL), joined


def test_a_kb_that_knows_the_template_actor_keeps_it() -> None:
    kb = KB.load_from_json(ROOT / "data" / "kb_seed_entries.json")
    client = StubLLMClient(kb)
    primary = asyncio.run(client.attribute_primary([_rf_anomaly()]))
    if "Russia" in kb.actors():
        assert primary.actor == "Russia"
    else:
        assert primary.actor == (kb.actors()[0] if kb.actors() else "Russia")
