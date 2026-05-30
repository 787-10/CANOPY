from __future__ import annotations

import asyncio
import logging
import re
from collections import OrderedDict

from canopy.services.bus import Bus
from canopy.services.schemas.events import (
    Action,
    Attribution,
    Decision,
    Recommendation,
    UIEvent,
    UIEventType,
    UISeverity,
)

log = logging.getLogger(__name__)

__all__ = ["UIEventService"]

ATTRIBUTION_CACHE_SIZE = 256

_HIGH_SEVERITY_ACTIONS: set[Action] = {
    "active_defense_escort",
    "active_defense_counterattack",
    "orbital_strike_request",
    "terrestrial_strike_request",
    "space_link_interdiction_request",
}

# At or above this attribution confidence, a threat is high severity even
# without a request. Tuned so 0.74 stays medium and 0.82 reads high
# (see data/expected_ui_events.json).
_HIGH_SEVERITY_CONFIDENCE = 0.75

_ACTION_TITLES: dict[Action, str] = {
    "passive_defense": "Defensive posture activated",
    "active_defense_escort": "Active defense escort recommended",
    "active_defense_counterattack": "Active defense counterattack proposed",
    "orbital_strike_request": "Orbital strike review",
    "terrestrial_strike_request": "Terrestrial strike review",
    "space_link_interdiction_request": "Space-link interdiction requested",
    "sda_tasking": "SDA tasking issued",
    "threat_warning": "Threat warning",
}

_BEAT_RAW_TO_DISPLAY = {"1": "1", "2": "2", "3": "3", "4": "4", "47": "4.7"}

_BEAT_RE = re.compile(r"canopy-beat(\d+)-")


def _extract_demo_beat(source_signal_ids: list[str]) -> str | None:
    for sid in source_signal_ids:
        m = _BEAT_RE.match(sid)
        if m:
            return _BEAT_RAW_TO_DISPLAY.get(m.group(1), m.group(1))
    return None


def _severity_for(decision: Decision, attribution: Attribution | None) -> UISeverity:
    if decision.authority == "request" or decision.action in _HIGH_SEVERITY_ACTIONS:
        return "high"
    if attribution is not None and attribution.confidence >= _HIGH_SEVERITY_CONFIDENCE:
        return "high"
    return "medium"


def _title_for(decision: Decision, attribution: Attribution | None) -> str:
    base = _ACTION_TITLES.get(decision.action, decision.action.replace("_", " ").title())
    if attribution and attribution.actor not in ("Unknown", "Multi-actor"):
        return f"{base} — {attribution.actor}"
    return base


def _build_message(decision: Decision, attribution: Attribution | None) -> str:
    parts = [decision.rationale]
    if attribution is not None:
        actor_clause = (
            f"Attributed actor: {attribution.actor} "
            f"(confidence {attribution.confidence:.2f})."
        )
        parts.append(actor_clause)
        if attribution.predicted_next:
            parts.append(f"Forecast: {attribution.predicted_next}")
    maneuver_clause = _maneuver_clause(decision.request_packet)
    if maneuver_clause:
        parts.append(maneuver_clause)
    return " ".join(parts)


def _maneuver_clause(request_packet: dict | None) -> str | None:
    if not request_packet:
        return None
    pre = request_packet.get("pre_miss_km")
    post = request_packet.get("post_miss_km")
    if pre is None or post is None:
        return None
    burn = request_packet.get("recommended_burn") or {}
    sat = burn.get("sat", "the protected asset")
    dv = burn.get("dv_m_s")
    lead_s = burn.get("lead_seconds")
    gain = round(post - pre, 1)
    dv_str = f"{dv} m/s" if dv is not None else "an impulsive"
    lead_clause = (
        f" with {lead_s / 3600:.0f} h planning lead" if lead_s else ""
    )
    return (
        f"Recommended maneuver{lead_clause}: {sat} {dv_str} prograde burn, "
        f"miss {pre:.1f} → {post:.1f} km (+{gain:.1f} km separation)."
    )


class UIEventService:
    """Joins Attributions with Decisions and publishes UIEvents.

    Subscribes to both ``attributions.*`` (to cache attribution context) and
    ``decisions.*`` (to fire UI events). The cache keeps the most recent
    256 attributions so a Decision arriving moments after its Attribution can
    pick up the actor/confidence/forecast for the message.
    """

    def __init__(self, bus: Bus, *, cache_size: int = ATTRIBUTION_CACHE_SIZE) -> None:
        self._bus = bus
        self._cache: OrderedDict[str, Attribution] = OrderedDict()
        self._cache_size = cache_size

    async def run(self) -> None:
        async with asyncio.TaskGroup() as tg:
            tg.create_task(self._consume_attributions(), name="ui-attribs")
            tg.create_task(self._consume_decisions(), name="ui-decisions")

    async def _consume_attributions(self) -> None:
        async for topic, event in self._bus.subscribe("attributions.*"):
            if not isinstance(event, Attribution):
                continue
            self._cache[event.id] = event
            self._cache.move_to_end(event.id)
            while len(self._cache) > self._cache_size:
                self._cache.popitem(last=False)

    async def _consume_decisions(self) -> None:
        async for topic, event in self._bus.subscribe("decisions.*"):
            if not isinstance(event, Decision):
                continue
            attribution = self._cache.get(event.attribution_id)
            ui_event = self._build_ui_event(event, attribution)
            await self._bus.publish(f"ui_events.{ui_event.type}", ui_event)
            log.info(
                "ui_events published id=%s type=%s severity=%s",
                ui_event.id,
                ui_event.type,
                ui_event.severity,
            )

    def _build_ui_event(
        self, decision: Decision, attribution: Attribution | None
    ) -> UIEvent:
        is_request = decision.authority == "request"
        ui_type: UIEventType = (
            "recommendation_created" if is_request else "threat_updated"
        )
        recommendation = (
            Recommendation(
                id=f"rec-{decision.id}",
                summary=decision.rationale,
                approveLabel="APPROVE",
            )
            if is_request
            else None
        )
        confidence = attribution.confidence if attribution else 0.5
        return UIEvent(
            id=f"uievt-{decision.id}",
            source_signal_ids=list(decision.source_signal_ids),
            type=ui_type,
            timestamp=decision.ts,
            severity=_severity_for(decision, attribution),
            title=_title_for(decision, attribution),
            message=_build_message(decision, attribution),
            confidence=confidence,
            demoBeat=_extract_demo_beat(list(decision.source_signal_ids)),
            recommendation=recommendation,
        )
