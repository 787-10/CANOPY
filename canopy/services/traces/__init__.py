"""Reasoning trace fanout.

Every visible step in the Sense → Attribute → Decide pipeline emits a
:class:`ReasoningTrace` to the bus on topic ``traces.{stage}``. The frontend
subscribes via the gateway's WebSocket fanout and renders the stream in a
terminal-styled panel; the resulting log is the auditable explanation of
why the engine arrived at its assessment.

The :class:`Tracer` is a thin façade so services do not have to know the
topic naming convention or how to build the event. One Tracer is shared
across all services, wired in :func:`canopy._engine.build_engine`.

Per-stage timing (MEGALITH wave 3A). A trace can be stamped with two
wall-clock durations in its payload, without changing the trace schema:

* ``latency_ms``: milliseconds since ``t0``, the moment the work that led to
  this trace entered the pipeline (the batch's first anomaly arrival at the
  attribution stage, or the signal's arrival in fusion when fusion recorded
  it).
* ``stage_ms``: milliseconds since ``stage_t0``, when the stage that emits
  the trace started its own work.

Both are optional: a trace emitted without them carries neither key. The
timestamps are :func:`time.monotonic` seconds. Because the shared Tracer is
the one object every stage can reach, it also keeps a small first-wins
registry of arrival times keyed by event id (:meth:`mark`, :meth:`t0_for`):
fusion or attrib marks an anomaly when it arrives, attrib marks the
attribution it publishes with the batch's earliest arrival, decide marks its
decision the same way, and any later stage looks the origin up by id.
"""
from __future__ import annotations

import logging
import time
from collections import OrderedDict
from collections.abc import Callable
from datetime import datetime
from typing import Any

from canopy.services.bus import Bus
from canopy.services.schemas.events import ReasoningTrace, TraceLevel, TraceStage

log = logging.getLogger(__name__)

__all__ = ["Tracer", "MARKS_SIZE"]

# How many arrival marks the tracer remembers (event ids, first-wins). Enough
# for every signal, anomaly, attribution and decision of a demo run.
MARKS_SIZE = 4096


def _ms(seconds: float) -> float:
    return round(max(0.0, seconds) * 1000.0, 1)


class Tracer:
    """Façade that publishes ReasoningTrace events on ``traces.{stage}``."""

    def __init__(
        self,
        bus: Bus,
        *,
        clock: Callable[[], float] = time.monotonic,
        marks_size: int = MARKS_SIZE,
    ) -> None:
        self._bus = bus
        self._clock = clock
        self._marks: OrderedDict[str, float] = OrderedDict()
        self._marks_size = marks_size

    # ---- Timing --------------------------------------------------------------

    def now(self) -> float:
        """The tracer's clock (monotonic seconds); use it for ``t0`` values."""
        return self._clock()

    def mark(self, key: str, t0: float | None = None) -> float:
        """Record when the event ``key`` first entered the pipeline.

        First mark wins: a stage that sees an event later than another stage
        did cannot move its origin forward. Returns the recorded time, so a
        caller can chain it (``t0 = tracer.mark(anomaly.id)``).
        """
        existing = self._marks.get(key)
        if existing is not None:
            return existing
        value = self._clock() if t0 is None else float(t0)
        self._marks[key] = value
        while len(self._marks) > self._marks_size:
            self._marks.popitem(last=False)
        return value

    def t0_for(self, *keys: str | None) -> float | None:
        """The earliest recorded arrival among ``keys``, or ``None``."""
        found = [self._marks[k] for k in keys if k is not None and k in self._marks]
        return min(found) if found else None

    def _elapsed_ms(self, since: float | datetime) -> float:
        if isinstance(since, datetime):
            reference = datetime.now(since.tzinfo) if since.tzinfo else datetime.now()
            return _ms((reference - since).total_seconds())
        return _ms(self._clock() - float(since))

    # ---- Emit ----------------------------------------------------------------

    async def emit(
        self,
        stage: TraceStage,
        level: TraceLevel,
        message: str,
        ref_id: str | None = None,
        *,
        t0: float | datetime | None = None,
        stage_t0: float | datetime | None = None,
        **payload: Any,
    ) -> None:
        """Publish one trace line.

        ``t0`` stamps ``payload["latency_ms"]`` (wall-clock ms since the
        pipeline first saw the work) and ``stage_t0`` stamps
        ``payload["stage_ms"]`` (ms since the emitting stage started). Both
        are monotonic seconds from :meth:`now`; an aware ``datetime`` is
        accepted too. A trace emitted without them carries neither key.
        """
        data = dict(payload)
        if t0 is not None:
            data["latency_ms"] = self._elapsed_ms(t0)
        if stage_t0 is not None:
            data["stage_ms"] = self._elapsed_ms(stage_t0)
        trace = ReasoningTrace(
            stage=stage,
            level=level,
            message=message,
            ref_id=ref_id,
            payload=data,
        )
        await self._bus.publish(f"traces.{stage}", trace)
        log.debug(
            "trace stage=%s level=%s ref=%s msg=%s",
            stage,
            level,
            ref_id,
            message,
        )
