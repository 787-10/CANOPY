"""Smoke tests for the FastAPI gateway."""
from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from canopy.api import app


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        yield test_client


def test_health(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["kb_entries"] >= 5


def test_list_scenarios(client: TestClient) -> None:
    response = client.get("/scenarios")
    assert response.status_code == 200
    scenarios = response.json()
    # We have 11 checked-in scenarios at the time of this test (4 canonical
    # beats + 4 army + 3 iran). Lower bound is more useful than exact match
    # so adding a scenario doesn't fail this test.
    assert len(scenarios) >= 11
    assert "beat47.jsonl" in scenarios
    assert "army_multidomain_attack_chain.jsonl" in scenarios


def test_scenario_registry_exposes_demo_metadata(client: TestClient) -> None:
    response = client.get("/scenario-registry")

    assert response.status_code == 200
    payload = response.json()
    assert payload["schema_version"] == 1
    by_file = {case["file"]: case for case in payload["cases"]}
    assert by_file["beat47.jsonl"]["short_name"] == "SATCOM gateway"
    assert "demo" in by_file["beat47.jsonl"]["visibility"]


def test_replay_unknown_scenario_404(client: TestClient) -> None:
    response = client.post("/scenarios/does_not_exist.jsonl/replay")
    assert response.status_code == 404


def test_replay_known_scenario_returns_200(client: TestClient) -> None:
    response = client.post("/scenarios/beat47.jsonl/replay?speed=1000")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "replaying"
    assert body["scenario"] == "beat47.jsonl"


def test_websocket_receives_ui_event_after_replay(client: TestClient) -> None:
    """Connect WS, trigger a replay, assert a ui_event envelope arrives."""
    with client.websocket_connect("/ws") as ws:
        # Kick off a replay; the WS should start receiving envelopes.
        response = client.post("/scenarios/beat47.jsonl/replay?speed=1000")
        assert response.status_code == 200

        # Drain envelopes until we see a ui_event or run out of patience.
        # beat47 has 6 signals; with speed=1000 the replay completes in ms.
        # Stub LLM is sub-millisecond, so a ui_event should arrive promptly.
        saw_ui_event = False
        # OSINT clustering loads sentence-transformer weights on the
        # first OSINT signal (multi-second cold start) and
        # orbit.compute_close_approach iterates Skyfield SGP4 over 360
        # samples per call. Give the pipeline a generous budget so this
        # test isn't flaky on cold caches.
        deadline = time.time() + 60.0
        kinds_seen: list[str] = []
        while time.time() < deadline:
            envelope = ws.receive_json()
            kinds_seen.append(envelope.get("kind"))
            if envelope.get("kind") == "ui_event":
                saw_ui_event = True
                break
        assert saw_ui_event, f"no ui_event seen within deadline; kinds={kinds_seen}"


def test_post_signal_publishes_to_bus(client: TestClient) -> None:
    payload = {
        "id": "test-sig-001",
        "ts": "2026-06-18T14:30:00Z",
        "domain": "rf_ew",
        "source": "test",
        "realism": "mock_operational",
        "confidence": 0.85,
        "location": {"label": "test"},
        "payload": {"event_type": "rf_interference", "summary": "test"},
        "provenance": {"source_id": "test"},
    }
    response = client.post("/signals", json=payload)
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "queued"
    assert body["id"] == "test-sig-001"
