"""Engine-owned ephemeris (spec §10, 1.4.4): the engine's circular model
reproduces every point of every synthetic track file, and the service
publishes one sample per body per tick while a run is in progress."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from canopy.services.bus import InProcessBus, codec
from canopy.services.ephemeris import Body, CircularOrbit, EphemerisService, load_bodies
from canopy.services.schemas.events import Ephemeris

ROOT = Path(__file__).resolve().parent.parent
ORBITAL = ROOT / "public" / "orbital"


def _synthetic_files() -> list[Path]:
    files = []
    for path in sorted(ORBITAL.glob("*_positions.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload.get("synthetic"), dict):
            files.append(path)
    return files


def test_loads_every_synthetic_body_and_no_real_cache() -> None:
    bodies = load_bodies(ORBITAL)
    names = sorted(body.name for body in bodies)
    assert names == ["OBJ-1", "SIM-01", "SIM-02"], names
    assert all(body.satellite_id.startswith("ctb://megalith.demo/") for body in bodies)
    assert {body.topic for body in bodies} == {"ephemeris.sim-01", "ephemeris.sim-02", "ephemeris.obj-01"}


@pytest.mark.parametrize("path", _synthetic_files(), ids=lambda p: p.stem)
def test_engine_model_reproduces_the_track_file(path: Path) -> None:
    payload = json.loads(path.read_text(encoding="utf-8"))
    orbit = CircularOrbit.from_synthetic_block(payload["synthetic"])
    assert orbit is not None
    assert orbit.period_s == pytest.approx(payload["synthetic"]["orbit"]["period_s"], abs=0.1)
    for point in payload["track"]:
        when = datetime.fromtimestamp(point["timestamp"], tz=UTC)
        lat, lng, alt = orbit.subpoint(when)
        assert abs(lat - point["lat"]) < 1e-6 and abs(lng - point["lng"]) < 1e-6, (path.name, point["timestamp_utc"])
        assert alt == pytest.approx(point["alt_km"], abs=0.01)
    # The orbit ring: one period from the track's first point in equal steps
    # (the generator's ORBIT_POINTS), timestamps written to the second, so the
    # sample times are rebuilt from the epoch and the step.
    ring = payload["orbit"]
    epoch = datetime.fromisoformat(ring[0]["timestamp_utc"].replace("Z", "+00:00"))
    step = orbit.period_s / (len(ring) - 1)
    for index, point in enumerate(ring):
        lat, lng, _ = orbit.subpoint(epoch + timedelta(seconds=index * step))
        assert abs(lat - point["lat"]) < 1e-6 and abs(lng - point["lng"]) < 1e-6, (path.name, index)


def test_sample_is_a_registered_event_with_the_scenario_time_and_the_elements() -> None:
    body = load_bodies(ORBITAL)[0]
    when = body.orbit.pass_time
    sample = body.sample(when)
    assert isinstance(sample, Ephemeris)
    assert sample.ts == when and sample.satellite_id == body.satellite_id
    assert sample.lat == pytest.approx(body.orbit.pass_lat, abs=1e-9)
    assert sample.lng == pytest.approx(body.orbit.pass_lng, abs=1e-6)
    assert sample.alt_km == body.orbit.altitude_km
    assert 7.0 < sample.speed_km_s < 8.0
    assert sample.elements["pass_utc"].endswith("Z") and sample.elements["period_s"] > 5000
    envelope = codec.envelope(body.topic, sample)
    assert envelope["kind"] == "ephemeris" and envelope["topic"] == body.topic
    assert envelope["data"]["source"] == "circular-model"
    assert codec.class_for("ephemeris") is Ephemeris


async def test_service_publishes_per_body_only_while_a_run_is_in_progress() -> None:
    bus = InProcessBus()
    received: list[tuple[str, Ephemeris]] = []

    async def sniff() -> None:
        async for topic, event in bus.subscribe("ephemeris.*"):
            received.append((topic, event))

    sniffer = asyncio.create_task(sniff())
    await asyncio.sleep(0.02)
    clock: list[datetime | None] = [None]
    bodies = load_bodies(ORBITAL)
    service = EphemerisService(bus, bodies, scenario_time=lambda: clock[0], cadence_s=0.02)
    try:
        assert await service.publish_once() == 0  # no run: nothing
        clock[0] = datetime(2026, 9, 20, 15, 8, 0, tzinfo=UTC)
        assert await service.publish_once() == len(bodies)
        await asyncio.sleep(0.05)
        assert len(received) == len(bodies)
        assert {topic for topic, _ in received} == {body.topic for body in bodies}
        assert all(event.ts == clock[0] for _, event in received)
        runner = asyncio.create_task(service.run())
        await asyncio.sleep(0.11)
        runner.cancel()
        await asyncio.gather(runner, return_exceptions=True)
        assert len(received) >= 3 * len(bodies), len(received)
    finally:
        sniffer.cancel()
        await asyncio.gather(sniffer, return_exceptions=True)
        bus.close()


def test_body_topic_uses_the_spacecraft_slug() -> None:
    orbit = CircularOrbit(550.0, 97.6, datetime(2026, 9, 20, 15, 8, tzinfo=UTC), -27.5, 128.5)
    assert Body("ctb://megalith.demo/sim-01", "SIM-01", orbit).topic == "ephemeris.sim-01"
    assert CircularOrbit.from_synthetic_block({"orbit": {"altitude_km": 550}}) is None
