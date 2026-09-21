"""POST /stress accepts every domain in the ``Domain`` literal.

The gateway's allow-list is derived from the literal (canopy/api/__init__.py),
so the two MEGALITH domains are blockable without another hand-typed copy.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from canopy.api import app


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        yield test_client


def test_stress_accepts_bus_health_and_space_weather(client: TestClient) -> None:
    blocked = ["bus_health", "space_weather"]
    try:
        response = client.post("/stress", json={"blocked_domains": blocked})
        assert response.status_code == 200, response.text
        assert response.json()["blocked_domains"] == blocked
        assert client.get("/stress").json()["blocked_domains"] == blocked
    finally:
        assert client.post("/stress", json={"blocked_domains": []}).status_code == 200


def test_stress_rejects_unknown_domain(client: TestClient) -> None:
    response = client.post("/stress", json={"blocked_domains": ["telemetry"]})
    assert response.status_code == 400
    assert "telemetry" in response.json()["detail"]
    assert client.get("/stress").json()["blocked_domains"] == []


def test_stress_rejects_non_string_entries_with_400(client: TestClient) -> None:
    # An unhashable entry used to raise inside the membership test and answer
    # 500; docs/C2-API.md promises 400 for anything outside the vocabulary.
    for bad in ([{"domain": "rf_ew"}], [["rf_ew"]], [7], ["rf_ew", None]):
        response = client.post("/stress", json={"blocked_domains": bad})
        assert response.status_code == 400, (bad, response.status_code, response.text)
        assert "unknown domains" in response.json()["detail"]
    assert client.get("/stress").json()["blocked_domains"] == []
