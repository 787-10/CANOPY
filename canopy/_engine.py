"""Shared engine builder used by both the CLI and the FastAPI gateway.

Bundling the bus + KB + LLM + four async services into one function keeps
:mod:`canopy.cli` and :mod:`canopy.api` in lock-step. If a new service joins
the engine, it ships here once.

The bus is any :class:`canopy.services.bus.Bus`. ``build_bus`` picks the
backend: ``memory`` (the in-process default) or ``nats`` (``megalith.bus``'s
JetStream client, imported only on that branch because CANOPY's own
environment carries neither ``nats-py`` nor ``megalith``).
"""
from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from canopy.services.attrib import AttribService
from canopy.services.bus import Bus, InProcessBus
from canopy.services.decide import DecideService, Gate
from canopy.services.decide.tools import build_tool_registry
from canopy.services.fusion import FusionService
from canopy.services.kb import KB
from canopy.services.llm import LLMClient
from canopy.services.orbit import OrbitService
from canopy.services.osint_cluster import OsintClusterService
from canopy.services.traces import Tracer
from canopy.services.ui_events import UIEventService

DEFAULT_KB_PATH = Path("data/kb_seed_entries.json")
LLM_PROVIDERS = ("stub", "anthropic", "ollama")
BUS_BACKENDS = ("memory", "nats")
BusBackend = Literal["memory", "nats"]
DEFAULT_NATS_URL = "nats://127.0.0.1:4222"

log = logging.getLogger(__name__)


@dataclass
class Engine:
    bus: Bus
    kb: KB
    orbit: OrbitService
    llm: LLMClient
    tracer: Tracer
    fusion: FusionService
    attrib: AttribService
    decide: DecideService
    ui_events: UIEventService
    osint_cluster: OsintClusterService | None


def build_llm(
    *,
    provider: str,
    kb: KB,
    model: str | None = None,
    endpoint: str | None = None,
    timeout_s: float | None = None,
    temperature: float = 0.0,
    seed: int = 1337,
) -> LLMClient:
    if provider == "anthropic":
        from canopy.services.llm.anthropic_client import (
            DEFAULT_MODEL,
            AnthropicLLMClient,
        )

        resolved_model = model or os.environ.get("CANOPY_ANTHROPIC_MODEL") or DEFAULT_MODEL
        return AnthropicLLMClient(
            kb,
            model=resolved_model,
            temperature=temperature,
            timeout_s=timeout_s,
        )
    if provider == "ollama":
        from canopy.services.llm.ollama_client import OllamaLLMClient

        return OllamaLLMClient(
            kb,
            model=model,
            base_url=endpoint,
            timeout_s=timeout_s,
            temperature=temperature,
            seed=seed,
        )
    if provider == "stub":
        from canopy.services.llm.stub import StubLLMClient

        return StubLLMClient(kb)
    raise ValueError(
        f"unknown LLM provider {provider!r}; expected one of {LLM_PROVIDERS}"
    )


def build_bus(
    backend: BusBackend = "memory",
    *,
    nats_url: str | None = None,
    nats_stream: str = "canopy",
    consumer_prefix: str | None = None,
) -> Bus:
    """Construct the bus backend.

    ``nats`` imports ``megalith.bus`` lazily: it needs ``nats-py`` and the
    ``megalith`` package, neither of which CANOPY's own environment has.
    ``nats_url`` falls back to ``CANOPY_NATS_URL`` then ``DEFAULT_NATS_URL``.
    ``consumer_prefix`` names this process's durable consumers so a restart
    resumes where it left off (``None`` keeps them ephemeral).
    """
    if backend == "memory":
        return InProcessBus()
    if backend == "nats":
        try:
            from megalith.bus import NatsBus
        except ImportError as exc:  # pragma: no cover - depends on the env
            raise RuntimeError(
                "bus backend 'nats' needs the megalith package and nats-py "
                "(run from the MEGALITH root environment)"
            ) from exc

        url = nats_url or os.environ.get("CANOPY_NATS_URL") or DEFAULT_NATS_URL
        return NatsBus(url, stream=nats_stream, consumer_prefix=consumer_prefix)
    raise ValueError(
        f"unknown bus backend {backend!r}; expected one of {BUS_BACKENDS}"
    )


def resolve_bus_backend(*, bus_flag: str | None) -> BusBackend:
    """Pick the bus backend from --bus > CANOPY_BUS env > memory."""
    value = bus_flag or os.environ.get("CANOPY_BUS") or "memory"
    value = value.lower()
    if value not in BUS_BACKENDS:
        raise ValueError(
            f"unknown bus backend {value!r}; expected one of {BUS_BACKENDS}"
        )
    return value  # type: ignore[return-value]


def resolve_provider(*, llm_flag: str | None, live_flag: bool = False) -> str:
    """Pick provider from --llm > CANOPY_LLM env > --live/CANOPY_LIVE > stub."""
    if llm_flag:
        return llm_flag
    env_value = os.environ.get("CANOPY_LLM")
    if env_value:
        return env_value.lower()
    if live_flag or os.environ.get("CANOPY_LIVE"):
        return "anthropic"
    return "stub"


def build_engine(
    *,
    provider: str = "stub",
    kb_path: str | Path = DEFAULT_KB_PATH,
    attrib_window_s: float = 2.0,
    attrib_cluster_window_scenario_s: float | None = None,
    attrib_clock_rate: Callable[[], float | None] | None = None,
    blocked_domains_provider=None,
    multi_agent: bool = True,
    enable_osint: bool = True,
    attrib_kb_context: Literal["scenario", "full"] = "scenario",
    model: str | None = None,
    endpoint: str | None = None,
    llm_timeout_s: float | None = None,
    temperature: float = 0.0,
    seed: int = 1337,
    llm: LLMClient | None = None,
    fusion_windows: Mapping[str, tuple[int, int]] | None = None,
    decision_gate: Gate | None = None,
    bus_health_registry: Callable[[], set[str]] | None = None,
    bus: Bus | None = None,
    bus_backend: BusBackend = "memory",
    nats_url: str | None = None,
    nats_stream: str = "canopy",
    consumer_prefix: str | None = None,
) -> Engine:
    """Wire up the bus, KB, LLM, and the four async services.

    ``bus`` injects a ready bus; otherwise ``bus_backend`` (``memory`` or
    ``nats``) selects one through :func:`build_bus`, with ``nats_url``,
    ``nats_stream`` and ``consumer_prefix`` forwarded to the NATS client.

    ``fusion_windows`` overrides entries of the fusion per-domain
    ``(look-back s, look-ahead s)`` table (``fusion.DEFAULT_WINDOWS``,
    docs/INTERFACE-SPEC.md §2); entries not given keep their defaults.

    ``decision_gate`` is the callable DecideService runs between tool
    enrichment and publish (spec §7); ``None`` selects the threat-context
    gate from ``megalith.gate`` when that package is installed, else the
    policy-only gate.
    """
    if bus is None:
        bus = build_bus(
            bus_backend,
            nats_url=nats_url,
            nats_stream=nats_stream,
            consumer_prefix=consumer_prefix,
        )
    kb = KB.load_from_json(kb_path)
    log.info("KB loaded: %d entries from %s", len(kb), kb_path)
    resolved_llm = llm or build_llm(
        provider=provider,
        kb=kb,
        model=model,
        endpoint=endpoint,
        timeout_s=llm_timeout_s,
        temperature=temperature,
        seed=seed,
    )

    orbit = OrbitService()
    log.info(
        "Orbit service loaded with %d cached satellites",
        len(orbit.known_satellites()),
    )

    tracer = Tracer(bus)
    tool_ctx, tools = build_tool_registry(kb=kb, orbit=orbit, tracer=tracer)
    fusion = FusionService(
        bus,
        tracer=tracer,
        blocked_domains=blocked_domains_provider,
        windows=fusion_windows,
    )
    attrib = AttribService(
        bus,
        resolved_llm,
        kb,
        window_s=attrib_window_s,
        # The fast lane's cluster window on scenario time (spec §5.0, 1.4.4):
        # the gateway sets both; the CLI and the bench keep the wall window.
        cluster_window_scenario_s=attrib_cluster_window_scenario_s,
        clock_rate=attrib_clock_rate if attrib_clock_rate is not None else (lambda: None),
        tracer=tracer,
        blocked_domains=blocked_domains_provider,
        multi_agent=multi_agent,
        kb_context_mode=attrib_kb_context,
        bus_health_registry=bus_health_registry,
    )
    decide = DecideService(
        bus,
        resolved_llm,
        orbit=orbit,
        tracer=tracer,
        tools=tools,
        tool_ctx=tool_ctx,
        gate=decision_gate,
    )
    ui_events = UIEventService(bus, tracer=tracer)
    osint_cluster = (
        OsintClusterService(bus, tracer=tracer) if enable_osint else None
    )

    return Engine(
        bus=bus,
        kb=kb,
        orbit=orbit,
        llm=resolved_llm,
        tracer=tracer,
        fusion=fusion,
        attrib=attrib,
        decide=decide,
        ui_events=ui_events,
        osint_cluster=osint_cluster,
    )


def start_engine_tasks(engine: Engine) -> list[asyncio.Task]:
    """Launch the service runners. Returns the tasks for cancellation."""
    tasks = [
        asyncio.create_task(engine.fusion.run(), name="fusion"),
        asyncio.create_task(engine.attrib.run(), name="attrib"),
        asyncio.create_task(engine.decide.run(), name="decide"),
        asyncio.create_task(engine.ui_events.run(), name="ui_events"),
    ]
    if engine.osint_cluster is not None:
        tasks.append(
            asyncio.create_task(engine.osint_cluster.run(), name="osint_cluster")
        )
    return tasks
