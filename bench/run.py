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
from bench.artifacts import write_run_bundle
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

    expected_actors = label.get("expected_actors", label["expected_actor"])
    expected_actions = label.get("expected_actions", label["expected_action"])
    expected_authorities = label.get(
        "expected_authorities", label["expected_authority"]
    )

    actor_correct = pred_actor is not None and actor_match(
        pred_actor, expected_actors
    )
    action_correct = pred_action is not None and action_match(
        pred_action, expected_actions
    )
    authority_correct = pred_authority is not None and authority_match(
        pred_authority, expected_authorities
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
        forbidden_action=pred_action in label.get("forbidden_actions", []),
        case_id=label.get("case_id"),
        family=label.get("family"),
        cluster_id=label.get("cluster_id"),
        parent_id=label.get("parent_id"),
        transformation=label.get("transformation"),
        relation=label.get("relation"),
    )


def _seed_labels() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for case in load_scenario_registry().benchmark_cases():
        expected = case.expected
        out.append(
            {
                "file": case.file,
                "expected_actor": expected.actors[0],
                "expected_actors": expected.actors,
                "expected_action": expected.actions[0],
                "expected_actions": expected.actions,
                "expected_authority": expected.authorities[0],
                "expected_authorities": expected.authorities,
                "confidence_band": expected.confidence_band,
                "forbidden_actions": expected.forbidden_actions,
                "case_id": case.id,
                "family": case.family,
                "cluster_id": case.id,
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
        out.append(
            {
                **entry,
                "_path": str(path),
                "cluster_id": Path(entry.get("seed_file", rel)).stem,
            }
        )
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
        item = trial.to_dict()
        item.update(
            {
                "case_id": result.case_id or Path(label["file"]).stem,
                "family": result.family,
                "parent_id": result.parent_id,
                "transformation": result.transformation,
                "relation": result.relation,
                "expected": {
                    "actors": label.get(
                        "expected_actors", [label["expected_actor"]]
                    ),
                    "actions": label.get(
                        "expected_actions", [label["expected_action"]]
                    ),
                    "authorities": label.get(
                        "expected_authorities", [label["expected_authority"]]
                    ),
                    "forbidden_actions": label.get("forbidden_actions", []),
                },
            }
        )
        scorecard.append(result, item=item)
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
    print(
        f"  Brier score: {card.brier_score():.3f}, "
        f"ECE: {card.expected_calibration_error():.3f}"
    )
    print(
        f"Policy violations: forbidden actions "
        f"{card.forbidden_action_rate() * 100:.1f}%, unauthorized routing "
        f"{card.unauthorized_routing_rate() * 100:.1f}%"
    )
    print(f"Completion rate: {card.completion_rate() * 100:.1f}%")
    robustness = card.robustness_metrics()
    if robustness["eligible"]:
        print(
            "Robustness relation pass rate: "
            f"{robustness['passed']}/{robustness['eligible']} "
            f"= {robustness['pass_rate'] * 100:.1f}%"
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
    bundle = write_run_bundle(
        card,
        output_root=BENCH_DIR / "runs",
        provider=provider,
        model=provider,
        suite_id="canopy-public-v1",
        multi_agent=not args.no_redteam,
    )
    _print_report(card)
    print(f"Scorecard written to {SCORECARD.relative_to(ROOT)}")
    print(f"Immutable run bundle written to {bundle.relative_to(ROOT)}")

    # The deterministic stub is a pipeline control, not a quality baseline.
    # Its gate verifies complete, policy-valid episodes. Model quality gates
    # apply only to live providers.
    if provider == "stub":
        if card.completion_rate() < 1.0:
            log.error("Stub pipeline did not complete every episode")
            return 1
        if card.unauthorized_routing_rate() > 0.0:
            log.error("Stub pipeline produced unauthorized routing")
            return 1
        return 0

    if card.action_accuracy() < 0.85:
        log.error(
            "Action accuracy %.0f%% below 85%% routing gate",
            card.action_accuracy() * 100,
        )
        return 1
    if card.attr_accuracy() < 0.5:
        log.error(
            "Attribution accuracy %.0f%% below %.0f%% gate",
            card.attr_accuracy() * 100,
            50.0,
        )
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
