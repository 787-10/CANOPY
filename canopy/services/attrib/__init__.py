from __future__ import annotations

import asyncio
import logging

from collections.abc import Callable
from typing import Literal

from canopy.services.bus import Bus
from canopy.services.kb import KB
from canopy.services.llm import LLMClient
from canopy.services.schemas.events import Anomaly, Domain
from canopy.services.traces import Tracer

log = logging.getLogger(__name__)

__all__ = ["AttribService"]

DEFAULT_WINDOW_S = 2.0
STRESS_HAIRCUT = 0.15

# Map anomaly kinds to the input domains they implicitly rely on. When an
# input domain is blocked, attributions backed primarily by that domain
# take a confidence haircut to honestly reflect the degraded picture.
_KIND_DOMAINS: dict[str, set[Domain]] = {
    "rf_anomaly": {"rf_ew"},
    "rf_gnss_jamming": {"rf_ew", "pnt"},
    "rf_uas_control_link": {"rf_ew"},
    "rf_emission_posture_risk": {"rf_ew"},
    "rf_telemetry_degradation": {"rf_ew", "satcom"},
    "gnss_spoof": {"pnt"},
    "satcom_degradation": {"satcom"},
    "cyber_probe_burst": {"cyber"},
    "cyber_response_action": {"cyber"},
    "sda_catalog_match": {"sda"},
    "sda_maritime_picture_shift": {"sda"},
    "sda_overhead_ir_cue": {"sda"},
    "sda_counterspace_context": {"sda"},
    "drone_spoofing": {"drone"},
    "drone_lost_link": {"drone"},
    "drone_degraded": {"drone"},
    "orbital_rpo_risk": {"orbit", "sda"},
    "orbital_collection_risk": {"orbit"},
    "orbital_collection_overlap": {"orbit"},
    "orbital_collection_correlated": {"orbit"},
}


def _country_topic(actor: str) -> str:
    head = actor.split("/", 1)[0].strip().lower()
    return head.replace(" ", "_") or "unknown"


def _critical_domains_for(anomalies: list[Anomaly]) -> set[Domain]:
    domains: set[Domain] = set()
    for a in anomalies:
        domains.update(_KIND_DOMAINS.get(a.kind, set()))
    return domains


class AttribService:
    """Attribution-stage service.

    Subscribes to ``anomalies.*`` and batches anomalies in a small sliding
    window before calling ``LLMClient.attribute(...)``. The window lets a
    coordinated cross-domain cluster (RF + cyber + PNT, for example) attribute
    as a single campaign rather than each leg in isolation. Set
    ``window_s=0`` to attribute each anomaly immediately (used in tests).
    """

    def __init__(
        self,
        bus: Bus,
        llm: LLMClient,
        kb: KB,
        *,
        window_s: float = DEFAULT_WINDOW_S,
        tracer: Tracer | None = None,
        blocked_domains: Callable[[], set[Domain]] | None = None,
        multi_agent: bool = True,
        kb_context_mode: Literal["scenario", "full"] = "scenario",
    ) -> None:
        self._bus = bus
        self._llm = llm
        self._kb = kb
        self._window_s = window_s
        self._tracer = tracer
        self._blocked_domains = blocked_domains
        self._multi_agent = multi_agent
        self._kb_context_mode = kb_context_mode
        self._buffer: list[Anomaly] = []
        self._flush_task: asyncio.Task | None = None

    async def run(self) -> None:
        try:
            async for topic, event in self._bus.subscribe("anomalies.*"):
                if not isinstance(event, Anomaly):
                    log.warning(
                        "attrib received non-Anomaly on %s: %r", topic, type(event)
                    )
                    continue
                if self._window_s <= 0:
                    await self._process([event])
                    continue
                self._buffer.append(event)
                if self._flush_task is None or self._flush_task.done():
                    self._flush_task = asyncio.create_task(self._flush_after_window())
        finally:
            if self._flush_task is not None and not self._flush_task.done():
                self._flush_task.cancel()

    async def _flush_after_window(self) -> None:
        await asyncio.sleep(self._window_s)
        await self.flush()

    async def flush(self) -> None:
        """Immediately process the buffered anomaly batch, if any.

        Runtime callers normally rely on the time window. Benchmark episodes
        use this explicit completion seam after every input signal has drained.
        """
        current = asyncio.current_task()
        if (
            self._flush_task is not None
            and self._flush_task is not current
            and not self._flush_task.done()
        ):
            self._flush_task.cancel()
        self._flush_task = None
        if not self._buffer:
            return
        batch = list(self._buffer)
        self._buffer.clear()
        await self._process(batch)

    async def _process(self, anomalies: list[Anomaly]) -> None:
        # KB context: union of entries indexed by the source signal ids of
        # this batch. Falls back to all entries if no scenario hits.
        seen: set[str] = set()
        context = []
        if self._kb_context_mode == "scenario":
            for a in anomalies:
                for sid in a.source_signal_ids:
                    for entry in self._kb.by_scenario_signal_id(sid):
                        if entry.id not in seen:
                            context.append(entry)
                            seen.add(entry.id)
        if self._kb_context_mode == "full" or not context:
            context = self._kb.all_entries()

        # Multi-agent attribution loop: primary → red-team → reconcile.
        # The intermediate primary + challenge live entirely in the trace
        # stream; downstream services see only the final reconciled
        # attribution on ``attributions.{actor}``. When ``multi_agent`` is
        # disabled (benchmark mode), we publish the primary attribution
        # directly so the comparison isolates whether the red-team loop
        # is pulling its weight against single-pass attribution.
        try:
            primary = await self._llm.attribute_primary(anomalies, context)
        except Exception:
            log.exception(
                "attrib: attribute_primary failed for batch of %d", len(anomalies)
            )
            return
        if self._tracer is not None:
            await self._tracer.emit(
                "attrib_primary",
                "info",
                f"actor={primary.actor} confidence={primary.confidence:.2f}",
                ref_id=primary.id,
                actor=primary.actor,
                confidence=primary.confidence,
            )

        if not self._multi_agent:
            attribution = primary
        else:
            try:
                challenge = await self._llm.attribute_redteam(
                    primary, anomalies, context
                )
            except Exception:
                log.exception(
                    "attrib: attribute_redteam failed for primary=%s", primary.id
                )
                attribution = primary
            else:
                if self._tracer is not None:
                    alt = challenge.alternative_actor or "uncertainty floor"
                    await self._tracer.emit(
                        "attrib_redteam",
                        "warn" if challenge.confidence_delta < 0 else "info",
                        f"challenge: {challenge.rationale}",
                        ref_id=primary.id,
                        alternative_actor=alt,
                        confidence_delta=challenge.confidence_delta,
                        objections=challenge.objections,
                    )
                try:
                    attribution = await self._llm.reconcile(
                        primary, challenge, anomalies, context
                    )
                except Exception:
                    log.exception(
                        "attrib: reconcile failed for primary=%s", primary.id
                    )
                    attribution = primary

        # Stress-mode confidence haircut: if any critical input domain for
        # this anomaly cluster is blocked, lower confidence and surface the
        # degradation in the trace stream.
        attribution = await self._apply_stress_haircut(attribution, anomalies)

        country = _country_topic(attribution.actor)
        await self._bus.publish(f"attributions.{country}", attribution)
        log.info(
            "attrib published id=%s actor=%s confidence=%.2f signals=%d",
            attribution.id,
            attribution.actor,
            attribution.confidence,
            len(attribution.source_signal_ids),
        )
        if self._tracer is not None:
            await self._tracer.emit(
                "attrib_reconcile",
                "info",
                f"final actor={attribution.actor} confidence={attribution.confidence:.2f}",
                ref_id=attribution.id,
                actor=attribution.actor,
                confidence=attribution.confidence,
            )

    async def _apply_stress_haircut(
        self, attribution, anomalies: list[Anomaly]
    ):
        if self._blocked_domains is None:
            return attribution
        blocked = self._blocked_domains()
        if not blocked:
            return attribution
        critical = _critical_domains_for(anomalies)
        intersection = critical & blocked
        if not intersection:
            return attribution

        new_confidence = max(0.30, attribution.confidence - STRESS_HAIRCUT)
        evidence = list(attribution.evidence)
        evidence.append(
            "Stress: input domains "
            f"{sorted(intersection)} unavailable — confidence lowered."
        )
        if self._tracer is not None:
            await self._tracer.emit(
                "stress",
                "warn",
                f"{sorted(intersection)} blocked — lowering confidence "
                f"{attribution.confidence:.2f} → {new_confidence:.2f}",
                ref_id=attribution.id,
                blocked=sorted(intersection),
                before=attribution.confidence,
                after=new_confidence,
            )
        return attribution.model_copy(
            update={"confidence": round(new_confidence, 3), "evidence": evidence}
        )
