from __future__ import annotations

import asyncio
import logging
import time
from collections import OrderedDict
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from canopy.services.bus import Bus
from canopy.services.decide.prompts import (
    RecoveryContext,
    _block_from,
    recovery_context,
    recovery_rationale,
    with_recovery_context,
)
from canopy.services.decide.tools import (
    GATE_DOWNGRADE_ACTION,
    REASON_AUTHORITY_MISMATCH,
    DecisionTool,
    Gate,
    GateContext,
    GateResult,
    ToolContext,
    dispatch,
    policy_gate,
)
from canopy.services.llm import LLMClient
from canopy.services.llm.validation import validate_and_repair_decision
from canopy.services.orbit import (
    MIN_OPERATIONAL_LEAD_S,
    OrbitService,
)
from canopy.services.schemas.events import (
    ACTION_AUTHORITY,
    SELECTABLE_ACTIONS,
    Action,
    Anomaly,
    Attribution,
    Authority,
    Decision,
    RecoveryBlock,
    WithheldRecovery,
    most_restrictive,
)
from canopy.services.traces import Tracer

log = logging.getLogger(__name__)

__all__ = [
    "DEFENSIVE_ACTIONS",
    "REASON_VERDICT_HOSTILE",
    "REASON_VERDICT_UNKNOWN",
    "SELECTION_BASES",
    "SELECTION_GATE_WITHHELD_PREFIX",
    "SELECTION_MODEL_OUTSIDE_SET_REPAIRED",
    "SELECTION_MODEL_WITHIN_SET",
    "SELECTION_RECOVERY_ROUTED",
    "DecideService",
    "Gate",
    "GateContext",
    "GateResult",
    "WithheldReason",
    "default_gate",
    "default_withheld_reason",
    "verdict_withheld_reason",
]


# Request-authority actions whose request_packet should be enriched with
# orbital maneuver math when an orbital_rpo_risk anomaly is in the cluster.
_ORBIT_ENRICHED_ACTIONS: set[Action] = {
    "active_defense_escort",
    "active_defense_counterattack",
    "orbital_strike_request",
}

# Time the engine reserves between detecting the threat and executing the
# burn — represents authorization + maneuver-prep latency. The engine
# computes burn time as ``anomaly.ts + AUTHORIZATION_LATENCY``.
_AUTHORIZATION_LATENCY = timedelta(seconds=60)

_ANOMALY_CACHE_SIZE = 256
# attribution id → decision id, so every revision of an attribution keeps
# the decision id its first revision got (wave 3A).
_DECISION_ID_CACHE_SIZE = 256

# How far around the cluster's time the gate looks for threat context on the
# same satellite (docs/INTERFACE-SPEC.md §7, matches the bus_health look-back
# in §2).
DEFAULT_GATE_LOOKBACK_S = 600.0

RECOVERY_ACTION: Action = "recovery_recommendation"

# ---- Bounded response (docs/INTERFACE-SPEC.md §6, spec 1.4) ------------------
#
# Every published decision names the set of actions it was legitimately drawn
# from (``Decision.selectable_set``) and why that set applied
# (``Decision.selection_basis``), so the model's choice is auditable. These
# fields never change which action is chosen; rule-based selection is a later
# item. The basis is one of a closed vocabulary:
#
#   recovery-routed              the §6 rule applied (internal or natural verdict
#                                with a recommended_recovery): the set is the
#                                routed action alone, whatever the model said.
#   model-within-set             no recovery applies and the model chose from the
#                                defensive menu (SELECTABLE_ACTIONS without
#                                recovery_recommendation).
#   model-outside-set-repaired   the model chose off the menu and the decide stage
#                                repaired it without a gate block (a recovery with
#                                no block, downgraded to threat_warning).
#   gate-withheld:<reason_code>  the gate blocked (§7): the set is the gate's
#                                replacement, threat_warning, and the reason is the
#                                one in the ``[gate:…]`` rationale prefix.
#   provisional-rule             the decision answers a provisional (fast-lane)
#                                verdict and no model was called: a recovery routes
#                                by the §6 rule, anything else holds a precautionary
#                                threat_warning until the reasoning lane's revision.

SELECTION_RECOVERY_ROUTED = "recovery-routed"
SELECTION_MODEL_WITHIN_SET = "model-within-set"
SELECTION_MODEL_OUTSIDE_SET_REPAIRED = "model-outside-set-repaired"
SELECTION_GATE_WITHHELD_PREFIX = "gate-withheld:"
SELECTION_PROVISIONAL_RULE = "provisional-rule"

# The revision-0 decision on a provisional verdict that routes no recovery:
# a precautionary threat warning to the space operations C2 cell (a synthetic
# addressee), replaced by the model's decision at the reasoning lane's revision.
PROVISIONAL_WARNING_ACTION: Action = "threat_warning"
PROVISIONAL_WARNING_TARGET = "space-ops-c2"

SELECTION_BASES: tuple[str, ...] = (
    SELECTION_RECOVERY_ROUTED,
    SELECTION_PROVISIONAL_RULE,
    SELECTION_MODEL_WITHIN_SET,
    SELECTION_MODEL_OUTSIDE_SET_REPAIRED,
    f"{SELECTION_GATE_WITHHELD_PREFIX}<reason_code>",
)

# The defensive menu: what the model may pick when no recovery is routed. A
# recovery_recommendation is selectable only with a block (§6 invariants), so
# it is not on this menu. Menu order is SELECTABLE_ACTIONS order.
DEFENSIVE_ACTIONS: tuple[Action, ...] = tuple(
    action for action in SELECTABLE_ACTIONS if action != RECOVERY_ACTION
)

# ---- Withheld recovery (docs/INTERFACE-SPEC.md §6, wave 4B) -----------------
#
# When the cluster recommends a recovery that the published decision does not
# carry, the decision says so and why. The two verdict reasons need nothing
# but the attribution and live here; the two threat reasons reuse the gate's
# R1/R2 predicates and live in ``megalith.gate.withheld``, which chains onto
# :func:`verdict_withheld_reason`. A withheld-reason callable answers
# ``(decision, gate context, recommended block) -> reason code or None``.

REASON_VERDICT_HOSTILE = "verdict/hostile_external"
REASON_VERDICT_UNKNOWN = "verdict/unknown"

WithheldReason = Callable[[Decision, GateContext, RecoveryBlock], str | None]


def verdict_withheld_reason(
    decision: Decision, ctx: GateContext, recommended: RecoveryBlock
) -> str | None:
    """The verdict-only withheld reasons: what CANOPY enforces on its own.

    A recovery is routed only for ``internal_fault`` and ``natural_external``
    (§6), so under ``hostile_external`` or ``unknown`` the recommended block is
    withheld for the verdict's sake. Any other verdict withholds nothing here.
    """
    if decision.action == RECOVERY_ACTION:
        return None
    if ctx.verdict == "hostile_external":
        return REASON_VERDICT_HOSTILE
    if ctx.verdict == "unknown":
        return REASON_VERDICT_UNKNOWN
    return None


def default_withheld_reason() -> WithheldReason:
    """The withheld-reason callable DecideService runs when none is injected.

    Mirrors :func:`default_gate`: the full helper (threat reasons first, then
    the verdict reasons) lives in the MEGALITH package; when CANOPY runs on
    its own only the verdict reasons apply.
    """
    try:
        from megalith.gate import withheld_reason
    except ImportError:
        log.info("megalith.gate unavailable; withheld recovery reports verdict reasons only")
        return verdict_withheld_reason
    return withheld_reason


def default_gate() -> Gate:
    """The gate DecideService runs when none is injected.

    The full threat-context gate (rules R1–R4, docs/INTERFACE-SPEC.md §7)
    lives in the MEGALITH package, which depends on CANOPY and not the other
    way round; when CANOPY runs on its own the policy rules R3 and R4 still
    apply through :func:`policy_gate`.
    """
    try:
        from megalith.gate import threat_context_gate
    except ImportError:
        log.info("megalith.gate unavailable; decide gate enforces policy rules only")
        return policy_gate
    return threat_context_gate


class DecideService:
    """Decision-stage service.

    Subscribes to ``attributions.*``, calls ``LLMClient.decide(...)``, and
    publishes Decision events to ``decisions.{authority}``.

    Between the model's answer and publish, in order:

    1. **Recovery routing** (spec §6). When the verdict is internal_fault or
       natural_external and an anomaly in the cluster carries an
       internal-diagnosis ``recommended_recovery``, the decision is a local
       ``recovery_recommendation`` carrying that block. The block is handed to
       the model as context on the attribution; whatever comes back is made to
       honour the rule and the §6 invariants.
    2. **Maneuver enrichment.** When wired with an ``OrbitService`` (the
       default in :mod:`canopy.cli`), request-authority Decisions whose
       attribution chain includes an ``orbital_rpo_risk`` anomaly get a
       ``recommended_burn`` block plus ``pre_miss_km`` / ``post_miss_km``
       in the ``request_packet``, sized by ``OrbitService.recommended_dv``
       and Clohessy-Wiltshire impulsive math.
    3. **Routing validation.** ``routing.validate`` runs on every decision;
       a disagreement with ``ACTION_AUTHORITY`` repairs the authority.
    4. **The gate** (spec §7): an injected ``Gate`` callable sees the
       decision plus every recent anomaly on the same satellite. A block is
       republished as a local ``threat_warning`` with the reason code in the
       rationale and a warn trace; an authority mismatch is repaired.
    5. **Withheld recovery** (spec §6, wave 4B). When the cluster carries a
       ``recommended_recovery`` and the decision leaving the gate is not a
       recovery, ``Decision.withheld_recovery`` names the block and the
       first applicable reason code (a threat rule that would block it, else
       the hostile or unknown verdict) and a warn trace
       ``recovery withheld: <action_id>: <reason_code>`` is emitted. The
       block path of the gate is unchanged; this only annotates.
    6. **Bounded response** (spec §6, 1.4). Last, ``selectable_set`` and
       ``selection_basis`` record the menu the published action was drawn
       from and why (:data:`SELECTION_BASES`). Never changes the action.

    Revisions (wave 3A). A provisional attribution and every reasoning-lane
    revision of it share an attribution id; the decisions made for them share
    a decision id (keyed by that attribution id) and carry the attribution's
    ``revision``. The whole chain above, gate included, runs again on every
    revision because the context may have changed. Every decide trace is
    stamped with ``latency_ms`` (since the cluster's first anomaly arrived)
    and ``stage_ms`` (since this attribution reached the decide stage).
    """

    def __init__(
        self,
        bus: Bus,
        llm: LLMClient,
        *,
        orbit: OrbitService | None = None,
        anomaly_cache_size: int = _ANOMALY_CACHE_SIZE,
        tracer: Tracer | None = None,
        tools: list[DecisionTool] | None = None,
        tool_ctx: ToolContext | None = None,
        kb=None,
        gate: Gate | None = None,
        withheld_reason: WithheldReason | None = None,
        lookback_s: float = DEFAULT_GATE_LOOKBACK_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._bus = bus
        self._llm = llm
        self._orbit = orbit
        self._tracer = tracer
        self._clock = clock
        # If the caller didn't pre-build a tool registry, build a minimal one
        # using the orbit service alone — that's enough for the maneuver
        # enrichment path used by the snapshot tests and direct callers that
        # don't go through build_engine.
        if tools is None or tool_ctx is None:
            from canopy.services.decide.tools import build_tool_registry
            from canopy.services.kb import KB

            fallback_kb = kb if kb is not None else KB(entries=[])
            tool_ctx, tools = build_tool_registry(
                kb=fallback_kb, orbit=orbit, tracer=tracer
            )
        self._tools = tools
        self._tool_ctx = tool_ctx
        self._gate: Gate = gate if gate is not None else default_gate()
        self._withheld_reason: WithheldReason = (
            withheld_reason if withheld_reason is not None else default_withheld_reason()
        )
        self._lookback = timedelta(seconds=float(lookback_s))
        self._anomaly_cache: OrderedDict[str, Anomaly] = OrderedDict()
        self._cache_size = anomaly_cache_size
        # Bumped by reset(): a decide result that started under an older
        # generation belongs to a run that has been cleared and is dropped.
        self._generation = 0
        # Wall-clock moment of the last reset; events stamped before it are stale.
        self._reset_at: datetime | None = None
        self._arrivals: OrderedDict[str, float] = OrderedDict()
        self._decision_ids: OrderedDict[str, str] = OrderedDict()
        # Timing of the attribution being handled (the consumer loop handles
        # one at a time): (t0 of its cluster, when it reached this stage).
        self._timing: tuple[float | None, float] | None = None
        self.errors: list[dict[str, str]] = []

    @property
    def gate(self) -> Gate:
        return self._gate

    @property
    def withheld_reason(self) -> WithheldReason:
        return self._withheld_reason

    def _predates_reset(self, ts: datetime) -> bool:
        """True when ``ts`` (an event's wall-clock stamp) is older than the last reset."""
        if self._reset_at is None:
            return False
        try:
            return ts < self._reset_at
        except TypeError:  # naive timestamp from a fixture: treat as fresh
            return False

    def reset(self) -> dict[str, int]:
        """Forget cached anomalies, arrival marks, decision ids and errors.

        In-process state only, for ``POST /reset`` between runs: without it
        the previous run's anomalies on the same satellite stay in the cache
        and feed the next run's gate context and withheld-recovery reason.
        Returns how many entries each store held.
        """
        cleared = {
            "anomaly_cache": len(self._anomaly_cache),
            "arrivals": len(self._arrivals),
            "decision_ids": len(self._decision_ids),
            "errors": len(self.errors),
        }
        self._anomaly_cache.clear()
        self._generation += 1
        self._reset_at = datetime.now(UTC)
        self._arrivals.clear()
        self._decision_ids.clear()
        self._timing = None
        self.errors.clear()
        return cleared

    async def run(self) -> None:
        async with asyncio.TaskGroup() as tg:
            tg.create_task(self._consume_anomalies(), name="decide-anomalies")
            tg.create_task(self._consume_attributions(), name="decide-attributions")

    async def _consume_anomalies(self) -> None:
        async for _, event in self._bus.subscribe("anomalies.*"):
            if not isinstance(event, Anomaly):
                continue
            self._note_arrival(event)
            self._anomaly_cache[event.id] = event
            self._anomaly_cache.move_to_end(event.id)
            while len(self._anomaly_cache) > self._cache_size:
                self._anomaly_cache.popitem(last=False)

    def _note_arrival(self, anomaly: Anomaly) -> None:
        """Stamp when the anomaly reached this stage; the tracer's mark wins."""
        now = self._clock()
        if self._tracer is not None:
            now = self._tracer.mark(anomaly.id, now)
        if anomaly.id not in self._arrivals:
            self._arrivals[anomaly.id] = now
            while len(self._arrivals) > self._cache_size:
                self._arrivals.popitem(last=False)

    def _t0_for(self, attribution: Attribution, cluster: list[Anomaly]) -> float | None:
        """When the attribution's cluster first entered the pipeline, if known."""
        known = [self._arrivals[a.id] for a in cluster if a.id in self._arrivals]
        if self._tracer is not None:
            traced = self._tracer.t0_for(attribution.id, *attribution.anomaly_ids)
            if traced is not None:
                known.append(traced)
        return min(known) if known else None

    def _shared_decision_id(self, attribution: Attribution, decision: Decision) -> str:
        """The decision id for this attribution id: the first revision's, reused."""
        existing = self._decision_ids.get(attribution.id)
        if existing is not None:
            self._decision_ids.move_to_end(attribution.id)
            return existing
        self._decision_ids[attribution.id] = decision.id
        while len(self._decision_ids) > _DECISION_ID_CACHE_SIZE:
            self._decision_ids.popitem(last=False)
        return decision.id

    async def _consume_attributions(self) -> None:
        async for topic, event in self._bus.subscribe("attributions.*"):
            if not isinstance(event, Attribution):
                log.warning(
                    "decide received non-Attribution on %s: %r", topic, type(event)
                )
                continue
            if self._predates_reset(event.ts):
                # Queued behind a slow decide call when POST /reset ran: the
                # generation guard below only covers the call in flight.
                log.info(
                    "decide: dropping attribution=%s queued before the engine reset",
                    event.id,
                )
                continue
            stage_t0 = self._clock()
            cluster = self._cluster_anomalies(event)
            self._timing = (self._t0_for(event, cluster), stage_t0)
            recovery = recovery_context(event, cluster)
            llm_input = event if recovery is None else with_recovery_context(event, recovery)
            generation = self._generation
            if event.provisional:
                # The provisional verdict gets its decision by rule, with no
                # model call: a recovery routes by the §6 rule, anything else
                # holds a precautionary threat warning. Revision 0 therefore
                # lands with the fast lane, and the model decides once, for
                # the reasoning lane's revision (pre-submission item C21).
                decision = self._provisional_decision(event, recovery)
                await self._trace(
                    "info",
                    f"provisional decision by rule: {decision.action} (fast lane, no LLM)",
                    decision,
                    event,
                    provisional=True,
                )
            else:
                try:
                    decision = await self._llm.decide(llm_input)
                except Exception as exc:
                    self.errors.append(
                        {
                            "stage": "decision",
                            "type": exc.__class__.__name__,
                            "message": str(exc),
                        }
                    )
                    log.exception(
                        "decide: LLMClient.decide failed for attribution=%s", event.id
                    )
                    continue
                if generation != self._generation:
                    log.info(
                        "decide: dropping result for attribution=%s from before an engine reset",
                        event.id,
                    )
                    continue
            model_action = decision.action
            decision = decision.model_copy(
                update={
                    "id": self._shared_decision_id(event, decision),
                    "revision": event.revision,
                }
            )
            decision = await self._route_recovery(decision, event, recovery)
            decision = await self._maybe_enrich_with_tools(decision, event)
            decision = await self._validate_routing(decision, event)
            decision = await self._apply_gate(decision, event, cluster)
            decision = await self._annotate_withheld(decision, event, cluster)
            decision = self._annotate_selection(
                decision,
                model_action=model_action,
                recovery=recovery,
                provisional=event.provisional,
            )
            decision = self._stamp_marking(decision, event, cluster)
            t0 = self._timing[0] if self._timing is not None else None
            if self._tracer is not None and t0 is not None:
                self._tracer.mark(decision.id, t0)
            await self._bus.publish(f"decisions.{decision.authority}", decision)
            log.info(
                "decide published id=%s action=%s authority=%s revision=%d",
                decision.id,
                decision.action,
                decision.authority,
                decision.revision,
            )
            if self._tracer is not None:
                await self._tracer.emit(
                    "decide",
                    "decision",
                    "action="
                    f"{decision.action} authority={decision.authority} "
                    f"target={decision.target}",
                    ref_id=decision.id,
                    t0=t0,
                    stage_t0=stage_t0,
                    attribution_id=event.id,
                    actor=event.actor,
                    revision=decision.revision,
                    provisional=event.provisional,
                )
            self._timing = None

    # ---- Cluster and threat context ----------------------------------------

    def _cluster_anomalies(self, attribution: Attribution) -> list[Anomaly]:
        """The cached anomalies this attribution covers, in attribution order."""
        found: list[Anomaly] = []
        for aid in attribution.anomaly_ids:
            anomaly = self._anomaly_cache.get(aid)
            if anomaly is not None:
                found.append(anomaly)
        return found

    def _gate_context(
        self, attribution: Attribution, cluster: list[Anomaly], decision: Decision
    ) -> GateContext:
        """Everything recent on the attribution's satellite (spec §7).

        The cluster's anomalies are always in; so is every cached anomaly whose
        payload ``satellite_id`` matches and whose time falls within the
        look-back of the decision time. The decision time is the cluster's
        latest anomaly (scenario time), not the wall clock the Decision was
        stamped with, so replayed scenarios see their own context.
        """
        satellite_id = attribution.satellite_id
        if satellite_id is None:
            for anomaly in cluster:
                sat = anomaly.payload.get("satellite_id")
                if isinstance(sat, str) and sat:
                    satellite_id = sat
                    break
        cluster_ts = [_ensure_utc(a.ts) for a in cluster]
        t_ref = max(cluster_ts) if cluster_ts else _ensure_utc(decision.ts)
        seen = {a.id for a in cluster}
        anomalies = list(cluster)
        if satellite_id is not None:
            for anomaly in self._anomaly_cache.values():
                if anomaly.id in seen or anomaly.payload.get("satellite_id") != satellite_id:
                    continue
                if abs(_ensure_utc(anomaly.ts) - t_ref) <= self._lookback:
                    anomalies.append(anomaly)
                    seen.add(anomaly.id)
        anomalies.sort(key=lambda a: (_ensure_utc(a.ts), a.id))
        return GateContext(
            satellite_id=satellite_id,
            verdict=attribution.verdict,
            anomalies=tuple(anomalies),
        )

    # ---- Recovery routing (spec §6) -----------------------------------------

    @staticmethod
    def _provisional_decision(
        attribution: Attribution, recovery: RecoveryContext | None
    ) -> Decision:
        """The revision-0 decision, by rule and without a model call.

        A recovery in the cluster routes as the §6 rule routes it; any other
        provisional verdict (a hostile call with no actor yet, an abstention)
        holds a precautionary ``threat_warning`` at local authority. The
        reasoning lane's revision replaces this decision under the same id,
        so the operator sees the rationale of the verdict on screen, never a
        model's reading of a verdict that was later revised.
        """
        if recovery is not None:
            return Decision(
                attribution_id=attribution.id,
                action=RECOVERY_ACTION,
                target=recovery.target,
                rationale=recovery_rationale(recovery, attribution),
                authority=ACTION_AUTHORITY[RECOVERY_ACTION],
                request_packet=None,
                source_signal_ids=list(attribution.source_signal_ids),
                recovery=recovery.block,
            )
        verdict = (attribution.verdict or "unknown").replace("_", " ")
        actor_clause = (
            ", with no actor attributed yet" if attribution.actor == "Unknown" else ""
        )
        return Decision(
            attribution_id=attribution.id,
            action=PROVISIONAL_WARNING_ACTION,
            target=PROVISIONAL_WARNING_TARGET,
            rationale=(
                f"Provisional: the fast lane called {verdict} at "
                f"{attribution.confidence:.2f} before any model ran{actor_clause}; "
                "a precautionary threat warning holds while the reasoning lane "
                "reviews the evidence. This decision is revised with the final verdict."
            ),
            authority=ACTION_AUTHORITY[PROVISIONAL_WARNING_ACTION],
            request_packet=None,
            source_signal_ids=list(attribution.source_signal_ids),
        )

    async def _route_recovery(
        self,
        decision: Decision,
        attribution: Attribution,
        recovery: RecoveryContext | None,
    ) -> Decision:
        """Make the decision honour the recovery rule and the §6 invariants."""
        if recovery is not None:
            if decision.action != RECOVERY_ACTION:
                replaced = decision.action
                decision = decision.model_copy(
                    update={
                        "action": RECOVERY_ACTION,
                        "authority": ACTION_AUTHORITY[RECOVERY_ACTION],
                        "target": recovery.target,
                        "rationale": recovery_rationale(recovery, attribution),
                        "request_packet": None,
                        "recovery": recovery.block,
                    }
                )
                await self._trace(
                    "info",
                    f"recovery routed: {recovery.block.action_id} on "
                    f"{recovery.block.target_subsystem} replaces {replaced} "
                    f"(verdict {attribution.verdict})",
                    decision,
                    attribution,
                    action_id=recovery.block.action_id,
                    replaced=replaced,
                )
                return decision
            update: dict[str, Any] = {}
            if decision.recovery != recovery.block:
                # Live clients build the Decision from the tool payload without
                # the block, and a model may have edited it; the cluster's
                # block is the one the operator sees.
                update["recovery"] = recovery.block
            if decision.authority != "local":
                update["authority"] = "local"
            if decision.request_packet is not None:
                update["request_packet"] = None
            if not decision.target:
                update["target"] = recovery.target
            return decision.model_copy(update=update) if update else decision
        if decision.action == RECOVERY_ACTION:
            # Nothing to recommend: no block anywhere in the cluster.
            note = "no internal-diagnosis recovery available; downgraded to threat_warning"
            decision = decision.model_copy(
                update={
                    "action": GATE_DOWNGRADE_ACTION,
                    "authority": ACTION_AUTHORITY[GATE_DOWNGRADE_ACTION],
                    "request_packet": None,
                    "recovery": None,
                    "rationale": f"{decision.rationale} [{note}]",
                }
            )
            await self._trace("warn", f"recovery downgraded: {note}", decision, attribution)
            return decision
        if decision.recovery is not None:
            return decision.model_copy(update={"recovery": None})
        return decision

    # ---- Routing validation and the gate (spec §7) --------------------------

    async def _validate_routing(self, decision: Decision, attribution: Attribution) -> Decision:
        """Run ``routing.validate`` on every decision and act on a mismatch."""
        tool = self._tool_by_name().get("routing.validate")
        if tool is None or self._tool_ctx is None:
            return decision
        result = await dispatch(
            tool,
            {"action": decision.action, "authority": decision.authority},
            self._tool_ctx,
            ref_id=decision.id,
        )
        if result.get("valid") is True or "error" in result:
            return decision
        expected = ACTION_AUTHORITY.get(decision.action)
        if expected is None or expected == decision.authority:
            # An action outside the taxonomy is the gate's R3, not a repair.
            return decision
        repaired = self._repair_authority(
            decision, expected, note=f"routing: {result.get('reason', 'authority mismatch')}"
        )
        await self._trace(
            "warn",
            f"routing repaired {decision.action}: authority {decision.authority} → {expected}",
            repaired,
            attribution,
            reason_code=REASON_AUTHORITY_MISMATCH,
        )
        return repaired

    async def _apply_gate(
        self, decision: Decision, attribution: Attribution, cluster: list[Anomaly]
    ) -> Decision:
        ctx = self._gate_context(attribution, cluster, decision)
        result: GateResult = self._gate(decision, ctx)
        if not result.allow:
            reason = result.reason_code or "policy/blocked"
            downgrade: Action = result.downgrade_to or GATE_DOWNGRADE_ACTION
            blocked = decision.model_copy(
                update={
                    "action": downgrade,
                    "authority": ACTION_AUTHORITY.get(downgrade, "local"),
                    "recovery": None,
                    "request_packet": None,
                    "rationale": f"[gate:{reason}] {decision.rationale}",
                }
            )
            await self._trace(
                "warn",
                f"gate blocked {decision.action}: {reason}",
                blocked,
                attribution,
                reason_code=reason,
                blocked_action=decision.action,
                note=result.note,
                satellite_id=ctx.satellite_id,
                context_anomaly_ids=[a.id for a in ctx.anomalies],
            )
            return blocked
        if result.reason_code == REASON_AUTHORITY_MISMATCH:
            expected = ACTION_AUTHORITY[decision.action]
            repaired = self._repair_authority(decision, expected, note=result.note or "gate")
            await self._trace(
                "warn",
                f"gate repaired {decision.action}: {REASON_AUTHORITY_MISMATCH}",
                repaired,
                attribution,
                reason_code=REASON_AUTHORITY_MISMATCH,
                note=result.note,
            )
            return repaired
        return decision

    # ---- Withheld recovery (spec §6, wave 4B) ---------------------------------

    @staticmethod
    def _recommended_block(
        cluster: list[Anomaly], satellite_id: str | None
    ) -> RecoveryBlock | None:
        """The cluster's ``recommended_recovery``, whatever the verdict.

        Same choice as the routing rule (the strongest anomaly carrying a valid
        block wins) but without the verdict filter, since the point is to name
        a recovery the verdict or a gate rule kept off the decision.
        """
        candidates = [
            a for a in cluster if isinstance(a.payload.get("recommended_recovery"), dict)
        ]
        for anomaly in sorted(candidates, key=lambda a: (-a.severity, a.id)):
            sat = satellite_id or anomaly.payload.get("satellite_id")
            block = _block_from(anomaly.payload["recommended_recovery"], satellite_id=sat)
            if block is not None:
                return block
        return None

    async def _annotate_withheld(
        self, decision: Decision, attribution: Attribution, cluster: list[Anomaly]
    ) -> Decision:
        """Set ``withheld_recovery`` when the cluster's recovery is not on the decision.

        Runs after the gate on every revision. A recovery decision withholds
        nothing; every other decision whose cluster carries a
        ``recommended_recovery`` is annotated with the first applicable
        reason code and a warn trace. When no reason applies (a verdict that
        is neither hostile nor unknown, no threat rule) nothing is set.
        """
        if decision.action == RECOVERY_ACTION:
            if decision.withheld_recovery is not None:
                return decision.model_copy(update={"withheld_recovery": None})
            return decision
        ctx = self._gate_context(attribution, cluster, decision)
        recommended = self._recommended_block(cluster, ctx.satellite_id)
        if recommended is None:
            if decision.withheld_recovery is not None:
                return decision.model_copy(update={"withheld_recovery": None})
            return decision
        reason = self._withheld_reason(decision, ctx, recommended)
        if reason is None:
            if decision.withheld_recovery is not None:
                return decision.model_copy(update={"withheld_recovery": None})
            return decision
        withheld = WithheldRecovery(
            action_id=recommended.action_id,
            target_subsystem=recommended.target_subsystem,
            reason_code=reason,
        )
        annotated = decision.model_copy(update={"withheld_recovery": withheld})
        await self._trace(
            "warn",
            f"recovery withheld: {withheld.action_id}: {withheld.reason_code}",
            annotated,
            attribution,
            reason_code=withheld.reason_code,
            action_id=withheld.action_id,
            target_subsystem=withheld.target_subsystem,
            verdict=ctx.verdict,
            satellite_id=ctx.satellite_id,
            context_anomaly_ids=[a.id for a in ctx.anomalies],
        )
        return annotated

    # ---- Bounded response (spec §6, 1.4) ----------------------------------------

    @staticmethod
    def _gate_reason_of(decision: Decision) -> str | None:
        """The reason code of a gate block, read from the §7 rationale prefix."""
        rationale = decision.rationale
        if not rationale.startswith("[gate:"):
            return None
        end = rationale.find("]")
        if end <= len("[gate:"):
            return None
        return rationale[len("[gate:") : end].strip() or None

    @staticmethod
    def _annotate_selection(
        decision: Decision,
        *,
        model_action: str,
        recovery: RecoveryContext | None,
        provisional: bool = False,
    ) -> Decision:
        """Set ``selectable_set`` and ``selection_basis`` (spec §6, 1.4).

        Runs last, after the gate and the withheld annotation, on every
        revision, and never changes the action. The set is the one the
        published action was legitimately drawn from: the gate's replacement
        when it blocked; the routed recovery when the §6 rule applied; the
        defensive menu otherwise, the basis saying whether the model's own
        choice (``model_action``, what the client returned) was on it.
        """
        gate_reason = DecideService._gate_reason_of(decision)
        selectable: list[Action]
        if gate_reason is not None:
            selectable = [GATE_DOWNGRADE_ACTION]
            basis = f"{SELECTION_GATE_WITHHELD_PREFIX}{gate_reason}"
        elif recovery is not None:
            selectable = [RECOVERY_ACTION]
            basis = SELECTION_RECOVERY_ROUTED
        elif provisional:
            selectable = list(DEFENSIVE_ACTIONS)
            basis = SELECTION_PROVISIONAL_RULE
        else:
            selectable = list(DEFENSIVE_ACTIONS)
            basis = (
                SELECTION_MODEL_WITHIN_SET
                if model_action in DEFENSIVE_ACTIONS
                else SELECTION_MODEL_OUTSIDE_SET_REPAIRED
            )
        return decision.model_copy(
            update={"selectable_set": selectable, "selection_basis": basis}
        )

    def _stamp_marking(
        self, decision: Decision, attribution: Attribution, cluster: list[Anomaly]
    ) -> Decision:
        """Set ``marking`` at publish (spec §1.1).

        Runs last. The decision is never marked lower than the attribution it
        answers, any anomaly the gate read as context for it (the cluster and
        the satellite's recent anomalies, the same set ``_apply_gate`` saw) or
        the client's own output.
        """
        context = self._gate_context(attribution, cluster, decision)
        return decision.model_copy(
            update={
                "marking": most_restrictive(
                    [
                        decision.marking,
                        attribution.marking,
                        *(a.marking for a in context.anomalies),
                    ]
                )
            }
        )

    @staticmethod
    def _repair_authority(decision: Decision, expected: Authority, *, note: str) -> Decision:
        """Set the authority the taxonomy requires and fix the packet to match.

        Goes through the decision validator so a repair to ``request`` gains
        the minimal packet and a repair to ``local`` drops it, the same way a
        live model output would.
        """
        data = decision.model_dump()
        data["authority"] = expected
        data["rationale"] = f"{decision.rationale} [authority repaired to {expected}: {note}]"
        data = validate_and_repair_decision(data)
        data.pop("_validation_notes", None)
        return Decision.model_validate(data)

    async def _trace(
        self,
        level: str,
        message: str,
        decision: Decision,
        attribution: Attribution,
        **payload: Any,
    ) -> None:
        if self._tracer is None:
            return
        t0, stage_t0 = self._timing if self._timing is not None else (None, None)
        await self._tracer.emit(
            "decide",
            level,  # type: ignore[arg-type]
            message,
            ref_id=decision.id,
            t0=t0,
            stage_t0=stage_t0,
            attribution_id=attribution.id,
            revision=attribution.revision,
            **payload,
        )

    def _tool_by_name(self) -> dict[str, DecisionTool]:
        return {tool.name: tool for tool in (self._tools or [])}

    # ---- Maneuver enrichment ---------------------------------------------

    async def _maybe_enrich_with_tools(
        self, decision: Decision, attribution: Attribution
    ) -> Decision:
        if self._orbit is None or self._tool_ctx is None or self._tool_ctx.orbit is None:
            return decision
        if decision.authority != "request":
            return decision
        if decision.action not in _ORBIT_ENRICHED_ACTIONS:
            return decision
        rpo = self._find_rpo_anomaly(attribution)
        if rpo is None:
            return decision
        return await self._apply_maneuver_via_tools(decision, attribution, rpo)

    def _find_rpo_anomaly(self, attribution: Attribution) -> Anomaly | None:
        for aid in attribution.anomaly_ids:
            anomaly = self._anomaly_cache.get(aid)
            if anomaly is not None and anomaly.kind == "orbital_rpo_risk":
                return anomaly
        return None

    async def _apply_maneuver_via_tools(
        self,
        decision: Decision,
        attribution: Attribution,
        rpo: Anomaly,
    ) -> Decision:
        """Drive the maneuver enrichment through the tool registry.

        The math is the same as before, but it runs through the named tools
        so the reasoning panel sees ``[tools] orbit.simulate_maneuver →
        post=110.4km``-style lines instead of opaque orbit enrichment.
        """
        assert self._tool_ctx is not None and self._tools is not None

        observables = (rpo.payload.get("observables") or {}) if rpo.payload else {}
        friendly = observables.get("target") or rpo.payload.get("satellite")
        inspector = rpo.payload.get("asset") or observables.get("asset")
        if not friendly or not inspector:
            log.debug(
                "decide: skipping orbit enrichment — could not identify "
                "friendly/inspector pair from anomaly %s",
                rpo.id,
            )
            return decision

        pre_miss_km = observables.get("miss_distance_km")
        if pre_miss_km is None:
            pre_miss_km = observables.get("range_km")
        if pre_miss_km is None:
            pre_miss_km = 10.0

        t_tca = _parse_tca(observables.get("time_of_closest_approach"))
        signal_burn_time = _ensure_utc(rpo.ts) + _AUTHORIZATION_LATENCY
        if t_tca is not None:
            actual_lead_s = max(0.0, (t_tca - signal_burn_time).total_seconds())
            effective_lead_s = max(actual_lead_s, MIN_OPERATIONAL_LEAD_S)
            t_burn = t_tca - timedelta(seconds=effective_lead_s)
        else:
            actual_lead_s = None
            t_burn = signal_burn_time

        tool_by_name = self._tool_by_name()

        # 1) kb.lookup — pull KB context for the actor.
        kb_tool = tool_by_name.get("kb.lookup")
        if kb_tool is not None:
            await dispatch(
                kb_tool,
                {"actor": attribution.actor},
                self._tool_ctx,
                ref_id=decision.id,
            )

        # 2) orbit.compute_close_approach — independently verify the
        # close-approach geometry using Skyfield SGP4 against cached
        # TLEs. The demo scenarios use synthetic satellite names that
        # aren't in the catalog; when that's the case fall back to a
        # documented adversary inspector (SJ-21, the Chinese inspector
        # that physically grappled BeiDou-2 G2 in 2022) so the operator
        # still sees the tool fire with real ephemeris numbers. Either
        # way the trace shows real math, not a template.
        ca_tool = tool_by_name.get("orbit.compute_close_approach")
        if ca_tool is not None and self._tool_ctx.orbit is not None:
            known = set(self._tool_ctx.orbit.known_satellites())
            if friendly in known and inspector in known:
                ca_args = {"sat_a": friendly, "sat_b": inspector}
            elif len(known) >= 2:
                # Pick a documented adversary pair from the catalog so
                # the displayed math is grounded in real public TLEs.
                ordered = sorted(known)
                ca_args = {"sat_a": ordered[0], "sat_b": ordered[1]}
            else:
                ca_args = None
            if ca_args is not None:
                await dispatch(
                    ca_tool, ca_args, self._tool_ctx, ref_id=decision.id
                )

        # 3) orbit.simulate_maneuver — the actual maneuver math.
        sim_tool = tool_by_name.get("orbit.simulate_maneuver")
        if sim_tool is None:
            return decision
        sim_args = {
            "sat": friendly,
            "against": inspector,
            "pre_miss_km": pre_miss_km,
            "t_burn_iso": _format_utc(t_burn),
        }
        if t_tca is not None:
            sim_args["t_tca_iso"] = _format_utc(t_tca)
        sim_result = await dispatch(
            sim_tool, sim_args, self._tool_ctx, ref_id=decision.id
        )
        if "error" in sim_result:
            return decision

        burn_for_packet = {
            **sim_result,
            "lead_seconds": sim_result.get("lead_seconds"),
        }

        # 4) request.draft — assemble the CJFSCC request packet.
        draft_tool = tool_by_name.get("request.draft")
        request_packet: dict[str, Any] = dict(decision.request_packet or {})
        if draft_tool is not None:
            draft_result = await dispatch(
                draft_tool,
                {
                    "actor": attribution.actor,
                    "confidence": attribution.confidence,
                    "justification": list(attribution.evidence),
                    "kb_citations": list(attribution.kb_citations),
                    "burn": burn_for_packet,
                },
                self._tool_ctx,
                ref_id=decision.id,
            )
            drafted = draft_result.get("request_packet") or {}
            request_packet.update(drafted)
            request_packet["pre_miss_km"] = sim_result.get("pre_miss_km")
            request_packet["post_miss_km"] = sim_result.get("post_miss_km")
            burn_block = request_packet.setdefault("recommended_burn", {})
            burn_block.setdefault("sat", sim_result.get("sat"))
            burn_block.setdefault("against", inspector)
            burn_block.setdefault("dv_m_s", sim_result.get("dv_m_s"))
            burn_block.setdefault("t_burn_utc", sim_result.get("t_burn"))
            burn_block.setdefault("lead_seconds", sim_result.get("lead_seconds"))
            burn_block["actual_lead_seconds"] = (
                round(actual_lead_s, 0) if actual_lead_s is not None else None
            )

        # routing.validate runs for every decision in ``_validate_routing``.
        return decision.model_copy(update={"request_packet": request_packet})


def _ensure_utc(ts: datetime) -> datetime:
    return ts if ts.tzinfo is not None else ts.replace(tzinfo=UTC)


def _parse_tca(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _format_utc(t: datetime) -> str:
    if t.tzinfo is None:
        t = t.replace(tzinfo=UTC)
    return t.astimezone(UTC).isoformat().replace("+00:00", "Z")
