from __future__ import annotations

import logging
from collections import OrderedDict
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field, fields
from types import MappingProxyType
from typing import Any

from canopy.services.bus import Bus
from canopy.services.schemas.events import (
    MARKING_UNCLASSIFIED,
    Anomaly,
    Domain,
    Signal,
    most_restrictive,
)
from canopy.services.traces import Tracer

log = logging.getLogger(__name__)

__all__ = ["FusionService", "DEFAULT_WINDOWS", "DEFAULT_WINDOW_KEY"]

# Sliding window (seconds) for cross-domain correlation. Matches the prior
# value baked into services/fusion/orbital_anomaly.py. It is the "all others"
# row of the per-domain window table below, so callers that only ever needed
# one number keep the same meaning.
CORRELATION_WINDOW_S = 120

# Per-domain correlation windows (docs/INTERFACE-SPEC.md §2) as
# ``domain -> (look-back s, look-ahead s)``. Look-back is how far *before* a
# new signal fusion searches for correlates; look-ahead is how long a stored
# correlate stays matchable by a signal that arrives out of order (a later
# arrival whose timestamp precedes it). ``DEFAULT_WINDOW_KEY`` is the "all
# others" row. Injected through ``FusionService(windows=...)`` and
# ``build_engine(fusion_windows=...)``; overrides are merged over this table.
DEFAULT_WINDOW_KEY = "default"
DEFAULT_WINDOWS: Mapping[str, tuple[int, int]] = MappingProxyType(
    {
        "bus_health": (600, 120),
        "space_weather": (900, 120),
        DEFAULT_WINDOW_KEY: (CORRELATION_WINDOW_S, CORRELATION_WINDOW_S),
    }
)

# Hard cap on the dedupe id sets and the correlate buffer. Oldest entries are
# evicted first, so a long-running engine holds bounded memory while dedupe
# stays exact for everything still retained.
MAX_TRACKED = 10_000

# Domains whose signals correlate with a bus-health symptom on a shared
# satellite key: hostile-activity cues that may explain an internal symptom
# on the same spacecraft (or be explained by it).
BUS_CORRELATION_DOMAINS: frozenset[str] = frozenset(
    {"rf_ew", "pnt", "cyber", "orbit", "sda", "satcom"}
)
# Every domain whose emitting signals are remembered as correlates.
_CORRELATABLE_DOMAINS: frozenset[str] = BUS_CORRELATION_DOMAINS | {
    "bus_health",
    "space_weather",
}

# Severity boosts when an orbital event correlates with concurrent activity.
# OVERLAP_BOOST also applies when a bus-health symptom and a hostile-domain
# cue share a satellite key inside the window.
OVERLAP_BOOST = 0.15
RF_BOOST = 0.10
GNSS_BOOST = 0.15

# Tokens used to recognise RF anomaly / GNSS spoof signals from the canonical
# payload event_type plus its summary text. Mirrors the prototype script.
RF_ANOMALY_TOKENS = ("anomaly", "interference", "jam", "degradation", "spoof")
GNSS_SPOOF_TOKEN = "spoof"

# Observables copied to the top level of the anomaly payload so downstream
# stages need not join back to the signal (spec §3 and §4). Missing keys are
# simply absent.
_BUS_PAYLOAD_FIELDS = (
    "subsystem",
    "symptom",
    "physics_consistency",
    "shape",
    "onset_ts",
    "recommended_recovery",
)
_SPACE_WEATHER_PAYLOAD_FIELDS = ("kp", "severity", "valid_from", "valid_to")

# Per-domain event_type → anomaly kind mappings for the simple "echo this as
# an anomaly" path. Orbital event_types are handled by the correlator below.
DOMAIN_PATTERN_MAP: dict[tuple[str, str], str] = {
    # RF / EW
    ("rf_ew", "rf_interference"): "rf_anomaly",
    ("rf_ew", "satcom_rf_spike"): "rf_anomaly",
    ("rf_ew", "emission_cluster_detected"): "rf_anomaly",
    ("rf_ew", "gnss_jamming_signature"): "rf_gnss_jamming",
    ("rf_ew", "uas_control_link_detected"): "rf_uas_control_link",
    ("rf_ew", "emission_posture_risk"): "rf_emission_posture_risk",
    ("rf_ew", "telemetry_degradation"): "rf_telemetry_degradation",
    # PNT / GNSS
    ("pnt", "pnt_spoofing"): "gnss_spoof",
    ("pnt", "pnt_rf_alignment"): "gnss_spoof",
    ("pnt", "gps_spoof"): "gnss_spoof",
    ("pnt", "receiver_holdover_active"): "gnss_spoof",
    # Cyber
    ("cyber", "credential_spray"): "cyber_probe_burst",
    ("cyber", "credential_probe"): "cyber_probe_burst",
    ("cyber", "process_anomaly"): "cyber_probe_burst",
    ("cyber", "intrusion"): "cyber_probe_burst",
    ("cyber", "gateway_config_probe"): "cyber_probe_burst",
    ("cyber", "response_action"): "cyber_response_action",
    # SATCOM
    ("satcom", "satcom_degradation"): "satcom_degradation",
    ("satcom", "satcom_link_margin_drop"): "satcom_degradation",
    ("satcom", "telemetry_degradation"): "satcom_degradation",
    ("satcom", "gateway_latency_rise"): "satcom_degradation",
    ("satcom", "low_rate_mode_active"): "satcom_degradation",
    ("satcom", "satcom_queue_pressure"): "satcom_degradation",
    ("satcom", "satcom_route_shed"): "satcom_degradation",
    # SDA
    ("sda", "sda_catalog_match"): "sda_catalog_match",
    ("sda", "custody_quality_change"): "sda_catalog_match",
    ("sda", "overhead_warning_quality_drop"): "sda_catalog_match",
    ("sda", "maritime_space_picture_shift"): "sda_maritime_picture_shift",
    ("sda", "overhead_ir_cue"): "sda_overhead_ir_cue",
    ("sda", "counterspace_capability_context"): "sda_counterspace_context",
    # Drone — both threat (spoof, lost link) and protective (FDIR, relay)
    ("drone", "drone_spoofing"): "drone_spoofing",
    ("drone", "lost_link"): "drone_lost_link",
    ("drone", "degraded_telemetry"): "drone_degraded",
    ("drone", "drone_track_custody_split"): "drone_degraded",
    ("drone", "observer_feed_quality_drop"): "drone_degraded",
    ("drone", "autonomous_relay_handoff"): "drone_relay_handoff",
    ("drone", "relay_candidate_ready"): "drone_relay_candidate_ready",
    ("drone", "relay_mesh_status"): "drone_relay_mesh_status",
    ("drone", "fdir_recovery_action"): "drone_fdir_recovery",
    ("drone", "base_defense_posture_change"): "drone_base_defense_posture",
    ("drone", "uas_track_detected"): "drone_uas_track",
    # Terrain
    ("terrain", "terrain_masking_risk"): "terrain_masking_risk",
    # HUMINT
    ("humint", "procurement_report"): "humint_report",
    # OSINT — assessments and contexts (correlation outputs from upstream cells)
    ("osint", "convergence"): "osint_convergence",
    ("osint", "commander_update"): "osint_commander_update",
    ("osint", "close_approach_assessment"): "osint_close_approach_assessment",
    ("osint", "campaign_assessment"): "osint_campaign_assessment",
    ("osint", "collection_cue"): "osint_collection_cue",
    ("osint", "multi_domain_attack_assessment"): "osint_multi_domain_attack",
    ("osint", "iran_counter_c5isr_assessment"): "osint_iran_c5isr_assessment",
    ("osint", "space_support_hold_recommendation"): "osint_space_support_hold",
    ("osint", "space_enabled_base_defense_assessment"): "osint_space_base_defense",
    ("osint", "collection_risk_assessment"): "osint_collection_risk",
    ("osint", "relay_resilience_assessment"): "osint_relay_resilience",
    ("osint", "fdir_assessment"): "osint_fdir_assessment",
    ("osint", "blockade_notice"): "osint_blockade_notice",
    ("osint", "missile_uas_capability_context"): "osint_missile_uas_context",
    ("osint", "militia_uas_risk_context"): "osint_militia_uas_context",
    # Bus health — internal-diagnosis symptoms (docs/INTERFACE-SPEC.md §3)
    ("bus_health", "link_margin_drop"): "bus_link_margin",
    ("bus_health", "sensor_saturation"): "bus_sensor_saturation",
    ("bus_health", "attitude_disturbance"): "bus_attitude_disturbance",
    ("bus_health", "unexpected_reset"): "bus_unexpected_reset",
    ("bus_health", "power_thermal_excursion"): "bus_power_thermal",
    ("bus_health", "orbit_decay"): "bus_orbit_decay",
    ("bus_health", "safe_mode_entry"): "bus_safe_mode",
    # Space weather — global natural-environment context (spec §4)
    ("space_weather", "geomagnetic_storm"): "space_weather_storm",
    ("space_weather", "solar_radio_burst"): "space_weather_radio_burst",
    ("space_weather", "radiation_enhancement"): "space_weather_radiation",
    ("space_weather", "density_enhancement"): "space_weather_density",
}

# Event types we deliberately do not emit anomalies for — baseline / context /
# informational signals. They still get logged as "seen" but the engine
# remains quiet rather than producing low-value threat warnings.
IGNORED_EVENT_TYPES: set[tuple[str, str]] = {
    ("bus_health", "nominal"),
    ("cyber", "ground_segment_baseline"),
    ("cyber", "maintenance_api_rate_limit"),
    ("drone", "telemetry_update"),
    ("drone", "backup_asset_ready"),
    ("drone", "cross_sensor_position_check"),
    ("drone", "isr_product_quality_gate"),
    ("drone", "track_handoff_success"),
    ("humint", "imagery_request_update"),
    ("orbit", "space_support_option"),
    ("osint", "osint_context"),
    ("osint", "public_report"),
    ("osint", "aor_commander_update"),
    ("osint", "attack_chain_commander_update"),
    ("osint", "attack_chain_correlation"),
    ("osint", "base_defense_recovery_update"),
    ("osint", "c5isr_commander_update"),
    ("osint", "commander_orbit_cue"),
    ("osint", "convoy_release_update"),
    ("osint", "fdir_mission_update"),
    ("osint", "gateway_pressure_assessment"),
    ("osint", "gateway_recovery_assessment"),
    ("osint", "local_route_report"),
    ("osint", "post_pass_collection_update"),
    ("osint", "relay_commander_update"),
    ("pnt", "alternate_pnt_check"),
    ("pnt", "alternate_pnt_restored"),
    ("rf_ew", "ew_bearing_refined"),
    ("rf_ew", "rf_bearing_crosscheck"),
    ("satcom", "backup_link_check"),
    ("satcom", "ground_segment_baseline"),
    ("satcom", "local_cache_confirmed"),
    ("satcom", "priority_path_confirmed"),
    ("satcom", "satcom_priority_queue"),
    ("sda", "custody_update"),
    ("space_weather", "quiet"),
    ("terrain", "approach_masking_check"),
    ("terrain", "concealment_route_check"),
    ("terrain", "line_of_sight_forecast"),
    ("terrain", "route_chokepoint_check"),
}

# Orbit-domain event types handled by the orbital correlator below. Anything
# in this set is "covered"; anything outside it on `domain == "orbit"` would
# fall through silently. The coverage regression test imports this constant.
ORBIT_EVENT_TYPES: set[str] = {
    "collection_window_start",
    "overhead_collection_window",
    "collection_window_end",
    "rpo_close_approach",
    "proximity_operations",
    "screening_overlay",
    "orbital_context_shift",
    "orbital_setup",
}


@dataclass
class _CollectionWindow:
    source_signal: str
    start_ts_s: float
    risk: float
    # Marking of the signal that opened the window (spec §1.1), so an anomaly
    # emitted against the window is never marked lower than it.
    marking: str = MARKING_UNCLASSIFIED


@dataclass
class _Correlation:
    """A remembered signal that later signals may correlate with.

    ``kind`` is the cue kind (``rf_anomaly`` / ``gnss_spoof``) for orbital
    correlator cues and otherwise the anomaly kind the signal emitted. ``cue``
    is set only for the RF / GNSS cues the orbital correlator consumes.
    ``satellite`` is the cluster key from :func:`_satellite_name`.
    """

    signal_id: str
    kind: str
    ts_s: float
    domain: str
    event_type: str | None
    source: str | None
    satellite: str = "unknown"
    cue: str | None = None
    # The remembered signal's marking (spec §1.1): an anomaly that correlates
    # with this signal carries at least this marking.
    marking: str = MARKING_UNCLASSIFIED
    # Closely-spaced objects (spec §5.4): the identities a cue without a
    # ``satellite_id`` could belong to. A bus-health signal on any of them is
    # keyed to this cue, in either arrival order. Empty for every other signal.
    candidates: tuple[str, ...] = ()


@dataclass(frozen=True)
class _Match:
    """A stored correlate matched by a new signal.

    ``keyed`` is True when the match is on a shared satellite key (bus health
    against a hostile-domain cue), which lifts severity by ``OVERLAP_BOOST``.
    Global matches (space weather) are unkeyed and never boost.
    """

    correlation: _Correlation
    keyed: bool


class _BoundedIdSet:
    """Insertion-ordered set of ids that evicts its oldest entry past ``cap``.

    Membership and ``add`` behave like a ``set`` for every retained id; an id
    older than the newest ``cap`` entries can be seen again, which is the
    accepted trade for bounded memory on a long-running engine.
    """

    __slots__ = ("_cap", "_ids")

    def __init__(self, cap: int = MAX_TRACKED) -> None:
        self._cap = cap
        self._ids: OrderedDict[str, None] = OrderedDict()

    def add(self, key: str) -> None:
        if key in self._ids:
            return
        self._ids[key] = None
        while len(self._ids) > self._cap:
            self._ids.popitem(last=False)

    def __contains__(self, key: object) -> bool:
        return key in self._ids

    def __len__(self) -> int:
        return len(self._ids)


@dataclass
class _State:
    open_windows: dict[str, _CollectionWindow] = field(default_factory=dict)
    recent_correlations: list[_Correlation] = field(default_factory=list)
    seen_signals: _BoundedIdSet = field(default_factory=_BoundedIdSet)
    emitted_anomaly_ids: _BoundedIdSet = field(default_factory=_BoundedIdSet)


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def _ts_seconds(signal: Signal) -> float:
    return signal.ts.timestamp()


def _candidates(signal: Signal) -> tuple[str, ...]:
    """The candidate identities of a cue that names no satellite (spec §5.4).

    Empty when ``payload.satellite_id`` is set: a resolved cue is keyed on it
    and the candidate list, if any, is informational only.
    """
    if signal.payload.satellite_id:
        return ()
    return tuple(dict.fromkeys(c for c in signal.payload.candidate_satellite_ids or () if c))


def _satellite_name(signal: Signal) -> str:
    """Cluster key for a signal.

    ``payload.satellite_id`` (the ``ctb://`` flight identity, spec §1) when
    set; otherwise the legacy name heuristic over observables / asset /
    source. Two signals share a cluster only when this key is equal on both,
    so a bus-health signal (which always carries ``satellite_id``) correlates
    with a hostile-domain signal only when that signal carries the same id.
    """
    if signal.payload.satellite_id:
        return signal.payload.satellite_id
    obs = signal.payload.observables or {}
    return (
        obs.get("satellite")
        or obs.get("object_id")
        or obs.get("target")
        or signal.payload.asset
        or signal.source
        or "unknown"
    )


def _is_rf_anomaly(signal: Signal) -> bool:
    if signal.domain not in ("rf_ew",):
        return False
    text = " ".join(
        [signal.payload.event_type, signal.payload.summary or ""]
    ).lower()
    return any(token in text for token in RF_ANOMALY_TOKENS)


def _is_gnss_spoof(signal: Signal) -> bool:
    if signal.domain != "pnt":
        return False
    text = " ".join(
        [signal.payload.event_type, signal.payload.summary or ""]
    ).lower()
    return GNSS_SPOOF_TOKEN in text


def _cue_kind(signal: Signal) -> str | None:
    """Orbital-correlator cue kind for a signal, if it is one."""
    if _is_rf_anomaly(signal):
        return "rf_anomaly"
    if _is_gnss_spoof(signal):
        return "gnss_spoof"
    return None


def _payload_enrichment(signal: Signal, kind: str) -> dict[str, Any]:
    """Fields copied from the signal to the anomaly payload (spec §3, §4).

    ``satellite_id`` is copied for every domain when set. ``bus_*`` kinds
    also copy the diagnosis fields and ``space_weather_*`` kinds the storm
    fields from ``payload.observables``. Missing keys are simply absent.
    """
    out: dict[str, Any] = {}
    if signal.payload.satellite_id:
        out["satellite_id"] = signal.payload.satellite_id
    candidates = _candidates(signal)
    if candidates:
        # Spec §5.4: the attrib stage and the rule lane resolve the cue among
        # these; copied so no stage joins back to the signal.
        out["candidate_satellite_ids"] = list(candidates)
    if kind.startswith("bus_"):
        names: tuple[str, ...] = _BUS_PAYLOAD_FIELDS
    elif kind.startswith("space_weather_"):
        names = _SPACE_WEATHER_PAYLOAD_FIELDS
    else:
        return out
    obs = signal.payload.observables or {}
    for name in names:
        if name in obs:
            out[name] = obs[name]
    return out


def _merge_windows(
    overrides: Mapping[str, tuple[int, int]] | None,
) -> Mapping[str, tuple[int, int]]:
    merged: dict[str, tuple[int, int]] = dict(DEFAULT_WINDOWS)
    for domain, window in (overrides or {}).items():
        try:
            lookback, lookahead = window
        except (TypeError, ValueError):
            raise ValueError(
                f"fusion window for {domain!r} must be (lookback_s, lookahead_s), "
                f"got {window!r}"
            ) from None
        if lookback < 0 or lookahead < 0:
            raise ValueError(
                f"fusion window for {domain!r} must be non-negative, got {window!r}"
            )
        merged[domain] = (lookback, lookahead)
    return MappingProxyType(merged)


class FusionService:
    """Cross-domain correlator over canonical Signals.

    Two emission paths run side by side per signal:

    1. **Domain pattern map** — payload.event_type is mapped to an anomaly
       kind. The anomaly carries a summary, the source signal id, and the
       location/asset from the originating signal. Severity defaults to the
       signal's own confidence.

    2. **Orbital correlator** — ported from services/fusion/orbital_anomaly.py.
       Tracks orbital collection windows, RF anomalies, and GNSS spoof events
       within a sliding window and emits orbital_* anomalies whose severity is
       boosted when concurrent multi-domain activity is observed.

    Both paths can fire for the same signal (e.g., an RF interference signal
    produces an `rf_anomaly` directly and also feeds the orbital correlator).

    **Cluster key.** Both paths key on :func:`_satellite_name`:
    ``payload.satellite_id`` when set, else the legacy name heuristic.

    **Cross-domain correlation with bus health.** Every emitting signal from
    ``BUS_CORRELATION_DOMAINS``, ``bus_health`` or ``space_weather`` is
    remembered in ``recent_correlations``. When a ``bus_*`` signal arrives
    and a remembered hostile-domain signal shares its satellite key inside
    the window (or the reverse order), the emitted anomaly lists the
    correlate in ``source_signal_ids`` and ``payload.correlated_events`` and
    its severity gains ``OVERLAP_BOOST`` (capped at 1.0). Space weather is
    global: a ``space_weather_*`` signal correlates with any ``bus_*`` signal
    inside the window regardless of satellite key, in either order, and is
    listed the same way but never boosts severity.

    **Closely-spaced objects** (spec §5.4). A hostile-domain cue with no
    ``satellite_id`` but a ``payload.candidate_satellite_ids`` list is keyed
    to a ``bus_*`` signal on *any* candidate, in either arrival order, and
    the candidate list is copied to its anomaly payload. Which candidate the
    cue counts for is the attrib stage's and the rule lane's call, not
    fusion's. A cue that names neither a satellite nor candidates behaves
    exactly as before.

    **Window rule** (``windows``: ``domain -> (look-back s, look-ahead s)``,
    spec §2; overrides merge over ``DEFAULT_WINDOWS``). A new signal at time
    ``t`` matches a remembered correlate ``C``:

    * when ``C`` is not newer (``C.ts <= t``): iff ``t - C.ts`` is within the
      *longer* of the two domains' look-backs,
      ``max(lookback(new.domain), lookback(C.domain))``. The domain with the
      longer memory governs the pair whichever side arrives second, so a bus
      symptom 400 s after a hostile RF cue and an RF cue 400 s after a bus
      symptom both correlate (600 s), an RF cue after an orbital window keeps
      the 120 s default, and an RF cue 700 s after a bus symptom does not
      correlate.
    * when ``C`` is newer (out-of-order arrival, ``C.ts > t``): iff
      ``C.ts - t <= lookahead(C.domain)``.

    Pruning keeps every correlate within the longest look-back in the table
    and caps the buffer at ``MAX_TRACKED`` entries (oldest evicted first);
    ``seen_signals`` and ``emitted_anomaly_ids`` are bounded the same way.
    """

    def __init__(
        self,
        bus: Bus,
        *,
        tracer: Tracer | None = None,
        blocked_domains: Callable[[], set[Domain]] | None = None,
        windows: Mapping[str, tuple[int, int]] | None = None,
    ) -> None:
        self._bus = bus
        self._tracer = tracer
        self._blocked_domains = blocked_domains
        self._windows = _merge_windows(windows)
        self._max_lookback = max(lookback for lookback, _ in self._windows.values())
        self._state = _State()

    @property
    def windows(self) -> Mapping[str, tuple[int, int]]:
        """Effective per-domain window table (read-only)."""
        return self._windows

    def reset(self) -> dict[str, int]:
        """Forget every open window, remembered correlate and seen signal.

        In-process state only (the bus subscription and the window table are
        untouched), so one gateway process can replay unrelated runs back to
        back without the previous run's cues correlating into the next
        (``POST /reset``). Returns how many entries each store held.
        """
        state = self._state
        cleared = {f.name: len(getattr(state, f.name)) for f in fields(state)}
        self._state = _State()
        return cleared

    async def run(self) -> None:
        async for topic, event in self._bus.subscribe("signals.*"):
            if not isinstance(event, Signal):
                log.warning("fusion: non-Signal on %s: %r", topic, type(event))
                continue
            await self._dispatch(event)

    # ---- Dispatch ---------------------------------------------------------

    async def _dispatch(self, signal: Signal) -> None:
        if signal.id in self._state.seen_signals:
            return
        self._state.seen_signals.add(signal.id)
        now = _ts_seconds(signal)
        self._prune_correlations(now)

        event_type = signal.payload.event_type
        domain = signal.domain

        # Stress mode: drop signals from blocked domains entirely. The trace
        # makes the loss visible to the operator so the engine doesn't go
        # silent without explanation.
        if self._blocked_domains is not None:
            blocked = self._blocked_domains()
            if domain in blocked:
                if self._tracer is not None:
                    await self._tracer.emit(
                        "stress",
                        "warn",
                        f"input dropped: {domain} blocked",
                        ref_id=signal.id,
                        domain=domain,
                        event_type=event_type,
                    )
                return

        if (domain, event_type) in IGNORED_EVENT_TYPES:
            log.debug("fusion: ignoring baseline %s/%s", domain, event_type)
            return

        sat = _satellite_name(signal)
        emitted_kind: str | None = None

        # 1) Per-domain pattern echo (works for every domain except orbit,
        # which has its own correlator below).
        kind = DOMAIN_PATTERN_MAP.get((domain, event_type))
        if kind:
            await self._emit_pattern_anomaly(signal, kind, now=now, sat=sat)
            emitted_kind = kind

        # 2) Cross-domain correlation cues (RF anomaly / GNSS spoof) may
        # trigger an orbital_collection_correlated emission against any open
        # window.
        cue = _cue_kind(signal)
        if cue:
            await self._handle_correlation_event(signal, cue, now=now, sat=sat)

        # 3) Orbital handlers.
        if domain == "orbit":
            if event_type in ("collection_window_start", "overhead_collection_window"):
                emitted_kind = await self._handle_collection_start(
                    signal, now=now, sat=sat
                )
            elif event_type == "collection_window_end":
                self._handle_collection_end(signal)
            elif event_type in (
                "rpo_close_approach",
                "proximity_operations",
                "screening_overlay",
            ):
                emitted_kind = await self._handle_rpo(signal, now=now, sat=sat)
            elif event_type in ("orbital_context_shift", "orbital_setup"):
                # Track but do not emit.
                pass

        # 4) Remember the signal for later correlates. Done last so a signal
        # never matches itself.
        remembered_kind = cue or emitted_kind
        if remembered_kind and domain in _CORRELATABLE_DOMAINS:
            self._state.recent_correlations.append(
                self._correlation(signal, now=now, sat=sat, kind=remembered_kind, cue=cue)
            )

    # ---- Helpers ----------------------------------------------------------

    @staticmethod
    def _correlation(
        signal: Signal, *, now: float, sat: str, kind: str, cue: str | None
    ) -> _Correlation:
        return _Correlation(
            signal_id=signal.id,
            kind=kind,
            ts_s=now,
            domain=signal.domain,
            event_type=signal.payload.event_type,
            source=signal.source,
            satellite=sat,
            cue=cue,
            marking=signal.marking,
            candidates=_candidates(signal),
        )

    def _window_for(self, domain: str) -> tuple[int, int]:
        return (
            self._windows.get(domain)
            or self._windows.get(DEFAULT_WINDOW_KEY)
            or (CORRELATION_WINDOW_S, CORRELATION_WINDOW_S)
        )

    def _within_window(
        self, new_domain: str, now: float, other_domain: str, other_ts: float
    ) -> bool:
        """Window rule from the class docstring for a new signal at ``now``."""
        if other_ts <= now:
            lookback = max(
                self._window_for(new_domain)[0], self._window_for(other_domain)[0]
            )
            return now - other_ts <= lookback
        return other_ts - now <= self._window_for(other_domain)[1]

    def _prune_correlations(self, now: float) -> None:
        kept = [
            c
            for c in self._state.recent_correlations
            if now - c.ts_s <= self._max_lookback
        ]
        if len(kept) > MAX_TRACKED:
            del kept[: len(kept) - MAX_TRACKED]
        self._state.recent_correlations[:] = kept

    def _correlated(self, now: float, *, domain: str = "orbit") -> list[_Correlation]:
        """RF / GNSS cues inside the window of a new ``domain`` signal.

        Input to the orbital correlator; matched on time only, as before.
        """
        return [
            c
            for c in self._state.recent_correlations
            if c.cue is not None and self._within_window(domain, now, c.domain, c.ts_s)
        ]

    def _cross_domain_matches(
        self, signal: Signal, *, now: float, sat: str
    ) -> list[_Match]:
        """Bus-health correlates for a new signal (see the class docstring).

        A hostile-domain cue that names no satellite but a candidate set
        (spec §5.4) is keyed to a bus-health signal on any candidate, in
        either arrival order; a cue with neither behaves as before.
        """
        domain = signal.domain
        candidates = _candidates(signal)
        matches: list[_Match] = []
        for c in self._state.recent_correlations:
            if c.signal_id == signal.id:
                continue
            if domain == "bus_health":
                if c.domain == "space_weather":
                    keyed = False
                elif c.domain in BUS_CORRELATION_DOMAINS and (
                    c.satellite == sat or sat in c.candidates
                ):
                    keyed = True
                else:
                    continue
            elif domain == "space_weather":
                if c.domain != "bus_health":
                    continue
                keyed = False
            elif domain in BUS_CORRELATION_DOMAINS:
                if c.domain != "bus_health" or (
                    c.satellite != sat and c.satellite not in candidates
                ):
                    continue
                keyed = True
            else:
                continue
            if self._within_window(domain, now, c.domain, c.ts_s):
                matches.append(_Match(correlation=c, keyed=keyed))
        return matches

    def _severity_with_context(
        self, base: float, *, overlaps: bool, correlations: list[_Correlation]
    ) -> float:
        sev = base
        if overlaps:
            sev += OVERLAP_BOOST
        if any(c.cue == "rf_anomaly" for c in correlations):
            sev += RF_BOOST
        if any(c.cue == "gnss_spoof" for c in correlations):
            sev += GNSS_BOOST
        return _clamp01(round(sev, 3))

    async def _trace_matches(
        self, signal: Signal, kind: str, sat: str, matches: list[_Match]
    ) -> None:
        if self._tracer is None or not matches:
            return
        ids = [m.correlation.signal_id for m in matches]
        keyed = any(m.keyed for m in matches)
        await self._tracer.emit(
            "fusion",
            "info",
            (
                f"cross-domain correlate: {kind} with "
                f"{', '.join(m.correlation.kind for m in matches)}"
                + (f" on {sat}" if keyed else " (global)")
            ),
            ref_id=signal.id,
            kind=kind,
            satellite=sat,
            correlated_signal_ids=ids,
            boosted=keyed,
        )

    async def _publish(self, anomaly: Anomaly) -> None:
        if anomaly.id in self._state.emitted_anomaly_ids:
            return
        self._state.emitted_anomaly_ids.add(anomaly.id)
        await self._bus.publish(f"anomalies.{anomaly.kind}", anomaly)
        log.info(
            "fusion published anomaly id=%s kind=%s severity=%.2f",
            anomaly.id,
            anomaly.kind,
            anomaly.severity,
        )
        if self._tracer is not None:
            await self._tracer.emit(
                "fusion",
                "info",
                f"new anomaly: {anomaly.kind} @ severity {anomaly.severity:.2f}",
                ref_id=anomaly.id,
                kind=anomaly.kind,
                severity=anomaly.severity,
                source_signal=anomaly.source_signal,
            )

    def _build_anomaly(
        self,
        *,
        kind: str,
        signal: Signal,
        severity: float,
        payload: dict[str, Any],
        suffix: str | None = None,
        correlates: Iterable[_Correlation] = (),
        context_markings: Iterable[str] = (),
    ) -> Anomaly:
        """Assemble the anomaly for ``signal``.

        ``correlates`` are the remembered signals it lists in
        ``source_signal_ids``; ``context_markings`` are the markings of inputs
        that shaped it without being listed (a window's opening signal, the
        cues that raised its severity). The anomaly's marking is the most
        restrictive of the signal's, the correlates' and the context's
        (spec §1.1).
        """
        anomaly_id = (
            f"anom-{kind}-{signal.id}-{suffix}" if suffix else f"anom-{kind}-{signal.id}"
        )
        source_signal_ids = [signal.id]
        markings = [signal.marking]
        for correlate in correlates:
            if correlate.signal_id not in source_signal_ids:
                source_signal_ids.append(correlate.signal_id)
            markings.append(correlate.marking)
        markings.extend(context_markings)
        enriched = dict(payload)
        for name, value in _payload_enrichment(signal, kind).items():
            enriched.setdefault(name, value)
        return Anomaly(
            id=anomaly_id,
            ts=signal.ts,
            kind=kind,
            source_signal=signal.id,
            source_signal_ids=source_signal_ids,
            severity=_clamp01(round(severity, 3)),
            payload=enriched,
            marking=most_restrictive(markings),
        )

    # ---- Path 1: per-domain pattern echo ---------------------------------

    async def _emit_pattern_anomaly(
        self, signal: Signal, kind: str, *, now: float, sat: str
    ) -> None:
        matches = self._cross_domain_matches(signal, now=now, sat=sat)
        severity = signal.confidence
        if any(m.keyed for m in matches):
            severity += OVERLAP_BOOST
        payload: dict[str, Any] = {
            "domain": signal.domain,
            "event_type": signal.payload.event_type,
            "summary": signal.payload.summary,
            "asset": signal.payload.asset,
            "observables": signal.payload.observables or {},
            "confidence": signal.confidence,
            "source": signal.source,
        }
        if matches:
            payload["correlated_events"] = [
                self._compact(m.correlation) for m in matches
            ]
        await self._trace_matches(signal, kind, sat, matches)
        await self._publish(
            self._build_anomaly(
                kind=kind,
                signal=signal,
                severity=severity,
                payload=payload,
                correlates=[m.correlation for m in matches],
            )
        )

    # ---- Path 2: orbital correlator (ported) -----------------------------

    async def _handle_collection_start(
        self, signal: Signal, *, now: float, sat: str
    ) -> str:
        risk = float((signal.payload.observables or {}).get("risk", signal.confidence))
        overlaps = [
            {
                "satellite": other,
                "source_signal": w.source_signal,
                "start_time": w.start_ts_s,
                "risk": w.risk,
            }
            for other, w in self._state.open_windows.items()
            if other != sat
        ]
        correlations = self._correlated(now)
        matches = self._cross_domain_matches(signal, now=now, sat=sat)

        self._state.open_windows[sat] = _CollectionWindow(
            source_signal=signal.id, start_ts_s=now, risk=risk, marking=signal.marking
        )

        kind = "orbital_collection_overlap" if overlaps else "orbital_collection_risk"
        severity = self._severity_with_context(
            risk,
            overlaps=bool(overlaps) or any(m.keyed for m in matches),
            correlations=correlations,
        )
        await self._trace_matches(signal, kind, sat, matches)
        await self._publish(
            self._build_anomaly(
                kind=kind,
                signal=signal,
                severity=severity,
                payload={
                    "satellite": sat,
                    "window_state": "open",
                    "overlap_detected": bool(overlaps),
                    "overlapping_windows": overlaps,
                    "correlated_events": [
                        *(self._compact(c) for c in correlations),
                        *(self._compact(m.correlation) for m in matches),
                    ],
                    "recommended_response": "low_observable_mode",
                    "summary": signal.payload.summary,
                },
                correlates=[m.correlation for m in matches],
                context_markings=[c.marking for c in correlations],
            )
        )
        return kind

    def _handle_collection_end(self, signal: Signal) -> None:
        sat = _satellite_name(signal)
        self._state.open_windows.pop(sat, None)

    async def _handle_rpo(self, signal: Signal, *, now: float, sat: str) -> str:
        observables = signal.payload.observables or {}
        miss_km = observables.get("miss_distance_km")
        range_km = observables.get("range_km")
        range_value = miss_km if miss_km is not None else range_km
        correlations = self._correlated(now)
        matches = self._cross_domain_matches(signal, now=now, sat=sat)
        base = signal.confidence
        if isinstance(range_value, (int, float)) and range_value <= 10:
            base = max(base, 0.82)

        kind = "orbital_rpo_risk"
        severity = self._severity_with_context(
            base,
            overlaps=any(m.keyed for m in matches),
            correlations=correlations,
        )
        await self._trace_matches(signal, kind, sat, matches)
        await self._publish(
            self._build_anomaly(
                kind=kind,
                signal=signal,
                severity=severity,
                payload={
                    "satellite": sat,
                    "asset": signal.payload.asset,
                    "event_type": signal.payload.event_type,
                    "summary": signal.payload.summary,
                    "observables": observables,
                    "correlated_events": [
                        *(self._compact(c) for c in correlations),
                        *(self._compact(m.correlation) for m in matches),
                    ],
                    "recommended_response": "request_space_support_options",
                    "confidence": signal.confidence,
                },
                correlates=[m.correlation for m in matches],
                context_markings=[c.marking for c in correlations],
            )
        )
        return kind

    async def _handle_correlation_event(
        self, signal: Signal, cue: str, *, now: float, sat: str
    ) -> None:
        correlation = self._correlation(signal, now=now, sat=sat, kind=cue, cue=cue)

        for window_sat, window in self._state.open_windows.items():
            if not self._within_window(signal.domain, now, "orbit", window.start_ts_s):
                continue
            severity = self._severity_with_context(
                window.risk, overlaps=False, correlations=[correlation]
            )
            await self._publish(
                self._build_anomaly(
                    kind="orbital_collection_correlated",
                    signal=signal,
                    severity=severity,
                    payload={
                        "satellite": window_sat,
                        "window_state": "open",
                        "source_window_signal": window.source_signal,
                        "correlated_events": [self._compact(correlation)],
                        "recommended_response": "low_observable_mode",
                        "summary": signal.payload.summary,
                    },
                    suffix=window.source_signal,
                    context_markings=[window.marking],
                )
            )

    @staticmethod
    def _compact(c: _Correlation) -> dict[str, Any]:
        return {
            "id": c.signal_id,
            "kind": c.kind,
            "domain": c.domain,
            "event_type": c.event_type,
            "source": c.source,
            "time": c.ts_s,
        }
