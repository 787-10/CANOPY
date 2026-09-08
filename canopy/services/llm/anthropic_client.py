from __future__ import annotations

import json
import logging
import os
from collections.abc import Iterable
from typing import Any

from canopy.services.kb import KB
from canopy.services.kb.models import KBEntry
from canopy.services.llm.validation import (
    validate_and_repair_attribution,
    validate_and_repair_decision,
)
from canopy.services.schemas.events import (
    Anomaly,
    Attribution,
    AttributionChallenge,
    Decision,
)

log = logging.getLogger(__name__)

DEFAULT_MODEL = "claude-sonnet-4-6"


class AnthropicLLMClient:
    """Live LLMClient backed by the Anthropic API.

    Foundation-pass implementation: thin wrapper around tool-use with strict
    JSON-typed tools. Prompt content lives in
    ``canopy.services.{attrib,decide}.prompts`` so prompt iteration is a
    single-file change in the next pass. The ``anthropic`` SDK is imported
    lazily so stub-only runs do not require an API key.
    """

    def __init__(
        self,
        kb: KB,
        *,
        model: str = DEFAULT_MODEL,
        temperature: float = 0.0,
        timeout_s: float | None = None,
    ) -> None:
        from anthropic import AsyncAnthropic

        self._kb = kb
        self._model = model
        client_kwargs: dict[str, Any] = {
            "api_key": os.environ.get("ANTHROPIC_API_KEY")
        }
        if timeout_s is not None:
            client_kwargs["timeout"] = timeout_s
        self._client = AsyncAnthropic(**client_kwargs)
        self._temperature = temperature
        self.validation_events: list[dict[str, Any]] = []
        self.runtime_events: list[dict[str, Any]] = []

    def _record_usage(self, response: Any) -> None:
        usage = getattr(response, "usage", None)
        if usage is None:
            return
        self.runtime_events.append(
            {
                "input_tokens": getattr(usage, "input_tokens", None),
                "output_tokens": getattr(usage, "output_tokens", None),
            }
        )

    async def attribute(
        self, anomalies: list[Anomaly], kb_context: Iterable[KBEntry] = ()
    ) -> Attribution:
        return await self.attribute_primary(anomalies, kb_context)

    async def attribute_primary(
        self, anomalies: list[Anomaly], kb_context: Iterable[KBEntry] = ()
    ) -> Attribution:
        from canopy.services.attrib.prompts import (
            ATTRIBUTION_TOOL,
            attribution_system_prompt,
            attribution_user_prompt,
        )

        relevant = self._resolve_kb_context(anomalies, kb_context)

        response = await self._client.messages.create(
            model=self._model,
            max_tokens=1024,
            temperature=self._temperature,
            system=attribution_system_prompt(),
            tools=[ATTRIBUTION_TOOL],
            tool_choice={"type": "tool", "name": ATTRIBUTION_TOOL["name"]},
            messages=[
                {
                    "role": "user",
                    "content": attribution_user_prompt(anomalies, relevant),
                }
            ],
        )
        self._record_usage(response)
        payload = _extract_tool_input(response, ATTRIBUTION_TOOL["name"])
        raw = dict(payload)
        validation = validate_and_repair_attribution(payload)
        self.validation_events.append(
            {
                "stage": "attribution",
                "raw": raw,
                "repaired": dict(validation.repaired),
                "flags": list(validation.flags),
            }
        )
        payload = validation.repaired
        return Attribution(
            anomaly_ids=[a.id for a in anomalies],
            actor=payload["actor"],
            confidence=float(payload["confidence"]),
            doctrine_match=payload.get("doctrine_match"),
            evidence=list(payload.get("evidence", [])),
            predicted_next=payload.get("predicted_next"),
            kb_citations=list(payload.get("kb_citations", [])),
            source_signal_ids=list(
                dict.fromkeys(sid for a in anomalies for sid in a.source_signal_ids)
            ),
        )

    async def attribute_redteam(
        self,
        primary: Attribution,
        anomalies: list[Anomaly],
        kb_context: Iterable[KBEntry] = (),
    ) -> AttributionChallenge:
        from canopy.services.attrib.prompts import (
            REDTEAM_TOOL,
            redteam_system_prompt,
            redteam_user_prompt,
        )

        relevant = self._resolve_kb_context(anomalies, kb_context)

        response = await self._client.messages.create(
            model=self._model,
            max_tokens=1024,
            temperature=self._temperature,
            system=redteam_system_prompt(),
            tools=[REDTEAM_TOOL],
            tool_choice={"type": "tool", "name": REDTEAM_TOOL["name"]},
            messages=[
                {
                    "role": "user",
                    "content": redteam_user_prompt(primary, anomalies, relevant),
                }
            ],
        )
        self._record_usage(response)
        payload = _extract_tool_input(response, REDTEAM_TOOL["name"])
        return AttributionChallenge(
            primary_attribution_id=primary.id,
            alternative_actor=payload.get("alternative_actor"),
            objections=list(payload.get("objections", [])),
            confidence_delta=float(payload.get("confidence_delta", 0.0)),
            rationale=payload.get("rationale", ""),
        )

    async def reconcile(
        self,
        primary: Attribution,
        challenge: AttributionChallenge,
        anomalies: list[Anomaly],
        kb_context: Iterable[KBEntry] = (),
    ) -> Attribution:
        from canopy.services.attrib.prompts import (
            ATTRIBUTION_TOOL,
            reconcile_system_prompt,
            reconcile_user_prompt,
        )

        relevant = self._resolve_kb_context(anomalies, kb_context)

        response = await self._client.messages.create(
            model=self._model,
            max_tokens=1024,
            temperature=self._temperature,
            system=reconcile_system_prompt(),
            tools=[ATTRIBUTION_TOOL],
            tool_choice={"type": "tool", "name": ATTRIBUTION_TOOL["name"]},
            messages=[
                {
                    "role": "user",
                    "content": reconcile_user_prompt(
                        primary, challenge, anomalies, relevant
                    ),
                }
            ],
        )
        self._record_usage(response)
        payload = _extract_tool_input(response, ATTRIBUTION_TOOL["name"])
        raw = dict(payload)
        validation = validate_and_repair_attribution(payload)
        self.validation_events.append(
            {
                "stage": "attribution",
                "raw": raw,
                "repaired": dict(validation.repaired),
                "flags": list(validation.flags),
            }
        )
        payload = validation.repaired
        return Attribution(
            anomaly_ids=list(primary.anomaly_ids),
            actor=payload["actor"],
            confidence=float(payload["confidence"]),
            doctrine_match=payload.get("doctrine_match"),
            evidence=list(payload.get("evidence", [])),
            predicted_next=payload.get("predicted_next"),
            kb_citations=list(payload.get("kb_citations", [])),
            source_signal_ids=list(primary.source_signal_ids),
        )

    def _resolve_kb_context(
        self,
        anomalies: list[Anomaly],
        kb_context: Iterable[KBEntry],
    ) -> list[KBEntry]:
        relevant: list[KBEntry] = list(kb_context)
        if relevant:
            return relevant
        seen: set[str] = set()
        for a in anomalies:
            for sid in a.source_signal_ids:
                for entry in self._kb.by_scenario_signal_id(sid):
                    if entry.id not in seen:
                        relevant.append(entry)
                        seen.add(entry.id)
        if not relevant:
            relevant = self._kb.all_entries()
        return relevant

    async def decide(self, attribution: Attribution) -> Decision:
        from canopy.services.decide.prompts import (
            DECISION_TOOL,
            decision_system_prompt,
            decision_user_prompt,
        )

        response = await self._client.messages.create(
            model=self._model,
            max_tokens=1024,
            temperature=self._temperature,
            system=decision_system_prompt(),
            tools=[DECISION_TOOL],
            tool_choice={"type": "tool", "name": DECISION_TOOL["name"]},
            messages=[
                {"role": "user", "content": decision_user_prompt(attribution)}
            ],
        )
        self._record_usage(response)
        payload = _extract_tool_input(response, DECISION_TOOL["name"])
        raw = dict(payload)
        payload = validate_and_repair_decision(payload)
        self.validation_events.append(
            {
                "stage": "decision",
                "raw": raw,
                "repaired": dict(payload),
                "flags": [],
            }
        )
        return Decision(
            attribution_id=attribution.id,
            action=payload["action"],
            target=payload["target"],
            rationale=payload["rationale"],
            authority=payload["authority"],
            request_packet=payload.get("request_packet"),
            source_signal_ids=list(attribution.source_signal_ids),
        )


def _extract_tool_input(response: Any, tool_name: str) -> dict:
    for block in response.content:
        if getattr(block, "type", None) == "tool_use" and block.name == tool_name:
            return block.input  # type: ignore[no-any-return]
    raise ValueError(
        f"Anthropic response did not contain a tool_use for {tool_name}: "
        f"{json.dumps([b.model_dump() for b in response.content], default=str)[:500]}"
    )
