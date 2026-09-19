from __future__ import annotations

import asyncio
import logging
import re
import time
from collections import OrderedDict
from collections.abc import Callable
from datetime import UTC, datetime

from canopy.services.bus import Bus
from canopy.services.schemas.events import (
    Action,
    Attribution,
    Decision,
    Recommendation,
    UIEvent,
    UIEventType,
    UISeverity,
    most_restrictive,
)
from canopy.services.traces import Tracer

log = logging.getLogger(__name__)

__all__ = ["UIEventService", "withheld_reason_label"]

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
    "recovery_recommendation": "Recovery recommendation",
}

_BEAT_RAW_TO_DISPLAY = {"1": "1", "2": "2", "3": "3", "4": "4", "47": "4.7"}

# Operator-facing labels for the withheld-recovery reason codes
# (docs/INTERFACE-SPEC.md §6, wave 4B). The console keeps its own copy in
# ``src/lib/commanderLanguage.ts`` (``gateReasonLabel``); these render the
# same codes into the UI event's prose. Unknown codes fall back to the
# humanised tail of the code.
_WITHHELD_REASON_LABELS: dict[str, str] = {
    "threat/uplink_jamming_active": "active jamming detected",
    "threat/hostile_close_approach": "hostile close approach in progress",
    "verdict/hostile_external": "verdict is hostile external",
    "verdict/unknown": "verdict is unknown",
}

_BEAT_RE = re.compile(r"canopy-beat(\d+)-")


def _extract_demo_beat(source_signal_ids: list[str]) -> str | None:
    for sid in source_signal_ids:
        m = _BEAT_RE.match(sid)
        if m:
            return _BEAT_RAW_TO_DISPLAY.get(m.group(1), m.group(1))
    return None


def _severity_for(decision: Decision, attribution: Attribution | None) -> UISeverity:
    # A recovery recommendation is a local-authority response to an internal
    # or natural finding, not a threat escalation: it stays medium even when
    # the attribution is confident (docs/INTERFACE-SPEC.md §6).
    if decision.action == "recovery_recommendation":
        return "medium"
    if decision.authority == "request" or decision.action in _HIGH_SEVERITY_ACTIONS:
        return "high"
    if attribution is not None and attribution.confidence >= _HIGH_SEVERITY_CONFIDENCE:
        return "high"
    return "medium"


def _title_for(decision: Decision, attribution: Attribution | None) -> str:
    base = _ACTION_TITLES.get(decision.action, decision.action.replace("_", " ").title())
    # "None" is the actor for internal_fault / natural_external verdicts
    # (docs/INTERFACE-SPEC.md §5); it is not a name to append to a title.
    if attribution and attribution.actor not in ("Unknown", "Multi-actor", "None"):
        return f"{base} — {attribution.actor}"
    return base


def _build_message(decision: Decision, attribution: Attribution | None) -> str:
    parts = [decision.rationale]
    recovery_clause = _recovery_clause(decision)
    if recovery_clause:
        parts.append(recovery_clause)
    withheld_clause = _withheld_clause(decision)
    if withheld_clause:
        parts.append(withheld_clause)
    if attribution is not None:
        if attribution.actor == "None" and attribution.verdict:
            # internal_fault / natural_external: there is no actor to name
            # (docs/INTERFACE-SPEC.md §5); name the finding instead.
            actor_clause = (
                f"Verdict: {attribution.verdict.replace('_', ' ')} "
                f"(confidence {attribution.confidence:.2f})."
            )
        else:
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


def _recovery_clause(decision: Decision) -> str | None:
    """Name the recovery a recovery_recommendation carries (spec §6)."""
    recovery = decision.recovery
    if recovery is None:
        return None
    approval = (
        "requires operator approval" if recovery.requires_approval else "no approval required"
    )
    return (
        f"Recommended recovery: {recovery.action_id} on the "
        f"{recovery.target_subsystem} subsystem ({approval}); "
        f"source {recovery.source}."
    )


def withheld_reason_label(reason_code: str) -> str:
    """Prose for a withheld-recovery reason code."""
    known = _WITHHELD_REASON_LABELS.get(reason_code)
    if known:
        return known
    tail = reason_code.rsplit("/", 1)[-1]
    return tail.replace("_", " ").strip() or reason_code


def _withheld_clause(decision: Decision) -> str | None:
    """Name the recovery the decide stage withheld and why (spec §6, wave 4B).

    The UI event's type and severity follow the decision as before; this only
    adds the clause the console shows as "radio reset withheld: active
    jamming detected".
    """
    withheld = decision.withheld_recovery
    if withheld is None:
        return None
    return (
        f"Recovery withheld: {withheld.action_id} on {withheld.target_subsystem}: "
        f"{withheld_reason_label(withheld.reason_code)}."
    )


def _needs_approval(decision: Decision) -> bool:
    """A recovery that needs sign-off gets the operator panel's approve control."""
    return decision.recovery is not None and decision.recovery.requires_approval


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

    Revisions (wave 3A). A revised attribution replaces the cached one under
    the same id, and the decision made for it arrives with the decision id
    its first revision got, so the UI event it produces has the same id as
    before: the console updates the card instead of adding a duplicate. With
    a ``tracer`` the service emits one ``decide``-stage trace per UI event
    (there is no separate UI stage in the trace vocabulary), stamped with
    ``latency_ms`` since the cluster's first anomaly and ``stage_ms`` for
    this stage's own work.
    """

    def __init__(
        self,
        bus: Bus,
        *,
        cache_size: int = ATTRIBUTION_CACHE_SIZE,
        tracer: Tracer | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._bus = bus
        self._cache: OrderedDict[str, Attribution] = OrderedDict()
        self._decisions: OrderedDict[str, Decision] = OrderedDict()
        self._reset_at: datetime | None = None
        self._cache_size = cache_size
        self._tracer = tracer
        self._clock = clock

    def reset(self) -> dict[str, int]:
        """Forget cached attributions and decisions (``POST /reset``).

        In-process state only. Afterwards the first decision of the next run
        is published as new rather than as an update of a card from the
        previous run. Returns how many entries each cache held.
        """
        cleared = {"attributions": len(self._cache), "decisions": len(self._decisions)}
        self._cache.clear()
        self._decisions.clear()
        self._reset_at = datetime.now(UTC)
        return cleared

    def _predates_reset(self, ts: datetime) -> bool:
        """True when an event stamped ``ts`` was produced before the last reset."""
        if self._reset_at is None:
            return False
        try:
            return ts < self._reset_at
        except TypeError:
            return False

    async def run(self) -> None:
        async with asyncio.TaskGroup() as tg:
            tg.create_task(self._consume_attributions(), name="ui-attribs")
            tg.create_task(self._consume_decisions(), name="ui-decisions")

    async def _consume_attributions(self) -> None:
        async for topic, event in self._bus.subscribe("attributions.*"):
            if not isinstance(event, Attribution) or self._predates_reset(event.ts):
                continue
            self._cache[event.id] = event
            self._cache.move_to_end(event.id)
            while len(self._cache) > self._cache_size:
                self._cache.popitem(last=False)

    async def _consume_decisions(self) -> None:
        async for topic, event in self._bus.subscribe("decisions.*"):
            if not isinstance(event, Decision):
                continue
            if self._predates_reset(event.ts):
                # A decision queued behind the reset belongs to the previous
                # take; publishing it would put its card into the new one.
                log.info("ui_events: dropping decision=%s queued before the engine reset", event.id)
                continue
            stage_t0 = self._clock()
            attribution = self._cache.get(event.attribution_id)
            previous = self._decisions.get(event.id)
            self._decisions[event.id] = event
            self._decisions.move_to_end(event.id)
            while len(self._decisions) > self._cache_size:
                self._decisions.popitem(last=False)
            ui_event = self._build_ui_event(event, attribution)
            await self._bus.publish(f"ui_events.{ui_event.type}", ui_event)
            verb = "updated" if previous is not None else "published"
            log.info(
                "ui_events %s id=%s type=%s severity=%s revision=%d",
                verb,
                ui_event.id,
                ui_event.type,
                ui_event.severity,
                event.revision,
            )
            if self._tracer is not None:
                await self._tracer.emit(
                    "decide",
                    "info",
                    f"ui event {verb}: {ui_event.type} severity={ui_event.severity} "
                    f"revision={event.revision}",
                    ref_id=ui_event.id,
                    t0=self._tracer.t0_for(event.id, event.attribution_id),
                    stage_t0=stage_t0,
                    decision_id=event.id,
                    attribution_id=event.attribution_id,
                    revision=event.revision,
                    provisional=attribution.provisional if attribution else None,
                    update=previous is not None,
                )

    def _build_ui_event(
        self, decision: Decision, attribution: Attribution | None
    ) -> UIEvent:
        # A request-authority decision and a recovery that requires approval
        # both surface an approve control; everything else is a threat update.
        is_request = decision.authority == "request"
        needs_approval = _needs_approval(decision)
        wants_recommendation = is_request or needs_approval
        ui_type: UIEventType = (
            "recommendation_created" if wants_recommendation else "threat_updated"
        )
        recommendation = (
            Recommendation(
                id=f"rec-{decision.id}",
                summary=(
                    _recovery_clause(decision) or decision.rationale
                    if needs_approval and not is_request
                    else decision.rationale
                ),
                approveLabel="APPROVE",
            )
            if wants_recommendation
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
            # Spec §1.1: the card is never marked lower than what it shows.
            marking=most_restrictive(
                [decision.marking, *([attribution.marking] if attribution else [])]
            ),
        )
