"""Prompt scaffolds for the live Anthropic decision agent.

Also home to the recovery-context helpers shared by the decide service, the
stub, and the live prompt: how an internal-diagnosis ``recommended_recovery``
travels from the anomaly cluster to the decision (docs/INTERFACE-SPEC.md §6).
"""
from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError

from canopy.services.schemas.events import (
    ACTION_AUTHORITY,
    SELECTABLE_ACTIONS,
    Anomaly,
    Attribution,
    RecoveryBlock,
)

__all__ = [
    "DECISION_TOOL",
    "RECOVERY_CONTEXT_KEY",
    "RECOVERY_TARGET_KEY",
    "RECOVERY_VERDICTS",
    "RecoveryContext",
    "decision_system_prompt",
    "decision_user_prompt",
    "recovery_context",
    "recovery_rationale",
    "with_recovery_context",
]

# ``LLMClient.decide`` receives only the attribution, so DecideService attaches
# the cluster's recovery block to the attribution it hands the client as two
# extra fields (``Attribution`` allows extras). Both the stub and the live
# prompt read them back through :func:`recovery_context`.
RECOVERY_CONTEXT_KEY = "recommended_recovery"
RECOVERY_TARGET_KEY = "recovery_target"

# Verdicts for which an internal-diagnosis recovery is the decision (§6).
RECOVERY_VERDICTS: frozenset[str] = frozenset({"internal_fault", "natural_external"})

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
        "counterspace operations taxonomy — passive and active defensive actions only — "
        "plus recovery_recommendation, which forwards an internal-diagnosis recovery "
        "for an internal_fault or natural_external verdict. "
        "Offensive counterspace actions (orbital strike, terrestrial strike) are "
        "outside this system's delegated authority and must not be selected. "
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
                    "recovery_recommendation is the one non-counterspace action: "
                    "select it only when attribution.verdict is internal_fault or "
                    "natural_external and a recommended_recovery block is present; "
                    "it is always local authority. "
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
                    "'local' = within the local space operations cell's delegated authority; execute now; "
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
            "recovery": {
                "type": ["object", "null"],
                "description": (
                    "Required when action='recovery_recommendation'; must be null "
                    "for every other action. Copy the internal-diagnosis "
                    "recommended_recovery block from the attribution context "
                    "verbatim: action_id, target_subsystem, requires_approval, "
                    "rationale, satellite_id. Never invent a recovery."
                ),
                "additionalProperties": False,
                "required": ["action_id", "target_subsystem", "requires_approval", "rationale"],
                "properties": {
                    "action_id": {"type": "string"},
                    "target_subsystem": {"type": "string"},
                    "requires_approval": {"type": "boolean"},
                    "rationale": {"type": "string"},
                    "source": {"type": "string", "enum": ["internal-diagnosis"]},
                    "satellite_id": {"type": ["string", "null"]},
                },
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
        "| verdict internal_fault/natural_external + recovery block | recovery_recommendation          | local     | no                   |\n"
        "| Multi-domain attack chain w/ RPO, confidence ≥ 0.60   | active_defense_escort             | request   | YES                  |\n"
        "| anything else                                         | threat_warning                    | local     | no                   |\n\n"

        "## HARD AUTHORITY RULES\n"
        "  - authority='request' → request_packet MUST be a non-null object\n"
        "  - authority='local'   → request_packet MUST be null\n"
        "  - if attribution.actor='Unknown' → action='threat_warning', authority='local'\n"
        "  - recovery_recommendation → authority='local' (never 'request'); it is "
        "appropriate ONLY when attribution.verdict is 'internal_fault' or "
        "'natural_external'. Never select it for 'hostile_external' or 'unknown'.\n"
        "  - when the attribution carries a recovery recommendation and the verdict "
        "allows it, recovery_recommendation is REQUIRED: copy the block into the "
        "recovery field verbatim. The recovery field is null for every other action.\n\n"

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
        "prompts escort request to preserve the primary BLOS link during the "
        "close-approach window.'\n"
        "  request_packet={'to': 'CJFSCC', 'reversibility': 'reversible', "
        "'actor': 'China', 'confidence': 0.71}\n\n"

        "### Example 2: GPS spoof + RF jam → passive defense\n"
        "Attribution: actor='Russia', confidence=0.68, evidence cites "
        "kb-gps-jamming-001.\n"
        "Decision:\n"
        "  action='passive_defense'\n"
        "  target='DRONE-03 UAS mesh'\n"
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
        "support to preserve the BLOS link.'\n"
        "  request_packet={'to': 'CJFSCC', 'reversibility': 'reversible', "
        "'actor': 'Russia', 'confidence': 0.66}\n\n"

        "### Example 4: Unknown actor / insufficient evidence → threat warning\n"
        "Attribution: actor='Unknown', confidence=0.40.\n"
        "Decision:\n"
        "  action='threat_warning'\n"
        "  target='space-ops-c2'\n"
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


def decision_user_prompt(
    attribution: Attribution, recovery: RecoveryContext | None = None
) -> str:
    """Render the user turn: the attribution, plus the recovery block when present.

    ``recovery`` defaults to whatever :func:`recovery_context` finds attached to
    the attribution, so the live clients need only pass the attribution.
    """
    if recovery is None:
        recovery = recovery_context(attribution)
    attribution_json = attribution.model_dump_json(
        indent=2, exclude={RECOVERY_CONTEXT_KEY, RECOVERY_TARGET_KEY}
    )
    recovery_section = ""
    if recovery is not None:
        recovery_section = (
            "## Recovery recommendation (internal diagnosis)\n"
            "The internal-diagnosis lane attributes this cluster to an "
            f"{_CAUSE_LABEL.get(attribution.verdict or '', 'internal or natural cause')} "
            "and recommends a recovery. Under the decision rule for verdict "
            f"'{attribution.verdict}', submit action='recovery_recommendation', "
            f"authority='local', target='{recovery.target}', request_packet=null, "
            "and copy this block into the recovery field verbatim:\n\n"
            f"```json\n{recovery.block.model_dump_json(indent=2)}\n```\n\n"
        )
    return (
        "## Attribution\n"
        "The following attribution has been produced by CANOPY's attribution agent. "
        "Your decision must be calibrated to the confidence score and evidence — "
        "do not recommend actions that exceed what the attribution supports.\n\n"
        f"```json\n{attribution_json}\n```\n\n"
        f"{recovery_section}"

        "## Pre-Submission Checklist — Verify Before Calling Tool\n"
        "[ ] If authority='local': request_packet is null AND rationale does "
        "not mention CJFSCC\n"
        "[ ] If authority='request': request_packet is populated with to, "
        "requested_effect, justification, actor, confidence, kb_citations, "
        "and reversibility\n"
        "[ ] If action='recovery_recommendation': recovery carries the block "
        "above verbatim and authority='local'; otherwise recovery is null\n"
        "[ ] Action selection matches the attribution confidence tier and "
        "the active defense threshold assessment\n"
        "[ ] Rationale confidence language matches the attribution confidence score\n"
        "[ ] 'confirmed', 'known hostile', 'proven' do not appear in any field\n\n"
        "Submit the recommended decision via the submit_decision tool."
    )


# ---- Recovery context ------------------------------------------------------

_CAUSE_LABEL: dict[str, str] = {
    "internal_fault": "internal fault",
    "natural_external": "natural external cause",
}


@dataclass(frozen=True)
class RecoveryContext:
    """The recovery a decision should carry, plus the asset it names as target."""

    block: RecoveryBlock
    target: str


def _block_from(raw: object, *, satellite_id: str | None) -> RecoveryBlock | None:
    if not isinstance(raw, dict) or not raw:
        return None
    data = dict(raw)
    data["source"] = "internal-diagnosis"
    if not data.get("satellite_id"):
        data["satellite_id"] = satellite_id
    try:
        return RecoveryBlock.model_validate(data)
    except ValidationError:
        return None


def _display_name(satellite_id: str | None) -> str | None:
    """Operator label for a ``ctb://<authority>/<spacecraft-id>`` (spec §1)."""
    if not satellite_id:
        return None
    slug = satellite_id.rstrip("/").rsplit("/", 1)[-1]
    return slug.upper() or None


def _target_for(payload: dict[str, Any], satellite_id: str | None) -> str:
    asset = payload.get("asset")
    if isinstance(asset, str) and asset:
        return asset
    return _display_name(satellite_id) or satellite_id or "affected spacecraft"


def recovery_context(
    attribution: Attribution, anomalies: Iterable[Anomaly] = ()
) -> RecoveryContext | None:
    """The recovery this attribution's decision must carry, or None.

    Applies when the verdict is ``internal_fault`` or ``natural_external`` and
    an anomaly in the cluster carries a valid ``recommended_recovery`` (the
    strongest such anomaly wins). Falls back to the context DecideService
    attached to the attribution (see ``RECOVERY_CONTEXT_KEY``) when the caller
    has no anomalies, which is the case for every ``LLMClient.decide``.
    """
    if attribution.verdict not in RECOVERY_VERDICTS:
        return None
    candidates = [
        a for a in anomalies if isinstance(a.payload.get("recommended_recovery"), dict)
    ]
    for anomaly in sorted(candidates, key=lambda a: (-a.severity, a.id)):
        satellite_id = attribution.satellite_id or anomaly.payload.get("satellite_id")
        block = _block_from(
            anomaly.payload["recommended_recovery"], satellite_id=satellite_id
        )
        if block is not None:
            return RecoveryContext(block=block, target=_target_for(anomaly.payload, satellite_id))
    extra = attribution.model_extra or {}
    block = _block_from(extra.get(RECOVERY_CONTEXT_KEY), satellite_id=attribution.satellite_id)
    if block is None:
        return None
    target = extra.get(RECOVERY_TARGET_KEY)
    if not isinstance(target, str) or not target:
        target = _target_for({}, block.satellite_id)
    return RecoveryContext(block=block, target=target)


def with_recovery_context(attribution: Attribution, recovery: RecoveryContext) -> Attribution:
    """A copy of ``attribution`` carrying ``recovery`` for ``LLMClient.decide``."""
    return Attribution.model_validate(
        {
            **attribution.model_dump(),
            RECOVERY_CONTEXT_KEY: recovery.block.model_dump(),
            RECOVERY_TARGET_KEY: recovery.target,
        }
    )


def recovery_rationale(recovery: RecoveryContext, attribution: Attribution) -> str:
    """Deterministic one-sentence rationale for a recovery decision."""
    block = recovery.block
    cause = _CAUSE_LABEL.get(attribution.verdict or "", "internal or natural cause")
    approval = " pending operator approval" if block.requires_approval else ""
    return (
        f"Internal diagnosis assesses an {cause} on {recovery.target}; "
        f"recommending {block.action_id} on the {block.target_subsystem} "
        f"subsystem{approval} to restore the affected capability. {block.rationale}"
    ).strip()
