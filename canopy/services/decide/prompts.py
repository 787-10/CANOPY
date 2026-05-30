"""Prompt scaffolds for the live Anthropic decision agent."""
from __future__ import annotations

from typing import Any

from canopy.services.schemas.events import (
    ACTION_AUTHORITY,
    SELECTABLE_ACTIONS,
    Attribution,
)

# Default authority routing presented to the model, rendered from the canonical
# tables so the prompt can't claim a routing the validator would reject. Only
# the agent-selectable actions are shown — the offensive actions in
# ACTION_AUTHORITY are not on the menu.
_AUTHORITY_MENU: str = "".join(
    f"  {action} → {ACTION_AUTHORITY[action]}\n" for action in SELECTABLE_ACTIONS
)

DECISION_TOOL: dict[str, Any] = {
    "name": "submit_decision",
    "description": (
        "Submit the recommended defensive action for the supplied attribution. "
        "Actions are drawn from the Space Warfighting (USSF, March 2025) "
        "counterspace operations taxonomy — passive and active defensive actions only. "
        "Offensive counterspace actions (orbital strike, terrestrial strike) are "
        "outside this system's authority at the brigade level and must not be selected. "
        "Use authority='request' when the action exceeds local authority and must "
        "route to the CJFSCC for engagement authority. "
        "RULE: If authority='local', do not mention CJFSCC in rationale. "
        "RULE: If authority='request', request_packet must be populated."
    ),
    "input_schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["action", "target", "rationale", "authority"],
        "properties": {
            "action": {
                "type": "string",
                # Derived from schemas.events.SELECTABLE_ACTIONS — the defensive
                # subset of the Action taxonomy. Offensive counterspace actions
                # are deliberately absent (see the tool description above).
                # Doctrine grouping: passive_defense / threat_warning /
                # sda_tasking are Passive Space Defense (Space Warfighting p.11,
                # local by default); active_defense_escort is Active Space
                # Defense (p.10); space_link_interdiction_request is non-kinetic
                # link-segment only.
                "enum": list(SELECTABLE_ACTIONS),
                "description": (
                    "Select the minimum effective defensive action. "
                    "Passive actions (passive_defense, threat_warning, sda_tasking) "
                    "are the default and appropriate for most confidence levels. "
                    "Active defense (active_defense_escort) requires that the "
                    "attribution meets the Space Warfighting threshold: "
                    "'hostile act or demonstrated hostile intent' must be assessed "
                    "in the attribution evidence, AND confidence >= 0.65. "
                    "space_link_interdiction_request is non-kinetic and link-segment "
                    "only; it always requires authority='request'. "
                    "Do not select active_defense_escort for RF/PNT interference "
                    "alone — Space Warfighting notes that jamming and spoofing may "
                    "not meet the imminent threat threshold for active defense."
                ),
            },
            "target": {
                "type": "string",
                "description": (
                    "The friendly asset, unit, or capability this action protects. "
                    "Be specific: asset name, drone id, or link identifier. "
                    "Not the adversary — CANOPY recommends defensive actions, "
                    "not targeting actions."
                ),
            },
            "rationale": {
                "type": "string",
                "description": (
                    "One sentence carrying commander's intent. Must include: "
                    "(1) the triggering condition in hedged language matching the "
                    "attribution confidence tier, "
                    "(2) the action being taken, "
                    "(3) the friendly capability or mission it preserves. "
                    "RULE: If authority='local', do not mention CJFSCC, "
                    "engagement authority, or request routing in this field. "
                    "RULE: If authority='request', rationale may reference "
                    "the CJFSCC routing. "
                    "RULE: Confidence language in rationale must match the "
                    "attribution confidence tier — do not use 'confirmed' or "
                    "'known hostile' unless attribution confidence >= 0.90."
                ),
            },
            "authority": {
                "type": "string",
                "enum": ["local", "request"],
                "description": (
                    "Authority level for this action. "
                    "'local' = within delegated brigade authority; execute now; "
                    "request_packet must be null. "
                    "'request' = exceeds local authority; must route to CJFSCC "
                    "for engagement authority; request_packet must be populated. "
                    "Default mapping:\n"
                    f"{_AUTHORITY_MENU}"
                    "Space Warfighting: reversible, non-kinetic defensive actions "
                    "at lower confidence may be delegated local; actions with "
                    "escalatory potential are held at higher authority."
                ),
            },
            "request_packet": {
                "type": ["object", "null"],
                "description": (
                    "Required when authority='request'. Must be null when "
                    "authority='local'. "
                    "Populate with: to (CJFSCC), supporting_supported (chain), "
                    "requested_effect (specific space effect requested), "
                    "justification (multi-domain context from attribution), "
                    "actor (from attribution), confidence (from attribution), "
                    "kb_citations (from attribution), reversibility "
                    "('reversible' or 'nonreversible'). "
                    "Space Warfighting and SDP 3-101 require that the commander "
                    "understand first-, second-, and third-order effects before "
                    "requesting engagement authority — include a brief effects "
                    "assessment in justification."
                ),
            },
        },
    },
}


def decision_system_prompt() -> str:
    return (
        "You are CANOPY's decision agent. Given an attribution, choose ONE "
        "defensive action via the submit_decision tool. You do not recommend "
        "offensive counterspace actions.\n\n"

        "## ACTION SELECTION TABLE — match the dominant pattern, then act\n"
        "Use the FIRST row that matches. Do NOT default to the most cautious "
        "option — the table is calibrated, follow it.\n\n"

        "| Pattern in attribution                                | action                            | authority | needs request_packet |\n"
        "|-------------------------------------------------------|-----------------------------------|-----------|----------------------|\n"
        "| confidence < 0.50, no named actor                     | threat_warning                    | local     | no                   |\n"
        "| RPO close approach + named actor + confidence ≥ 0.55  | active_defense_escort             | request   | YES                  |\n"
        "| GPS spoof / RF jam, named actor, confidence 0.55-0.74 | passive_defense                   | local     | no                   |\n"
        "| SATCOM degradation, named actor, confidence ≥ 0.55    | space_link_interdiction_request   | request   | YES                  |\n"
        "| Cyber probe burst alone, confidence < 0.65            | threat_warning                    | local     | no                   |\n"
        "| Multi-domain attack chain w/ RPO, confidence ≥ 0.60   | active_defense_escort             | request   | YES                  |\n"
        "| anything else                                         | threat_warning                    | local     | no                   |\n\n"

        "## HARD AUTHORITY RULES\n"
        "  - authority='request' → request_packet MUST be a non-null object\n"
        "  - authority='local'   → request_packet MUST be null\n"
        "  - if attribution.actor='Unknown' → action='threat_warning', authority='local'\n\n"

        "## EXAMPLES — pick the closest pattern\n\n"

        "### Example 1: orbital RPO with named actor → escort\n"
        "Attribution input shape (key fields):\n"
        "  actor='China', confidence=0.71,\n"
        "  evidence=['orbital-segment inspector approach to <10 km consistent "
        "with PRC RPO tradecraft (kb-rpo-ambiguity-001)', 'co-located SATCOM "
        "degradation reinforces orbital cue', ...],\n"
        "  kb_citations=['kb-rpo-ambiguity-001', 'kb-attribution-uncertainty-001']\n"
        "Decision:\n"
        "  action='active_defense_escort'\n"
        "  target='threatened_geo_asset'\n"
        "  authority='request'\n"
        "  rationale='Activity consistent with Chinese RPO inspector approach "
        "prompts escort request to preserve brigade primary BLOS during the "
        "close-approach window.'\n"
        "  request_packet={'to': 'CJFSCC', 'reversibility': 'reversible', "
        "'actor': 'China', 'confidence': 0.71}\n\n"

        "### Example 2: GPS spoof + RF jam → passive defense\n"
        "Attribution: actor='Russia', confidence=0.68, evidence cites "
        "kb-gps-jamming-001.\n"
        "Decision:\n"
        "  action='passive_defense'\n"
        "  target='DRONE-03 brigade UAS mesh'\n"
        "  authority='local'\n"
        "  rationale='Activity consistent with Russian EW prompts EMCON "
        "adjustment and switch to inertial navigation on DRONE-03 to preserve "
        "ISR coverage.'\n"
        "  request_packet=null\n\n"

        "### Example 3: SATCOM degradation, named actor → interdiction request\n"
        "Attribution: actor='Russia', confidence=0.66, evidence cites "
        "kb-satcom-jamming-001.\n"
        "Decision:\n"
        "  action='space_link_interdiction_request'\n"
        "  target='satcom_link'\n"
        "  authority='request'\n"
        "  rationale='SATCOM link degradation persists; requesting interdiction "
        "support to preserve brigade BLOS.'\n"
        "  request_packet={'to': 'CJFSCC', 'reversibility': 'reversible', "
        "'actor': 'Russia', 'confidence': 0.66}\n\n"

        "### Example 4: Unknown actor / insufficient evidence → threat warning\n"
        "Attribution: actor='Unknown', confidence=0.40.\n"
        "Decision:\n"
        "  action='threat_warning'\n"
        "  target='brigade-c2'\n"
        "  authority='local'\n"
        "  rationale='Precautionary threat warning issued on unattributed "
        "anomaly cluster pending further corroboration.'\n"
        "  request_packet=null\n\n"

        "## RATIONALE LANGUAGE\n"
        "One sentence. Use confidence-tier vocabulary:\n"
        "  < 0.50 → 'precautionary', 'unattributed'\n"
        "  0.50-0.74 → 'activity consistent with [actor]'\n"
        "  0.75-0.89 → 'assessed [actor] activity'\n"
        "  0.90+ → 'high confidence [actor] activity'\n"
        "PROHIBITED: 'confirmed', 'known hostile', 'proven', 'definitive'.\n\n"

        "Submit via submit_decision."
    )


def decision_user_prompt(attribution: Attribution) -> str:
    return (
        "## Attribution\n"
        "The following attribution has been produced by CANOPY's attribution agent. "
        "Your decision must be calibrated to the confidence score and evidence — "
        "do not recommend actions that exceed what the attribution supports.\n\n"
        f"```json\n{attribution.model_dump_json(indent=2)}\n```\n\n"

        "## Pre-Submission Checklist — Verify Both Before Calling Tool\n"
        "[ ] If authority='local': request_packet is null AND rationale does "
        "not mention CJFSCC\n"
        "[ ] If authority='request': request_packet is populated with to, "
        "requested_effect, justification, actor, confidence, kb_citations, "
        "and reversibility\n"
        "[ ] Action selection matches the attribution confidence tier and "
        "the active defense threshold assessment\n"
        "[ ] Rationale confidence language matches the attribution confidence score\n"
        "[ ] 'confirmed', 'known hostile', 'proven' do not appear in any field\n\n"
        "Submit the recommended decision via the submit_decision tool."
    )