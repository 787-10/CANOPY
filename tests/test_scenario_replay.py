from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from canopy.services.bus import InProcessBus
from canopy.services.scenario_replay import ScenarioReplayService, load_scenario_signals
from canopy.services.schemas.events import Signal

ROOT = Path(__file__).resolve().parent.parent
SCENARIOS = sorted((ROOT / "scenarios").glob("*.jsonl"))


def test_all_scenarios_load_as_canonical_signals() -> None:
    assert SCENARIOS, "expected checked-in scenario files"
    for path in SCENARIOS:
        signals = load_scenario_signals(path)
        assert signals, f"empty scenario: {path}"
        assert all(isinstance(s, Signal) for s in signals)


async def test_replay_publishes_signals_in_order() -> None:
    bus = InProcessBus()
    received: list = []
    done = asyncio.Event()

    async def sniff() -> None:
        async for topic, event in bus.subscribe("signals.*"):
            received.append((topic, event))

    sniff_task = asyncio.create_task(sniff())
    await asyncio.sleep(0.02)

    stop_event = asyncio.Event()
    replay = ScenarioReplayService(
        bus,
        ROOT / "scenarios" / "beat2.jsonl",
        speed=1000.0,
        max_delay_s=0.0,
        stop_when_done=stop_event,
    )
    replay_task = asyncio.create_task(replay.run())

    try:
        await asyncio.wait_for(stop_event.wait(), timeout=2.0)
        # Let the sniff task drain any items already queued before publish raced
        # past it.
        await asyncio.sleep(0.1)
    finally:
        sniff_task.cancel()
        replay_task.cancel()
        await asyncio.gather(sniff_task, replay_task, return_exceptions=True)
        bus.close()

    assert len(received) == len(load_scenario_signals(ROOT / "scenarios" / "beat2.jsonl"))
    # Topics derive from the signal's domain.
    domains = {evt.domain for _, evt in received}
    assert domains, "no signals captured"


async def test_replay_rejects_zero_speed() -> None:
    bus = InProcessBus()
    with pytest.raises(ValueError):
        ScenarioReplayService(bus, ROOT / "scenarios" / "beat1.jsonl", speed=0.0)


async def test_replay_paces_by_deadline_so_publish_time_does_not_accumulate(tmp_path: Path) -> None:
    """Flight plan §8: with records 1 s apart at 25x (40 ms gaps) and a bus that
    takes 30 ms per publish, a per-gap sleep would take about 70 ms per record;
    deadline pacing lands each record at start + k * 40 ms regardless."""
    import json
    import time
    from datetime import timedelta

    base = load_scenario_signals(ROOT / "scenarios" / "beat1.jsonl")[0]
    records = []
    for k in range(6):
        record = json.loads(base.model_dump_json())
        record["id"] = f"pace-{k}"
        record["ts"] = (base.ts + timedelta(seconds=k)).isoformat().replace("+00:00", "Z")
        records.append(json.dumps(record))
    path = tmp_path / "paced.jsonl"
    path.write_text("\n".join(records) + "\n")

    class SlowBus(InProcessBus):
        def __init__(self) -> None:
            super().__init__()
            self.stamps: list[float] = []

        async def publish(self, topic: str, event) -> None:  # type: ignore[override]
            self.stamps.append(time.monotonic())
            await asyncio.sleep(0.03)
            await super().publish(topic, event)

    bus = SlowBus()
    stop_event = asyncio.Event()
    replay = ScenarioReplayService(bus, path, speed=25.0, stop_when_done=stop_event)
    try:
        await asyncio.wait_for(replay.run(), timeout=5.0)
    finally:
        bus.close()
    assert stop_event.is_set()
    assert len(bus.stamps) == 6
    offsets = [stamp - bus.stamps[0] for stamp in bus.stamps]
    # Each record within a scheduler tick of its deadline; the last lands near
    # 200 ms, not near 350 ms (5 gaps of 40 ms plus 5 publishes of 30 ms).
    for k, offset in enumerate(offsets):
        assert abs(offset - 0.04 * k) < 0.02, (k, offsets)
