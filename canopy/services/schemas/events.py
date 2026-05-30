from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal, get_args
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator

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
]

Authority = Literal["local", "request"]

# ---- Action taxonomy: single source of truth ------------------------------
#
# The ``Action`` literal above is CANOPY's complete counterspace-action
# vocabulary; a ``Decision`` (and the decide-stage orbit enrichment, replayed
# traces, the frontend operator panel, …) may carry any of these. Two things
# are derived from it here so the taxonomy can't fork across the modules that
# consume it:
#
#   ACTION_AUTHORITY   authority routing for *every* action. ``request`` means
#                      the action exceeds local commander authority and must
#                      route to the CJFSCC for engagement authority; ``local``
#                      means it is within delegated brigade authority. Consumed
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
    "active_defense_escort": "request",
    "space_link_interdiction_request": "request",
    "active_defense_counterattack": "request",
    "orbital_strike_request": "request",
    "terrestrial_strike_request": "request",
}

SELECTABLE_ACTIONS: tuple[Action, ...] = (
    "passive_defense",
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
    observables: dict[str, Any] | None = None


# ---- Top-level event models -----------------------------------------------


class _Event(BaseModel):
    """Common base for in-bus event models with id + ts defaults."""

    model_config = ConfigDict(extra="allow")

    id: str = Field(default_factory=_new_id)
    ts: datetime = Field(default_factory=_now)


class Signal(_Event):
    """Canonical CANOPY Signal — matches services/bus/schemas/signal.schema.json."""

    domain: Domain
    source: str = Field(min_length=1)
    realism: Realism
    confidence: float = Field(ge=0.0, le=1.0)
    location: Location
    payload: Payload
    provenance: Provenance


class Anomaly(_Event):
    """Canonical CANOPY Anomaly — matches services/bus/schemas/anomaly.schema.json."""

    kind: str = Field(min_length=1)
    source_signal: str = Field(min_length=1)
    source_signal_ids: list[str] = Field(default_factory=list)
    severity: float = Field(ge=0.0, le=1.0)
    payload: dict[str, Any] = Field(default_factory=dict)


class Attribution(_Event):
    """Attribution assessment for an anomaly cluster."""

    anomaly_ids: list[str]
    actor: str = Field(min_length=1)
    confidence: float = Field(ge=0.0, le=1.0)
    doctrine_match: str | None = None
    evidence: list[str] = Field(default_factory=list)
    predicted_next: str | None = None
    kb_citations: list[str] = Field(default_factory=list)
    source_signal_ids: list[str] = Field(default_factory=list)


class Decision(_Event):
    """Recommended action for an attribution."""

    attribution_id: str
    action: Action
    target: str
    rationale: str
    authority: Authority
    request_packet: dict[str, Any] | None = None
    source_signal_ids: list[str] = Field(default_factory=list)


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
