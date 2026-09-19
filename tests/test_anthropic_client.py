"""AnthropicLLMClient tests against a fake SDK client.

Pins the output cap, the truncation guard (a response that stops on
``max_tokens`` carries a partial tool input that parses as a valid object, so
it must be retried, never validated) and the absence of sampling parameters,
which the anthropic 1.x SDK removed from ``messages.create``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from canopy.services.kb import KB
from canopy.services.llm.anthropic_client import (
    DEFAULT_MAX_TOKENS,
    AnthropicLLMClient,
    TruncatedOutputError,
)
from canopy.services.llm.validation import UNCERTAINTY_ANCHOR
from canopy.services.schemas.events import Anomaly, Attribution

KB_FILE = Path(__file__).resolve().parent.parent / "data" / "kb_seed_entries.json"

COMPLETE_ATTRIBUTION = {
    "actor": "China",
    "confidence": 0.74,
    "doctrine_match": None,
    "evidence": [
        "Orbital segment: RPO approach assessed as consistent with kb-rpo-ambiguity-001.",
        f"Alternative actors have not been ruled out; {UNCERTAINTY_ANCHOR} applies.",
    ],
    "predicted_next": None,
    "kb_citations": ["kb-rpo-ambiguity-001", UNCERTAINTY_ANCHOR],
    "verdict": "hostile_external",
    "verdict_basis": "reasoning",
    "verdict_evidence": ["directional approach with no natural driver"],
}

# What the API hands back when max_tokens cuts the tool input: the fields the
# model had not reached are simply absent.
TRUNCATED_ATTRIBUTION = {
    "actor": "China",
    "confidence": 0.74,
    "doctrine_match": None,
    "verdict": "hostile_external",
}


class _Block:
    type = "tool_use"

    def __init__(self, name: str, payload: dict[str, Any]) -> None:
        self.name = name
        self.input = payload

    def model_dump(self) -> dict[str, Any]:
        return {"type": self.type, "name": self.name, "input": self.input}


class _Usage:
    def __init__(self, output_tokens: int) -> None:
        self.input_tokens = 1200
        self.output_tokens = output_tokens


class _Response:
    def __init__(self, payload: dict[str, Any], *, stop_reason: str, output_tokens: int) -> None:
        self.content = [_Block("submit_attribution", payload)]
        self.stop_reason = stop_reason
        self.usage = _Usage(output_tokens)


class _FakeMessages:
    def __init__(self, responses: list[_Response]) -> None:
        self._responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    async def create(self, **kwargs: Any) -> _Response:
        self.calls.append(kwargs)
        return self._responses.pop(0)


class _FakeSDK:
    def __init__(self, responses: list[_Response]) -> None:
        self.messages = _FakeMessages(responses)


def _client(
    monkeypatch, responses: list[_Response], **kwargs: Any
) -> tuple[AnthropicLLMClient, _FakeMessages]:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-never-used")
    client = AnthropicLLMClient(KB.load_from_json(KB_FILE), **kwargs)
    fake = _FakeSDK(responses)
    client._client = fake  # type: ignore[assignment]
    return client, fake.messages


def _anomaly() -> Anomaly:
    return Anomaly(
        kind="orbital_rpo_risk",
        source_signal="canopy-beat47-002",
        source_signal_ids=["canopy-beat47-002"],
        severity=0.82,
        payload={"satellite": "CANOPY-LEO-07", "summary": "test", "observables": {}},
    )


def _complete(output_tokens: int = 600) -> _Response:
    return _Response(COMPLETE_ATTRIBUTION, stop_reason="tool_use", output_tokens=output_tokens)


def _truncated(cap: int) -> _Response:
    return _Response(TRUNCATED_ATTRIBUTION, stop_reason="max_tokens", output_tokens=cap)


@pytest.mark.asyncio
async def test_attribute_uses_the_output_cap_without_sampling_params(monkeypatch) -> None:
    client, messages = _client(monkeypatch, [_complete()])

    result = await client.attribute_primary([_anomaly()])

    assert isinstance(result, Attribution)
    assert result.actor == "China"
    assert len(messages.calls) == 1
    call = messages.calls[0]
    assert call["max_tokens"] == DEFAULT_MAX_TOKENS == 4096
    assert call["tool_choice"] == {"type": "tool", "name": "submit_attribution"}
    assert "temperature" not in call and "top_p" not in call
    assert client.runtime_events == [
        {
            "input_tokens": 1200,
            "output_tokens": 600,
            "stop_reason": "tool_use",
            "stage": "attribution_primary",
            "max_tokens": 4096,
            "attempt": 1,
        }
    ]


@pytest.mark.asyncio
async def test_truncated_output_is_retried_with_a_larger_cap(monkeypatch) -> None:
    client, messages = _client(monkeypatch, [_truncated(4096), _complete()])

    result = await client.attribute_primary([_anomaly()])

    assert [c["max_tokens"] for c in messages.calls] == [4096, 8192]
    # The partial payload never reached the validator: the actor survives
    # with its citations instead of being downgraded for lacking them.
    assert result.actor == "China"
    assert "kb-rpo-ambiguity-001" in result.kb_citations
    assert [e["stop_reason"] for e in client.runtime_events] == ["max_tokens", "tool_use"]
    assert len(client.validation_events) == 1
    assert client.validation_events[0]["raw"] == COMPLETE_ATTRIBUTION


@pytest.mark.asyncio
async def test_output_truncated_twice_raises_instead_of_using_a_partial_payload(
    monkeypatch,
) -> None:
    client, messages = _client(monkeypatch, [_truncated(4096), _truncated(8192)])

    with pytest.raises(TruncatedOutputError, match="max_tokens twice"):
        await client.attribute_primary([_anomaly()])

    assert [c["max_tokens"] for c in messages.calls] == [4096, 8192]
    assert client.validation_events == []


def test_output_cap_env_override_and_explicit_argument(monkeypatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-never-used")
    monkeypatch.setenv("CANOPY_ANTHROPIC_MAX_TOKENS", "2048")
    kb = KB.load_from_json(KB_FILE)
    assert AnthropicLLMClient(kb)._max_tokens == 2048
    assert AnthropicLLMClient(kb, max_tokens=512)._max_tokens == 512
    monkeypatch.delenv("CANOPY_ANTHROPIC_MAX_TOKENS")
    assert AnthropicLLMClient(kb)._max_tokens == DEFAULT_MAX_TOKENS
