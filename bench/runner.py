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
    ReasoningTrace,
    Signal,
    UIEvent,
)
from bench.specs import ScenarioSpec
from bench.specs import ModelSpec

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
    traces: list[ReasoningTrace] = field(default_factory=list)
    errors: list[dict[str, str]] = field(default_factory=list)
    validation_events: list[dict] = field(default_factory=list)
    runtime_events: list[dict] = field(default_factory=list)
    kb_context: list[dict] = field(default_factory=list)

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

    def to_dict(self) -> dict:
        return {
            "scenario": str(self.scenario),
            "elapsed_seconds": self.elapsed_seconds,
            "signals": [item.model_dump(mode="json") for item in self.signals],
            "anomalies": [item.model_dump(mode="json") for item in self.anomalies],
            "attributions": [
                item.model_dump(mode="json") for item in self.attributions
            ],
            "decisions": [item.model_dump(mode="json") for item in self.decisions],
            "ui_events": [item.model_dump(mode="json") for item in self.ui_events],
            "traces": [item.model_dump(mode="json") for item in self.traces],
            "errors": self.errors,
            "validation_events": self.validation_events,
            "runtime_events": self.runtime_events,
            "kb_context": self.kb_context,
        }


async def run_trial(
    scenario: str | Path | ScenarioSpec,
    *,
    provider: str,
    multi_agent: bool = True,
    timeout_s: float = DEFAULT_TRIAL_TIMEOUT_S,
    model_spec: ModelSpec | None = None,
) -> TrialArtifact:
    """Replay and fully drain one scenario through a fresh production engine."""
    if isinstance(scenario, ScenarioSpec):
        path = scenario.scenario_path
        signal_filter = scenario.includes_as_input
        signal_transform = scenario.sanitize_input
    else:
        path = Path(scenario)
        # Legacy generated variants predate record roles. Their embedded
        # CANOPY assessments are oracle/display records, never model inputs.
        signal_filter = lambda signal: (
            signal.source != "canopy-correlation-engine"
        )
        signal_transform = None
    artifact = TrialArtifact(scenario=path)
    engine = build_engine(
        provider=provider,
        attrib_window_s=BENCHMARK_ATTRIBUTION_WINDOW_S,
        multi_agent=multi_agent,
        enable_osint=False,
        attrib_kb_context="full",
        model=model_spec.model if model_spec else None,
        endpoint=model_spec.endpoint if model_spec else None,
        llm_timeout_s=model_spec.timeout_s if model_spec else None,
        temperature=model_spec.temperature if model_spec else 0.0,
        seed=model_spec.seed if model_spec else 1337,
    )
    artifact.kb_context = [
        entry.model_dump(mode="json") for entry in engine.kb.all_entries()
    ]
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
        asyncio.create_task(consume("traces.*", artifact.traces, ReasoningTrace)),
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
            signal_filter=signal_filter,
            signal_transform=signal_transform,
        )
        await replay.run()
        await engine.bus.drain()
        await engine.attrib.flush()
        await engine.bus.drain()

    started = time.perf_counter()
    try:
        try:
            await asyncio.wait_for(execute(), timeout=timeout_s)
        except TimeoutError:
            artifact.errors.append(
                {
                    "stage": "trial",
                    "type": "timeout",
                    "message": f"trial exceeded {timeout_s:.1f}s",
                }
            )
        except Exception as exc:  # noqa: BLE001 - preserve a failed case
            artifact.errors.append(
                {
                    "stage": "trial",
                    "type": exc.__class__.__name__,
                    "message": str(exc),
                }
            )
    finally:
        artifact.elapsed_seconds = time.perf_counter() - started
        all_tasks = (*capture_tasks, *service_tasks)
        for task in all_tasks:
            task.cancel()
        outcomes = await asyncio.gather(*all_tasks, return_exceptions=True)
        for task, outcome in zip(all_tasks, outcomes, strict=True):
            if isinstance(outcome, Exception):
                artifact.errors.append(
                    {
                        "stage": task.get_name(),
                        "type": outcome.__class__.__name__,
                        "message": str(outcome),
                    }
                )
        artifact.errors.extend(engine.attrib.errors)
        artifact.errors.extend(engine.decide.errors)
        artifact.validation_events = list(
            getattr(engine.llm, "validation_events", [])
        )
        artifact.runtime_events = list(getattr(engine.llm, "runtime_events", []))
        if not artifact.attributions:
            artifact.errors.append(
                {
                    "stage": "attribution",
                    "type": "missing_output",
                    "message": "trial produced no attribution",
                }
            )
        if not artifact.decisions:
            artifact.errors.append(
                {
                    "stage": "decision",
                    "type": "missing_output",
                    "message": "trial produced no decision",
                }
            )
        engine.bus.close()

    return artifact
