"""Tool surface for the decide agent.

Defines five named tools the decide agent can call. Each tool wraps an
existing engine capability (KB lookup, orbit math, request templating,
routing rules) so the reasoning panel reads as real work, not narration:
when the panel says ``[tools] orbit.compute_close_approach → 8.2 km in
11:47`` the math actually ran. The same tools are used by the live
Anthropic tool-use loop and the deterministic stub planner.
"""
from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from canopy.services.kb import KB
from canopy.services.orbit import MIN_OPERATIONAL_LEAD_S, OrbitService
from canopy.services.schemas.events import (
    ACTION_AUTHORITY,
    SELECTABLE_ACTIONS,
    Action,
    Anomaly,
    Authority,
    Decision,
    Verdict,
)
from canopy.services.traces import Tracer

log = logging.getLogger(__name__)

__all__ = [
    "GATE_DOWNGRADE_ACTION",
    "REASON_AUTHORITY_MISMATCH",
    "REASON_UNSELECTABLE_ACTION",
    "DecisionTool",
    "Gate",
    "GateContext",
    "GateResult",
    "ToolContext",
    "build_tool_registry",
    "gate_allow",
    "policy_gate",
]


@dataclass
class ToolContext:
    """Shared context plumbed through every tool call."""

    kb: KB
    orbit: OrbitService | None
    tracer: Tracer | None


class DecisionTool(Protocol):
    name: str
    description: str
    input_schema: dict[str, Any]

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]: ...


# ---- kb.lookup -------------------------------------------------------------


@dataclass
class KBLookupTool:
    name: str = "kb.lookup"
    description: str = (
        "Look up KB entries by actor, capability_type, or scenario_signal_id. "
        "Returns a list of matching KB entries (id, actor, title, summary)."
    )
    input_schema: dict[str, Any] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        self.input_schema = {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "actor": {"type": "string"},
                "capability_type": {"type": "string"},
                "scenario_signal_id": {"type": "string"},
            },
        }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        entries = []
        if "scenario_signal_id" in args:
            entries.extend(ctx.kb.by_scenario_signal_id(args["scenario_signal_id"]))
        if "capability_type" in args:
            entries.extend(ctx.kb.by_capability(args["capability_type"]))
        if "actor" in args:
            entries.extend(ctx.kb.by_actor(args["actor"]))

        seen: set[str] = set()
        deduped = []
        for entry in entries:
            if entry.id in seen:
                continue
            seen.add(entry.id)
            deduped.append(
                {
                    "id": entry.id,
                    "actor": entry.actor,
                    "title": entry.title,
                    "summary": entry.summary,
                    "capability_type": entry.capability_type,
                }
            )
        return {"entries": deduped, "count": len(deduped)}


# ---- orbit.compute_close_approach -----------------------------------------


@dataclass
class OrbitCloseApproachTool:
    name: str = "orbit.compute_close_approach"
    description: str = (
        "Compute the closest approach between two cached satellites within a "
        "search window. Returns closest_approach_km and t_closest. Backed by "
        "Skyfield SGP4 propagation against the cached TLE bundle."
    )
    input_schema: dict[str, Any] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        self.input_schema = {
            "type": "object",
            "additionalProperties": False,
            "required": ["sat_a", "sat_b"],
            "properties": {
                "sat_a": {"type": "string"},
                "sat_b": {"type": "string"},
                "window_minutes": {"type": "number", "default": 360.0},
                "t0_iso": {"type": "string"},
            },
        }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        if ctx.orbit is None:
            return {"error": "orbit service unavailable"}
        sat_a = args["sat_a"]
        sat_b = args["sat_b"]
        if sat_a not in ctx.orbit.known_satellites():
            return {"error": f"unknown satellite: {sat_a}"}
        if sat_b not in ctx.orbit.known_satellites():
            return {"error": f"unknown satellite: {sat_b}"}

        window = timedelta(minutes=float(args.get("window_minutes", 360.0)))
        t0 = _parse_iso(args.get("t0_iso"))
        result = ctx.orbit.close_approach(sat_a, sat_b, window=window, t0=t0)
        return {
            "sat_a": result.sat_a,
            "sat_b": result.sat_b,
            "closest_approach_km": round(result.closest_approach_km, 2),
            "t_closest": _format_iso(result.t_closest),
        }


# ---- orbit.simulate_maneuver -----------------------------------------------


@dataclass
class OrbitSimulateManeuverTool:
    name: str = "orbit.simulate_maneuver"
    description: str = (
        "Simulate a Clohessy-Wiltshire prograde impulsive burn for a friendly "
        "satellite to widen the miss distance against an inspector. Returns "
        "pre_miss_km, post_miss_km, dv_m_s, lead_seconds. The Δv is sized via "
        "OrbitService.recommended_dv unless the caller overrides it."
    )
    input_schema: dict[str, Any] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        self.input_schema = {
            "type": "object",
            "additionalProperties": False,
            "required": ["sat", "pre_miss_km"],
            "properties": {
                "sat": {"type": "string"},
                "against": {"type": "string"},
                "pre_miss_km": {"type": "number"},
                "t_burn_iso": {"type": "string"},
                "t_tca_iso": {"type": "string"},
                "dv_m_s": {"type": "number"},
            },
        }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        if ctx.orbit is None:
            return {"error": "orbit service unavailable"}
        sat = args["sat"]
        pre_miss_km = float(args["pre_miss_km"])
        t_tca = _parse_iso(args.get("t_tca_iso"))
        t_burn = _parse_iso(args.get("t_burn_iso"))
        if t_burn is None and t_tca is not None:
            t_burn = t_tca - timedelta(seconds=MIN_OPERATIONAL_LEAD_S)
        elif t_burn is None:
            t_burn = datetime.now(UTC)

        if t_tca is not None:
            lead_s = max(MIN_OPERATIONAL_LEAD_S, (t_tca - t_burn).total_seconds())
        else:
            lead_s = MIN_OPERATIONAL_LEAD_S

        dv_m_s = args.get("dv_m_s")
        if dv_m_s is None:
            dv_m_s = ctx.orbit.recommended_dv(pre_miss_km, lead_s)
        result = ctx.orbit.simulate_maneuver(
            sat,
            dv_m_s=float(dv_m_s),
            t_burn=t_burn,
            against=args.get("against"),
            pre_miss_km=pre_miss_km,
            t_tca=t_tca,
        )
        return {
            "sat": result.sat,
            "against": args.get("against"),
            "pre_miss_km": result.pre_miss_km,
            "post_miss_km": result.post_miss_km,
            "dv_m_s": round(result.dv_m_s, 3),
            "lead_seconds": round(result.lead_seconds, 0),
            "t_burn": _format_iso(result.t_burn),
        }


# ---- request.draft ---------------------------------------------------------


@dataclass
class RequestDraftTool:
    name: str = "request.draft"
    description: str = (
        "Draft a CJFSCC-formatted request packet for a request-authority "
        "decision. Includes the actor, justification, KB citations, and any "
        "attached burn block. Returns a ready-to-attach request_packet dict."
    )
    input_schema: dict[str, Any] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        self.input_schema = {
            "type": "object",
            "additionalProperties": False,
            "required": ["actor", "confidence", "justification"],
            "properties": {
                "to": {"type": "string", "default": "CJFSCC"},
                "actor": {"type": "string"},
                "confidence": {"type": "number"},
                "justification": {
                    "type": "array",
                    "items": {"type": "string"},
                },
                "kb_citations": {
                    "type": "array",
                    "items": {"type": "string"},
                },
                "supporting_supported": {"type": "string", "default": "supported_by_USSF"},
                "burn": {
                    "type": ["object", "null"],
                    "description": "Optional recommended_burn block from orbit.simulate_maneuver",
                },
            },
        }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        packet: dict[str, Any] = {
            "to": args.get("to", "CJFSCC"),
            "supporting_supported": args.get("supporting_supported", "supported_by_USSF"),
            "actor": args["actor"],
            "confidence": float(args["confidence"]),
            "justification": list(args.get("justification", [])),
            "kb_citations": list(args.get("kb_citations", [])),
        }
        burn = args.get("burn")
        if burn:
            packet["recommended_burn"] = {
                "sat": burn.get("sat"),
                "against": burn.get("against"),
                "dv_m_s": burn.get("dv_m_s"),
                "t_burn_utc": burn.get("t_burn"),
                "lead_seconds": burn.get("lead_seconds"),
            }
            if "pre_miss_km" in burn:
                packet["pre_miss_km"] = burn["pre_miss_km"]
            if "post_miss_km" in burn:
                packet["post_miss_km"] = burn["post_miss_km"]
        return {"request_packet": packet}


# ---- routing.validate ------------------------------------------------------

# Authority routing is the canonical ACTION_AUTHORITY table in schemas.events
# (keyed over the full Action taxonomy), so this validator can't drift from the
# actions it checks. ``request`` means the action requires CJFSCC engagement
# authority, not the local commander; a local commander cannot authorise
# active-defense or strike actions on their own.


@dataclass
class RoutingValidateTool:
    name: str = "routing.validate"
    description: str = (
        "Validate that the proposed action is being routed to the correct "
        "authority. Returns valid=True/False and a reason string. Local "
        "commanders cannot authorise active-defense or strike actions."
    )
    input_schema: dict[str, Any] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        self.input_schema = {
            "type": "object",
            "additionalProperties": False,
            "required": ["action", "authority"],
            "properties": {
                "action": {"type": "string"},
                "authority": {"type": "string", "enum": ["local", "request"]},
            },
        }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        action: Action = args["action"]
        authority: Authority = args["authority"]
        expected = ACTION_AUTHORITY.get(action)
        if expected is None:
            return {
                "valid": False,
                "reason": f"unknown action: {action}",
            }
        if expected != authority:
            return {
                "valid": False,
                "reason": (
                    f"action {action} requires authority={expected}; got {authority}"
                ),
            }
        return {"valid": True, "reason": f"action {action} routed correctly to {authority}"}


# ---- Decision gate contract -----------------------------------------------
#
# A gate runs in DecideService between tool enrichment and publish
# (docs/INTERFACE-SPEC.md §7). It sees the decision plus the threat context
# for the satellite it concerns and either allows it, allows it with an
# authority repair, or blocks it; a blocked decision is republished as a local
# threat_warning. The two threat-context rules (R1 uplink jamming, R2 hostile
# close approach) need the anomaly kind→domain table and live in
# ``megalith.gate.rules``; the two policy rules below (R3 unselectable action,
# R4 authority mismatch) depend only on the action taxonomy and live here so
# CANOPY enforces them even when it runs without the MEGALITH package.
# ``megalith.gate.rules`` re-exports these types and chains onto
# :func:`policy_gate` after its own rules.

REASON_UNSELECTABLE_ACTION = "policy/unselectable_action"
REASON_AUTHORITY_MISMATCH = "policy/authority_mismatch"

# What a blocked decision is republished as.
GATE_DOWNGRADE_ACTION: Action = "threat_warning"


@dataclass(frozen=True)
class GateContext:
    """Threat context for one decision: everything recent on its satellite."""

    satellite_id: str | None
    verdict: Verdict | None
    anomalies: tuple[Anomaly, ...]


@dataclass(frozen=True)
class GateResult:
    """``allow=False`` blocks; ``allow=True`` with a reason code is a repair."""

    allow: bool
    reason_code: str | None
    downgrade_to: Action | None
    note: str


Gate = Callable[[Decision, GateContext], GateResult]


def gate_allow(note: str = "") -> GateResult:
    return GateResult(allow=True, reason_code=None, downgrade_to=None, note=note)


def policy_gate(decision: Decision, ctx: GateContext) -> GateResult:
    """Rules R3 and R4 of the decision gate; pure and deterministic.

    R3 blocks any action outside ``SELECTABLE_ACTIONS`` (the offensive
    counterspace actions exist in the taxonomy for routing and replay but must
    never be published as a recommendation). R4 allows but flags an authority
    that disagrees with ``ACTION_AUTHORITY``; the caller repairs it.
    """
    if decision.action not in SELECTABLE_ACTIONS:
        return GateResult(
            allow=False,
            reason_code=REASON_UNSELECTABLE_ACTION,
            downgrade_to=GATE_DOWNGRADE_ACTION,
            note=f"{decision.action} is not a selectable action",
        )
    expected = ACTION_AUTHORITY[decision.action]
    if decision.authority != expected:
        return GateResult(
            allow=True,
            reason_code=REASON_AUTHORITY_MISMATCH,
            downgrade_to=None,
            note=(
                f"{decision.action} requires authority={expected}; "
                f"got {decision.authority}; repaired"
            ),
        )
    return gate_allow()


# ---- Helpers ---------------------------------------------------------------


def _parse_iso(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _format_iso(t: datetime) -> str:
    if t.tzinfo is None:
        t = t.replace(tzinfo=UTC)
    return t.astimezone(UTC).isoformat().replace("+00:00", "Z")


def build_tool_registry(
    *,
    kb: KB,
    orbit: OrbitService | None,
    tracer: Tracer | None,
) -> tuple[ToolContext, list[DecisionTool]]:
    """Return the shared (context, tool_list) used by stub + live decide."""
    ctx = ToolContext(kb=kb, orbit=orbit, tracer=tracer)
    tools: list[DecisionTool] = [
        KBLookupTool(),
        OrbitCloseApproachTool(),
        OrbitSimulateManeuverTool(),
        RequestDraftTool(),
        RoutingValidateTool(),
    ]
    return ctx, tools


async def dispatch(
    tool: DecisionTool,
    args: dict[str, Any],
    ctx: ToolContext,
    *,
    ref_id: str | None = None,
) -> dict[str, Any]:
    """Execute a tool and emit a tools-stage trace before/after."""
    try:
        result = await tool.execute(args, ctx)
    except Exception as exc:
        log.exception("decide tool %s failed: %s", tool.name, exc)
        if ctx.tracer is not None:
            await ctx.tracer.emit(
                "tools",
                "warn",
                f"{tool.name} failed: {exc}",
                ref_id=ref_id,
                tool=tool.name,
                args=args,
            )
        return {"error": str(exc)}
    if ctx.tracer is not None:
        summary = _summarise_result(tool.name, result)
        await ctx.tracer.emit(
            "tools",
            "tool",
            f"{tool.name} → {summary}",
            ref_id=ref_id,
            tool=tool.name,
            args=args,
            result=result,
        )
    return result


def _summarise_result(tool_name: str, result: dict[str, Any]) -> str:
    if "error" in result:
        return f"error: {result['error']}"
    if tool_name == "kb.lookup":
        return f"{result.get('count', 0)} entries"
    if tool_name == "orbit.compute_close_approach":
        return f"{result.get('closest_approach_km')} km @ {result.get('t_closest')}"
    if tool_name == "orbit.simulate_maneuver":
        return (
            f"pre={result.get('pre_miss_km')}km post={result.get('post_miss_km')}km "
            f"dv={result.get('dv_m_s')}m/s"
        )
    if tool_name == "request.draft":
        packet = result.get("request_packet", {})
        return f"packet to {packet.get('to')}"
    if tool_name == "routing.validate":
        return f"valid={result.get('valid')} ({result.get('reason')})"
    return "ok"
