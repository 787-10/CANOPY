"""``POST /reset`` and the services' ``reset()`` hooks (docs/C2-API.md §2).

One gateway process replaying Run B and then Run A carried B's RF anomaly on
the same satellite into A's attrib context and decide cache, so A came out
``unknown`` with a withheld recovery citing jamming. ``reset()`` on each
service clears only in-process run state; the route cancels an in-flight
replay first and calls them all. The unit tests below drive each service on
an in-process bus; the gateway tests use a TestClient of their own so they
never depend on another module's engine; the last test replays the two demo
scenarios back to back from the root environment, where the rule lane runs.
"""
from __future__ import annotations

import asyncio
import importlib.util
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from canopy.api import create_app
from canopy.services.attrib import AttribService
from canopy.services.bus import InProcessBus
from canopy.services.decide import DecideService
from canopy.services.decide.tools import policy_gate
from canopy.services.fusion import FusionService
from canopy.services.kb import KB
from canopy.services.llm.stub import StubLLMClient
from canopy.services.schemas.events import Anomaly, Attribution, Decision, Signal
from canopy.services.ui_events import UIEventService

MEGALITH_AVAILABLE = importlib.util.find_spec("megalith") is not None
ROOT = Path(__file__).resolve().parents[1]
KB_FILE = ROOT / "data" / "kb_seed_entries.json"
SAT = "ctb://centralblue.dev/leo-science-1"
T0 = datetime(2026, 9, 17, 14, 30, tzinfo=UTC)


def _signal(sid: str, domain: str, event_type: str, *, offset_s: float, **observables: Any) -> Signal:
    return Signal.model_validate(
        {
            "id": sid,
            "ts": (T0 + timedelta(seconds=offset_s)).isoformat(),
            "domain": domain,
            "source": "test",
            "realism": "mock_operational",
            "confidence": 0.8,
            "location": {"label": "LEO-SCIENCE-1"},
            "payload": {
                "event_type": event_type,
                "summary": f"{event_type} on LEO-SCIENCE-1",
                "asset": "LEO-SCIENCE-1",
                "satellite_id": SAT,
                "observables": observables,
            },
            "provenance": {"source_id": "test"},
        }
    )


def _anomaly(kind: str, sid: str, *, offset_s: float = 0.0, **payload: Any) -> Anomaly:
    return Anomaly(
        id=f"anom-{kind}-{sid}",
        ts=T0 + timedelta(seconds=offset_s),
        kind=kind,
        source_signal=sid,
        source_signal_ids=[sid],
        severity=0.8,
        payload={"asset": "LEO-SCIENCE-1", "satellite_id": SAT, **payload},
    )


async def _spin() -> None:
    for _ in range(3):
        await asyncio.sleep(0)


# ---- Service hooks -----------------------------------------------------------------------


async def test_fusion_reset_forgets_seen_signals_and_correlates() -> None:
    bus = InProcessBus()
    fusion = FusionService(bus)
    anomalies: list[Anomaly] = []

    async def sniff() -> None:
        async for _, event in bus.subscribe("anomalies.*"):
            if isinstance(event, Anomaly):
                anomalies.append(event)

    tasks = [asyncio.create_task(fusion.run()), asyncio.create_task(sniff())]
    try:
        await _spin()
        rf = _signal("sig-rf-1", "rf_ew", "rf_interference", offset_s=0, band="X")
        bus_sig = _signal(
            "sig-bus-1", "bus_health", "link_margin_drop", offset_s=300,
            subsystem="comms", symptom="link_margin_db_drop", physics_consistency=0.83,
        )
        for signal in (rf, bus_sig):
            await bus.publish(f"signals.{signal.domain}", signal)
        await bus.drain()
        first = len(anomalies)
        assert first >= 2
        # The bus symptom correlated with the RF cue that preceded it.
        bus_anoms = [a for a in anomalies if a.kind.startswith("bus_")]
        assert bus_anoms and "sig-rf-1" in bus_anoms[0].source_signal_ids
        assert "sig-rf-1" in fusion._state.seen_signals

        cleared = fusion.reset()
        assert cleared["seen_signals"] == 2
        assert cleared["recent_correlations"] >= 1
        assert "sig-rf-1" not in fusion._state.seen_signals
        assert not fusion._state.recent_correlations and not fusion._state.open_windows

        # After the reset the same bus symptom is new again and has no correlate.
        await bus.publish("signals.bus_health", bus_sig)
        await bus.drain()
        assert len(anomalies) > first
        again = [a for a in anomalies[first:] if a.kind.startswith("bus_")]
        assert again and again[0].source_signal_ids == ["sig-bus-1"]
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        bus.close()


async def test_attrib_reset_cancels_the_window_timer_and_drops_context() -> None:
    bus = InProcessBus()
    attrib = AttribService(bus, StubLLMClient(KB.load_from_json(KB_FILE)), KB.load_from_json(KB_FILE), window_s=60.0)
    attributions: list[Attribution] = []

    async def sniff() -> None:
        async for _, event in bus.subscribe("attributions.*"):
            if isinstance(event, Attribution):
                attributions.append(event)

    tasks = [asyncio.create_task(attrib.run()), asyncio.create_task(sniff())]
    try:
        await _spin()
        # No satellite id: the legacy windowed path buffers it under a 60 s timer.
        legacy = Anomaly(id="anom-legacy", ts=T0, kind="rf_anomaly", source_signal="s", severity=0.7, payload={})
        await bus.publish("anomalies.rf_anomaly", legacy)
        await bus.drain()
        assert attrib._buffer and attrib._flush_task is not None and not attrib._flush_task.done()
        assert attrib.recent_context(None)
        timer = attrib._flush_task

        cleared = await attrib.reset()
        assert cleared["buffer"] == 1 and cleared["recent_anomalies"] == 1
        assert timer.cancelled() or timer.done()
        assert attrib._flush_task is None and not attrib._buffer
        assert not attrib.recent_context(None) and attrib._latest_ts is None
        assert not attributions  # nothing was attributed on the way out
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        bus.close()


async def test_attrib_reset_cancels_fast_lane_clusters_and_the_next_run_starts_clean() -> None:
    pytest.importorskip("megalith")
    bus = InProcessBus()
    attrib = AttribService(bus, StubLLMClient(KB.load_from_json(KB_FILE)), KB.load_from_json(KB_FILE), window_s=60.0)
    assert attrib.fast_lane_enabled
    attributions: list[Attribution] = []

    async def sniff() -> None:
        async for _, event in bus.subscribe("attributions.*"):
            if isinstance(event, Attribution):
                attributions.append(event)

    tasks = [asyncio.create_task(attrib.run()), asyncio.create_task(sniff())]
    try:
        await _spin()
        # Run 1: an RF cue then a healthy-physics bus symptom on the same satellite.
        await bus.publish("anomalies.rf_anomaly", _anomaly("rf_anomaly", "sig-rf-1", offset_s=0))
        await bus.publish(
            "anomalies.bus_link_margin",
            _anomaly("bus_link_margin", "sig-bus-1", offset_s=100, subsystem="comms", physics_consistency=0.83),
        )
        await bus.drain()
        provisional = [a for a in attributions if a.provisional]
        assert provisional and provisional[0].verdict == "unknown"  # rule 5: good physics, hostile context
        assert attrib.open_clusters and SAT in attrib.open_clusters
        cluster_task = attrib._clusters[SAT].task
        assert cluster_task is not None and not cluster_task.done()  # waiting out the 60 s window
        first_id = provisional[0].id

        cleared = await attrib.reset()
        assert cleared["clusters"] == 1 and cleared["recent_anomalies"] >= 2
        assert cluster_task.done()
        assert attrib.open_clusters == {} and attrib._clusters == {}
        assert not attrib.recent_context(SAT)
        seen_before = len(attributions)

        # Run 2: the same bus symptom alone. Without the reset the RF cue would
        # still be in context and the verdict would again be unknown.
        await bus.publish(
            "anomalies.bus_link_margin",
            _anomaly("bus_link_margin", "sig-bus-2", offset_s=200, subsystem="comms", physics_consistency=0.83),
        )
        await bus.drain()
        fresh = [a for a in attributions[seen_before:] if a.provisional]
        assert fresh and fresh[0].verdict == "internal_fault"
        assert fresh[0].id != first_id
        await attrib.reset()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        bus.close()


async def test_decide_reset_forgets_the_anomaly_cache_and_decision_ids() -> None:
    bus = InProcessBus()
    decide = DecideService(bus, StubLLMClient(KB(entries=[])), gate=policy_gate)
    decisions: list[Decision] = []

    async def sniff() -> None:
        async for _, event in bus.subscribe("decisions.*"):
            if isinstance(event, Decision):
                decisions.append(event)

    tasks = [asyncio.create_task(decide.run()), asyncio.create_task(sniff())]
    try:
        await _spin()
        rf = _anomaly("rf_anomaly", "sig-rf-1")
        await bus.publish("anomalies.rf_anomaly", rf)
        await bus.drain()
        attribution = Attribution(
            id="attr-1", anomaly_ids=[rf.id], actor="Unknown", confidence=0.4,
            kb_citations=["kb-attribution-uncertainty-001"], verdict="unknown", satellite_id=SAT,
        )
        await bus.publish("attributions.unknown", attribution)
        await bus.drain()
        assert rf.id in decide._anomaly_cache and "attr-1" in decide._decision_ids
        first_decision_id = decisions[0].id

        cleared = decide.reset()
        assert cleared == {"anomaly_cache": 1, "arrivals": 1, "decision_ids": 1, "errors": 0}
        assert not decide._anomaly_cache and not decide._decision_ids and not decide._arrivals
        assert decide._timing is None

        # The same attribution id after a reset is a new decision, not a revision
        # (stamped after the reset: an older stamp would be dropped as stale).
        await bus.publish(
            "attributions.unknown", attribution.model_copy(update={"ts": datetime.now(UTC)})
        )
        await bus.drain()
        assert decisions[-1].id != first_decision_id
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        bus.close()


async def test_decide_drops_an_attribution_queued_before_the_reset() -> None:
    """An attribution stamped before POST /reset belongs to the previous take."""
    bus = InProcessBus()
    decide = DecideService(bus, StubLLMClient(KB(entries=[])), gate=policy_gate)
    decisions: list[Decision] = []

    async def sniff() -> None:
        async for _, event in bus.subscribe("decisions.*"):
            if isinstance(event, Decision):
                decisions.append(event)

    tasks = [asyncio.create_task(decide.run()), asyncio.create_task(sniff())]
    try:
        await _spin()
        rf = _anomaly("rf_anomaly", "sig-rf-2")
        await bus.publish("anomalies.rf_anomaly", rf)
        await bus.drain()
        stale = Attribution(
            id="attr-stale", anomaly_ids=[rf.id], actor="Unknown", confidence=0.4,
            kb_citations=["kb-attribution-uncertainty-001"], verdict="unknown", satellite_id=SAT,
            ts=datetime.now(UTC) - timedelta(seconds=1),
        )
        decide.reset()
        await bus.publish("attributions.unknown", stale)
        await bus.drain()
        assert decisions == []
        fresh = stale.model_copy(update={"id": "attr-fresh", "ts": datetime.now(UTC)})
        await bus.publish("attributions.unknown", fresh)
        await bus.drain()
        assert [d.attribution_id for d in decisions] == ["attr-fresh"]
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        bus.close()


async def test_ui_events_drops_a_decision_queued_before_the_reset() -> None:
    bus = InProcessBus()
    ui = UIEventService(bus)
    published: list[Any] = []

    async def sniff() -> None:
        async for _, event in bus.subscribe("ui_events.*"):
            published.append(event)

    tasks = [asyncio.create_task(ui.run()), asyncio.create_task(sniff())]
    try:
        await _spin()
        ui.reset()
        stale = Decision(
            id="dec-stale", attribution_id="attr-x", action="threat_warning", target="SIM-01",
            rationale="stale", authority="local", ts=datetime.now(UTC) - timedelta(seconds=1),
        )
        await bus.publish("decisions.threat_warning", stale)
        await bus.drain()
        assert published == []
        fresh = stale.model_copy(update={"id": "dec-fresh", "ts": datetime.now(UTC)})
        await bus.publish("decisions.threat_warning", fresh)
        await bus.drain()
        assert len(published) == 1
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        bus.close()


async def test_ui_events_reset_forgets_cached_attributions_and_decisions() -> None:
    bus = InProcessBus()
    ui = UIEventService(bus)
    task = asyncio.create_task(ui.run())
    try:
        await _spin()
        attribution = Attribution(
            id="attr-1", anomaly_ids=["a"], actor="Unknown", confidence=0.4,
            kb_citations=["kb-attribution-uncertainty-001"],
        )
        decision = Decision(
            id="dec-1", attribution_id="attr-1", action="threat_warning", target="t",
            rationale="r", authority="local",
        )
        await bus.publish("attributions.unknown", attribution)
        await bus.publish("decisions.local", decision)
        await bus.drain()
        assert "attr-1" in ui._cache and "dec-1" in ui._decisions
        assert ui.reset() == {"attributions": 1, "decisions": 1}
        assert not ui._cache and not ui._decisions
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        bus.close()


# ---- The gateway route ---------------------------------------------------------------------


@pytest.fixture(scope="module")
def client():
    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setenv("CANOPY_DISABLE_OSINT", "1")
    try:
        with TestClient(create_app(api_token=None)) as test_client:
            yield test_client
    finally:
        monkeypatch.undo()


def _wait_for_replay(client: TestClient, timeout_s: float = 60.0) -> None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        task = client.app.state.replay_task
        if task is None or task.done():
            return
        time.sleep(0.02)
    raise AssertionError("replay did not finish in time")


def _settle(client: TestClient) -> None:
    """Attribute whatever is buffered, close the fast-lane clusters, drain the bus."""
    engine = client.app.state.engine
    client.portal.call(engine.attrib.flush)
    client.portal.call(engine.bus.drain)


def test_reset_reports_what_it_cleared_and_empties_the_caches(client: TestClient) -> None:
    engine = client.app.state.engine
    assert client.post("/scenarios/beat47.jsonl/replay?speed=1000&max_delay_s=0.01").status_code == 200
    _wait_for_replay(client)
    _settle(client)
    assert engine.decide._anomaly_cache and engine.ui_events._decisions
    assert engine.fusion._state.seen_signals

    response = client.post("/reset")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "reset"
    assert body["replay_cancelled"] is False  # the replay had already finished
    assert set(body["cleared"]) == {"attrib", "fusion", "decide", "ui_events", "tracer", "attrib_late"}
    assert body["cleared"]["tracer"]["marks"] >= 1  # the replayed anomalies were marked
    assert client.app.state.engine.tracer.t0_for("anything") is None
    assert body["cleared"]["decide"]["anomaly_cache"] > 0
    assert body["cleared"]["fusion"]["seen_signals"] > 0
    assert body["cleared"]["ui_events"]["decisions"] > 0
    assert not engine.decide._anomaly_cache and not engine.decide._decision_ids
    assert not engine.ui_events._cache and not engine.ui_events._decisions
    assert len(engine.fusion._state.seen_signals) == 0
    assert engine.attrib.open_clusters == {} and not engine.attrib._buffer
    assert client.app.state.replay_task is None


def test_reset_cancels_an_in_flight_replay(client: TestClient) -> None:
    # A crawl: the first pause is capped at 100 s, so the replay is mid-flight.
    response = client.post("/scenarios/beat47.jsonl/replay?speed=0.001&max_delay_s=100")
    assert response.status_code == 200
    task = client.app.state.replay_task
    assert task is not None and not task.done()

    body = client.post("/reset").json()
    assert body["replay_cancelled"] is True
    assert task.cancelled() or task.done()
    assert client.app.state.replay_task is None
    # Idempotent: nothing to cancel, nothing to clear.
    again = client.post("/reset").json()
    assert again["replay_cancelled"] is False
    assert all(v == 0 for stage in again["cleared"].values() for v in stage.values())


def test_starting_a_replay_cancels_the_previous_one(client: TestClient) -> None:
    client.post("/scenarios/beat47.jsonl/replay?speed=0.001&max_delay_s=100")
    crawl = client.app.state.replay_task
    assert client.post("/scenarios/beat47.jsonl/replay?speed=1000&max_delay_s=0.01").status_code == 200
    assert crawl.cancelled() or crawl.done()
    _wait_for_replay(client)
    client.post("/reset")


# ---- Run B then Run A in one process gives Run A's expected verdict -------------------------


def _demo_case(name: str):
    from bench.specs import load_scenario_registry

    try:
        return load_scenario_registry().by_file(name)
    except KeyError:
        pytest.skip(f"{name} is not registered as a demo scenario (wave 4A)")


def _run_through_gateway(client: TestClient, name: str) -> tuple[list[Attribution], list[Decision]]:
    engine = client.app.state.engine
    attributions: list[Attribution] = []
    decisions: list[Decision] = []

    async def start() -> list[asyncio.Task]:
        async def collect(pattern: str, sink: list, kind: type) -> None:
            async for _, event in engine.bus.subscribe(pattern):
                if isinstance(event, kind):
                    sink.append(event)

        return [
            asyncio.create_task(collect("attributions.*", attributions, Attribution)),
            asyncio.create_task(collect("decisions.*", decisions, Decision)),
        ]

    async def stop(tasks: list[asyncio.Task]) -> None:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    collectors = client.portal.call(start)
    try:
        response = client.post(f"/scenarios/{name}/replay?speed=1000&max_delay_s=0.01")
        assert response.status_code == 200, response.text
        _wait_for_replay(client)
        _settle(client)
    finally:
        client.portal.call(stop, collectors)
    return attributions, decisions


def _episode(attributions: list[Attribution], decisions: list[Decision]) -> tuple[Attribution, Decision]:
    """The satellite cluster's final revision and the decision made for it (spec §5.0)."""
    keyed = [a for a in attributions if a.satellite_id]
    assert keyed, "no satellite-keyed attribution was published"
    final = max(keyed, key=lambda a: (a.revision, a.ts))
    made = [d for d in decisions if d.attribution_id == final.id]
    assert made, f"no decision for attribution {final.id}"
    return final, max(made, key=lambda d: (d.revision, d.ts))


def test_run_b_then_run_a_in_one_process_gives_run_a_its_own_verdict(client: TestClient) -> None:
    pytest.importorskip("megalith")
    run_b = _demo_case("megalith_link_margin_b.jsonl")
    run_a = _demo_case("megalith_link_margin_a.jsonl")
    expected_b = run_b.model_dump()["expected"]["verdict"]
    expected_a = run_a.model_dump()["expected"]["verdict"]
    assert expected_b == "hostile_external" and expected_a == "internal_fault"

    assert client.post("/reset").status_code == 200
    attributions, decisions = _run_through_gateway(client, run_b.file)
    final_b, decision_b = _episode(attributions, decisions)
    assert final_b.verdict == expected_b
    assert decision_b.action != "recovery_recommendation"
    # F8: the recommended radio recovery is reported as withheld because of the jamming.
    assert decision_b.withheld_recovery is not None
    assert decision_b.withheld_recovery.reason_code == "threat/uplink_jamming_active"
    satellite = final_b.satellite_id

    assert client.post("/reset").status_code == 200
    engine = client.app.state.engine
    assert not engine.decide._anomaly_cache and not engine.attrib.recent_context(satellite)

    attributions, decisions = _run_through_gateway(client, run_a.file)
    final_a, decision_a = _episode(attributions, decisions)
    assert final_a.satellite_id == satellite
    assert final_a.verdict == expected_a, (
        f"Run A after Run B came out {final_a.verdict!r}; B's context leaked across the reset"
    )
    assert final_a.id != final_b.id
    assert decision_a.action == "recovery_recommendation"
    assert decision_a.recovery is not None
    assert decision_a.withheld_recovery is None
    assert decision_a.id != decision_b.id
    client.post("/reset")
