"""Post-processing validation and repair for live LLM outputs."""
from __future__ import annotations

import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

logger = logging.getLogger(__name__)

UNCERTAINTY_ANCHOR = "kb-attribution-uncertainty-001"

PROHIBITED_PHRASES: list[tuple[str, str]] = [
    (r"\bconfirmed\b", "use 'assessed as consistent with' instead"),
    (r"\bproves\b", "use 'is consistent with' instead"),
    (r"\bdemonstrably\b", "use hedged language instead"),
    (r"\bdefinitively\b", "use confidence-tier language instead"),
    (
        r"\bcredible coordinated threat pattern\b",
        "use 'pattern assessed as consistent with coordinated activity' instead",
    ),
    (r"\bknown hostile\b", "use 'assessed as hostile' instead"),
]

CAVEAT_ONLY_ENTRIES = {UNCERTAINTY_ANCHOR}
MULTI_ACTOR_CONFIDENCE_CAP = 0.72

# ---- Verdict lane (docs/INTERFACE-SPEC.md §5, §5.2) ------------------------
#
# The rule verdict is computed in ``megalith/verdict`` (CANOPY never imports
# that package; its own environment does not contain it). It reaches this
# module as any object with the attributes of ``RuleVerdictLike``. The numeric
# bounds below mirror ``megalith/verdict/config.py``; a megalith test asserts
# the two copies agree.

VERDICTS: frozenset[str] = frozenset(
    {"internal_fault", "natural_external", "hostile_external", "unknown"}
)
POSITIVE_VERDICTS: frozenset[str] = frozenset({"internal_fault", "natural_external"})
NO_ACTOR = "None"
UNKNOWN_ACTOR = "Unknown"
UNKNOWN_CAP = 0.49
REASONING_DELTA_MAX = 0.15
REASONING_CONFIDENCE_MIN = 0.30
REASONING_CONFIDENCE_MAX = 0.85

VerdictBasisValue = Literal["rule", "reasoning"]


class RuleVerdictLike(Protocol):
    """Structural view of ``megalith.verdict.rule.RuleVerdict``."""

    @property
    def verdict(self) -> str: ...

    @property
    def confidence(self) -> float: ...

    @property
    def basis(self) -> Sequence[str]: ...

    @property
    def satellite_id(self) -> str | None: ...

    @property
    def pc(self) -> float | None: ...


@dataclass(frozen=True)
class VerdictResolution:
    """What the §5.2 bounds make of a proposed verdict."""

    verdict: str | None
    basis: VerdictBasisValue | None
    verdict_evidence: list[str]
    confidence: float
    actor: str
    repair_note: str | None = None


def actor_for_verdict(verdict: str | None, actor: str) -> str:
    """The §5 actor convention: positive findings carry no actor."""
    if verdict in POSITIVE_VERDICTS:
        return NO_ACTOR
    if verdict == "unknown":
        return UNKNOWN_ACTOR
    if verdict == "hostile_external":
        return actor if actor not in ("", NO_ACTOR, UNKNOWN_ACTOR) else UNKNOWN_ACTOR
    return actor


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def resolve_verdict(
    *,
    proposed: str | None,
    cited_evidence: Sequence[str] | None,
    confidence: float,
    actor: str,
    rule: RuleVerdictLike | None,
) -> VerdictResolution:
    """Apply the §5.2 bounds to a proposed verdict.

    Idempotent: feeding a resolution's outputs back in yields the same
    outputs, so the live clients (which resolve inside
    ``validate_and_repair_attribution``) and the attribution service (which
    resolves once more after reconcile, covering the stub path) agree.

    * No proposal, or the rule's own verdict: basis ``rule``; confidence
      clamped to ``rule.confidence ± REASONING_DELTA_MAX``.
    * A different verdict with nothing in ``verdict_evidence``: reset to the
      rule verdict, basis ``rule``, same clamp, and a repair note.
    * A different verdict with cited evidence: basis ``reasoning``;
      confidence clamped to ``[REASONING_CONFIDENCE_MIN, _MAX]``.
    * The actor then follows the §5 convention; an ``Unknown`` actor is
      capped at ``UNKNOWN_CAP``.
    """
    proposed = proposed if proposed in VERDICTS else None
    cited = [s.strip() for s in (cited_evidence or []) if isinstance(s, str) and s.strip()]
    confidence = _clamp(float(confidence), 0.0, 1.0)
    repair_note: str | None = None
    basis: VerdictBasisValue | None
    if rule is None:
        verdict = proposed
        basis = "reasoning" if proposed is not None else None
        evidence_out = cited
    elif proposed is None or proposed == rule.verdict:
        verdict, basis, evidence_out = rule.verdict, "rule", cited
        confidence = _clamp(
            confidence,
            rule.confidence - REASONING_DELTA_MAX,
            rule.confidence + REASONING_DELTA_MAX,
        )
    elif not cited:
        verdict, basis, evidence_out = rule.verdict, "rule", []
        repair_note = (
            f"Verdict repair: the reasoning lane proposed {proposed} without citing "
            f"verdict_evidence; the provisional rule verdict {rule.verdict} stands."
        )
        confidence = _clamp(
            confidence,
            rule.confidence - REASONING_DELTA_MAX,
            rule.confidence + REASONING_DELTA_MAX,
        )
    else:
        verdict, basis, evidence_out = proposed, "reasoning", cited
        confidence = _clamp(confidence, REASONING_CONFIDENCE_MIN, REASONING_CONFIDENCE_MAX)
    actor_out = actor_for_verdict(verdict, actor)
    if verdict is not None and actor_out == UNKNOWN_ACTOR:
        confidence = min(confidence, UNKNOWN_CAP)
    return VerdictResolution(
        verdict=verdict,
        basis=basis,
        verdict_evidence=evidence_out,
        confidence=confidence,
        actor=actor_out,
        repair_note=repair_note,
    )


def _is_positive_finding(d: dict[str, Any]) -> bool:
    return d.get("verdict") in POSITIVE_VERDICTS and d.get("actor") == NO_ACTOR


def _apply_verdict_rules(
    d: dict[str, Any], rule: RuleVerdictLike | None, result: "ValidationResult"
) -> None:
    raw_verdict = d.get("verdict")
    raw_cited = d.get("verdict_evidence")
    if raw_verdict is not None and raw_verdict not in VERDICTS:
        logger.warning("ATTRIB_VALIDATION: verdict=%r is not a Verdict; dropped.", raw_verdict)
        result.flags.append(f"verdict={raw_verdict!r} is not a Verdict; dropped")
        result.was_modified = True
        raw_verdict = None
    if raw_verdict is None and rule is None and not raw_cited:
        return  # legacy payload with no verdict lane: nothing to resolve
    old_actor = str(d.get("actor", UNKNOWN_ACTOR))
    old_confidence = float(d.get("confidence", 0.5))
    resolution = resolve_verdict(
        proposed=raw_verdict,
        cited_evidence=raw_cited,
        confidence=old_confidence,
        actor=old_actor,
        rule=rule,
    )
    if resolution.repair_note is not None:
        logger.warning(
            "ATTRIB_VALIDATION: verdict=%r differs from rule verdict %r without "
            "verdict_evidence; reset to the rule verdict.",
            raw_verdict,
            rule.verdict if rule is not None else None,
        )
        d["evidence"] = [*(d.get("evidence") or []), resolution.repair_note]
        result.was_modified = True
        result.flags.append(
            f"verdict={raw_verdict!r} changed without verdict_evidence; reset to rule verdict"
        )
    if resolution.verdict != raw_verdict and resolution.repair_note is None:
        result.was_modified = True
        result.flags.append(f"verdict={raw_verdict!r} filled from rule verdict")
    if resolution.actor != old_actor:
        result.was_modified = True
        result.flags.append(
            f"actor={old_actor!r} does not fit verdict {resolution.verdict!r}; "
            f"set to {resolution.actor!r}"
        )
    if abs(resolution.confidence - old_confidence) > 1e-9:
        result.was_modified = True
        result.flags.append(
            f"confidence={old_confidence:.2f} outside verdict bounds; "
            f"clamped to {resolution.confidence:.2f}"
        )
    d["verdict"] = resolution.verdict
    d["verdict_basis"] = resolution.basis
    d["verdict_evidence"] = resolution.verdict_evidence
    d["actor"] = resolution.actor
    d["confidence"] = resolution.confidence


@dataclass
class ValidationResult:
    repaired: dict[str, Any]
    was_modified: bool = False
    flags: list[str] = field(default_factory=list)
    downgraded_to_unknown: bool = False


def validate_and_repair_attribution(
    raw: dict[str, Any], rule_verdict: RuleVerdictLike | None = None
) -> ValidationResult:
    """Repair a raw attribution tool payload.

    ``rule_verdict`` is the fast-lane prior for the same cluster (spec §5.2).
    When given, a verdict that differs from it without cited
    ``verdict_evidence`` is reset to the rule value with basis ``rule`` and a
    repair note in ``evidence``; a cited change keeps basis ``reasoning``.
    Confidence is bounded relative to the rule either way and the actor
    follows the §5 convention. Positive findings (``internal_fault`` or
    ``natural_external`` with actor ``None``) are never downgraded to
    ``Unknown`` nor capped at 0.49 for lacking KB citations: those rules are
    about naming an adversary, which a positive finding does not do.
    """
    result = ValidationResult(repaired=dict(raw))
    d = result.repaired

    citations = list(d.get("kb_citations") or [])
    if not citations:
        logger.warning(
            "ATTRIB_VALIDATION: kb_citations was empty; appending uncertainty anchor. "
            "actor=%s confidence=%s",
            d.get("actor"),
            d.get("confidence"),
        )
        citations = [UNCERTAINTY_ANCHOR]
        d["kb_citations"] = citations
        result.was_modified = True
        result.flags.append("kb_citations was empty; uncertainty anchor appended")
    elif UNCERTAINTY_ANCHOR not in citations:
        citations.append(UNCERTAINTY_ANCHOR)
        d["kb_citations"] = citations
        result.was_modified = True
        result.flags.append("uncertainty anchor was missing; appended to kb_citations")

    _apply_verdict_rules(d, rule_verdict, result)
    positive_finding = _is_positive_finding(d)

    actor = d.get("actor", "Unknown")
    substantive_citations = [c for c in citations if c not in CAVEAT_ONLY_ENTRIES]

    if actor not in ("Unknown", "") and not substantive_citations and not positive_finding:
        logger.warning(
            "ATTRIB_VALIDATION: actor=%r with no substantive KB citations; "
            "downgrading to Unknown.",
            actor,
        )
        d["actor"] = "Unknown"
        d["confidence"] = min(float(d.get("confidence", 0.5)), 0.49)
        result.was_modified = True
        result.downgraded_to_unknown = True
        result.flags.append(
            f"actor={actor!r} had no substantive KB citations; downgraded to Unknown"
        )
        actor = "Unknown"

    evidence = list(d.get("evidence") or [])
    if positive_finding and not evidence:
        # A positive finding with no evidence chain keeps its verdict and
        # actor (the §5 convention) but is flagged and given a placeholder.
        d["evidence"] = [
            "No evidence chain was produced by the attribution agent for this "
            f"{d.get('verdict')} finding; the rule-lane basis is the only support. "
            f"{UNCERTAINTY_ANCHOR} applies."
        ]
        result.was_modified = True
        result.flags.append(
            f"verdict={d.get('verdict')!r} had empty evidence; placeholder inserted"
        )
    elif actor not in ("Unknown", "") and not evidence:
        logger.warning(
            "ATTRIB_VALIDATION: actor=%r with empty evidence; downgrading to Unknown.",
            actor,
        )
        d["actor"] = "Unknown"
        d["confidence"] = min(float(d.get("confidence", 0.5)), 0.49)
        d["evidence"] = [
            "No evidence chain was produced by the attribution agent. "
            "Actor attribution is not supportable without observable signal evidence. "
            "Alternative explanations have not been ruled out. "
            f"{UNCERTAINTY_ANCHOR} applies."
        ]
        result.was_modified = True
        result.downgraded_to_unknown = True
        result.flags.append(f"actor={actor!r} had empty evidence; downgraded to Unknown")

    fields_to_scan = {
        "evidence": " ".join(d.get("evidence") or []),
        "predicted_next": d.get("predicted_next") or "",
    }
    for field_name, text in fields_to_scan.items():
        for pattern, suggestion in PROHIBITED_PHRASES:
            if re.search(pattern, text, re.IGNORECASE):
                logger.warning(
                    "ATTRIB_VALIDATION: prohibited phrase matched in field %r: "
                    "pattern=%r suggestion=%r",
                    field_name,
                    pattern,
                    suggestion,
                )
                result.flags.append(
                    f"prohibited phrase in {field_name}: {pattern!r}; {suggestion}"
                )

    if d.get("actor") == "Unknown":
        confidence = float(d.get("confidence", 0.0))
        if confidence >= 0.50:
            logger.warning(
                "ATTRIB_VALIDATION: actor='Unknown' with confidence=%.2f; "
                "capping at 0.49.",
                confidence,
            )
            d["confidence"] = 0.49
            result.was_modified = True
            result.flags.append(
                f"actor=Unknown with confidence={confidence:.2f}; capped at 0.49"
            )

    if d.get("actor") == "Multi-actor":
        confidence = float(d.get("confidence", 0.0))
        if confidence > MULTI_ACTOR_CONFIDENCE_CAP:
            joint_exercise_cited = any(
                "joint" in c or "exercise" in c for c in d.get("kb_citations", [])
            )
            if not joint_exercise_cited:
                logger.warning(
                    "ATTRIB_VALIDATION: Multi-actor confidence=%.2f exceeds cap %.2f "
                    "without joint exercise KB entry; capping.",
                    confidence,
                    MULTI_ACTOR_CONFIDENCE_CAP,
                )
                d["confidence"] = MULTI_ACTOR_CONFIDENCE_CAP
                result.was_modified = True
                result.flags.append(
                    f"Multi-actor confidence={confidence:.2f} capped at "
                    f"{MULTI_ACTOR_CONFIDENCE_CAP} (no joint exercise KB entry)"
                )

    evidence_text = " ".join(d.get("evidence") or [])
    if UNCERTAINTY_ANCHOR not in evidence_text:
        current_evidence = list(d.get("evidence") or [])
        current_evidence.append(
            "Alternative explanations have not been ruled out. "
            f"{UNCERTAINTY_ANCHOR} applies."
        )
        d["evidence"] = current_evidence
        result.was_modified = True
        result.flags.append("uncertainty caveat appended to evidence")

    if result.was_modified:
        logger.info("ATTRIB_VALIDATION: output repaired. flags=%s", result.flags)

    return result


def validate_and_repair_decision(raw: dict[str, Any]) -> dict[str, Any]:
    d = dict(raw)
    _repair_recovery_invariants(d)
    authority = d.get("authority", "local")
    rationale = d.get("rationale", "")
    request_packet = d.get("request_packet")

    if authority == "local":
        if request_packet is not None:
            logger.warning(
                "DECIDE_VALIDATION: authority='local' but request_packet is populated; "
                "clearing request_packet."
            )
            d["request_packet"] = None

        if re.search(r"\bCJFSCC\b", rationale, re.IGNORECASE):
            logger.warning(
                "DECIDE_VALIDATION: authority='local' but rationale mentions CJFSCC. "
                "rationale=%r",
                rationale,
            )

    if authority == "request" and not request_packet:
        logger.warning(
            "DECIDE_VALIDATION: authority='request' but request_packet is null; "
            "inserting minimal stub. action=%r target=%r",
            d.get("action"),
            d.get("target"),
        )
        d["request_packet"] = {
            "to": "CJFSCC",
            "supporting_supported": "Brigade -> CJFSCC",
            "requested_effect": d.get("action", "unspecified"),
            "justification": rationale,
            "actor": "unspecified - attribution not forwarded",
            "confidence": None,
            "kb_citations": [],
            "reversibility": "unspecified",
            "_validation_note": (
                "request_packet was null; stub inserted by validator. "
                "Operator should review before routing."
            ),
        }

    return d


# ---- Recovery invariants (docs/INTERFACE-SPEC.md §6) ------------------------
#
# A decision carries a recovery block iff its action is
# recovery_recommendation, and such a decision is local authority with no
# request packet. Violations are repaired, never rejected: a recovery without
# a usable block becomes a threat_warning, a stray block is dropped, and the
# note lands in ``_validation_notes`` and on the rationale so the operator
# sees it.
#
# The withheld-recovery block (wave 4B) is the mirror image: it may only sit
# on a decision that is *not* a recovery, so a recovery decision never carries
# one and a withheld block never coexists with a recovery block. A malformed
# withheld block is dropped rather than repaired: the decide stage recomputes
# it on every revision from the cluster and the gate context.

RECOVERY_ACTION = "recovery_recommendation"
RECOVERY_DOWNGRADE_ACTION = "threat_warning"
RECOVERY_SOURCE = "internal-diagnosis"
_RECOVERY_REQUIRED_KEYS = ("action_id", "target_subsystem", "requires_approval", "rationale")
_WITHHELD_REQUIRED_KEYS = ("action_id", "target_subsystem", "reason_code")


def _normalise_recovery_block(raw: object) -> dict[str, Any] | None:
    """A well-formed RecoveryBlock dict from a model-supplied object, or None."""
    if not isinstance(raw, dict):
        return None
    if any(key not in raw for key in _RECOVERY_REQUIRED_KEYS):
        return None
    action_id = str(raw["action_id"]).strip()
    target_subsystem = str(raw["target_subsystem"]).strip()
    if not action_id or not target_subsystem:
        return None
    satellite_id = raw.get("satellite_id")
    return {
        "action_id": action_id,
        "target_subsystem": target_subsystem,
        "requires_approval": bool(raw["requires_approval"]),
        "rationale": str(raw["rationale"]),
        "source": RECOVERY_SOURCE,
        "satellite_id": satellite_id if isinstance(satellite_id, str) and satellite_id else None,
    }


def _normalise_withheld_block(raw: object) -> dict[str, Any] | None:
    """A well-formed WithheldRecovery dict from a supplied object, or None."""
    if not isinstance(raw, dict):
        return None
    if any(key not in raw for key in _WITHHELD_REQUIRED_KEYS):
        return None
    values = {key: str(raw[key]).strip() for key in _WITHHELD_REQUIRED_KEYS}
    if not all(values.values()):
        return None
    return {**values, "source": RECOVERY_SOURCE}


def _repair_recovery_invariants(d: dict[str, Any]) -> list[str]:
    notes: list[str] = []
    action = d.get("action")
    block = _normalise_recovery_block(d.get("recovery"))
    if action == RECOVERY_ACTION:
        if block is None:
            d["action"] = RECOVERY_DOWNGRADE_ACTION
            d["recovery"] = None
            d["authority"] = "local"
            d["request_packet"] = None
            notes.append(
                "recovery_recommendation without a valid recovery block; "
                f"downgraded to {RECOVERY_DOWNGRADE_ACTION}"
            )
        else:
            d["recovery"] = block
            if d.get("authority") != "local":
                d["authority"] = "local"
                notes.append("recovery_recommendation is local authority; repaired")
            if d.get("request_packet") is not None:
                d["request_packet"] = None
                notes.append("recovery_recommendation carries no request_packet; cleared")
    elif d.get("recovery") is not None:
        d["recovery"] = None
        notes.append(f"recovery block is only valid on {RECOVERY_ACTION}; cleared from {action}")
    # The decision is a recovery iff it still carries a block after the repairs
    # above; a withheld block is only valid on every other decision.
    if d.get("recovery") is not None:
        if d.get("withheld_recovery") is not None:
            d["withheld_recovery"] = None
            notes.append("a recovery decision withholds nothing; withheld_recovery cleared")
    elif "withheld_recovery" in d and d["withheld_recovery"] is not None:
        withheld = _normalise_withheld_block(d["withheld_recovery"])
        if withheld is None:
            d["withheld_recovery"] = None
            notes.append("malformed withheld_recovery block dropped")
        else:
            d["withheld_recovery"] = withheld
    if notes:
        logger.warning("DECIDE_VALIDATION: recovery invariants repaired: %s", notes)
        d["_validation_notes"] = [*(d.get("_validation_notes") or []), *notes]
        rationale = str(d.get("rationale") or "").rstrip()
        d["rationale"] = f"{rationale} [validator: {'; '.join(notes)}]".strip()
    return notes
