from __future__ import annotations

import asyncio
import inspect
import logging
import time

from collections import OrderedDict, deque
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from canopy.services.bus import Bus
from canopy.services.kb import KB
from canopy.services.llm import LLMClient
from canopy.services.llm.validation import (
    RuleVerdictLike,
    VerdictResolution,
    resolve_verdict,
)
from canopy.services.schemas.events import Anomaly, Attribution, Domain, _new_id
from canopy.services.traces import Tracer

log = logging.getLogger(__name__)

__all__ = ["AttribService", "DEFAULT_RULE_VERDICT"]

DEFAULT_WINDOW_S = 2.0
STRESS_HAIRCUT = 0.15

# Verdict-lane context (docs/INTERFACE-SPEC.md §5.1, §5.2). The two window
# constants mirror LOOKBACK_S / LOOKAHEAD_S in megalith/verdict/config.py.
VERDICT_LOOKBACK_S = 600
VERDICT_LOOKAHEAD_S = 120
# Bounds on the recent-anomaly memory the rule lane reads: per satellite,
# across satellites (oldest satellite evicted first), and in scenario time
# relative to the newest anomaly seen.
CONTEXT_MAX_PER_SATELLITE = 64
CONTEXT_MAX_SATELLITES = 128
CONTEXT_HORIZON_S = 2 * VERDICT_LOOKBACK_S
# Wall-clock arrival stamps kept for per-stage timing (anomaly id → monotonic).
ARRIVALS_SIZE = 4096
# Evidence line every provisional attribution carries (wave 3A).
PROVISIONAL_NOTE = (
    "Provisional: rule lane only; the reasoning lane will revise this attribution."
)

# Map anomaly kinds to the input domains they implicitly rely on. When an
# input domain is blocked, attributions backed primarily by that domain
# take a confidence haircut to honestly reflect the degraded picture.
_KIND_DOMAINS: dict[str, set[Domain]] = {
    "rf_anomaly": {"rf_ew"},
    "rf_gnss_jamming": {"rf_ew", "pnt"},
    "rf_uas_control_link": {"rf_ew"},
    "rf_emission_posture_risk": {"rf_ew"},
    "rf_telemetry_degradation": {"rf_ew", "satcom"},
    "gnss_spoof": {"pnt"},
    "satcom_degradation": {"satcom"},
    "cyber_probe_burst": {"cyber"},
    "cyber_response_action": {"cyber"},
    "sda_catalog_match": {"sda"},
    "sda_maritime_picture_shift": {"sda"},
    "sda_overhead_ir_cue": {"sda"},
    "sda_counterspace_context": {"sda"},
    "drone_spoofing": {"drone"},
    "drone_lost_link": {"drone"},
    "drone_degraded": {"drone"},
    "orbital_rpo_risk": {"orbit", "sda"},
    "orbital_collection_risk": {"orbit"},
    "orbital_collection_overlap": {"orbit"},
    "orbital_collection_correlated": {"orbit"},
    # Drone (protective autonomous actions and tracks).
    "drone_relay_handoff": {"drone"},
    "drone_relay_candidate_ready": {"drone"},
    "drone_relay_mesh_status": {"drone"},
    "drone_fdir_recovery": {"drone"},
    "drone_base_defense_posture": {"drone"},
    "drone_uas_track": {"drone"},
    # Terrain / HUMINT.
    "terrain_masking_risk": {"terrain"},
    "humint_report": {"humint"},
    # OSINT: correlation outputs, contexts, and the semantic cluster emitted
    # by the osint_cluster service (which fusion's pattern map never sees).
    "osint_convergence": {"osint"},
    "osint_commander_update": {"osint"},
    "osint_close_approach_assessment": {"osint"},
    "osint_campaign_assessment": {"osint"},
    "osint_collection_cue": {"osint"},
    "osint_multi_domain_attack": {"osint"},
    "osint_iran_c5isr_assessment": {"osint"},
    "osint_space_support_hold": {"osint"},
    "osint_space_base_defense": {"osint"},
    "osint_collection_risk": {"osint"},
    "osint_relay_resilience": {"osint"},
    "osint_fdir_assessment": {"osint"},
    "osint_blockade_notice": {"osint"},
    "osint_missile_uas_context": {"osint"},
    "osint_militia_uas_context": {"osint"},
    "osint_semantic_cluster": {"osint"},
    # Bus health: the internal-diagnosis lane (docs/INTERFACE-SPEC.md §3).
    # Missing or stale bus telemetry is treated as this domain being blocked.
    "bus_link_margin": {"bus_health"},
    "bus_sensor_saturation": {"bus_health"},
    "bus_attitude_disturbance": {"bus_health"},
    "bus_unexpected_reset": {"bus_health"},
    "bus_power_thermal": {"bus_health"},
    "bus_orbit_decay": {"bus_health"},
    "bus_safe_mode": {"bus_health"},
    # Space weather (docs/INTERFACE-SPEC.md §4).
    "space_weather_storm": {"space_weather"},
    "space_weather_radio_burst": {"space_weather"},
    "space_weather_radiation": {"space_weather"},
    "space_weather_density": {"space_weather"},
}

# ``rule_verdict(batch, context, *, kind_domains=...) -> RuleVerdictLike``.
RuleVerdictFn = Callable[..., RuleVerdictLike]


class _DefaultRule:
    """Sentinel: resolve the rule lane from ``megalith.verdict`` if installed."""

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "DEFAULT_RULE_VERDICT"


DEFAULT_RULE_VERDICT = _DefaultRule()


def _resolve_default_rule() -> RuleVerdictFn | None:
    # The rule lives in the MEGALITH package, which depends on CANOPY and not
    # the other way round; CANOPY's own environment may not contain it. When
    # it is absent the verdict fields simply stay unset.
    try:
        from megalith.verdict.rule import rule_verdict
    except ImportError:
        log.info("attrib: megalith.verdict not importable; verdict lane is off")
        return None
    return rule_verdict


def _country_topic(actor: str) -> str:
    head = actor.split("/", 1)[0].strip().lower()
    return head.replace(" ", "_") or "unknown"


def _critical_domains_for(anomalies: list[Anomaly]) -> set[Domain]:
    domains: set[Domain] = set()
    for a in anomalies:
        domains.update(_KIND_DOMAINS.get(a.kind, set()))
    return domains


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _satellite_of(anomaly: Anomaly) -> str | None:
    value = anomaly.payload.get("satellite_id")
    return value if isinstance(value, str) and value else None


def _context_end(anomaly: Anomaly) -> datetime:
    """When an anomaly stops being recent context.

    Space-weather anomalies are stamped at ``valid_from`` and stay relevant
    until ``valid_to`` (spec §4, §5.1), so a storm is kept while its
    validity window is open; everything else ages from its ``ts``.
    """
    end = _utc(anomaly.ts)
    raw = anomaly.payload.get("valid_to")
    if isinstance(raw, str) and raw.strip():
        text = raw.strip()
        if text.endswith(("Z", "z")):
            text = text[:-1] + "+00:00"
        try:
            end = max(end, _utc(datetime.fromisoformat(text)))
        except ValueError:
            pass
    elif isinstance(raw, datetime):
        end = max(end, _utc(raw))
    return end


def _is_bus_kind(kind: str) -> bool:
    return "bus_health" in _KIND_DOMAINS.get(kind, set())


def _batch_satellite_id(anomalies: Sequence[Anomaly]) -> str | None:
    """The cluster's identity: a bus anomaly's ``satellite_id`` first."""
    for a in anomalies:
        if _is_bus_kind(a.kind) and _satellite_of(a) is not None:
            return _satellite_of(a)
    for a in anomalies:
        if _satellite_of(a) is not None:
            return _satellite_of(a)
    return None


def _max_physics_consistency(anomalies: Sequence[Anomaly]) -> float | None:
    """Spec §5 (1.2): the most recent bus anomaly's physics consistency, else None.

    Later records are scored over longer windows, so the latest is the most
    informed; a max would let an early short-window 0.5 mask a later 0.25.
    Ties on time take the larger value. The name is kept for the callers.
    """
    best: float | None = None
    best_ts = None
    for a in anomalies:
        if not _is_bus_kind(a.kind):
            continue
        value = a.payload.get("physics_consistency")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        if best_ts is None or a.ts > best_ts or (a.ts == best_ts and float(value) > best):
            best, best_ts = float(value), a.ts
    return best


def _fmt_pc(pc: float | None) -> str:
    return "None" if pc is None else f"{pc:.2f}"


def _verdict_evidence_line(resolution: VerdictResolution, rule: RuleVerdictLike) -> str:
    """One evidence-chain line saying who set the verdict and on what."""
    if resolution.basis == "reasoning":
        cited = "; ".join(resolution.verdict_evidence)
        return (
            f"Verdict (reasoning): {resolution.verdict}, departing from the rule "
            f"verdict {rule.verdict} on cited evidence: {cited}"
        )
    head, *rest = tuple(rule.basis) or (f"rule verdict {rule.verdict}",)
    detail = f" Basis: {'; '.join(rest)}" if rest else ""
    return f"Verdict (rule): {resolution.verdict}. {head}.{detail}"


@dataclass
class _SatelliteCluster:
    """One satellite's open anomaly cluster on the fast lane (wave 3A).

    Opened by the first batch on a satellite that contains a ``bus_*``
    anomaly; every later anomaly on the same satellite joins it while it is
    open. ``attribution_id`` is shared by the provisional attribution and by
    every reasoning-lane revision. The cluster closes once the reasoning task
    has nothing left to do and ``window_s`` has passed without a new arrival
    (or immediately on :meth:`AttribService.flush`).
    """

    satellite_id: str
    attribution_id: str
    anomalies: list[Anomaly]
    t0: float
    revision: int = 0
    dirty: bool = False
    closing: bool = False
    closed: bool = False
    task: asyncio.Task | None = None
    joined: asyncio.Event = field(default_factory=asyncio.Event)

    @property
    def anomaly_ids(self) -> set[str]:
        return {a.id for a in self.anomalies}


class AttribService:
    """Attribution-stage service.

    Subscribes to ``anomalies.*`` and batches anomalies in a small sliding
    window before calling ``LLMClient.attribute(...)``. The window lets a
    coordinated cross-domain cluster (RF + cyber + PNT, for example) attribute
    as a single campaign rather than each leg in isolation. Set
    ``window_s=0`` to attribute each anomaly immediately (used in tests).

    Verdict lane (docs/INTERFACE-SPEC.md §5): every anomaly the service
    consumes is remembered in a bounded per-satellite context. Before the
    primary call the ``rule_verdict`` function classifies the batch against
    that context; the result goes into the LLM prompt as the provisional
    verdict and, after reconcile and the stress haircut, is enforced by
    ``_apply_verdict_prior`` as the floor the reasoning lane may only leave
    by citing evidence. ``rule_verdict`` defaults to ``megalith.verdict``
    when that package is importable and to "lane off" otherwise; pass
    ``None`` to disable it explicitly.

    Fast lane (plan §4, wave 3A). A batch keyed by ``satellite_id`` that
    contains a ``bus_*`` anomaly does not wait for the window or for any
    LLM: the rule verdict is published at once as a *provisional*
    Attribution (``provisional=True``, ``revision=0``) from the consumer
    loop, and the reasoning lane (primary → red-team → reconcile → haircut →
    verdict prior, exactly as for every other batch) runs in its own task
    and republishes the same attribution id with ``provisional=False`` and
    ``revision=1``. Anomalies on the same satellite that arrive while that
    task runs join the cluster and are attributed together as the next
    revision; one reasoning task per satellite is in flight at any time.
    Batches without a ``satellite_id``, without a bus anomaly, or with the
    rule lane off keep the windowed, synchronous behaviour unchanged.

    ``bus_health_registry`` names the satellites that have internal-diagnosis
    telemetry. A batch on one of them with no bus anomaly in the batch or in
    recent context is treated as if ``bus_health`` were a blocked domain
    (§5.2): the stress haircut applies and the evidence says the telemetry
    is missing.
    """

    def __init__(
        self,
        bus: Bus,
        llm: LLMClient,
        kb: KB,
        *,
        window_s: float = DEFAULT_WINDOW_S,
        tracer: Tracer | None = None,
        blocked_domains: Callable[[], set[Domain]] | None = None,
        multi_agent: bool = True,
        kb_context_mode: Literal["scenario", "full"] = "scenario",
        rule_verdict: RuleVerdictFn | None | _DefaultRule = DEFAULT_RULE_VERDICT,
        bus_health_registry: Callable[[], set[str]] | None = None,
        fast_lane: bool = True,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._bus = bus
        self._llm = llm
        self._kb = kb
        self._window_s = window_s
        self._tracer = tracer
        self._blocked_domains = blocked_domains
        self._multi_agent = multi_agent
        self._kb_context_mode = kb_context_mode
        self._rule_verdict: RuleVerdictFn | None = (
            _resolve_default_rule()
            if isinstance(rule_verdict, _DefaultRule)
            else rule_verdict
        )
        self._bus_health_registry = bus_health_registry
        self._fast_lane = fast_lane
        self._clock = clock
        self._buffer: list[Anomaly] = []
        self._flush_task: asyncio.Task | None = None
        self._recent: OrderedDict[str | None, deque[Anomaly]] = OrderedDict()
        self._latest_ts: datetime | None = None
        self._llm_accepts_rule: dict[str, bool] = {}
        self._arrivals: OrderedDict[str, float] = OrderedDict()
        self._clusters: dict[str, _SatelliteCluster] = {}
        self.errors: list[dict[str, str]] = []

    @property
    def verdict_lane_enabled(self) -> bool:
        return self._rule_verdict is not None

    @property
    def fast_lane_enabled(self) -> bool:
        """The fast lane needs the rule lane: no rule, no provisional verdict."""
        return self._fast_lane and self._rule_verdict is not None

    def _record_error(self, stage: str, exc: Exception) -> None:
        self.errors.append(
            {
                "stage": stage,
                "type": exc.__class__.__name__,
                "message": str(exc),
            }
        )

    async def run(self) -> None:
        try:
            async for topic, event in self._bus.subscribe("anomalies.*"):
                if not isinstance(event, Anomaly):
                    log.warning(
                        "attrib received non-Anomaly on %s: %r", topic, type(event)
                    )
                    continue
                self._note_arrival(event)
                self._remember(event)
                if await self._try_fast_lane(event):
                    continue
                if self._window_s <= 0:
                    await self._process([event])
                    continue
                self._buffer.append(event)
                if self._flush_task is None or self._flush_task.done():
                    self._flush_task = asyncio.create_task(self._flush_after_window())
        finally:
            if self._flush_task is not None and not self._flush_task.done():
                self._flush_task.cancel()
            for cluster in list(self._clusters.values()):
                if cluster.task is not None and not cluster.task.done():
                    cluster.task.cancel()

    async def _flush_after_window(self) -> None:
        await asyncio.sleep(self._window_s)
        # The legacy timer flushes only the windowed buffer: it must never
        # wait on a reasoning task, or a slow model would delay the next
        # legacy batch.
        await self._flush_buffer()

    async def flush(self) -> None:
        """Process the buffered batch and settle the fast lane.

        Runtime callers normally rely on the time window. Benchmark episodes
        and tests use this explicit completion seam after every input signal
        has drained: it attributes whatever is buffered, lets every in-flight
        reasoning task finish (including the coalesced revision for anomalies
        that joined meanwhile) and closes the satellite clusters, so the next
        batch on a satellite starts a new attribution.
        """
        await self._flush_buffer()
        await self.settle()

    async def _flush_buffer(self) -> None:
        current = asyncio.current_task()
        if (
            self._flush_task is not None
            and self._flush_task is not current
            and not self._flush_task.done()
        ):
            self._flush_task.cancel()
        self._flush_task = None
        if not self._buffer:
            return
        batch = list(self._buffer)
        self._buffer.clear()
        await self._process(batch)

    async def settle(self) -> None:
        """Wait for every in-flight reasoning task and close the clusters."""
        while self._clusters:
            pending: list[asyncio.Task] = []
            for cluster in list(self._clusters.values()):
                cluster.closing = True
                cluster.joined.set()
                if cluster.task is not None and not cluster.task.done():
                    pending.append(cluster.task)
                else:
                    self._close_cluster(cluster)
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)

    @property
    def open_clusters(self) -> dict[str, list[str]]:
        """Satellite → anomaly ids of every open fast-lane cluster (diagnostics)."""
        return {
            sat: [a.id for a in cluster.anomalies]
            for sat, cluster in self._clusters.items()
            if not cluster.closed
        }

    # ---- Arrival timing -----------------------------------------------------

    def _note_arrival(self, anomaly: Anomaly) -> float:
        """Remember when ``anomaly`` reached this stage (monotonic seconds).

        The shared tracer's first-wins mark keeps an earlier origin (fusion's
        signal arrival) when one was recorded, so ``latency_ms`` on every
        trace measures from the earliest moment the pipeline knows about.
        """
        now = self._clock()
        if self._tracer is not None:
            now = self._tracer.mark(anomaly.id, now)
        if anomaly.id not in self._arrivals:
            self._arrivals[anomaly.id] = now
            while len(self._arrivals) > ARRIVALS_SIZE:
                self._arrivals.popitem(last=False)
        return now

    def _batch_t0(self, anomalies: Sequence[Anomaly]) -> float | None:
        """When the batch's first anomaly arrived, if this service saw it arrive."""
        known = [self._arrivals[a.id] for a in anomalies if a.id in self._arrivals]
        if self._tracer is not None:
            traced = self._tracer.t0_for(*(a.id for a in anomalies))
            if traced is not None:
                known.append(traced)
        return min(known) if known else None

    # ---- Fast lane (wave 3A) ------------------------------------------------

    async def _try_fast_lane(self, anomaly: Anomaly) -> bool:
        """Route ``anomaly`` through the fast lane when it is satellite-keyed.

        Returns ``True`` when the anomaly was consumed (it joined an open
        cluster, or opened one and a provisional attribution went out);
        ``False`` hands it to the legacy windowed path untouched.
        """
        if not self.fast_lane_enabled:
            return False
        satellite_id = _satellite_of(anomaly)
        if satellite_id is None:
            return False
        cluster = self._clusters.get(satellite_id)
        if cluster is not None and not cluster.closed:
            # A cluster that is closing (flush) still takes late joiners: the
            # reasoning task drains ``dirty`` before it closes, so they are
            # attributed as the next revision rather than lost.
            if anomaly.id not in cluster.anomaly_ids:
                cluster.anomalies.append(anomaly)
            cluster.dirty = True
            cluster.joined.set()
            self._ensure_reasoning_task(cluster)
            return True
        # A new cluster: this anomaly plus whatever is waiting in the window
        # for the same satellite. Only a batch with a bus anomaly qualifies.
        pending = [a for a in self._buffer if _satellite_of(a) == satellite_id]
        batch = [*pending, anomaly]
        if not any(_is_bus_kind(a.kind) for a in batch):
            return False
        recent = self.recent_context(satellite_id)
        rule = self._compute_rule_verdict(batch, recent)
        if rule is None:
            return False  # the rule failed: the legacy path still attributes it
        self._buffer = [a for a in self._buffer if _satellite_of(a) != satellite_id]
        t0 = self._batch_t0(batch)
        cluster = _SatelliteCluster(
            satellite_id=satellite_id,
            attribution_id=_new_id(),
            anomalies=batch,
            t0=self._clock() if t0 is None else t0,
        )
        self._clusters[satellite_id] = cluster
        await self._publish_provisional(cluster, rule)
        cluster.dirty = True
        self._ensure_reasoning_task(cluster)
        return True

    def _ensure_reasoning_task(self, cluster: _SatelliteCluster) -> None:
        if cluster.task is None or cluster.task.done():
            cluster.task = asyncio.create_task(
                self._reason(cluster), name=f"attrib-reasoning-{cluster.satellite_id}"
            )

    async def _reason(self, cluster: _SatelliteCluster) -> None:
        """The reasoning lane for one cluster: one revision per dirty batch.

        Runs until the cluster has been quiet for ``window_s`` (or is told to
        close), attributing the whole cluster again whenever anomalies
        joined since the last pass started. Each pass republishes the same
        attribution id with the next revision.
        """
        try:
            while True:
                while cluster.dirty:
                    cluster.dirty = False
                    cluster.joined.clear()
                    cluster.revision += 1
                    await self._process(list(cluster.anomalies), cluster=cluster)
                if cluster.closing or self._window_s <= 0:
                    break
                try:
                    await asyncio.wait_for(cluster.joined.wait(), timeout=self._window_s)
                except TimeoutError:
                    break
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - one cluster must not kill the lane
            self._record_error("reasoning_lane", exc)
            log.exception(
                "attrib: reasoning lane failed for %s", cluster.satellite_id
            )
        finally:
            self._close_cluster(cluster)

    def _close_cluster(self, cluster: _SatelliteCluster) -> None:
        cluster.closed = True
        if self._clusters.get(cluster.satellite_id) is cluster:
            del self._clusters[cluster.satellite_id]

    async def _publish_provisional(
        self, cluster: _SatelliteCluster, rule: RuleVerdictLike
    ) -> None:
        """Publish the rule lane's call for the cluster, before any LLM runs.

        Verdict, confidence and basis come from the rule; the actor follows
        the §5 convention (no actor has been attributed yet, so a hostile
        verdict carries ``Unknown`` and the §5 cap applies). The id is the
        cluster's, which every reasoning-lane revision reuses.
        """
        anomalies = cluster.anomalies
        resolution = resolve_verdict(
            proposed=None,
            cited_evidence=None,
            confidence=rule.confidence,
            actor="Unknown",
            rule=rule,
        )
        physics_consistency = _max_physics_consistency(anomalies)
        source_ids = list(dict.fromkeys(sid for a in anomalies for sid in a.source_signal_ids))
        attribution = Attribution(
            id=cluster.attribution_id,
            anomaly_ids=[a.id for a in anomalies],
            actor=resolution.actor,
            confidence=round(resolution.confidence, 3),
            evidence=[
                _verdict_evidence_line(resolution, rule),
                PROVISIONAL_NOTE,
            ],
            source_signal_ids=source_ids,
            verdict=resolution.verdict,
            physics_consistency=physics_consistency,
            verdict_basis=resolution.basis,
            verdict_evidence=[],
            satellite_id=rule.satellite_id or cluster.satellite_id,
            provisional=True,
            revision=cluster.revision,
        )
        if self._tracer is not None:
            self._tracer.mark(attribution.id, cluster.t0)
        await self._bus.publish(f"attributions.{_country_topic(attribution.actor)}", attribution)
        log.info(
            "attrib published provisional id=%s verdict=%s confidence=%.2f satellite=%s",
            attribution.id,
            attribution.verdict,
            attribution.confidence,
            attribution.satellite_id,
        )
        if self._tracer is not None:
            await self._tracer.emit(
                "attrib_primary",
                "decision",
                f"provisional verdict={attribution.verdict} "
                f"confidence={attribution.confidence:.2f} basis=rule "
                f"pc={_fmt_pc(physics_consistency)} (fast lane, no LLM)",
                ref_id=attribution.id,
                t0=cluster.t0,
                stage_t0=cluster.t0,
                actor=attribution.actor,
                confidence=attribution.confidence,
                verdict=attribution.verdict,
                verdict_basis="rule",
                physics_consistency=physics_consistency,
                rule_confidence=rule.confidence,
                basis=list(rule.basis),
                satellite_id=attribution.satellite_id,
                provisional=True,
                revision=attribution.revision,
                anomaly_ids=list(attribution.anomaly_ids),
            )

    # ---- Recent-anomaly context -------------------------------------------

    def _remember(self, anomaly: Anomaly) -> None:
        sat = _satellite_of(anomaly)
        bucket = self._recent.get(sat)
        if bucket is None:
            bucket = deque(maxlen=CONTEXT_MAX_PER_SATELLITE)
            self._recent[sat] = bucket
        else:
            self._recent.move_to_end(sat)
        if any(a.id == anomaly.id for a in bucket):
            return
        bucket.append(anomaly)
        while len(self._recent) > CONTEXT_MAX_SATELLITES:
            self._recent.popitem(last=False)
        ts = _utc(anomaly.ts)
        if self._latest_ts is None or ts > self._latest_ts:
            self._latest_ts = ts
        self._prune()

    def _prune(self) -> None:
        if self._latest_ts is None:
            return
        horizon = self._latest_ts - timedelta(seconds=CONTEXT_HORIZON_S)
        for sat in list(self._recent):
            bucket = self._recent[sat]
            kept = [a for a in bucket if _context_end(a) >= horizon]
            if len(kept) != len(bucket):
                bucket.clear()
                bucket.extend(kept)
            if not bucket:
                del self._recent[sat]

    def recent_context(self, satellite_id: str | None) -> list[Anomaly]:
        """Recent anomalies on ``satellite_id`` plus the identity-less ones.

        The identity-less bucket carries space weather (global, no
        ``satellite_id``) and legacy signals without identity; the rule
        lane decides which of those may bear on a given satellite.
        """
        out = list(self._recent.get(satellite_id, ()))
        if satellite_id is not None:
            out.extend(self._recent.get(None, ()))
        return out

    # ---- Verdict lane helpers ---------------------------------------------

    def _compute_rule_verdict(
        self, anomalies: list[Anomaly], recent: list[Anomaly]
    ) -> RuleVerdictLike | None:
        if self._rule_verdict is None:
            return None
        try:
            return self._rule_verdict(anomalies, recent, kind_domains=_KIND_DOMAINS)
        except Exception as exc:  # noqa: BLE001 - the lane must not stall attribution
            self._record_error("rule_verdict", exc)
            log.exception("attrib: rule_verdict failed for batch of %d", len(anomalies))
            return None

    def _rule_kwargs(self, method: str, rule: RuleVerdictLike | None) -> dict[str, Any]:
        """``{"rule_verdict": rule}`` when the client's method accepts it.

        The ``LLMClient`` protocol predates the verdict lane; clients that
        take the keyword get the provisional verdict, others are called as
        before.
        """
        if rule is None:
            return {}
        accepts = self._llm_accepts_rule.get(method)
        if accepts is None:
            fn = getattr(self._llm, method, None)
            try:
                params = inspect.signature(fn).parameters if fn is not None else {}
            except (TypeError, ValueError):
                params = {}
            accepts = "rule_verdict" in params or any(
                p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()
            )
            self._llm_accepts_rule[method] = accepts
        return {"rule_verdict": rule} if accepts else {}

    def _missing_bus_telemetry(
        self, anomalies: list[Anomaly], recent: list[Anomaly], satellite_id: str | None
    ) -> str | None:
        """The satellite whose internal-diagnosis telemetry is missing, if any.

        Spec §5.2: a satellite in the bus-health registry with no ``bus_*``
        anomaly in the batch or in recent context inside the look-back is
        treated as ``bus_health`` being blocked for this batch.
        """
        if self._bus_health_registry is None or satellite_id is None:
            return None
        try:
            registry = self._bus_health_registry()
        except Exception as exc:  # noqa: BLE001 - a broken registry must not stall
            self._record_error("bus_health_registry", exc)
            return None
        if satellite_id not in registry:
            return None
        if any(_is_bus_kind(a.kind) for a in anomalies):
            return None
        onset = min(_utc(a.ts) for a in anomalies)
        start = onset - timedelta(seconds=VERDICT_LOOKBACK_S)
        end = onset + timedelta(seconds=VERDICT_LOOKAHEAD_S)
        for a in recent:
            if (
                _is_bus_kind(a.kind)
                and _satellite_of(a) == satellite_id
                and start <= _utc(a.ts) <= end
            ):
                return None
        return satellite_id

    # ---- Pipeline -------------------------------------------------------------

    async def _process(
        self, anomalies: list[Anomaly], *, cluster: _SatelliteCluster | None = None
    ) -> None:
        """Attribute one batch: the reasoning lane.

        ``cluster`` is set when the batch is a fast-lane cluster: the result
        then reuses the cluster's attribution id and carries its revision.
        Everything between the rule verdict and the published attribution is
        the same on both paths.
        """
        # Direct callers (tests, benchmark seams) may bypass run(); make sure
        # the batch is part of its own context either way.
        for a in anomalies:
            self._remember(a)
        t0 = cluster.t0 if cluster is not None else self._batch_t0(anomalies)
        revision = cluster.revision if cluster is not None else 0
        satellite_id = _batch_satellite_id(anomalies)
        recent = self.recent_context(satellite_id)
        rule = self._compute_rule_verdict(anomalies, recent)
        if rule is not None and rule.satellite_id:
            satellite_id = rule.satellite_id
        physics_consistency = _max_physics_consistency(anomalies)
        missing_bus_for = self._missing_bus_telemetry(anomalies, recent, satellite_id)

        # KB context: union of entries indexed by the source signal ids of
        # this batch. Falls back to all entries if no scenario hits.
        seen: set[str] = set()
        context = []
        if self._kb_context_mode == "scenario":
            for a in anomalies:
                for sid in a.source_signal_ids:
                    for entry in self._kb.by_scenario_signal_id(sid):
                        if entry.id not in seen:
                            context.append(entry)
                            seen.add(entry.id)
        if self._kb_context_mode == "full" or not context:
            context = self._kb.all_entries()

        # Multi-agent attribution loop: primary → red-team → reconcile.
        # The intermediate primary + challenge live entirely in the trace
        # stream; downstream services see only the final reconciled
        # attribution on ``attributions.{actor}``. When ``multi_agent`` is
        # disabled (benchmark mode), we publish the primary attribution
        # directly so the comparison isolates whether the red-team loop
        # is pulling its weight against single-pass attribution.
        stage_t0 = self._clock()
        try:
            primary = await self._llm.attribute_primary(
                anomalies, context, **self._rule_kwargs("attribute_primary", rule)
            )
        except Exception as exc:
            self._record_error("attribute_primary", exc)
            log.exception(
                "attrib: attribute_primary failed for batch of %d", len(anomalies)
            )
            return
        if cluster is not None:
            # Every trace and revision of a fast-lane cluster shares its id.
            primary = primary.model_copy(update={"id": cluster.attribution_id})
        if self._tracer is not None:
            provisional = rule.verdict if rule is not None else None
            await self._tracer.emit(
                "attrib_primary",
                "info",
                f"actor={primary.actor} confidence={primary.confidence:.2f} "
                f"verdict={provisional} basis={'rule' if rule is not None else None} "
                f"pc={_fmt_pc(physics_consistency)}",
                ref_id=primary.id,
                t0=t0,
                stage_t0=stage_t0,
                actor=primary.actor,
                confidence=primary.confidence,
                verdict=provisional,
                verdict_basis="rule" if rule is not None else None,
                physics_consistency=physics_consistency,
                rule_confidence=rule.confidence if rule is not None else None,
                basis=list(rule.basis) if rule is not None else [],
                satellite_id=satellite_id,
                revision=revision,
            )

        if not self._multi_agent:
            attribution = primary
        else:
            stage_t0 = self._clock()
            try:
                challenge = await self._llm.attribute_redteam(
                    primary, anomalies, context
                )
            except Exception as exc:
                self._record_error("attribute_redteam", exc)
                log.exception(
                    "attrib: attribute_redteam failed for primary=%s", primary.id
                )
                attribution = primary
            else:
                if self._tracer is not None:
                    alt = challenge.alternative_actor or "uncertainty floor"
                    await self._tracer.emit(
                        "attrib_redteam",
                        "warn" if challenge.confidence_delta < 0 else "info",
                        f"challenge: {challenge.rationale}",
                        ref_id=primary.id,
                        t0=t0,
                        stage_t0=stage_t0,
                        alternative_actor=alt,
                        confidence_delta=challenge.confidence_delta,
                        objections=challenge.objections,
                        revision=revision,
                    )
                stage_t0 = self._clock()
                try:
                    attribution = await self._llm.reconcile(
                        primary,
                        challenge,
                        anomalies,
                        context,
                        **self._rule_kwargs("reconcile", rule),
                    )
                except Exception as exc:
                    self._record_error("reconcile", exc)
                    log.exception(
                        "attrib: reconcile failed for primary=%s", primary.id
                    )
                    attribution = primary

        # Stress-mode confidence haircut: if any critical input domain for
        # this anomaly cluster is blocked, lower confidence and surface the
        # degradation in the trace stream.
        attribution = await self._apply_stress_haircut(
            attribution,
            anomalies,
            missing_bus_for=missing_bus_for,
            t0=t0,
            stage_t0=stage_t0,
        )
        # Verdict prior: the rule verdict is the floor; the reasoning lane
        # may leave it only with cited evidence, inside bounded confidence.
        attribution = await self._apply_verdict_prior(
            attribution,
            anomalies,
            rule,
            physics_consistency=physics_consistency,
            satellite_id=satellite_id,
            t0=t0,
            stage_t0=stage_t0,
        )
        if cluster is not None:
            attribution = attribution.model_copy(
                update={
                    "id": cluster.attribution_id,
                    "provisional": False,
                    "revision": cluster.revision,
                }
            )

        if self._tracer is not None and t0 is not None:
            self._tracer.mark(attribution.id, t0)
        country = _country_topic(attribution.actor)
        await self._bus.publish(f"attributions.{country}", attribution)
        log.info(
            "attrib published id=%s actor=%s confidence=%.2f verdict=%s signals=%d revision=%d",
            attribution.id,
            attribution.actor,
            attribution.confidence,
            attribution.verdict,
            len(attribution.source_signal_ids),
            attribution.revision,
        )
        if self._tracer is not None:
            await self._tracer.emit(
                "attrib_reconcile",
                "info",
                f"final actor={attribution.actor} confidence={attribution.confidence:.2f} "
                f"verdict={attribution.verdict} basis={attribution.verdict_basis} "
                f"pc={_fmt_pc(attribution.physics_consistency)}",
                ref_id=attribution.id,
                t0=t0,
                stage_t0=stage_t0,
                actor=attribution.actor,
                confidence=attribution.confidence,
                verdict=attribution.verdict,
                verdict_basis=attribution.verdict_basis,
                physics_consistency=attribution.physics_consistency,
                basis=list(rule.basis) if rule is not None else [],
                verdict_evidence=list(attribution.verdict_evidence),
                satellite_id=attribution.satellite_id,
                provisional=attribution.provisional,
                revision=attribution.revision,
            )

    async def _apply_stress_haircut(
        self,
        attribution: Attribution,
        anomalies: list[Anomaly],
        *,
        missing_bus_for: str | None = None,
        t0: float | None = None,
        stage_t0: float | None = None,
    ) -> Attribution:
        blocked: set[Domain] = set()
        if self._blocked_domains is not None:
            blocked = set(self._blocked_domains())
        critical = _critical_domains_for(anomalies)
        if missing_bus_for is not None:
            # Spec §5.2: missing internal-diagnosis telemetry for a satellite
            # that has it is bus_health being blocked, for a cluster that
            # would have used it.
            blocked.add("bus_health")
            critical.add("bus_health")
        intersection = critical & blocked
        if not intersection:
            return attribution

        new_confidence = max(0.30, attribution.confidence - STRESS_HAIRCUT)
        evidence = list(attribution.evidence)
        evidence.append(
            "Stress: input domains "
            f"{sorted(intersection)} unavailable — confidence lowered."
        )
        if missing_bus_for is not None:
            evidence.append(f"internal diagnosis telemetry missing for {missing_bus_for}")
        if self._tracer is not None:
            await self._tracer.emit(
                "stress",
                "warn",
                f"{sorted(intersection)} blocked — lowering confidence "
                f"{attribution.confidence:.2f} → {new_confidence:.2f}",
                ref_id=attribution.id,
                t0=t0,
                stage_t0=stage_t0,
                blocked=sorted(intersection),
                before=attribution.confidence,
                after=new_confidence,
                missing_bus_telemetry=missing_bus_for,
            )
        return attribution.model_copy(
            update={"confidence": round(new_confidence, 3), "evidence": evidence}
        )

    async def _apply_verdict_prior(
        self,
        attribution: Attribution,
        anomalies: list[Anomaly],
        rule: RuleVerdictLike | None,
        *,
        physics_consistency: float | None,
        satellite_id: str | None,
        t0: float | None = None,
        stage_t0: float | None = None,
    ) -> Attribution:
        """Enforce spec §5.2 on the reconciled attribution.

        The rule verdict is the floor: a verdict that differs from it
        without ``verdict_evidence`` is reset (basis ``rule``) with a repair
        note; a cited change keeps basis ``reasoning``. Confidence is clamped
        to ``rule ± 0.15`` when the verdict stands and to ``[0.30, 0.85]``
        when it changed. The actor follows the §5 convention and an
        ``Unknown`` actor is capped at 0.49. Runs after the stress haircut,
        so the clamp bounds the total departure from the rule confidence,
        haircut included. With the lane off (``rule is None``) only
        ``physics_consistency`` and ``satellite_id`` are filled in.
        """
        resolution = resolve_verdict(
            proposed=attribution.verdict,
            cited_evidence=attribution.verdict_evidence,
            confidence=attribution.confidence,
            actor=attribution.actor,
            rule=rule,
        )
        evidence = list(attribution.evidence)
        if resolution.repair_note is not None and resolution.repair_note not in evidence:
            evidence.append(resolution.repair_note)
            if self._tracer is not None:
                await self._tracer.emit(
                    "attrib_reconcile",
                    "warn",
                    f"verdict repair: {attribution.verdict} proposed without "
                    f"verdict_evidence; rule verdict {resolution.verdict} stands",
                    ref_id=attribution.id,
                    t0=t0,
                    stage_t0=stage_t0,
                    proposed=attribution.verdict,
                    verdict=resolution.verdict,
                    verdict_basis=resolution.basis,
                    physics_consistency=physics_consistency,
                    basis=list(rule.basis) if rule is not None else [],
                )
        if rule is not None and resolution.verdict is not None:
            if not any(line.startswith("Verdict (") for line in evidence):
                evidence.append(_verdict_evidence_line(resolution, rule))

        confidence = resolution.confidence
        if abs(confidence - attribution.confidence) > 1e-12:
            confidence = round(confidence, 3)
        return attribution.model_copy(
            update={
                "verdict": resolution.verdict,
                "verdict_basis": resolution.basis,
                "verdict_evidence": resolution.verdict_evidence,
                "actor": resolution.actor,
                "confidence": confidence,
                "evidence": evidence,
                "physics_consistency": (
                    physics_consistency
                    if physics_consistency is not None
                    else attribution.physics_consistency
                ),
                "satellite_id": satellite_id or attribution.satellite_id,
            }
        )
