from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable, Iterable, Iterator
from pathlib import Path

from canopy.services.bus import Bus
from canopy.services.schemas.events import Signal

log = logging.getLogger(__name__)

__all__ = ["ScenarioReplayService", "load_scenario_signals"]


def _read_jsonl(path: Path) -> Iterator[dict]:
    with path.open("r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                record = json.loads(stripped)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_no}: invalid JSON: {exc}") from exc
            if not isinstance(record, dict):
                raise ValueError(f"{path}:{line_no}: record must be a JSON object")
            yield record


def load_scenario_signals(path: str | Path) -> list[Signal]:
    """Load a scenario JSONL into validated Signal objects, in file order."""
    return [Signal.model_validate(rec) for rec in _read_jsonl(Path(path))]


class ScenarioReplayService:
    """Reads a scenario JSONL and publishes canonical Signals on the bus.

    Honors scenario timestamps so the replay paces in real time, scaled by
    ``speed`` (e.g., 20.0 = 20x). ``max_delay_s`` caps any single inter-event
    sleep, useful when tests want to drain a scenario without waiting for
    long lulls. ``stop_when_done`` is provided so an orchestrator can wait
    for the replay to finish; the service signals completion by setting it.
    """

    def __init__(
        self,
        bus: Bus,
        scenarios: str | Path | Iterable[str | Path],
        *,
        speed: float = 1.0,
        max_delay_s: float | None = None,
        stop_when_done: asyncio.Event | None = None,
        signal_filter: Callable[[Signal], bool] | None = None,
    ) -> None:
        if isinstance(scenarios, (str, Path)):
            self._paths = [Path(scenarios)]
        else:
            self._paths = [Path(p) for p in scenarios]
        if speed <= 0:
            raise ValueError("speed must be positive")
        self._bus = bus
        self._speed = speed
        self._max_delay_s = max_delay_s
        self._stop_when_done = stop_when_done
        self._signal_filter = signal_filter

    async def run(self) -> None:
        try:
            for path in self._paths:
                await self._replay_one(path)
        finally:
            if self._stop_when_done is not None:
                self._stop_when_done.set()

    async def _replay_one(self, path: Path) -> None:
        log.info("scenario replay: starting %s (speed=%sx)", path, self._speed)
        previous_ts = None
        published = 0
        for signal in load_scenario_signals(path):
            if self._signal_filter is not None and not self._signal_filter(signal):
                continue
            if previous_ts is not None:
                delay = (signal.ts - previous_ts).total_seconds() / self._speed
                if self._max_delay_s is not None:
                    delay = min(delay, self._max_delay_s)
                if delay > 0:
                    await asyncio.sleep(delay)
            await self._bus.publish(f"signals.{signal.domain}", signal)
            previous_ts = signal.ts
            published += 1
        log.info("scenario replay: published %d signals from %s", published, path)
