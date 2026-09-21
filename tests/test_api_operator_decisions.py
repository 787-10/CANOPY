"""POST /decisions/{id}/operator records the operator's call and traces it.

The console's Accept, Deny and Reconsider post here; the gateway keeps the
latest call per decision, emits a decide-stage trace line, and forgets the
calls on ``POST /reset``.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from canopy.api import app


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        yield test_client


def test_operator_call_is_recorded_traced_and_reset(client: TestClient) -> None:
    try:
        response = client.post(
            "/decisions/dec-1/operator",
            json={"status": "accepted", "action": "threat_warning", "authority": "local", "target": "space-ops-c2"},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "recorded"
        assert body["trace"] == "operator accepted: threat_warning → space-ops-c2"
        assert body["record"]["decision_id"] == "dec-1"

        listed = client.get("/decisions/operator").json()["decisions"]
        assert [d["decision_id"] for d in listed] == ["dec-1"]
        assert listed[0]["status"] == "accepted"

        denied = client.post(
            "/decisions/dec-1/operator",
            json={"status": "denied", "action": "threat_warning", "authority": "local", "target": "space-ops-c2"},
        ).json()
        assert denied["trace"] == "operator denied: threat_warning → space-ops-c2"
        assert client.get("/decisions/operator").json()["decisions"][0]["status"] == "denied"

        reconsidered = client.post(
            "/decisions/dec-1/operator", json={"status": "reconsidered", "action": "threat_warning"}
        ).json()
        assert reconsidered["trace"] == "operator reconsidered: threat_warning"
    finally:
        assert client.post("/reset").status_code == 200
    assert client.get("/decisions/operator").json()["decisions"] == []


def test_operator_call_rejects_an_unknown_status(client: TestClient) -> None:
    response = client.post("/decisions/dec-2/operator", json={"status": "maybe"})
    assert response.status_code == 400
    assert "accepted" in response.json()["detail"]
    assert client.get("/decisions/operator").json()["decisions"] == []


def test_operator_call_rejects_a_non_string_attribution_id(client: TestClient) -> None:
    # The id keys the tracer's arrival marks; a list used to raise there (500).
    response = client.post(
        "/decisions/dec-3/operator", json={"status": "accepted", "attribution_id": ["attr-1"]}
    )
    assert response.status_code == 400
    assert "attribution_id" in response.json()["detail"]
    assert client.get("/decisions/operator").json()["decisions"] == []
    try:
        # A string id and no id at all are both accepted.
        for attribution_id in ("attr-1", None):
            response = client.post(
                "/decisions/dec-3/operator",
                json={"status": "accepted", "attribution_id": attribution_id},
            )
            assert response.status_code == 200, response.text
            assert response.json()["record"]["attribution_id"] == attribution_id
    finally:
        assert client.post("/reset").status_code == 200
