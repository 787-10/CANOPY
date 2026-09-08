"""Shared engine builder used by both the CLI and the FastAPI gateway.

Bundling the ``InProcessBus`` + KB + LLM + four async services into one
function keeps :mod:`canopy.cli` and :mod:`canopy.api` in lock-step. If a new
service joins the engine, it ships here once.
"""
from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from canopy.services.attrib import AttribService
from canopy.services.bus import InProcessBus
from canopy.services.decide import DecideService
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

log = logging.getLogger(__name__)


@dataclass
class Engine:
    bus: InProcessBus
    kb: KB
    orbit: OrbitService
    llm: LLMClient
    tracer: Tracer
    fusion: FusionService
    attrib: AttribService
    decide: DecideService
    ui_events: UIEventService
    osint_cluster: OsintClusterService | None


def build_llm(*, provider: str, kb: KB) -> LLMClient:
    if provider == "anthropic":
        from canopy.services.llm.anthropic_client import (
            DEFAULT_MODEL,
            AnthropicLLMClient,
        )

        model = os.environ.get("CANOPY_ANTHROPIC_MODEL") or DEFAULT_MODEL
        return AnthropicLLMClient(kb, model=model)
    if provider == "ollama":
        from canopy.services.llm.ollama_client import OllamaLLMClient

        return OllamaLLMClient(kb)
    if provider == "stub":
        from canopy.services.llm.stub import StubLLMClient

        return StubLLMClient(kb)
    raise ValueError(
        f"unknown LLM provider {provider!r}; expected one of {LLM_PROVIDERS}"
    )


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
    blocked_domains_provider=None,
    multi_agent: bool = True,
    enable_osint: bool = True,
    attrib_kb_context: Literal["scenario", "full"] = "scenario",
) -> Engine:
    """Wire up the in-process bus, KB, LLM, and the four async services."""
    bus = InProcessBus()
    kb = KB.load_from_json(kb_path)
    log.info("KB loaded: %d entries from %s", len(kb), kb_path)
    llm = build_llm(provider=provider, kb=kb)

    orbit = OrbitService()
    log.info(
        "Orbit service loaded with %d cached satellites",
        len(orbit.known_satellites()),
    )

    tracer = Tracer(bus)
    tool_ctx, tools = build_tool_registry(kb=kb, orbit=orbit, tracer=tracer)
    fusion = FusionService(
        bus, tracer=tracer, blocked_domains=blocked_domains_provider
    )
    attrib = AttribService(
        bus,
        llm,
        kb,
        window_s=attrib_window_s,
        tracer=tracer,
        blocked_domains=blocked_domains_provider,
        multi_agent=multi_agent,
        kb_context_mode=attrib_kb_context,
    )
    decide = DecideService(
        bus,
        llm,
        orbit=orbit,
        tracer=tracer,
        tools=tools,
        tool_ctx=tool_ctx,
    )
    ui_events = UIEventService(bus)
    osint_cluster = (
        OsintClusterService(bus, tracer=tracer) if enable_osint else None
    )

    return Engine(
        bus=bus,
        kb=kb,
        orbit=orbit,
        llm=llm,
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
