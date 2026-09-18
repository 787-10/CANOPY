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


# ---- Bus protocol: drain() and close() (docs/INTERFACE-SPEC.md §10) --------


def test_inprocess_bus_satisfies_the_protocol() -> None:
    from canopy.services.bus import Bus

    bus = InProcessBus()
    for member in ("publish", "subscribe", "drain", "close"):
        assert callable(getattr(Bus, member))
        assert callable(getattr(bus, member))


async def test_close_is_awaitable_and_still_closes_synchronously() -> None:
    bus = InProcessBus()
    bus.subscribe("signals.*")
    assert len(bus._subs) == 1  # type: ignore[attr-defined]

    result = bus.close()  # legacy un-awaited form still closes at once
    assert len(bus._subs) == 0  # type: ignore[attr-defined]
    await result  # protocol form

    bus.subscribe("signals.*")
    await bus.close()  # and awaiting directly works too
    assert len(bus._subs) == 0  # type: ignore[attr-defined]


async def test_drain_on_idle_bus_returns() -> None:
    bus = InProcessBus()
    await asyncio.wait_for(bus.drain(), timeout=1.0)


# ---- Engine wiring: Engine.bus is any Bus ---------------------------------


def test_engine_bus_is_typed_as_the_protocol() -> None:
    from canopy._engine import Engine
    from canopy.services.bus import Bus

    assert Engine.__dataclass_fields__["bus"].type in (Bus, "Bus")


async def test_build_engine_accepts_an_injected_bus() -> None:
    from canopy._engine import build_engine

    bus = InProcessBus()
    engine = build_engine(bus=bus, enable_osint=False)
    assert engine.bus is bus
    await engine.bus.close()


def test_build_bus_memory_default_and_backend_resolution(monkeypatch) -> None:
    from canopy._engine import build_bus, resolve_bus_backend

    assert isinstance(build_bus(), InProcessBus)
    assert isinstance(build_bus("memory"), InProcessBus)

    monkeypatch.delenv("CANOPY_BUS", raising=False)
    assert resolve_bus_backend(bus_flag=None) == "memory"
    assert resolve_bus_backend(bus_flag="nats") == "nats"
    monkeypatch.setenv("CANOPY_BUS", "NATS")
    assert resolve_bus_backend(bus_flag=None) == "nats"
    with pytest.raises(ValueError):
        resolve_bus_backend(bus_flag="kafka")
    with pytest.raises(ValueError):
        build_bus("kafka")  # type: ignore[arg-type]


def test_build_engine_nats_backend_is_lazy_and_forwards_the_url(monkeypatch) -> None:
    """The nats branch imports ``megalith.bus`` only when selected.

    CANOPY's own environment has neither nats-py nor megalith, so a fake
    module stands in; what matters is that the constructor receives the URL
    and the stream and that nothing is imported on the memory path.
    """
    import sys
    import types

    from canopy._engine import build_engine

    calls: list[tuple] = []

    class FakeNatsBus(InProcessBus):
        def __init__(self, url, *, stream, consumer_prefix=None):
            super().__init__()
            calls.append((url, stream, consumer_prefix))

    fake_pkg = types.ModuleType("megalith")
    fake_bus = types.ModuleType("megalith.bus")
    fake_bus.NatsBus = FakeNatsBus  # type: ignore[attr-defined]
    fake_pkg.bus = fake_bus  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "megalith", fake_pkg)
    monkeypatch.setitem(sys.modules, "megalith.bus", fake_bus)
    monkeypatch.delenv("CANOPY_NATS_URL", raising=False)

    engine = build_engine(
        bus_backend="nats",
        nats_url="nats://broker:4222",
        nats_stream="canopy",
        consumer_prefix="engine",
        enable_osint=False,
    )
    assert isinstance(engine.bus, FakeNatsBus)
    assert calls == [("nats://broker:4222", "canopy", "engine")]

    monkeypatch.setenv("CANOPY_NATS_URL", "nats://from-env:4222")
    build_engine(bus_backend="nats", enable_osint=False)
    assert calls[-1][0] == "nats://from-env:4222"

    calls.clear()
    build_engine(enable_osint=False)  # default stays memory
    assert calls == []
