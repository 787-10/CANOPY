from __future__ import annotations

import asyncio

import pytest

from canopy.services.bus import InProcessBus
from canopy.services.schemas.events import Location, Provenance, Signal


def _signal(domain: str = "cyber", confidence: float = 0.5) -> Signal:
    return Signal(
        domain=domain,
        source="t",
        realism="mock_operational",
        confidence=confidence,
        location=Location(label="t"),
        payload={"event_type": "test", "summary": "test"},
        provenance=Provenance(source_id="t"),
    )


async def _drain(bus: InProcessBus, pattern: str, n: int, timeout: float = 1.0) -> list:
    received: list = []
    sub = bus.subscribe(pattern)

    async def _run() -> None:
        async for topic, event in sub:
            received.append((topic, event))
            if len(received) >= n:
                return

    try:
        await asyncio.wait_for(_run(), timeout=timeout)
    except TimeoutError:
        pass
    return received


async def test_publish_subscribe_basic() -> None:
    bus = InProcessBus()
    sig = _signal()

    async def consumer() -> tuple[str, Signal]:
        async for topic, event in bus.subscribe("signals.*"):
            return topic, event  # type: ignore[return-value]
        raise AssertionError("consumer exited without receiving")

    consumer_task = asyncio.create_task(consumer())
    await asyncio.sleep(0.05)
    await bus.publish("signals.cyber", sig)
    topic, event = await asyncio.wait_for(consumer_task, timeout=1.0)
    assert topic == "signals.cyber"
    assert event == sig


async def test_glob_pattern_matches() -> None:
    bus = InProcessBus()

    sig_cyber = _signal("cyber")
    sig_rf = _signal("rf_ew")

    async def collect() -> None:
        await asyncio.sleep(0.05)
        await bus.publish("signals.cyber", sig_cyber)
        await bus.publish("signals.rf_ew", sig_rf)
        await bus.publish("anomalies.gps_spoof", _signal())

    asyncio.create_task(collect())
    received = await _drain(bus, "signals.*", n=2, timeout=1.0)
    topics = [t for t, _ in received]
    assert sorted(topics) == ["signals.cyber", "signals.rf_ew"]


async def test_multiple_subscribers_all_receive() -> None:
    bus = InProcessBus()
    received_a: list = []
    received_b: list = []

    async def sub_a() -> None:
        async for topic, event in bus.subscribe("signals.*"):
            received_a.append((topic, event))

    async def sub_b() -> None:
        async for topic, event in bus.subscribe("signals.cyber"):
            received_b.append((topic, event))

    task_a = asyncio.create_task(sub_a())
    task_b = asyncio.create_task(sub_b())
    await asyncio.sleep(0.05)

    await bus.publish("signals.cyber", _signal("cyber"))
    await bus.publish("signals.rf_ew", _signal("rf_ew"))
    await asyncio.sleep(0.05)

    task_a.cancel()
    task_b.cancel()
    await asyncio.gather(task_a, task_b, return_exceptions=True)

    assert len(received_a) == 2
    assert len(received_b) == 1
    assert received_b[0][0] == "signals.cyber"


async def test_overflow_drops_without_blocking_publisher() -> None:
    # Tiny queue size so we can force overflow deterministically. The publisher
    # must not block when subscribers are full.
    bus = InProcessBus(queue_maxsize=2)

    sub = bus.subscribe("signals.*")  # registers but never reads
    await asyncio.sleep(0)

    for _ in range(5):
        await bus.publish("signals.cyber", _signal())

    # Consume what made it through; we should get at most queue_maxsize entries
    # without the publisher blocking above.
    received: list = []

    async def reader() -> None:
        async for item in sub:
            received.append(item)
            if len(received) >= 2:
                return

    try:
        await asyncio.wait_for(reader(), timeout=0.5)
    except TimeoutError:
        pass

    assert len(received) == 2


async def test_subscription_cleans_up_on_cancel() -> None:
    bus = InProcessBus()

    async def consumer() -> None:
        async for _ in bus.subscribe("signals.*"):
            pass

    task = asyncio.create_task(consumer())
    await asyncio.sleep(0.05)
    assert len(bus._subs) == 1  # type: ignore[attr-defined]

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.sleep(0)
    assert len(bus._subs) == 0  # type: ignore[attr-defined]


async def test_drain_waits_for_cascaded_publications() -> None:
    bus = InProcessBus()
    received: list[Signal] = []

    async def relay() -> None:
        async for _, event in bus.subscribe("signals.input"):
            await asyncio.sleep(0.01)
            await bus.publish("signals.output", event)

    async def collect() -> None:
        async for _, event in bus.subscribe("signals.output"):
            received.append(event)  # type: ignore[arg-type]

    relay_task = asyncio.create_task(relay())
    collect_task = asyncio.create_task(collect())
    await asyncio.sleep(0)

    signal = _signal()
    await bus.publish("signals.input", signal)
    await bus.drain()

    assert received == [signal]

    relay_task.cancel()
    collect_task.cancel()
    await asyncio.gather(relay_task, collect_task, return_exceptions=True)
