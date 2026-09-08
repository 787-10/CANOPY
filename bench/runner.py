"""Isolated, scenario-level execution for the CANOPY benchmark."""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from pathlib import Path

from canopy._engine import build_engine, start_engine_tasks
from canopy.services.scenario_replay import ScenarioReplayService
from canopy.services.schemas.events import (
    Anomaly,
    Attribution,
    Decision,
    Signal,
    UIEvent,
)

BENCHMARK_ATTRIBUTION_WINDOW_S = 3600.0
DEFAULT_TRIAL_TIMEOUT_S = 600.0


@dataclass
class TrialArtifact:
    """All observable outputs from one isolated scenario episode."""

    scenario: Path
    elapsed_seconds: float = 0.0
    signals: list[Signal] = field(default_factory=list)
    anomalies: list[Anomaly] = field(default_factory=list)
    attributions: list[Attribution] = field(default_factory=list)
    decisions: list[Decision] = field(default_factory=list)
    ui_events: list[UIEvent] = field(default_factory=list)

    @property
    def anomaly_source_signal_ids(self) -> list[str]:
        return list(
            dict.fromkeys(
                signal_id
                for anomaly in self.anomalies
                for signal_id in anomaly.source_signal_ids
            )
        )

    def captured(self) -> dict[str, list]:
        return {
            "signal": self.signals,
            "anomaly": self.anomalies,
            "attribution": self.attributions,
            "decision": self.decisions,
            "ui_event": self.ui_events,
        }


async def run_trial(
    scenario: str | Path,
    *,
    provider: str,
    multi_agent: bool = True,
    timeout_s: float = DEFAULT_TRIAL_TIMEOUT_S,
) -> TrialArtifact:
    """Replay and fully drain one scenario through a fresh production engine."""
    path = Path(scenario)
    artifact = TrialArtifact(scenario=path)
    engine = build_engine(
        provider=provider,
        attrib_window_s=BENCHMARK_ATTRIBUTION_WINDOW_S,
        multi_agent=multi_agent,
        enable_osint=False,
    )
    service_tasks = start_engine_tasks(engine)

    async def consume(pattern: str, target: list, expected_type: type) -> None:
        async for _, event in engine.bus.subscribe(pattern):
            if isinstance(event, expected_type):
                target.append(event)

    capture_tasks = [
        asyncio.create_task(consume("signals.*", artifact.signals, Signal)),
        asyncio.create_task(consume("anomalies.*", artifact.anomalies, Anomaly)),
        asyncio.create_task(
            consume("attributions.*", artifact.attributions, Attribution)
        ),
        asyncio.create_task(consume("decisions.*", artifact.decisions, Decision)),
        asyncio.create_task(consume("ui_events.*", artifact.ui_events, UIEvent)),
    ]

    async def execute() -> None:
        # Allow top-level and nested TaskGroup consumers to subscribe before
        # the first non-buffered publication.
        for _ in range(3):
            await asyncio.sleep(0)
        replay = ScenarioReplayService(
            engine.bus,
            path,
            speed=10000.0,
            max_delay_s=0.0,
        )
        await replay.run()
        await engine.bus.drain()
        await engine.attrib.flush()
        await engine.bus.drain()

    started = time.perf_counter()
    try:
        await asyncio.wait_for(execute(), timeout=timeout_s)
    finally:
        artifact.elapsed_seconds = time.perf_counter() - started
        for task in (*capture_tasks, *service_tasks):
            task.cancel()
        await asyncio.gather(
            *capture_tasks, *service_tasks, return_exceptions=True
        )
        engine.bus.close()

    return artifact
