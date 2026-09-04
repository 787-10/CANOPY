"""OllamaLLMClient tests against a mocked Ollama daemon.

Pins the wire format the client speaks to Ollama, the env-var configuration
plumbing, and the JSON-extraction fallback for sloppy model output.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from canopy.services.kb import KB
from canopy.services.llm.ollama_client import OllamaLLMClient, _extract_json
from canopy.services.schemas.events import Anomaly, Attribution

KB_FILE = Path(__file__).resolve().parent.parent / "data" / "kb_seed_entries.json"


def _kb() -> KB:
    return KB.load_from_json(KB_FILE)


def _anomaly() -> Anomaly:
    return Anomaly(
        kind="orbital_rpo_risk",
        source_signal="canopy-beat47-002",
        source_signal_ids=["canopy-beat47-002"],
        severity=0.82,
        payload={
            "satellite": "CANOPY-LEO-07",
            "asset": "UNKNOWN-RSO-441",
            "summary": "test",
            "observables": {"miss_distance_km": 8.6},
        },
    )


def _attribution() -> Attribution:
    return Attribution(
        anomaly_ids=["anom-1"],
        actor="China",
        confidence=0.74,
        evidence=["test"],
        kb_citations=["kb-rpo-ambiguity-001", "kb-attribution-uncertainty-001"],
        source_signal_ids=["canopy-beat47-002"],
    )


# ---- _extract_json behavior --------------------------------------------------


def test_extract_json_clean() -> None:
    assert _extract_json('{"a": 1}') == {"a": 1}


def test_extract_json_strips_markdown_fence() -> None:
    text = "```json\n{\"a\": 1}\n```"
    assert _extract_json(text) == {"a": 1}


def test_extract_json_finds_brace_block_in_prose() -> None:
    text = 'Here is the answer: {"a": 1, "b": [2,3]}. Hope that helps!'
    assert _extract_json(text) == {"a": 1, "b": [2, 3]}


def test_extract_json_raises_on_garbage() -> None:
    with pytest.raises(json.JSONDecodeError):
        _extract_json("definitely not JSON")


# ---- Constructor / env wiring -----------------------------------------------


def test_constructor_uses_explicit_args_over_env(monkeypatch) -> None:
    monkeypatch.setenv("CANOPY_OLLAMA_URL", "http://env-host:11434")
    monkeypatch.setenv("CANOPY_OLLAMA_MODEL", "env-model")
    client = OllamaLLMClient(
        _kb(),
        model="explicit-model",
        base_url="http://explicit-host:99",
        timeout_s=42.0,
        temperature=0.0,
        seed=7,
    )
    assert client._model == "explicit-model"
    assert client._base_url == "http://explicit-host:99"
    assert client._timeout_s == 42.0
    assert client._temperature == 0.0
    assert client._seed == 7


def test_constructor_picks_up_env_when_no_args(monkeypatch) -> None:
    monkeypatch.setenv("CANOPY_OLLAMA_URL", "http://env-host:11434")
    monkeypatch.setenv("CANOPY_OLLAMA_MODEL", "env-model")
    monkeypatch.setenv("CANOPY_OLLAMA_TIMEOUT_S", "30")
    client = OllamaLLMClient(_kb())
    assert client._model == "env-model"
    assert client._base_url == "http://env-host:11434"
    assert client._timeout_s == 30.0


def test_constructor_strips_trailing_slash_from_base_url() -> None:
    client = OllamaLLMClient(_kb(), base_url="http://x:11434/")
    assert client._base_url == "http://x:11434"


# ---- attribute() and decide() against a mocked Ollama daemon ---------------


class _FakeOllamaTransport(httpx.AsyncBaseTransport):
    """Mock transport that records the wire request and returns a canned reply."""

    def __init__(self, response_payload: dict[str, Any]) -> None:
        self.response_payload = response_payload
        self.requests: list[dict[str, Any]] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(json.loads(request.content))
        body = {"message": {"content": json.dumps(self.response_payload)}}
        return httpx.Response(200, json=body)


async def test_attribute_speaks_correct_wire_format() -> None:
    canned = {
        "actor": "China",
        "confidence": 0.78,
        "doctrine_match": "kb-rpo-ambiguity-001",
        "evidence": ["consistent with SJ-21 precedent"],
        "predicted_next": "watch for SATCOM compound effect",
        "kb_citations": ["kb-rpo-ambiguity-001", "kb-attribution-uncertainty-001"],
    }
    transport = _FakeOllamaTransport(canned)

    client = OllamaLLMClient(
        _kb(), base_url="http://fake:11434", model="gemma4:26b", transport=transport
    )
    attribution = await client.attribute([_anomaly()])

    assert attribution.actor == "China"
    assert attribution.confidence == pytest.approx(0.78)
    assert attribution.kb_citations == [
        "kb-rpo-ambiguity-001",
        "kb-attribution-uncertainty-001",
    ]
    assert attribution.source_signal_ids == ["canopy-beat47-002"]

    # Check the wire request shape
    assert len(transport.requests) == 1
    req = transport.requests[0]
    assert req["model"] == "gemma4:26b"
    assert req["stream"] is False
    assert req["messages"][0]["role"] == "system"
    assert req["messages"][1]["role"] == "user"
    # Schema-typed structured output (Ollama ≥ 0.5)
    assert isinstance(req["format"], dict)
    assert req["options"] == {"temperature": 0.0, "seed": 1337}
    # The user prompt should echo the schema as a markdown fence so smaller
    # models that ignore the format hint still have it in context.
    assert "```json" in req["messages"][1]["content"]


async def test_decide_speaks_correct_wire_format() -> None:
    canned = {
        "action": "active_defense_escort",
        "target": "threatened_geo_asset",
        "rationale": "Reposition request to CJFSCC.",
        "authority": "request",
        "request_packet": {"to": "CJFSCC"},
    }
    transport = _FakeOllamaTransport(canned)

    client = OllamaLLMClient(
        _kb(), base_url="http://fake:11434", model="gemma4:26b", transport=transport
    )
    decision = await client.decide(_attribution())

    assert decision.action == "active_defense_escort"
    assert decision.authority == "request"
    assert decision.target == "threatened_geo_asset"
    assert decision.request_packet == {"to": "CJFSCC"}
    # source_signal_ids should propagate from the attribution.
    assert decision.source_signal_ids == ["canopy-beat47-002"]


async def test_attribute_falls_back_to_plain_json_format_if_schema_rejected() -> None:
    """Older Ollama versions don't accept a schema dict in `format`. The
    client should retry with `format="json"` and still succeed."""
    canned = {
        "actor": "Unknown",
        "confidence": 0.5,
        "evidence": ["fallback"],
        "kb_citations": ["kb-attribution-uncertainty-001"],
    }
    seen_formats: list[Any] = []

    class _SchemaRejectingTransport(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            seen_formats.append(body.get("format"))
            if isinstance(body.get("format"), dict):
                # Old Ollama: 400 on schema dict
                return httpx.Response(400, json={"error": "schema unsupported"})
            return httpx.Response(
                200, json={"message": {"content": json.dumps(canned)}}
            )

    transport = _SchemaRejectingTransport()
    client = OllamaLLMClient(
        _kb(), base_url="http://fake:11434", model="gemma4:e2b", transport=transport
    )
    attribution = await client.attribute([_anomaly()])

    assert attribution.actor == "Unknown"
    # Two attempts: schema first, then json fallback.
    assert len(seen_formats) == 2
    assert isinstance(seen_formats[0], dict)
    assert seen_formats[1] == "json"


async def test_ollama_applies_common_attribution_repair() -> None:
    transport = _FakeOllamaTransport(
        {
            "actor": "Example Actor",
            "confidence": 0.9,
            "evidence": [],
            "kb_citations": [],
        }
    )
    client = OllamaLLMClient(_kb(), transport=transport)

    attribution = await client.attribute([_anomaly()])

    assert attribution.actor == "Unknown"
    assert attribution.confidence == 0.49
    assert client.validation_events[-1]["stage"] == "attribution"
    assert client.validation_events[-1]["raw"]["actor"] == "Example Actor"
    assert client.validation_events[-1]["repaired"]["actor"] == "Unknown"
