"""Per-domain windows, satellite-keyed cross-domain correlation, payload
enrichment, and bounded state for :class:`FusionService`.

Correlation-direction rule under test (see the ``FusionService`` docstring):
two signals correlate when their separation is within the *longer* of the two
domains' look-backs, whichever arrives second; an out-of-order arrival uses the
stored correlate's look-ahead instead.
"""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from canopy.services.bus import InProcessBus
from canopy.services.fusion import (
    CORRELATION_WINDOW_S,
    DEFAULT_WINDOW_KEY,
    DEFAULT_WINDOWS,
    MAX_TRACKED,
    OVERLAP_BOOST,
    FusionService,
    _BoundedIdSet,
    _Correlation,
)
from canopy.services.schemas.events import Anomaly, Location, Provenance, Signal

T0 = datetime(2026, 9, 17, 14, 30, tzinfo=UTC)
SAT_A = "ctb://centralblue.dev/leo-science-1"
SAT_B = "ctb://centralblue.dev/leo-science-2"


def _signal(
    *,
    id: str,
    domain: str,
    event_type: str,
    offset_s: float = 0.0,
    satellite_id: str | None = None,
    confidence: float = 0.8,
    observables: dict | None = None,
    summary: str = "test",
) -> Signal:
    return Signal(
        id=id,
        ts=T0 + timedelta(seconds=offset_s),
        domain=domain,
        source="test",
        realism="mock_operational",
        confidence=confidence,
        location=Location(label="t"),
        payload={
            "event_type": event_type,
            "summary": summary,
            "satellite_id": satellite_id,
            "observables": observables or {},
        },
        provenance=Provenance(source_id="t"),
    )


def _bus(id: str, offset_s: float, sat: str = SAT_A, **kw) -> Signal:
    kw.setdefault("event_type", "link_margin_drop")
    return _signal(id=id, domain="bus_health", offset_s=offset_s, satellite_id=sat, **kw)


def _rf(id: str, offset_s: float, sat: str | None = SAT_A, **kw) -> Signal:
    return _signal(
        id=id, domain="rf_ew", event_type="rf_interference",
        offset_s=offset_s, satellite_id=sat, **kw,
    )


async def _run(
    signals: list[Signal], *, windows: dict[str, tuple[int, int]] | None = None
) -> list[Anomaly]:
    """Publish ``signals`` in order through a live FusionService; return anomalies."""
    bus = InProcessBus()
    fusion = FusionService(bus, windows=windows)
    received: list[Anomaly] = []

    async def sniff() -> None:
        async for _, event in bus.subscribe("anomalies.*"):
            if isinstance(event, Anomaly):
                received.append(event)

    tasks = [asyncio.create_task(sniff()), asyncio.create_task(fusion.run())]
    await asyncio.sleep(0)
    try:
        for signal in signals:
            await bus.publish(f"signals.{signal.domain}", signal)
        await asyncio.wait_for(bus.drain(), timeout=2.0)
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        bus.close()
    return received


def _by_source(anomalies: list[Anomaly], signal_id: str) -> Anomaly:
    return next(a for a in anomalies if a.source_signal == signal_id)


# ---- (5) window table -------------------------------------------------------


def test_default_windows_match_the_spec_table() -> None:
    assert DEFAULT_WINDOWS["bus_health"] == (600, 120)
    assert DEFAULT_WINDOWS["space_weather"] == (900, 120)
    assert DEFAULT_WINDOWS[DEFAULT_WINDOW_KEY] == (120, 120)
    assert DEFAULT_WINDOWS[DEFAULT_WINDOW_KEY] == (
        CORRELATION_WINDOW_S,
        CORRELATION_WINDOW_S,
    )


def test_window_overrides_merge_over_defaults() -> None:
    fusion = FusionService(InProcessBus(), windows={"bus_health": (900, 60)})
    assert fusion.windows["bus_health"] == (900, 60)
    assert fusion.windows["space_weather"] == DEFAULT_WINDOWS["space_weather"]
    assert fusion.windows[DEFAULT_WINDOW_KEY] == DEFAULT_WINDOWS[DEFAULT_WINDOW_KEY]
    with pytest.raises(TypeError):
        fusion.windows["bus_health"] = (1, 1)  # type: ignore[index]


@pytest.mark.parametrize("bad", [{"bus_health": (600,)}, {"bus_health": (-1, 120)}])
def test_invalid_window_overrides_are_rejected(bad: dict) -> None:
    with pytest.raises(ValueError):
        FusionService(InProcessBus(), windows=bad)


# ---- (1)-(3) bus_health x hostile domain on the satellite key ---------------


async def test_rf_400s_after_bus_on_same_satellite_is_correlated_and_boosted() -> None:
    anomalies = await _run([_bus("bus-1", 0), _rf("rf-1", 400, confidence=0.8)])

    rf = _by_source(anomalies, "rf-1")
    assert rf.kind == "rf_anomaly"
    assert rf.source_signal_ids == ["rf-1", "bus-1"]
    assert rf.severity == pytest.approx(0.8 + OVERLAP_BOOST)
    assert [c["id"] for c in rf.payload["correlated_events"]] == ["bus-1"]

    bus = _by_source(anomalies, "bus-1")
    assert bus.source_signal_ids == ["bus-1"]  # nothing to look back on yet
    assert "correlated_events" not in bus.payload


async def test_bus_400s_after_rf_on_same_satellite_is_correlated_and_boosted() -> None:
    anomalies = await _run([_rf("rf-1", 0), _bus("bus-1", 400, confidence=0.81)])

    bus = _by_source(anomalies, "bus-1")
    assert bus.kind == "bus_link_margin"
    assert bus.source_signal_ids == ["bus-1", "rf-1"]
    assert bus.severity == pytest.approx(0.81 + OVERLAP_BOOST)


async def test_different_satellite_ids_do_not_correlate() -> None:
    anomalies = await _run([_bus("bus-1", 0, sat=SAT_A), _rf("rf-1", 400, sat=SAT_B)])

    rf = _by_source(anomalies, "rf-1")
    assert rf.source_signal_ids == ["rf-1"]
    assert rf.severity == pytest.approx(0.8)
    assert "correlated_events" not in rf.payload


async def test_rf_700s_after_bus_is_beyond_the_bus_lookback() -> None:
    """600 s is the longer look-back of the pair (bus_health); 700 s exceeds it."""
    anomalies = await _run([_bus("bus-1", 0), _rf("rf-1", 700)])

    rf = _by_source(anomalies, "rf-1")
    assert rf.source_signal_ids == ["rf-1"]
    assert rf.severity == pytest.approx(0.8)


async def test_bus_lookback_override_widens_the_pair() -> None:
    anomalies = await _run(
        [_bus("bus-1", 0), _rf("rf-1", 700)], windows={"bus_health": (900, 120)}
    )
    assert _by_source(anomalies, "rf-1").source_signal_ids == ["rf-1", "bus-1"]


async def test_severity_boost_is_capped_at_one() -> None:
    anomalies = await _run([_bus("bus-1", 0), _rf("rf-1", 10, confidence=0.95)])
    assert _by_source(anomalies, "rf-1").severity == 1.0


async def test_out_of_order_arrival_uses_the_correlate_lookahead() -> None:
    # rf at T+100 arrives first; bus at T arrives second. The rf correlate
    # is newer by 100 s <= lookahead(rf_ew) = 120 s -> correlated.
    anomalies = await _run([_rf("rf-1", 100), _bus("bus-1", 0)])
    assert _by_source(anomalies, "bus-1").source_signal_ids == ["bus-1", "rf-1"]

    # 200 s ahead exceeds the 120 s look-ahead -> not correlated.
    anomalies = await _run([_rf("rf-2", 200), _bus("bus-2", 0)])
    assert _by_source(anomalies, "bus-2").source_signal_ids == ["bus-2"]


async def test_orbit_rpo_after_bus_on_same_satellite_is_correlated() -> None:
    rpo = _signal(
        id="orb-1", domain="orbit", event_type="rpo_close_approach",
        offset_s=300, satellite_id=SAT_A, confidence=0.7,
        observables={"miss_distance_km": 25.0},
    )
    anomalies = await _run([_bus("bus-1", 0), rpo])

    orbital = _by_source(anomalies, "orb-1")
    assert orbital.kind == "orbital_rpo_risk"
    assert orbital.source_signal_ids == ["orb-1", "bus-1"]
    assert orbital.severity == pytest.approx(0.7 + OVERLAP_BOOST)
    assert orbital.payload["satellite"] == SAT_A
    assert orbital.payload["satellite_id"] == SAT_A


async def test_hostile_domains_without_bus_health_do_not_key_correlate() -> None:
    cyber = _signal(
        id="cy-1", domain="cyber", event_type="intrusion",
        offset_s=30, satellite_id=SAT_A,
    )
    anomalies = await _run([_rf("rf-1", 0), cyber])
    assert _by_source(anomalies, "cy-1").source_signal_ids == ["cy-1"]


# ---- (4) space weather is global ------------------------------------------


def _storm(id: str, offset_s: float, **kw) -> Signal:
    kw.setdefault(
        "observables",
        {"kp": 7, "severity": 0.6, "valid_from": "2026-09-17T14:00:00Z",
         "valid_to": "2026-09-17T20:00:00Z"},
    )
    return _signal(
        id=id, domain="space_weather", event_type="geomagnetic_storm",
        offset_s=offset_s, satellite_id=None, **kw,
    )


async def test_storm_then_orbit_decay_correlates_globally_without_boost() -> None:
    anomalies = await _run(
        [_storm("sw-1", 0), _bus("bus-1", 500, event_type="orbit_decay", confidence=0.7)]
    )

    bus = _by_source(anomalies, "bus-1")
    assert bus.kind == "bus_orbit_decay"
    assert bus.source_signal_ids == ["bus-1", "sw-1"]
    assert bus.severity == pytest.approx(0.7)
    assert bus.payload["correlated_events"][0]["kind"] == "space_weather_storm"


async def test_orbit_decay_then_storm_correlates_within_storm_lookback() -> None:
    anomalies = await _run(
        [_bus("bus-1", 0, event_type="orbit_decay"), _storm("sw-1", 800, confidence=0.9)]
    )
    storm = _by_source(anomalies, "sw-1")
    assert storm.source_signal_ids == ["sw-1", "bus-1"]
    assert storm.severity == pytest.approx(0.9)


async def test_storm_beyond_900s_does_not_correlate() -> None:
    anomalies = await _run([_storm("sw-1", 0), _bus("bus-1", 1000, event_type="orbit_decay")])
    assert _by_source(anomalies, "bus-1").source_signal_ids == ["bus-1"]


async def test_storm_does_not_correlate_with_hostile_domains() -> None:
    anomalies = await _run([_storm("sw-1", 0), _rf("rf-1", 100)])
    assert _by_source(anomalies, "rf-1").source_signal_ids == ["rf-1"]


# ---- (6) payload enrichment -------------------------------------------------


async def test_bus_anomaly_payload_copies_the_spec_fields() -> None:
    recovery = {
        "action_id": "switch_redundant_amplifier",
        "target_subsystem": "comms",
        "requires_approval": True,
        "rationale": "Primary amplifier output trending down.",
    }
    bus = _bus(
        "bus-1", 0,
        observables={
            "subsystem": "comms",
            "symptom": "link_margin_db_drop",
            "physics_consistency": 0.83,
            "shape": "ramp",
            "onset_ts": "2026-09-17T14:32:10Z",
            "recommended_recovery": recovery,
            "rate_of_change": -0.42,
        },
    )
    anomaly = _by_source(await _run([bus]), "bus-1")

    assert anomaly.payload["satellite_id"] == SAT_A
    assert anomaly.payload["subsystem"] == "comms"
    assert anomaly.payload["symptom"] == "link_margin_db_drop"
    assert anomaly.payload["physics_consistency"] == 0.83
    assert anomaly.payload["shape"] == "ramp"
    assert anomaly.payload["onset_ts"] == "2026-09-17T14:32:10Z"
    assert anomaly.payload["recommended_recovery"] == recovery
    # untouched keys stay inside observables only
    assert "rate_of_change" not in anomaly.payload
    assert anomaly.payload["observables"]["rate_of_change"] == -0.42


async def test_bus_anomaly_payload_tolerates_missing_fields() -> None:
    anomaly = _by_source(
        await _run([_bus("bus-1", 0, observables={"subsystem": "power"})]), "bus-1"
    )
    assert anomaly.payload["subsystem"] == "power"
    for name in ("symptom", "physics_consistency", "shape", "onset_ts", "recommended_recovery"):
        assert name not in anomaly.payload


async def test_space_weather_anomaly_payload_copies_the_spec_fields() -> None:
    anomaly = _by_source(await _run([_storm("sw-1", 0)]), "sw-1")
    assert anomaly.kind == "space_weather_storm"
    assert anomaly.payload["kp"] == 7
    assert anomaly.payload["severity"] == 0.6
    assert anomaly.payload["valid_from"] == "2026-09-17T14:00:00Z"
    assert anomaly.payload["valid_to"] == "2026-09-17T20:00:00Z"
    assert "satellite_id" not in anomaly.payload  # space weather is global


async def test_satellite_id_is_copied_for_every_domain() -> None:
    anomaly = _by_source(await _run([_rf("rf-1", 0, sat=SAT_B)]), "rf-1")
    assert anomaly.payload["satellite_id"] == SAT_B
    anomaly = _by_source(await _run([_rf("rf-2", 0, sat=None)]), "rf-2")
    assert "satellite_id" not in anomaly.payload


async def test_ignored_bus_and_space_weather_event_types_stay_quiet() -> None:
    anomalies = await _run(
        [
            _bus("bus-1", 0, event_type="nominal"),
            _signal(id="sw-1", domain="space_weather", event_type="quiet"),
        ]
    )
    assert anomalies == []


# ---- bounded state -----------------------------------------------------------


def test_bounded_id_set_evicts_oldest_and_keeps_dedupe() -> None:
    ids = _BoundedIdSet(cap=3)
    for key in ("a", "b", "c"):
        ids.add(key)
    ids.add("b")  # re-adding an existing id neither duplicates nor evicts
    assert len(ids) == 3
    ids.add("d")
    assert "a" not in ids
    assert all(k in ids for k in ("b", "c", "d"))
    assert len(ids) == 3


def test_fusion_id_sets_are_capped_at_max_tracked() -> None:
    fusion = FusionService(InProcessBus())
    for i in range(MAX_TRACKED + 5):
        fusion._state.seen_signals.add(f"sig-{i}")
        fusion._state.emitted_anomaly_ids.add(f"anom-{i}")
    assert len(fusion._state.seen_signals) == MAX_TRACKED
    assert len(fusion._state.emitted_anomaly_ids) == MAX_TRACKED
    assert "sig-0" not in fusion._state.seen_signals
    assert f"sig-{MAX_TRACKED + 4}" in fusion._state.seen_signals


def test_correlation_pruning_is_time_and_count_bounded() -> None:
    fusion = FusionService(InProcessBus())
    now = T0.timestamp()

    def corr(i: int, age_s: float) -> _Correlation:
        return _Correlation(
            signal_id=f"c-{i}", kind="rf_anomaly", ts_s=now - age_s,
            domain="rf_ew", event_type="rf_interference", source="t",
        )

    fusion._state.recent_correlations.extend(corr(i, 0) for i in range(MAX_TRACKED + 50))
    fusion._state.recent_correlations.append(corr(-1, 901))  # beyond max look-back
    fusion._prune_correlations(now)
    ids = [c.signal_id for c in fusion._state.recent_correlations]
    assert len(ids) == MAX_TRACKED
    assert "c--1" not in ids
    assert ids[0] == "c-50" and ids[-1] == f"c-{MAX_TRACKED + 49}"


async def test_duplicate_signal_ids_are_processed_once() -> None:
    anomalies = await _run([_rf("rf-1", 0), _rf("rf-1", 0)])
    assert [a.source_signal for a in anomalies] == ["rf-1"]


# ---- engine plumbing ---------------------------------------------------------


def test_build_engine_passes_fusion_windows_through() -> None:
    from canopy._engine import build_engine

    engine = build_engine(
        enable_osint=False, fusion_windows={"bus_health": (900, 60)}
    )
    assert engine.fusion.windows["bus_health"] == (900, 60)
    assert engine.fusion.windows["space_weather"] == DEFAULT_WINDOWS["space_weather"]
    engine.bus.close()
