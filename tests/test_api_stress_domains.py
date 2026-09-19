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
