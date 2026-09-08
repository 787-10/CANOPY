"""Local LLM client backed by Ollama.

Talks to a running Ollama daemon (default: ``http://localhost:11434``) over
HTTP and uses Ollama's structured-output feature to force JSON conforming to
the same input_schemas the Anthropic tool-use path defines. Designed to drop
in behind ``LLMClient`` so the rest of the engine doesn't notice which
backend is producing Attributions and Decisions.

Configure via env vars (or constructor args):

* ``CANOPY_OLLAMA_URL`` — base URL of the Ollama daemon. Over Tailscale this
  is typically ``http://<machine-name>:11434`` or ``http://<100.x.x.x>:11434``.
* ``CANOPY_OLLAMA_MODEL`` — the model tag to use (e.g. ``gemma3:4b``).
* ``CANOPY_OLLAMA_TIMEOUT_S`` — per-request HTTP timeout (default 180 s).
"""
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

DEFAULT_OLLAMA_URL = "http://localhost:11434"
DEFAULT_OLLAMA_MODEL = "gemma3:4b"
DEFAULT_TIMEOUT_S = 180.0


class OllamaLLMClient:
    """Local LLMClient backed by Ollama's HTTP API.

    Uses ``/api/chat`` with ``format=<json schema>`` so the model output is
    constrained to the same input_schema the Anthropic tool-use path uses.
    Falls back to ``format="json"`` (free-form JSON) if the daemon doesn't
    accept a schema dict — older Ollama versions only support the boolean
    JSON-mode flag.
    """

    def __init__(
        self,
        kb: KB,
        *,
        model: str | None = None,
        base_url: str | None = None,
        timeout_s: float | None = None,
        temperature: float = 0.0,
        seed: int = 1337,
        transport: Any | None = None,
    ) -> None:
        self._kb = kb
        self._model = model or os.environ.get("CANOPY_OLLAMA_MODEL", DEFAULT_OLLAMA_MODEL)
        url = base_url or os.environ.get("CANOPY_OLLAMA_URL", DEFAULT_OLLAMA_URL)
        self._base_url = url.rstrip("/")
        timeout = timeout_s
        if timeout is None:
            timeout_env = os.environ.get("CANOPY_OLLAMA_TIMEOUT_S")
            timeout = float(timeout_env) if timeout_env else DEFAULT_TIMEOUT_S
        self._timeout_s = timeout
        self._temperature = temperature
        self._seed = seed
        self.validation_events: list[dict[str, Any]] = []
        self.runtime_events: list[dict[str, Any]] = []
        # Optional transport injection for tests; production code leaves it
        # None and httpx picks the default httpx.AsyncHTTPTransport.
        self._transport = transport
        log.info(
            "ollama: configured base_url=%s model=%s timeout=%.0fs",
            self._base_url,
            self._model,
            self._timeout_s,
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

        source_ids = [sid for a in anomalies for sid in a.source_signal_ids]
        relevant = self._resolve_kb_context(anomalies, kb_context)

        schema = ATTRIBUTION_TOOL["input_schema"]
        payload = await self._chat(
            system=attribution_system_prompt(),
            user=attribution_user_prompt(anomalies, relevant),
            schema=schema,
        )
        payload = self._repair_attribution(payload)
        return Attribution(
            anomaly_ids=[a.id for a in anomalies],
            actor=str(payload.get("actor", "Unknown")),
            confidence=float(payload.get("confidence", 0.5)),
            doctrine_match=payload.get("doctrine_match"),
            evidence=list(payload.get("evidence", [])),
            predicted_next=payload.get("predicted_next"),
            kb_citations=list(payload.get("kb_citations", [])),
            source_signal_ids=list(dict.fromkeys(source_ids)),
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
        schema = REDTEAM_TOOL["input_schema"]
        payload = await self._chat(
            system=redteam_system_prompt(),
            user=redteam_user_prompt(primary, anomalies, relevant),
            schema=schema,
        )
        return AttributionChallenge(
            primary_attribution_id=primary.id,
            alternative_actor=payload.get("alternative_actor"),
            objections=list(payload.get("objections", [])),
            confidence_delta=float(payload.get("confidence_delta", 0.0)),
            rationale=str(payload.get("rationale", "")),
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
        schema = ATTRIBUTION_TOOL["input_schema"]
        payload = await self._chat(
            system=reconcile_system_prompt(),
            user=reconcile_user_prompt(primary, challenge, anomalies, relevant),
            schema=schema,
        )
        payload = self._repair_attribution(payload)
        return Attribution(
            anomaly_ids=list(primary.anomaly_ids),
            actor=str(payload.get("actor", primary.actor)),
            confidence=float(payload.get("confidence", primary.confidence)),
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

        schema = DECISION_TOOL["input_schema"]
        payload = await self._chat(
            system=decision_system_prompt(),
            user=decision_user_prompt(attribution),
            schema=schema,
        )
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

    # ---- HTTP plumbing ----------------------------------------------------

    def _repair_attribution(self, payload: dict[str, Any]) -> dict[str, Any]:
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
        return validation.repaired

    async def _chat(self, *, system: str, user: str, schema: dict[str, Any]) -> dict:
        # Lazy-import httpx so this client can sit on disk without forcing a
        # dependency on http machinery for stub-only runs.
        import httpx

        # Most local models follow instructions better when the schema is
        # echoed in the user prompt as well; Ollama's `format` enforces it
        # but the prompt belt+suspenders matters for smaller models.
        user_with_schema = (
            f"{user}\n\n"
            f"Reply with a single JSON object that conforms to this schema:\n"
            f"```json\n{json.dumps(schema, indent=2)}\n```"
        )

        url = f"{self._base_url}/api/chat"
        base_body: dict[str, Any] = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user_with_schema},
            ],
            "stream": False,
            "options": {"temperature": self._temperature, "seed": self._seed},
        }

        # Try schema-typed structured output first (Ollama ≥ 0.5). Fall back
        # to plain JSON mode if the daemon rejects the schema dict.
        attempts = ({**base_body, "format": schema}, {**base_body, "format": "json"})
        last_error: Exception | None = None
        client_kwargs: dict[str, Any] = {"timeout": self._timeout_s}
        if self._transport is not None:
            client_kwargs["transport"] = self._transport
        async with httpx.AsyncClient(**client_kwargs) as client:
            for body in attempts:
                try:
                    response = await client.post(url, json=body)
                    response.raise_for_status()
                    data = response.json()
                    self.runtime_events.append(
                        {
                            key: data.get(key)
                            for key in (
                                "total_duration",
                                "load_duration",
                                "prompt_eval_count",
                                "prompt_eval_duration",
                                "eval_count",
                                "eval_duration",
                            )
                            if data.get(key) is not None
                        }
                    )
                    content = (data.get("message") or {}).get("content", "")
                    if not content:
                        raise ValueError(f"empty content from Ollama: {data}")
                    return _extract_json(content)
                except Exception as exc:  # noqa: BLE001 - want to retry below
                    last_error = exc
                    log.debug(
                        "ollama: chat attempt failed (format=%r): %s",
                        body.get("format"),
                        exc,
                    )
                    continue
        raise RuntimeError(f"Ollama chat failed: {last_error}") from last_error


def _extract_json(content: str) -> dict:
    """Pull the first JSON object out of an Ollama response.

    Ollama's structured-output mode usually returns clean JSON, but small
    models occasionally wrap the answer in prose or fence it with markdown.
    Be tolerant.
    """
    content = content.strip()
    if content.startswith("```"):
        # Strip ```json ... ``` fences
        content = content.strip("`")
        if content.lower().startswith("json"):
            content = content[4:].lstrip()
        if content.endswith("```"):
            content = content[: -3]
        content = content.strip()
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        # Last resort: find the first {...} balanced block.
        start = content.find("{")
        end = content.rfind("}")
        if start >= 0 and end > start:
            return json.loads(content[start : end + 1])
        raise
