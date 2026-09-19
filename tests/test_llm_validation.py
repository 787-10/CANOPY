import pytest

from canopy.services.llm.validation import (
    UNCERTAINTY_ANCHOR,
    validate_and_repair_attribution,
    validate_and_repair_decision,
)


def test_attribution_appends_uncertainty_anchor() -> None:
    result = validate_and_repair_attribution(
        {
            "actor": "Unknown",
            "confidence": 0.31,
            "evidence": ["insufficient signal"],
            "kb_citations": [],
        }
    )

    assert result.was_modified
    assert result.repaired["kb_citations"] == [UNCERTAINTY_ANCHOR]


def test_named_actor_without_substantive_citation_is_downgraded() -> None:
    result = validate_and_repair_attribution(
        {
            "actor": "Multi-actor",
            "confidence": 0.68,
            "evidence": ["pattern is ambiguous"],
            "kb_citations": [],
        }
    )

    assert result.downgraded_to_unknown
    assert result.repaired["actor"] == "Unknown"
    assert result.repaired["confidence"] == 0.49
    assert UNCERTAINTY_ANCHOR in result.repaired["kb_citations"]


def test_named_actor_without_evidence_is_downgraded() -> None:
    result = validate_and_repair_attribution(
        {
            "actor": "Iran",
            "confidence": 0.62,
            "evidence": [],
            "kb_citations": ["kb-gps-jamming-001"],
        }
    )

    assert result.downgraded_to_unknown
    assert result.repaired["actor"] == "Unknown"
    assert result.repaired["confidence"] == 0.49
    assert result.repaired["evidence"]


def test_unknown_confidence_is_capped() -> None:
    result = validate_and_repair_attribution(
        {
            "actor": "Unknown",
            "confidence": 0.7,
            "evidence": ["ambiguous signal"],
            "kb_citations": [UNCERTAINTY_ANCHOR],
        }
    )

    assert result.repaired["confidence"] == 0.49


def test_multi_actor_confidence_is_capped_without_joint_kb() -> None:
    result = validate_and_repair_attribution(
        {
            "actor": "Multi-actor",
            "confidence": 0.9,
            "evidence": ["multi-domain pattern"],
            "kb_citations": ["kb-rpo-ambiguity-001", UNCERTAINTY_ANCHOR],
        }
    )

    assert result.repaired["confidence"] == 0.72


def test_request_decision_gets_stub_packet() -> None:
    repaired = validate_and_repair_decision(
        {
            "action": "sda_tasking",
            "target": "CANOPY-LEO-07",
            "rationale": "Request SDA retask.",
            "authority": "request",
            "request_packet": None,
        }
    )

    assert repaired["request_packet"]["to"] == "CJFSCC"
    assert repaired["request_packet"]["requested_effect"] == "sda_tasking"


def test_local_decision_clears_request_packet() -> None:
    repaired = validate_and_repair_decision(
        {
            "action": "passive_defense",
            "target": "UAS mesh",
            "rationale": "Local defensive posture.",
            "authority": "local",
            "request_packet": {"to": "CJFSCC"},
        }
    )

    assert repaired["request_packet"] is None


# ---- Verdict lane (docs/INTERFACE-SPEC.md §5.2) ------------------------------

from types import SimpleNamespace  # noqa: E402

from canopy.services.llm.validation import (  # noqa: E402
    REASONING_CONFIDENCE_MAX,
    REASONING_CONFIDENCE_MIN,
    REASONING_DELTA_MAX,
    UNKNOWN_CAP,
    actor_for_verdict,
    resolve_verdict,
)


def _rule(verdict: str = "internal_fault", confidence: float = 0.83) -> SimpleNamespace:
    return SimpleNamespace(
        verdict=verdict,
        confidence=confidence,
        basis=(f"rule: {verdict} confidence={confidence:.2f} (test)", "pc=0.83"),
        satellite_id="ctb://centralblue.dev/leo-science-1",
        pc=0.83,
    )


def _payload(**overrides) -> dict:
    base = {
        "actor": "None",
        "confidence": 0.83,
        "evidence": ["Comms amplifier output trending down on the internal-diagnosis lane."],
        "kb_citations": [UNCERTAINTY_ANCHOR],
        "verdict": "internal_fault",
        "verdict_evidence": [],
    }
    base.update(overrides)
    return base


def test_positive_finding_without_substantive_citations_is_not_downgraded() -> None:
    result = validate_and_repair_attribution(_payload(kb_citations=[]), _rule())

    assert not result.downgraded_to_unknown
    assert result.repaired["actor"] == "None"
    assert result.repaired["verdict"] == "internal_fault"
    assert result.repaired["verdict_basis"] == "rule"
    assert result.repaired["confidence"] == pytest.approx(0.83)


def test_natural_external_positive_finding_keeps_full_confidence() -> None:
    result = validate_and_repair_attribution(
        _payload(verdict="natural_external", confidence=0.78, kb_citations=[]),
        _rule("natural_external", 0.75),
    )

    assert result.repaired["actor"] == "None"
    assert result.repaired["confidence"] == pytest.approx(0.78)


def test_verdict_changed_without_evidence_is_reset_to_rule() -> None:
    result = validate_and_repair_attribution(
        _payload(
            actor="Russia",
            confidence=0.6,
            verdict="hostile_external",
            verdict_evidence=[],
            kb_citations=["kb-gps-jamming-001", UNCERTAINTY_ANCHOR],
        ),
        _rule("internal_fault", 0.83),
    )

    d = result.repaired
    assert d["verdict"] == "internal_fault"
    assert d["verdict_basis"] == "rule"
    assert d["actor"] == "None"
    assert any(line.startswith("Verdict repair:") for line in d["evidence"])
    assert any("changed without verdict_evidence" in flag for flag in result.flags)
    # Unchanged-verdict clamp: 0.6 is below 0.83 - 0.15.
    assert d["confidence"] == pytest.approx(0.83 - REASONING_DELTA_MAX)


def test_verdict_changed_with_evidence_keeps_reasoning_basis() -> None:
    result = validate_and_repair_attribution(
        _payload(
            actor="Russia",
            confidence=0.95,
            verdict="hostile_external",
            verdict_evidence=["anom-rf-1 rf_anomaly on the same satellite 40 s before onset"],
            kb_citations=["kb-gps-jamming-001", UNCERTAINTY_ANCHOR],
        ),
        _rule("internal_fault", 0.83),
    )

    d = result.repaired
    assert d["verdict"] == "hostile_external"
    assert d["verdict_basis"] == "reasoning"
    assert d["actor"] == "Russia"
    assert d["verdict_evidence"] == ["anom-rf-1 rf_anomaly on the same satellite 40 s before onset"]
    assert d["confidence"] == pytest.approx(REASONING_CONFIDENCE_MAX)
    assert not any(line.startswith("Verdict repair:") for line in d["evidence"])


def test_reasoning_change_floors_at_reasoning_minimum() -> None:
    result = validate_and_repair_attribution(
        _payload(
            actor="Russia",
            confidence=0.1,
            verdict="hostile_external",
            verdict_evidence=["cited"],
            kb_citations=["kb-gps-jamming-001", UNCERTAINTY_ANCHOR],
        ),
        _rule("internal_fault", 0.83),
    )
    assert result.repaired["confidence"] == pytest.approx(REASONING_CONFIDENCE_MIN)


@pytest.mark.parametrize(("given", "expected"), [(0.4, 0.68), (1.0, 0.98), (0.8, 0.8)])
def test_unchanged_verdict_confidence_is_bounded_to_rule_delta(given: float, expected: float) -> None:
    result = validate_and_repair_attribution(_payload(confidence=given), _rule("internal_fault", 0.83))
    assert result.repaired["confidence"] == pytest.approx(expected)


def test_blank_verdict_evidence_strings_do_not_count_as_citations() -> None:
    result = validate_and_repair_attribution(
        _payload(actor="Russia", verdict="hostile_external", verdict_evidence=["", "  "]),
        _rule("internal_fault", 0.83),
    )
    assert result.repaired["verdict"] == "internal_fault"
    assert result.repaired["verdict_evidence"] == []


def test_unknown_verdict_forces_unknown_actor_and_cap() -> None:
    result = validate_and_repair_attribution(
        _payload(
            actor="Russia",
            confidence=0.7,
            verdict="unknown",
            kb_citations=["kb-gps-jamming-001", UNCERTAINTY_ANCHOR],
        ),
        _rule("unknown", 0.49),
    )
    assert result.repaired["actor"] == "Unknown"
    assert result.repaired["confidence"] == pytest.approx(UNKNOWN_CAP)


def test_hostile_external_with_unknown_actor_is_capped() -> None:
    result = validate_and_repair_attribution(
        _payload(actor="Unknown", confidence=0.7, verdict="hostile_external"),
        _rule("hostile_external", 0.7),
    )
    assert result.repaired["actor"] == "Unknown"
    assert result.repaired["confidence"] == pytest.approx(UNKNOWN_CAP)


def test_hostile_external_with_actor_none_becomes_unknown() -> None:
    result = validate_and_repair_attribution(
        _payload(actor="None", confidence=0.7, verdict="hostile_external"),
        _rule("hostile_external", 0.7),
    )
    assert result.repaired["actor"] == "Unknown"
    assert result.repaired["confidence"] == pytest.approx(UNKNOWN_CAP)


def test_hostile_external_named_actor_keeps_confidence_with_citations() -> None:
    result = validate_and_repair_attribution(
        _payload(
            actor="Russia",
            confidence=0.72,
            verdict="hostile_external",
            kb_citations=["kb-gps-jamming-001", UNCERTAINTY_ANCHOR],
        ),
        _rule("hostile_external", 0.7),
    )
    assert result.repaired["actor"] == "Russia"
    assert result.repaired["confidence"] == pytest.approx(0.72)


def test_hostile_external_named_actor_without_citations_still_downgrades() -> None:
    # The existing citation rule is about naming an adversary; it still fires.
    result = validate_and_repair_attribution(
        _payload(actor="Russia", confidence=0.72, verdict="hostile_external"),
        _rule("hostile_external", 0.7),
    )
    assert result.downgraded_to_unknown
    assert result.repaired["actor"] == "Unknown"
    assert result.repaired["verdict"] == "hostile_external"
    assert result.repaired["confidence"] == pytest.approx(UNKNOWN_CAP)


def test_actor_convention_forces_none_for_positive_verdicts() -> None:
    result = validate_and_repair_attribution(
        _payload(actor="Russia", kb_citations=["kb-gps-jamming-001", UNCERTAINTY_ANCHOR]),
        _rule("internal_fault", 0.83),
    )
    assert result.repaired["actor"] == "None"
    assert any("does not fit verdict" in flag for flag in result.flags)


def test_invalid_verdict_is_dropped_and_filled_from_rule() -> None:
    result = validate_and_repair_attribution(_payload(verdict="banana"), _rule("internal_fault", 0.83))
    assert result.repaired["verdict"] == "internal_fault"
    assert any("is not a Verdict" in flag for flag in result.flags)


def test_missing_verdict_is_filled_from_rule() -> None:
    payload = _payload()
    del payload["verdict"]
    del payload["verdict_evidence"]
    result = validate_and_repair_attribution(payload, _rule("internal_fault", 0.83))
    assert result.repaired["verdict"] == "internal_fault"
    assert result.repaired["verdict_basis"] == "rule"
    assert result.repaired["verdict_evidence"] == []


def test_positive_finding_with_empty_evidence_is_not_downgraded() -> None:
    result = validate_and_repair_attribution(_payload(evidence=[]), _rule("internal_fault", 0.83))
    assert not result.downgraded_to_unknown
    assert result.repaired["actor"] == "None"
    assert result.repaired["evidence"]


def test_legacy_payload_without_verdict_or_rule_is_untouched() -> None:
    result = validate_and_repair_attribution(
        {
            "actor": "China",
            "confidence": 0.74,
            "evidence": ["consistent with SJ-21 precedent"],
            "kb_citations": ["kb-rpo-ambiguity-001", UNCERTAINTY_ANCHOR],
        }
    )
    assert "verdict" not in result.repaired
    assert result.repaired["actor"] == "China"
    assert result.repaired["confidence"] == pytest.approx(0.74)


def test_verdict_without_rule_is_reasoning_basis() -> None:
    result = validate_and_repair_attribution(
        _payload(actor="Russia", verdict="hostile_external", kb_citations=["kb-gps-jamming-001", UNCERTAINTY_ANCHOR])
    )
    assert result.repaired["verdict"] == "hostile_external"
    assert result.repaired["verdict_basis"] == "reasoning"


def test_resolve_verdict_is_idempotent() -> None:
    rule = _rule("internal_fault", 0.83)
    first = resolve_verdict(
        proposed="hostile_external",
        cited_evidence=["cited"],
        confidence=0.95,
        actor="Russia",
        rule=rule,
    )
    second = resolve_verdict(
        proposed=first.verdict,
        cited_evidence=first.verdict_evidence,
        confidence=first.confidence,
        actor=first.actor,
        rule=rule,
    )
    assert second == first


@pytest.mark.parametrize(
    ("verdict", "actor", "expected"),
    [
        ("internal_fault", "Russia", "None"),
        ("natural_external", "Unknown", "None"),
        ("unknown", "Russia", "Unknown"),
        ("hostile_external", "Russia", "Russia"),
        ("hostile_external", "None", "Unknown"),
        ("hostile_external", "", "Unknown"),
        (None, "China", "China"),
    ],
)
def test_actor_for_verdict_convention(verdict, actor, expected) -> None:
    assert actor_for_verdict(verdict, actor) == expected
