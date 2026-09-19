"""Tests for the reasoning trace fanout (Phase 1) and per-stage timing (wave 3A)."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from canopy.services.bus import InProcessBus
from canopy.services.fusion import FusionService
from canopy.services.schemas.events import (
    Location,
    Provenance,
    ReasoningTrace,
    Signal,
)
from canopy.services.traces import Tracer


def _signal() -> Signal:
    return Signal(
        domain="rf_ew",
        source="test",
        realism="mock_operational",
        confidence=0.9,
        location=Location(label="test"),
        payload={"event_type": "rf_interference", "summary": "test"},
        provenance=Provenance(source_id="t"),
    )


@pytest.mark.asyncio
async def test_tracer_publishes_to_traces_topic():
    bus = InProcessBus()
    tracer = Tracer(bus)

    received: list[tuple[str, ReasoningTrace]] = []

    async def consume() -> None:
        async for topic, event in bus.subscribe("traces.*"):
            assert isinstance(event, ReasoningTrace)
            received.append((topic, event))
            if len(received) >= 2:
                break

    consumer = asyncio.create_task(consume())
    await asyncio.sleep(0)

    await tracer.emit("fusion", "info", "first line", ref_id="anom-1")
    await tracer.emit("decide", "decision", "approved", ref_id="dec-1", actor="test")

    await asyncio.wait_for(consumer, timeout=1.0)

    assert received[0][0] == "traces.fusion"
    assert received[0][1].stage == "fusion"
    assert received[0][1].message == "first line"
    assert received[0][1].ref_id == "anom-1"

    assert received[1][0] == "traces.decide"
    assert received[1][1].level == "decision"
    assert received[1][1].payload == {"actor": "test"}


@pytest.mark.asyncio
async def test_fusion_emits_trace_per_anomaly():
    bus = InProcessBus()
    tracer = Tracer(bus)
    fusion = FusionService(bus, tracer=tracer)

    traces: list[ReasoningTrace] = []

    async def consume_traces() -> None:
        async for _, event in bus.subscribe("traces.fusion"):
            assert isinstance(event, ReasoningTrace)
            traces.append(event)
            if traces:
                break

    consumer = asyncio.create_task(consume_traces())
    runner = asyncio.create_task(fusion.run())
    await asyncio.sleep(0)

    await bus.publish("signals.rf_ew", _signal())

    await asyncio.wait_for(consumer, timeout=1.0)

    runner.cancel()
    try:
        await runner
    except asyncio.CancelledError:
        pass

    assert len(traces) >= 1
    trace = traces[0]
    assert trace.stage == "fusion"
    assert "anomaly" in trace.message
    assert trace.ref_id is not None


# ---- Per-stage timing (wave 3A) ------------------------------------------------


class _Clock:
    def __init__(self, start: float = 100.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now


async def _capture(bus: InProcessBus, count: int) -> list[ReasoningTrace]:
    received: list[ReasoningTrace] = []

    async def consume() -> None:
        async for _, event in bus.subscribe("traces.*"):
            received.append(event)
            if len(received) >= count:
                break

    task = asyncio.create_task(consume())
    await asyncio.sleep(0)
    return received, task  # type: ignore[return-value]


@pytest.mark.asyncio
async def test_emit_stamps_latency_and_stage_ms_from_t0_and_stage_t0():
    bus = InProcessBus()
    clock = _Clock(100.0)
    tracer = Tracer(bus, clock=clock)
    received, consumer = await _capture(bus, 3)

    clock.now = 101.5
    await tracer.emit("attrib_primary", "info", "timed", ref_id="a", t0=100.0, stage_t0=101.25, actor="x")
    await tracer.emit("decide", "decision", "latency only", t0=100.0)
    await tracer.emit("fusion", "info", "untimed", kind="rf_anomaly")
    await asyncio.wait_for(consumer, timeout=1.0)

    assert received[0].payload == {
        "actor": "x",
        "latency_ms": 1500.0,
        "stage_ms": 250.0,
    }
    assert received[1].payload == {"latency_ms": 1500.0}
    # No t0: the payload is exactly what the caller passed, as before.
    assert received[2].payload == {"kind": "rf_anomaly"}


@pytest.mark.asyncio
async def test_emit_never_reports_negative_durations_and_accepts_datetimes():
    bus = InProcessBus()
    clock = _Clock(50.0)
    tracer = Tracer(bus, clock=clock)
    received, consumer = await _capture(bus, 2)

    await tracer.emit("decide", "info", "future t0", t0=60.0, stage_t0=55.0)
    earlier = datetime.now(UTC) - timedelta(milliseconds=200)
    await tracer.emit("decide", "info", "datetime t0", t0=earlier)
    await asyncio.wait_for(consumer, timeout=1.0)

    assert received[0].payload == {"latency_ms": 0.0, "stage_ms": 0.0}
    assert received[1].payload["latency_ms"] >= 200.0


def test_mark_is_first_wins_and_t0_for_takes_the_earliest():
    clock = _Clock(10.0)
    tracer = Tracer(InProcessBus(), clock=clock)

    assert tracer.mark("anom-1") == 10.0
    clock.now = 12.0
    assert tracer.mark("anom-1") == 10.0  # a later stage cannot move the origin
    assert tracer.mark("anom-2") == 12.0
    assert tracer.mark("attr-1", 11.0) == 11.0

    assert tracer.t0_for("anom-2", "attr-1") == 11.0
    assert tracer.t0_for("anom-1", "missing", None) == 10.0
    assert tracer.t0_for("missing") is None
    assert tracer.t0_for() is None


def test_marks_are_bounded_oldest_first():
    tracer = Tracer(InProcessBus(), clock=_Clock(), marks_size=3)
    for key in ("a", "b", "c", "d"):
        tracer.mark(key)
    assert tracer.t0_for("a") is None
    assert tracer.t0_for("d") is not None



def test_clear_marks_forgets_first_wins_arrivals() -> None:
    """A retake of the same scenario re-uses anomaly ids; reset must drop the marks."""
    tracer = Tracer(InProcessBus())
    first = tracer.mark("anom-1", 100.0)
    assert tracer.mark("anom-1", 200.0) == first  # first wins
    assert tracer.t0_for("anom-1") == 100.0
    assert tracer.clear_marks() == {"marks": 1}
    assert tracer.t0_for("anom-1") is None
    assert tracer.mark("anom-1", 300.0) == 300.0
    assert tracer.clear_marks() == {"marks": 1}
