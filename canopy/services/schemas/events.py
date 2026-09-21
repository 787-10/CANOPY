from __future__ import annotations

import re
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any, Literal, get_args
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Domain = Literal[
    "sda",
    "orbit",
    "osint",
    "humint",
    "rf_ew",
    "cyber",
    "pnt",
    "satcom",
    "drone",
    "terrain",
    "bus_health",
    "space_weather",
]

Realism = Literal[
    "real_source",
    "mock_operational",
    "synthetic_orbital_overlay",
]

Action = Literal[
    "passive_defense",
    "active_defense_escort",
    "active_defense_counterattack",
    "orbital_strike_request",
    "terrestrial_strike_request",
    "space_link_interdiction_request",
    "sda_tasking",
    "threat_warning",
    "recovery_recommendation",
]

Authority = Literal["local", "request"]

# ---- Three-way verdict (MEGALITH) -----------------------------------------
#
# Every anomaly cluster resolves to one of three causes, or to ``unknown``.
# ``verdict_basis`` records whether the deterministic rule lane or the LLM
# reasoning lane set the final value. See docs/INTERFACE-SPEC.md §5.
Verdict = Literal["internal_fault", "natural_external", "hostile_external", "unknown"]
VerdictBasis = Literal["rule", "reasoning"]

# ---- Action taxonomy: single source of truth ------------------------------
#
# The ``Action`` literal above is CANOPY's complete counterspace-action
# vocabulary; a ``Decision`` (and the decide-stage orbit enrichment, replayed
# traces, the frontend operator panel, …) may carry any of these. Two things
# are derived from it here so the taxonomy can't fork across the modules that
# consume it:
#
#   recovery_recommendation is the one non-counterspace action: a recovery
#   proposed by the internal-diagnosis lane for an internal or natural verdict.
#
#   ACTION_AUTHORITY   authority routing for *every* action. ``request`` means
#                      the action exceeds local commander authority and must
#                      route to the CJFSCC for engagement authority; ``local``
#                      means it is within the local cell's delegated authority. Consumed
#                      by ``decide.tools`` (``routing.validate``).
#   SELECTABLE_ACTIONS the subset the decision agent is permitted to recommend,
#                      in menu order. CANOPY is a defensive system: the
#                      offensive counterspace actions (counterattack, orbital /
#                      terrestrial strike) exist in the taxonomy so the engine
#                      can model and route them, but must never be *selected* by
#                      the agent. Consumed by ``decide.prompts`` as the
#                      ``submit_decision`` tool's action enum.
#
# The guards below turn "add an action but forget to classify it" from a silent
# three-way drift into an import-time error.
ACTION_AUTHORITY: dict[Action, Authority] = {
    "passive_defense": "local",
    "threat_warning": "local",
    "sda_tasking": "local",
    "recovery_recommendation": "local",
    "active_defense_escort": "request",
    "space_link_interdiction_request": "request",
    "active_defense_counterattack": "request",
    "orbital_strike_request": "request",
    "terrestrial_strike_request": "request",
}

SELECTABLE_ACTIONS: tuple[Action, ...] = (
    "passive_defense",
    "recovery_recommendation",
    "threat_warning",
    "sda_tasking",
    "active_defense_escort",
    "space_link_interdiction_request",
)

_ALL_ACTIONS: frozenset[str] = frozenset(get_args(Action))
if set(ACTION_AUTHORITY) != _ALL_ACTIONS:
    raise RuntimeError(
        "ACTION_AUTHORITY must route exactly the Action literal: "
        f"missing={sorted(_ALL_ACTIONS - set(ACTION_AUTHORITY))}, "
        f"unknown={sorted(set(ACTION_AUTHORITY) - _ALL_ACTIONS)}"
    )
if not set(SELECTABLE_ACTIONS) <= _ALL_ACTIONS:
    raise RuntimeError(
        "SELECTABLE_ACTIONS must be a subset of the Action literal: "
        f"unknown={sorted(set(SELECTABLE_ACTIONS) - _ALL_ACTIONS)}"
    )

UIEventType = Literal["threat_updated", "recommendation_created", "status_update"]

UISeverity = Literal["low", "medium", "high", "critical"]

# ---- Reasoning trace ------------------------------------------------------

# What stage of the pipeline produced this trace line. Used by the UI to
# colour-code lines in the terminal panel and by the bus for fanout topic
# (`traces.{stage}`).
TraceStage = Literal[
    "fusion",
    "attrib_primary",
    "attrib_redteam",
    "attrib_reconcile",
    "decide",
    "tools",
    "stress",
]

# Severity / category of an individual trace line. Drives weight + colour in
# the panel: "info" = ambient, "decision" = bold accent, "tool" = amber tag,
# "warn" = red tag.
TraceLevel = Literal["info", "decision", "tool", "warn"]


# ---- Marking (docs/INTERFACE-SPEC.md §1.1, spec 1.4) -----------------------
#
# Every event carries a ``marking``. Grammar: ``U`` (unclassified), ``CUI``
# (controlled unclassified information, basic) or ``CUI//SP-<CATEGORY>`` with
# one or more specified categories joined by ``/`` (``CUI//SP-A/SP-B``); a
# category is uppercase letters, digits and hyphens. Ordering for derivation
# is ``U`` < ``CUI`` < ``CUI//SP-*``; two specified markings combine to the
# sorted union of their categories. ``most_restrictive`` is the propagation
# rule every derivation site applies: a derived event's marking is never
# lower than the most restrictive input. Nothing in the engine acts on the
# marking yet; it is carried, combined and displayed.

MARKING_UNCLASSIFIED = "U"
MARKING_CUI = "CUI"
_MARKING_SP_PREFIX = "CUI//SP-"
_CATEGORY = r"[A-Z0-9][A-Z0-9-]*"
MARKING_PATTERN = rf"^(U|CUI|CUI//SP-{_CATEGORY}(/SP-{_CATEGORY})*)$"
_MARKING_RE = re.compile(MARKING_PATTERN)


def marking_categories(marking: str) -> tuple[str, ...]:
    """The specified categories of a marking, sorted; empty for ``U`` and ``CUI``."""
    if not marking.startswith(_MARKING_SP_PREFIX):
        return ()
    return tuple(sorted(part[len("SP-") :] for part in marking[len("CUI//") :].split("/")))


def validate_marking(value: object) -> str:
    """Return ``value`` when it is a well-formed marking; raise ``ValueError`` otherwise."""
    if not isinstance(value, str):
        # ValueError, not TypeError: pydantic turns it into a ValidationError.
        raise ValueError("marking must be a string")  # noqa: TRY004
    if not _MARKING_RE.match(value):
        raise ValueError(
            f"marking {value!r} must be U, CUI or CUI//SP-<CATEGORY>[/SP-<CATEGORY>...] "
            "(uppercase letters, digits and hyphens)"
        )
    categories = marking_categories(value)
    if len(set(categories)) != len(categories):
        raise ValueError(f"marking {value!r} repeats a category")
    return value


def most_restrictive(markings: Iterable[str]) -> str:
    """The marking a derivation of ``markings`` must carry (spec §1.1).

    ``U`` < ``CUI`` < ``CUI//SP-*``; specified categories accumulate as a
    sorted union (``CUI//SP-A`` with ``CUI//SP-B`` gives ``CUI//SP-A/SP-B``).
    No inputs give ``U``. Every input is validated.
    """
    level = 0
    categories: set[str] = set()
    for marking in markings:
        marking = validate_marking(marking)
        if marking == MARKING_UNCLASSIFIED:
            continue
        if marking == MARKING_CUI:
            level = max(level, 1)
            continue
        level = 2
        categories.update(marking_categories(marking))
    if level == 0:
        return MARKING_UNCLASSIFIED
    if level == 1:
        return MARKING_CUI
    return "CUI//" + "/".join(f"SP-{c}" for c in sorted(categories))


def _new_id() -> str:
    return uuid4().hex


def _now() -> datetime:
    return datetime.now(UTC)


# ---- Sub-models for the canonical Signal envelope -------------------------


class Location(BaseModel):
    """Where the signal applies. Must include at least one localizer."""

    model_config = ConfigDict(extra="allow")

    label: str | None = None
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)
    alt_km: float | None = None
    alt_m: float | None = None
    ce_m: float | None = Field(default=None, ge=0)
    mgrs: str | None = None
    area_wkt: str | None = None

    @model_validator(mode="after")
    def _at_least_one_localizer(self) -> "Location":
        has_point = self.lat is not None and self.lng is not None
        if not (has_point or self.mgrs or self.area_wkt or self.label):
            raise ValueError(
                "Location requires one of: lat+lng, mgrs, area_wkt, or label"
            )
        return self


class Provenance(BaseModel):
    """Source traceability for a signal."""

    model_config = ConfigDict(extra="allow")

    source_id: str = Field(min_length=1)
    citation: str | None = None
    collector: str | None = None
    method: str | None = None
    references: list[str] = Field(default_factory=list)
    generated_at: datetime | None = None
    notes: str | None = None


class Payload(BaseModel):
    """Domain-specific observation. Carries the canonical event_type/summary."""

    model_config = ConfigDict(extra="allow")

    event_type: str = Field(min_length=1)
    summary: str = Field(min_length=1)
    beat: str | None = None
    asset: str | None = None
    satellite_id: str | None = None
    # Closely-spaced objects (docs/INTERFACE-SPEC.md §5.4, spec 1.4): the
    # flight identities a cue could belong to when the sensor cannot resolve
    # one (an emitter bearing consistent with two objects on the same pass).
    # Consulted only when ``satellite_id`` is absent; ``None`` for every
    # publisher that does not use it, so nothing serialises for existing data.
    candidate_satellite_ids: list[str] | None = None
    observables: dict[str, Any] | None = None


# ---- Top-level event models -----------------------------------------------


class _Event(BaseModel):
    """Common base for in-bus event models with id + ts + marking defaults."""

    model_config = ConfigDict(extra="allow")

    id: str = Field(default_factory=_new_id)
    ts: datetime = Field(default_factory=_now)
    # Marking (docs/INTERFACE-SPEC.md §1.1, spec 1.4). Defaults to ``U``;
    # derivation sites set ``most_restrictive`` of their inputs.
    marking: str = Field(
        default=MARKING_UNCLASSIFIED,
        pattern=MARKING_PATTERN,
        description=(
            "Marking: U, CUI or CUI//SP-<CATEGORY>[/SP-<CATEGORY>...]; a derived event "
            "carries the most restrictive marking of its inputs (docs/INTERFACE-SPEC.md 1.1)."
        ),
    )

    @field_validator("marking")
    @classmethod
    def _marking_is_well_formed(cls, value: str) -> str:
        return validate_marking(value)


class Signal(_Event):
    """Canonical CANOPY Signal — matches services/bus/schemas/signal.schema.json."""

    domain: Domain
    source: str = Field(min_length=1)
    realism: Realism
    confidence: float = Field(ge=0.0, le=1.0)
    location: Location
    payload: Payload
    provenance: Provenance


class Ephemeris(_Event):
    """An engine-owned position sample for one spacecraft (spec §10, 1.4.4).

    ``ts`` is the *scenario* time of the state. The engine propagates the same
    circular model the synthetic track files come from (``elements`` is the
    file's defining pass) and publishes a sample on a cadence while a replay is
    in progress, so the console draws what the engine states rather than what
    it computes itself; the console's own port is the fallback with no run.
    Synthetic spacecraft only: never a TLE, never a catalogue number.
    """

    satellite_id: str = Field(min_length=1)
    source: Literal["circular-model"] = "circular-model"
    lat: float = Field(ge=-90.0, le=90.0)
    lng: float = Field(ge=-180.0, lt=180.0)
    alt_km: float = Field(gt=0.0)
    speed_km_s: float = Field(gt=0.0)
    #: The defining pass the state was propagated from: altitude_km,
    #: inclination_deg, pass_utc, pass_lat, pass_lng, period_s.
    elements: dict[str, Any] = Field(default_factory=dict)
    #: Wall UTC the sample was published.
    published_at: datetime = Field(default_factory=_now)


class Anomaly(_Event):
    """Canonical CANOPY Anomaly — matches services/bus/schemas/anomaly.schema.json."""

    kind: str = Field(min_length=1)
    source_signal: str = Field(min_length=1)
    source_signal_ids: list[str] = Field(default_factory=list)
    severity: float = Field(ge=0.0, le=1.0)
    payload: dict[str, Any] = Field(default_factory=dict)


class KBRef(BaseModel):
    """Provenance of the knowledge base an attribution was reasoned against.

    Stamped on every published ``Attribution`` (docs/INTERFACE-SPEC.md §5.3).
    ``path`` is the knowledge-base file as configured (``CANOPY_KB_PATH``),
    ``resolved`` its absolute path and ``sha256`` the digest of the file
    bytes; a knowledge base built in memory has neither path and hashes the
    canonical JSON of its entries. ``actor_entry_count`` counts every entry
    other than the uncertainty anchor; when it is zero the attrib stage
    withholds any named actor at publish.
    """

    path: str | None = None
    resolved: str | None = None
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    entry_count: int = Field(ge=0)
    actor_entry_count: int = Field(ge=0)


class Attribution(_Event):
    """Attribution assessment for an anomaly cluster."""

    anomaly_ids: list[str]
    actor: str = Field(min_length=1)
    confidence: float = Field(ge=0.0, le=1.0)
    doctrine_match: str | None = None
    evidence: list[str] = Field(default_factory=list)
    predicted_next: str | None = None
    kb_citations: list[str] = Field(default_factory=list)
    # Which knowledge base the citations resolve against (spec §5.3). Set by
    # the attrib stage at publish; optional so fixtures predating it stay valid.
    kb_ref: KBRef | None = None
    source_signal_ids: list[str] = Field(default_factory=list)
    # MEGALITH three-way verdict (docs/INTERFACE-SPEC.md §5). Optional so
    # pre-existing scenarios and fixtures stay valid.
    verdict: Verdict | None = None
    physics_consistency: float | None = Field(default=None, ge=0.0, le=1.0)
    verdict_basis: VerdictBasis | None = None
    verdict_evidence: list[str] = Field(default_factory=list)
    satellite_id: str | None = None
    # Closely-spaced objects (spec §5.4, 1.4): set only on an attribution the
    # engine could not key to one satellite, from the candidate sets of the
    # cues in its batch; ``None`` on every keyed attribution.
    candidate_satellite_ids: list[str] | None = None
    # Fast lane (wave 3A): a provisional attribution is the rule lane's call,
    # published before any LLM runs; the reasoning lane republishes the same
    # id with ``provisional=False`` and ``revision`` incremented.
    provisional: bool = False
    revision: int = 0


class RecoveryBlock(BaseModel):
    """The internal-diagnosis recovery a ``recovery_recommendation`` carries.

    Copied from the ``recommended_recovery`` observable of the bus-health
    anomaly that triggered it (docs/INTERFACE-SPEC.md §3, §6). ``source`` is
    fixed: only the internal-diagnosis lane proposes recoveries.
    """

    action_id: str
    target_subsystem: str
    requires_approval: bool
    rationale: str
    source: Literal["internal-diagnosis"] = "internal-diagnosis"
    satellite_id: str | None = None


class WithheldRecovery(BaseModel):
    """A recovery the internal diagnosis recommended and the decide stage withheld.

    Set on a Decision whose cluster carries a ``recommended_recovery`` but
    whose action is not ``recovery_recommendation`` (docs/INTERFACE-SPEC.md
    §6, wave 4B): the verdict is ``hostile_external`` or ``unknown``, or a
    threat-context gate rule (§7) would block the recovery. ``reason_code`` is
    one of ``threat/uplink_jamming_active``, ``threat/hostile_close_approach``,
    ``verdict/hostile_external``, ``verdict/unknown``; the console renders a
    label for it. Never coexists with ``recovery``.
    """

    action_id: str
    target_subsystem: str
    reason_code: str
    source: Literal["internal-diagnosis"] = "internal-diagnosis"


class Decision(_Event):
    """Recommended action for an attribution."""

    attribution_id: str
    action: Action
    target: str
    rationale: str
    authority: Authority
    request_packet: dict[str, Any] | None = None
    source_signal_ids: list[str] = Field(default_factory=list)
    # Set iff ``action == "recovery_recommendation"`` (docs/INTERFACE-SPEC.md
    # §6); such a decision is local authority with no request packet.
    recovery: RecoveryBlock | None = None
    # Set when the cluster recommended a recovery that this decision does not
    # carry (docs/INTERFACE-SPEC.md §6, wave 4B); never set together with
    # ``recovery``. Re-evaluated on every revision like the gate.
    withheld_recovery: WithheldRecovery | None = None
    # Mirrors the revision of the attribution the decision was made for; the
    # decision id is stable across revisions (wave 3A).
    revision: int = 0
    # Bounded response (docs/INTERFACE-SPEC.md §6, spec 1.4): the actions this
    # decision was legitimately drawn from and why that set applied, one of the
    # closed vocabulary in ``canopy.services.decide.SELECTION_BASES``. Set by the
    # decide stage on every published decision, after the gate; ``None`` only
    # on decisions recorded before 1.4, so nothing serialises for old data.
    selectable_set: list[Action] | None = None
    selection_basis: str | None = None


class Recommendation(BaseModel):
    """Optional recommendation surfaced to the operator on a UIEvent."""

    model_config = ConfigDict(extra="allow")

    id: str
    summary: str
    approveLabel: str = "APPROVE"


class UIEvent(_Event):
    """Frontend-facing event — matches data/expected_ui_events.json shape.

    Field names use camelCase where the existing fixture does (demoBeat,
    approveLabel) so the frontend can read either source interchangeably.
    """

    model_config = ConfigDict(extra="allow", populate_by_name=True)

    source_signal_ids: list[str] = Field(default_factory=list)
    type: UIEventType
    timestamp: datetime = Field(default_factory=_now)
    severity: UISeverity
    title: str = Field(min_length=1)
    message: str = Field(min_length=1)
    confidence: float = Field(ge=0.0, le=1.0)
    demoBeat: str | None = Field(default=None, alias="demoBeat")
    recommendation: Recommendation | None = None


class ReasoningTrace(_Event):
    """A single line of agent / tool reasoning.

    Streams in real time on the bus topic ``traces.{stage}`` and is rendered
    by the frontend's terminal-styled reasoning panel. Every visible step
    that contributes to an attribution or decision should produce one trace
    so the resulting log is the auditable explanation of why the engine
    arrived at its assessment.
    """

    stage: TraceStage
    level: TraceLevel = "info"
    message: str = Field(min_length=1)
    ref_id: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


class AttributionChallenge(_Event):
    """Red-team agent's critique of a primary attribution.

    Emitted as part of the multi-agent attribution loop: primary →
    red-team → reconciler. Lives on the bus only as a trace payload
    (i.e., as the structured input to the reconciler); it is *not*
    published as a top-level bus event so downstream services that
    listen on ``attributions.*`` see only the final reconciled
    attribution.
    """

    primary_attribution_id: str
    alternative_actor: str | None = None
    objections: list[str] = Field(default_factory=list)
    confidence_delta: float = 0.0
    rationale: str


# ---- OSINT semantic clustering -------------------------------------------


class EmbeddingPoint(BaseModel):
    """A single OSINT signal projected to 2D via PCA for visualization."""

    signal_id: str
    summary: str
    cluster_id: int
    x: float
    y: float
    ts: datetime


class OsintEmbeddingSnapshot(_Event):
    """A snapshot of the OSINT semantic clustering window.

    Emitted every time a new OSINT signal is ingested and clustered.
    Carries the entire current sliding window — points, cluster
    assignments, and PCA-projected (x, y) coordinates — so the frontend
    can render a complete scatter plot from a single event without
    needing to maintain its own incremental projection.
    """

    points: list[EmbeddingPoint] = Field(default_factory=list)
    cluster_count: int = 0
    similarity_threshold: float = 0.70
    model_name: str = ""
    embedding_dim: int = 0
