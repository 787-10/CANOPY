from __future__ import annotations

from collections.abc import Iterable
from typing import Any, Protocol

from canopy.services.kb.models import KBEntry
from canopy.services.schemas.events import (
    Anomaly,
    Attribution,
    AttributionChallenge,
    Decision,
)

__all__ = ["LLMClient"]


class LLMClient(Protocol):
    async def attribute(
        self, anomalies: list[Anomaly], kb_context: Iterable[KBEntry] = ()
    ) -> Attribution:
        """Single-pass attribution. Default backwards-compatible entry point.

        Implementations may delegate to :meth:`attribute_primary` for the same
        result. The :class:`~canopy.services.attrib.AttribService` orchestrator
        prefers the three-pass primary → redteam → reconcile pipeline; this
        method is preserved for tests and clients that want a single call.
        """
        ...

    async def attribute_primary(
        self,
        anomalies: list[Anomaly],
        kb_context: Iterable[KBEntry] = (),
        *,
        rule_verdict: Any | None = None,
    ) -> Attribution:
        """Primary attribution agent — first pass, before red-team challenge.

        ``rule_verdict`` is the deterministic fast-lane verdict
        (docs/INTERFACE-SPEC.md §5.1). Structurally it is any object with
        ``verdict``, ``confidence`` and ``basis`` attributes; clients pass it
        into the prompt and the validator.
        """
        ...

    async def attribute_redteam(
        self,
        primary: Attribution,
        anomalies: list[Anomaly],
        kb_context: Iterable[KBEntry] = (),
    ) -> AttributionChallenge:
        """Red-team agent — critiques the primary attribution."""
        ...

    async def reconcile(
        self,
        primary: Attribution,
        challenge: AttributionChallenge,
        anomalies: list[Anomaly],
        kb_context: Iterable[KBEntry] = (),
        *,
        rule_verdict: Any | None = None,
    ) -> Attribution:
        """Reconciler agent — produces the final, calibrated attribution."""
        ...

    async def decide(self, attribution: Attribution) -> Decision: ...
