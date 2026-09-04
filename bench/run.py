"""Benchmark harness — replays each labeled scenario through the engine
and produces a scorecard.

Usage:

    uv run python -m bench.run                # runs seeds + variants
    uv run python -m bench.run --seeds-only   # skip variants
    uv run python -m bench.run --provider stub
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
from pathlib import Path
from typing import Any

from bench import generate as bench_generate
from bench.runner import run_trial
from bench.specs import load_scenario_registry
from bench.scoring import (
    ScenarioResult,
    Scorecard,
    action_match,
    actor_match,
    authority_match,
    confidence_band_match,
)
from canopy._engine import resolve_provider
from canopy.services.schemas.events import Attribution, Decision

ROOT = Path(__file__).resolve().parent.parent
BENCH_DIR = Path(__file__).resolve().parent
VARIANTS_DIR = BENCH_DIR / "scenarios"
SCORECARD = BENCH_DIR / "scorecard.json"
TRIAL_TIMEOUTS_S: dict[str, float] = {
    "stub": 30.0,
    "anthropic": 360.0,
    "ollama": 900.0,
}
TRIAL_TIMEOUT_DEFAULT_S = 600.0

log = logging.getLogger(__name__)


def _label_outputs(
    label: dict[str, Any], captured: dict[str, list], elapsed: float
) -> ScenarioResult:
    attribution: Attribution | None = (
        captured["attribution"][-1] if captured["attribution"] else None
    )
    decision: Decision | None = captured["decision"][-1] if captured["decision"] else None

    pred_actor = attribution.actor if attribution else None
    pred_conf = attribution.confidence if attribution else None
    pred_action = decision.action if decision else None
    pred_authority = decision.authority if decision else None

    actor_correct = pred_actor is not None and actor_match(
        pred_actor, label["expected_actor"]
    )
    action_correct = pred_action is not None and action_match(
        pred_action, label["expected_action"]
    )
    authority_correct = pred_authority is not None and authority_match(
        pred_authority, label["expected_authority"]
    )
    calibrated = pred_conf is not None and confidence_band_match(
        pred_conf, label.get("confidence_band", "med")
    )

    return ScenarioResult(
        file=label.get("file", "?"),
        expected_actor=label["expected_actor"],
        predicted_actor=pred_actor,
        expected_action=label["expected_action"],
        predicted_action=pred_action,
        expected_authority=label["expected_authority"],
        predicted_authority=pred_authority,
        confidence=pred_conf,
        expected_confidence_band=label.get("confidence_band", "med"),
        latency_seconds=elapsed,
        actor_correct=actor_correct,
        action_correct=action_correct,
        authority_correct=authority_correct,
        calibrated=calibrated,
    )


def _seed_labels() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for case in load_scenario_registry().benchmark_cases():
        expected = case.expected
        out.append(
            {
                "file": case.file,
                "expected_actor": expected.actors[0],
                "expected_action": expected.actions[0],
                "expected_authority": expected.authorities[0],
                "confidence_band": expected.confidence_band,
                "_path": str(case.scenario_path),
                "_case": case,
            }
        )
    return out


def _variant_labels() -> list[dict[str, Any]]:
    labels_path = VARIANTS_DIR / "labels.json"
    if not labels_path.exists():
        return []
    raw = json.loads(labels_path.read_text())
    out: list[dict[str, Any]] = []
    for entry in raw:
        rel = entry["file"]
        path = (BENCH_DIR / rel).resolve()
        if not path.exists():
            continue
        out.append({**entry, "_path": str(path)})
    return out


async def _run(
    *,
    provider: str,
    seeds_only: bool,
    limit: int | None,
    multi_agent: bool = True,
) -> Scorecard:
    log.info(
        "Building engine (llm=%s, multi_agent=%s)", provider, multi_agent
    )
    scorecard = Scorecard()

    labels: list[dict[str, Any]] = []
    labels.extend(_seed_labels())
    if not seeds_only:
        labels.extend(_variant_labels())
    if limit is not None:
        labels = labels[:limit]

    trial_timeout = TRIAL_TIMEOUTS_S.get(provider, TRIAL_TIMEOUT_DEFAULT_S)
    log.info(
        "Scoring %d scenarios (trial timeout: %.0fs)",
        len(labels),
        trial_timeout,
    )

    for i, label in enumerate(labels, start=1):
        path = Path(label["_path"])
        trial = await run_trial(
            label.get("_case", path),
            provider=provider,
            multi_agent=multi_agent,
            timeout_s=trial_timeout,
        )
        result = _label_outputs(
            label, trial.captured(), trial.elapsed_seconds
        )
        scorecard.append(result)
        log.info(
            "  [%d/%d] %-50s  actor=%s%s  action=%s%s  "
            "auth=%s%s  conf=%s",
            i,
            len(labels),
            Path(label["file"]).name,
            result.predicted_actor or "—",
            "✓" if result.actor_correct else "✗",
            result.predicted_action or "—",
            "✓" if result.action_correct else "✗",
            result.predicted_authority or "—",
            "✓" if result.authority_correct else "✗",
            f"{result.confidence:.2f}" if result.confidence is not None else "—",
        )

    return scorecard


def _print_report(card: Scorecard) -> None:
    means = card.confidence_means()
    print()
    print("=" * 60)
    print(f"Running {card.total} scenarios…")
    print(
        f"Attribution accuracy: {card.correct('actor_correct')}/{card.total} "
        f"= {card.attr_accuracy() * 100:.0f}%"
    )
    print(
        f"  Mean confidence on correct:   {means['correct_mean']:.2f}"
    )
    print(
        f"  Mean confidence on incorrect: {means['incorrect_mean']:.2f}  "
        f"(well-calibrated when correct > incorrect)"
    )
    print("Decision quality:")
    print(
        f"  Action match: {card.correct('action_correct')}/{card.total} "
        f"= {card.action_accuracy() * 100:.0f}%"
    )
    print(
        f"  Authority routing correct: {card.correct('authority_correct')}/{card.total} "
        f"= {card.authority_accuracy() * 100:.0f}%"
    )
    print(
        f"  Confidence calibration tier: {card.correct('calibrated')}/{card.total} "
        f"= {card.calibration_rate() * 100:.0f}%"
    )
    print(f"Latency p50: {card.latency_p(0.5):.2f}s, p95: {card.latency_p(0.95):.2f}s")
    print("=" * 60)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", default=None, help="stub|anthropic|ollama")
    parser.add_argument("--seeds-only", action="store_true")
    parser.add_argument("--regenerate-variants", action="store_true")
    parser.add_argument("--variants", type=int, default=4)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument(
        "--no-redteam",
        action="store_true",
        help="Disable the red-team / reconcile attribution agents (single-pass).",
    )
    args = parser.parse_args()

    if args.regenerate_variants and not args.seeds_only:
        bench_generate.generate(variants_per_seed=args.variants)
    elif not args.seeds_only and not (VARIANTS_DIR / "labels.json").exists():
        bench_generate.generate(variants_per_seed=args.variants)

    provider = resolve_provider(llm_flag=args.provider)
    card = asyncio.run(
        _run(
            provider=provider,
            seeds_only=args.seeds_only,
            limit=args.limit,
            multi_agent=not args.no_redteam,
        )
    )

    SCORECARD.write_text(json.dumps(card.to_dict(), indent=2))
    _print_report(card)
    print(f"Scorecard written to {SCORECARD.relative_to(ROOT)}")

    # Stub LLM is deterministic — actor accuracy is bounded by the
    # _KIND_TO_ATTRIBUTION mapping. Live providers should clear ≥0.50;
    # for the stub baseline we only fail if action+authority routing
    # collapses, since those are deterministic and stable.
    gate = 0.5 if provider != "stub" else 0.0
    if card.action_accuracy() < 0.85:
        log.error(
            "Action accuracy %.0f%% below 85%% routing gate",
            card.action_accuracy() * 100,
        )
        return 1
    if card.attr_accuracy() < gate:
        log.error(
            "Attribution accuracy %.0f%% below %.0f%% gate",
            card.attr_accuracy() * 100,
            gate * 100,
        )
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
