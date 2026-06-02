"""The Action taxonomy has one source of truth.

`schemas.events` owns the `Action` literal plus the two tables derived from it
(`ACTION_AUTHORITY`, `SELECTABLE_ACTIONS`); `decide.prompts` and `decide.tools`
must consume those rather than re-declaring their own action lists. These tests
guard against the three-way drift that previously existed (a 5-action tool enum
vs. an 8-action routing dict vs. the 8-action literal).
"""
from __future__ import annotations

from typing import get_args

from canopy.services.decide.prompts import DECISION_TOOL
from canopy.services.decide.tools import RoutingValidateTool, ToolContext
from canopy.services.kb import KB
from canopy.services.schemas.events import (
    ACTION_AUTHORITY,
    SELECTABLE_ACTIONS,
    Action,
)

# The offensive counterspace actions: in the taxonomy (so Decisions/routing can
# model them) but never selectable by the defensive decision agent.
OFFENSIVE_ACTIONS = {
    "active_defense_counterattack",
    "orbital_strike_request",
    "terrestrial_strike_request",
}


def test_action_authority_covers_exactly_the_action_literal() -> None:
    assert set(ACTION_AUTHORITY) == set(get_args(Action))


def test_selectable_actions_are_real_defensive_actions() -> None:
    assert set(SELECTABLE_ACTIONS) <= set(get_args(Action))
    # The defensive subset is exactly the full taxonomy minus the offensive set.
    assert set(SELECTABLE_ACTIONS) == set(get_args(Action)) - OFFENSIVE_ACTIONS
    # No duplicates / stable menu order.
    assert len(SELECTABLE_ACTIONS) == len(set(SELECTABLE_ACTIONS))


def test_decision_tool_enum_is_derived_from_selectable_actions() -> None:
    enum = DECISION_TOOL["input_schema"]["properties"]["action"]["enum"]
    assert enum == list(SELECTABLE_ACTIONS)
    # Offensive actions must not be offered to the agent.
    assert not (set(enum) & OFFENSIVE_ACTIONS)


def test_tool_authority_mapping_matches_canonical_table() -> None:
    # The "Default mapping" prose in the submit_decision tool is rendered from
    # ACTION_AUTHORITY, so it can't claim a routing the validator would reject.
    desc = DECISION_TOOL["input_schema"]["properties"]["authority"]["description"]
    for action in SELECTABLE_ACTIONS:
        assert f"{action} → {ACTION_AUTHORITY[action]}" in desc
    # The agent's menu never lists offensive actions.
    for action in OFFENSIVE_ACTIONS:
        assert action not in desc


async def test_routing_validate_agrees_with_action_authority_for_all_actions() -> None:
    tool = RoutingValidateTool()
    ctx = ToolContext(kb=KB(entries=[]), orbit=None, tracer=None)
    for action, expected in ACTION_AUTHORITY.items():
        other = "request" if expected == "local" else "local"
        good = await tool.execute({"action": action, "authority": expected}, ctx)
        assert good["valid"] is True, action
        bad = await tool.execute({"action": action, "authority": other}, ctx)
        assert bad["valid"] is False, action
