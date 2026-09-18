from __future__ import annotations

import json
import logging
import os
from collections.abc import Iterable
from typing import Any

from canopy.services.kb import KB
from canopy.services.kb.models import KBEntry
from canopy.services.llm.validation import (
    RuleVerdictLike,
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

# Output cap per call. The attribution payload (evidence chain, citations,
# verdict evidence) ran past the old 1024-token cap on claude-sonnet-4-6, and
# the API returns a tool input cut off at max_tokens as a silently partial
# object: the missing fields are simply absent, so the validator saw no
# citations and downgraded a correctly named actor to Unknown.
DEFAULT_MAX_TOKENS = 4096
TRUNCATION_RETRY_FACTOR = 2


class TruncatedOutputError(ValueError):
    """The model stopped on ``max_tokens`` mid tool input twice in a row."""


def _verdict_fields(payload: dict[str, Any]) -> dict[str, Any]:
    """Verdict lane fields from a validated attribution payload (spec §5)."""
    return {
        "verdict": payload.get("verdict"),
        "verdict_basis": payload.get("verdict_basis"),
        "verdict_evidence": list(payload.get("verdict_evidence") or []),
    }


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
        max_tokens: int | None = None,
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
        # Kept for provenance only: the anthropic SDK 1.x removed the sampling
        # parameters from messages.create(); current models reject them anyway.
        self._temperature = temperature
        self._max_tokens = int(
            max_tokens
            or os.environ.get("CANOPY_ANTHROPIC_MAX_TOKENS")
            or DEFAULT_MAX_TOKENS
        )
        self.validation_events: list[dict[str, Any]] = []
        self.runtime_events: list[dict[str, Any]] = []

    def _record_usage(self, response: Any, **context: Any) -> None:
        usage = getattr(response, "usage", None)
        event: dict[str, Any] = {
            "input_tokens": getattr(usage, "input_tokens", None),
            "output_tokens": getattr(usage, "output_tokens", None),
            "stop_reason": getattr(response, "stop_reason", None),
        }
        event.update(context)
        self.runtime_events.append(event)

    async def _create(self, *, stage: str, **kwargs: Any) -> Any:
        """``messages.create`` with the output cap and a truncation guard.

        A response that stops on ``max_tokens`` carries a partial tool input
        that still parses as a valid object, which the validator would then
        repair into a downgrade. Retry once with a larger cap; raise if the
        second attempt is cut off as well rather than use a partial payload.
        """
        max_tokens = self._max_tokens
        for attempt in (1, 2):
            response = await self._client.messages.create(
                model=self._model, max_tokens=max_tokens, **kwargs
            )
            self._record_usage(
                response, stage=stage, max_tokens=max_tokens, attempt=attempt
            )
            if getattr(response, "stop_reason", None) != "max_tokens":
                return response
            log.warning(
                "ANTHROPIC: %s output truncated at max_tokens=%d (attempt %d)",
                stage,
                max_tokens,
                attempt,
            )
            max_tokens *= TRUNCATION_RETRY_FACTOR
        raise TruncatedOutputError(
            f"Anthropic {stage} output stopped on max_tokens twice "
            f"(last cap {max_tokens // TRUNCATION_RETRY_FACTOR}); "
            "refusing to use a partial tool input"
        )

    async def attribute(
        self, anomalies: list[Anomaly], kb_context: Iterable[KBEntry] = ()
    ) -> Attribution:
        return await self.attribute_primary(anomalies, kb_context)

    async def attribute_primary(
        self,
        anomalies: list[Anomaly],
        kb_context: Iterable[KBEntry] = (),
        *,
        rule_verdict: RuleVerdictLike | None = None,
    ) -> Attribution:
        from canopy.services.attrib.prompts import (
            attribution_system_prompt,
            attribution_tool,
            attribution_user_prompt,
        )

        relevant = self._resolve_kb_context(anomalies, kb_context)
        tool = attribution_tool(rule_verdict)

        response = await self._create(
            stage="attribution_primary",
            system=attribution_system_prompt(),
            tools=[tool],
            tool_choice={"type": "tool", "name": tool["name"]},
            messages=[
                {
                    "role": "user",
                    "content": attribution_user_prompt(anomalies, relevant, rule_verdict),
                }
            ],
        )
        payload = _extract_tool_input(response, tool["name"])
        raw = dict(payload)
        validation = validate_and_repair_attribution(payload, rule_verdict)
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
            **_verdict_fields(payload),
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

        response = await self._create(
            stage="attribution_redteam",
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
        *,
        rule_verdict: RuleVerdictLike | None = None,
    ) -> Attribution:
        from canopy.services.attrib.prompts import (
            attribution_tool,
            reconcile_system_prompt,
            reconcile_user_prompt,
        )

        relevant = self._resolve_kb_context(anomalies, kb_context)
        tool = attribution_tool(rule_verdict)

        response = await self._create(
            stage="attribution_reconcile",
            system=reconcile_system_prompt(),
            tools=[tool],
            tool_choice={"type": "tool", "name": tool["name"]},
            messages=[
                {
                    "role": "user",
                    "content": reconcile_user_prompt(
                        primary, challenge, anomalies, relevant, rule_verdict
                    ),
                }
            ],
        )
        payload = _extract_tool_input(response, tool["name"])
        raw = dict(payload)
        validation = validate_and_repair_attribution(payload, rule_verdict)
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
            **_verdict_fields(payload),
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

        response = await self._create(
            stage="decision",
            system=decision_system_prompt(),
            tools=[DECISION_TOOL],
            tool_choice={"type": "tool", "name": DECISION_TOOL["name"]},
            messages=[
                {"role": "user", "content": decision_user_prompt(attribution)}
            ],
        )
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
            # The validator has already normalised an echoed recovery block
            # to a well-formed dict or None (spec §6 invariants); keep it so
            # the round trip is not lossy.
            recovery=payload.get("recovery"),
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
