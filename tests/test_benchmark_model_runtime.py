from __future__ import annotations

import httpx

from bench.model_runtime import preflight_model
from bench.specs import ModelSpec


def test_stub_preflight_is_offline_and_available() -> None:
    result = preflight_model(
        ModelSpec(id="stub", provider="stub", model="deterministic-control")
    )

    assert result["available"] is True
    assert result["model"] == "deterministic-control"


def test_ollama_preflight_records_exact_model_digest() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/tags"
        return httpx.Response(
            200,
            json={
                "models": [
                    {
                        "name": "gemma3:4b",
                        "digest": "sha256:abc",
                        "size": 3_300_000_000,
                        "details": {"quantization_level": "Q4_K_M"},
                    }
                ]
            },
        )

    spec = ModelSpec(
        id="gemma3-4b",
        provider="ollama",
        model="gemma3:4b",
        endpoint="http://ollama:11434",
    )
    result = preflight_model(spec, transport=httpx.MockTransport(handler))

    assert result["available"] is True
    assert result["digest"] == "sha256:abc"
    assert result["quantization"] == "Q4_K_M"


def test_ollama_preflight_fails_closed_for_missing_model() -> None:
    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, json={"models": []})
    )
    spec = ModelSpec(
        id="missing",
        provider="ollama",
        model="missing:1b",
        endpoint="http://ollama:11434",
    )

    result = preflight_model(spec, transport=transport)

    assert result["available"] is False
    assert "not installed" in result["error"]
