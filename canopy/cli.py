from __future__ import annotations

import argparse
import asyncio
import logging
import os
from pathlib import Path

from dotenv import load_dotenv

from canopy.services.attrib import AttribService
from canopy.services.bus import InProcessBus
from canopy.services.decide import DecideService
from canopy.services.fusion import DEFAULT_WINDOWS, FusionService
from canopy.services.kb import KB
from canopy.services.llm import LLMClient
from canopy.services.orbit import OrbitService
from canopy.services.scenario_replay import ScenarioReplayService
from canopy.services.ui_events import UIEventService

DEFAULT_KB_PATH = Path("data/kb_seed_entries.json")
DEFAULT_BEATS = (
    "scenarios/beat1.jsonl",
    "scenarios/beat2.jsonl",
    "scenarios/beat4.jsonl",
    "scenarios/beat47.jsonl",
)


LLM_PROVIDERS = ("stub", "anthropic", "ollama")


def _build_llm(*, provider: str, kb: KB) -> LLMClient:
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
    from canopy.services.llm.stub import StubLLMClient

    return StubLLMClient(kb)


def _resolve_provider(*, llm_flag: str | None, live_flag: bool) -> str:
    """Pick provider from --llm > CANOPY_LLM env > --live/CANOPY_LIVE > stub."""
    if llm_flag:
        return llm_flag
    env_llm = os.environ.get("CANOPY_LLM")
    if env_llm:
        return env_llm.lower()
    if live_flag or os.environ.get("CANOPY_LIVE"):
        return "anthropic"
    return "stub"


def _live_from_env() -> bool:
    return bool(os.environ.get("CANOPY_LIVE"))


async def main(
    *,
    provider: str = "stub",
    log_level: str = "INFO",
    scenarios: list[str] | None = None,
    scenario_speed: float = 20.0,
    scenario_max_delay_s: float | None = 0.5,
    drain_s: float = 4.0,
    attrib_window_s: float = 2.0,
    kb_path: str | Path = DEFAULT_KB_PATH,
    bus_health_lookback_s: int | None = None,
) -> None:
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    log = logging.getLogger("canopy.cli")
    log.info("CANOPY engine starting (llm=%s scenarios=%s)", provider, scenarios)

    bus = InProcessBus()
    kb = KB.load_from_json(kb_path)
    log.info("KB loaded: %d entries from %s", len(kb), kb_path)
    llm = _build_llm(provider=provider, kb=kb)

    orbit = OrbitService()
    log.info("Orbit service loaded with %d cached satellites", len(orbit.known_satellites()))

    fusion_windows = None
    if bus_health_lookback_s is not None:
        # Override only the bus_health look-back; its look-ahead and every
        # other row keep the spec defaults.
        fusion_windows = {
            "bus_health": (bus_health_lookback_s, DEFAULT_WINDOWS["bus_health"][1])
        }
    fusion = FusionService(bus, windows=fusion_windows)
    attrib = AttribService(bus, llm, kb, window_s=attrib_window_s)
    decide = DecideService(bus, llm, orbit=orbit)
    ui = UIEventService(bus)

    services = [
        ("fusion", fusion.run()),
        ("attrib", attrib.run()),
        ("decide", decide.run()),
        ("ui_events", ui.run()),
    ]
    tasks = [asyncio.create_task(coro, name=name) for name, coro in services]

    replay_task: asyncio.Task | None = None
    done_event: asyncio.Event | None = None
    if scenarios:
        done_event = asyncio.Event()
        replay = ScenarioReplayService(
            bus,
            scenarios,
            speed=scenario_speed,
            max_delay_s=scenario_max_delay_s,
            stop_when_done=done_event,
        )
        replay_task = asyncio.create_task(replay.run(), name="scenario_replay")
        tasks.append(replay_task)

    try:
        if done_event is not None:
            await done_event.wait()
            log.info(
                "scenario replay complete; draining pipeline for %.1fs", drain_s
            )
            await asyncio.sleep(drain_s)
        else:
            log.info("CANOPY engine running. Press Ctrl-C to stop.")
            await asyncio.gather(*tasks)
    except (asyncio.CancelledError, KeyboardInterrupt):
        pass
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        bus.close()


def cli() -> None:
    # Load .env if present so ANTHROPIC_API_KEY / CANOPY_LIVE / CANOPY_ANTHROPIC_MODEL
    # are available before we parse args or build clients. .env values do not
    # override variables that are already set in the environment.
    load_dotenv()

    parser = argparse.ArgumentParser(
        prog="canopy", description="CANOPY engine orchestrator"
    )
    parser.add_argument(
        "--llm",
        choices=LLM_PROVIDERS,
        default=None,
        help=(
            "LLM provider: 'stub' (default, no network), 'anthropic' (requires "
            "ANTHROPIC_API_KEY), or 'ollama' (requires CANOPY_OLLAMA_URL). "
            "Falls back to CANOPY_LLM env var, then to --live/CANOPY_LIVE, "
            "then to stub."
        ),
    )
    parser.add_argument(
        "--live",
        action="store_true",
        default=_live_from_env(),
        help="Deprecated alias for --llm anthropic.",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )
    parser.add_argument(
        "--scenario",
        action="append",
        default=[],
        help=(
            "Replay a scenario JSONL file. Repeat the flag to play several in "
            "sequence. Use --beats to play the canonical four-beat demo."
        ),
    )
    parser.add_argument(
        "--beats",
        action="store_true",
        default=False,
        help="Replay all four canonical beats in order.",
    )
    parser.add_argument("--scenario-speed", type=float, default=20.0)
    parser.add_argument("--scenario-max-delay-s", type=float, default=0.5)
    parser.add_argument("--drain-s", type=float, default=4.0)
    parser.add_argument(
        "--attrib-window-s",
        type=float,
        default=2.0,
        help="Sliding window over anomalies before attribution fires.",
    )
    parser.add_argument(
        "--bus-health-lookback-s",
        type=int,
        default=None,
        help=(
            "How far back (seconds) fusion searches for correlates of a "
            f"bus_health signal. Default {DEFAULT_WINDOWS['bus_health'][0]}."
        ),
    )
    args = parser.parse_args()

    provider = _resolve_provider(llm_flag=args.llm, live_flag=args.live)

    scenarios = list(args.scenario)
    if args.beats:
        scenarios = list(DEFAULT_BEATS) + scenarios

    try:
        asyncio.run(
            main(
                provider=provider,
                log_level=args.log_level,
                scenarios=scenarios or None,
                scenario_speed=args.scenario_speed,
                scenario_max_delay_s=args.scenario_max_delay_s,
                drain_s=args.drain_s,
                attrib_window_s=args.attrib_window_s,
                bus_health_lookback_s=args.bus_health_lookback_s,
            )
        )
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    cli()
