"""Run the benchmark across multiple LLM providers (and optionally with
the red-team loop disabled) and print a side-by-side comparison.

Provider names accept an optional ``+single`` / ``+multi`` suffix:

  ``anthropic``         — multi-agent (primary + redteam + reconcile)
  ``anthropic+single``  — single-pass (primary only — no redteam, no reconcile)
  ``anthropic+multi``   — explicit alias for the default multi-agent path

This lets you isolate whether the redteam loop is actually pulling its
weight against bare single-pass attribution.

Anthropic is expensive: each scenario fires three attribution calls
(primary / redteam / reconcile) plus one decide call in multi-agent mode,
or one + one in single mode. The full 55-scenario multi-agent run is
~220 API calls. Default is seeds-only (11 scenarios). Use ``--full`` for
seeds + variants.

Usage:

    uv run python -m bench.compare                                        # stub vs anthropic-multi
    uv run python -m bench.compare --providers stub anthropic+single anthropic+multi
    uv run python -m bench.compare --full                                 # all 55 scenarios
    uv run python -m bench.compare --skip-stub                            # only re-run anthropic
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

from bench import generate as bench_generate
from bench.run import _run, BENCH_DIR
from bench.scoring import Scorecard

# Pull ANTHROPIC_API_KEY (and any other provider creds) out of .env at the
# repo root before we check for them. Mirrors canopy.api lifespan behaviour.
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

ROOT = Path(__file__).resolve().parent.parent
COMPARE_DIR = BENCH_DIR / "compare"

log = logging.getLogger(__name__)


def _pct(x: float) -> str:
    return f"{x * 100:5.1f}%"


def _print_table(scorecards: dict[str, Scorecard]) -> None:
    """Render a side-by-side comparison table organised by what the engine
    is actually good at vs the soft attribution metric.

    Sections (in order — what to lead with on a slide):

    1. **Decision routing** — does the engine route the action to the right
       authority and pick a sensible action class? This is the production
       value: even a perfect attribution is useless if it's routed wrong.
    2. **Calibration discipline** — when the engine commits, is it right?
       And does it ever overclaim? A calibrated model can score low on
       raw accuracy and still beat an overconfident one in practice.
    3. **Raw attribution** — actor accuracy across all scenarios. Kept
       for completeness but should not lead the demo narrative.
    4. **Cost & latency** — engineering tradeoff between providers.
    """
    providers = list(scorecards.keys())

    def row(label: str, fmt) -> tuple[str, list[str]]:
        return (label, [fmt(c) for c in scorecards.values()])

    sections: list[tuple[str, list[tuple[str, list[str]]]]] = [
        (
            "Decision quality (the production metric)",
            [
                row("Action class accuracy", lambda c: _pct(c.action_accuracy())),
                row("Authority routing", lambda c: _pct(c.authority_accuracy())),
                row(
                    "Forbidden action rate",
                    lambda c: _pct(c.forbidden_action_rate()),
                ),
                row(
                    "Unauthorized route rate",
                    lambda c: _pct(c.unauthorized_routing_rate()),
                ),
            ],
        ),
        (
            "Calibration discipline (the LLM differentiator)",
            [
                row(
                    "Commit rate (conf ≥ 0.55)",
                    lambda c: _pct(c.commit_rate(0.55)),
                ),
                row(
                    "Accuracy when committed",
                    lambda c: _pct(c.accuracy_when_committed(0.55)),
                ),
                row(
                    "Hallucination rate (conf ≥ 0.70 & wrong)",
                    lambda c: _pct(c.hallucination_rate(0.70)),
                ),
                row(
                    "Confidence-tier match",
                    lambda c: _pct(c.calibration_rate()),
                ),
                row("Brier score", lambda c: f"{c.brier_score():.3f}"),
                row(
                    "Expected calibration error",
                    lambda c: f"{c.expected_calibration_error():.3f}",
                ),
            ],
        ),
        (
            "Raw attribution (background metric)",
            [
                row("Attribution accuracy (all)", lambda c: _pct(c.attr_accuracy())),
                row(
                    "Mean conf · when correct",
                    lambda c: f"{c.confidence_means()['correct_mean']:.2f}",
                ),
                row(
                    "Mean conf · when wrong",
                    lambda c: f"{c.confidence_means()['incorrect_mean']:.2f}",
                ),
            ],
        ),
        (
            "Cost & latency",
            [
                row("Latency p50 (s)", lambda c: f"{c.latency_p(0.5):.2f}"),
                row("Latency p95 (s)", lambda c: f"{c.latency_p(0.95):.2f}"),
            ],
        ),
    ]

    label_w = max(
        len(label) for _, rows in sections for label, _ in rows
    ) + 2
    col_w = max(12, max(len(p) for p in providers) + 2)
    width = label_w + col_w * len(providers) + 2

    print()
    print("=" * width)
    print(
        f"{'Metric':<{label_w}}"
        + "".join(f"{p:>{col_w}}" for p in providers)
    )
    for section_title, rows in sections:
        print("-" * width)
        print(f"{section_title}")
        print("-" * width)
        for label, values in rows:
            print(
                f"  {label:<{label_w - 2}}"
                + "".join(f"{v:>{col_w}}" for v in values)
            )
    print("=" * width)

    _print_calibration_bins(scorecards)


def _print_calibration_bins(scorecards: dict[str, Scorecard]) -> None:
    """Confidence-stratified accuracy table — slide-ready calibration plot."""
    providers = list(scorecards.keys())
    bands = ["0.00-0.49", "0.50-0.69", "0.70-0.84", "0.85-1.00"]

    print()
    print("Calibration: accuracy within each confidence band")
    print("(a calibrated model has accuracy roughly equal to the band midpoint)")
    print()
    label_w = 14
    col_w = max(14, max(len(p) for p in providers) + 2)
    width = label_w + col_w * len(providers) + 2

    print(
        f"{'Conf band':<{label_w}}"
        + "".join(f"{p:>{col_w}}" for p in providers)
    )
    print("-" * width)

    for band in bands:
        cells: list[str] = []
        for card in scorecards.values():
            row = next(
                (b for b in card.calibration_bins() if b["band"] == band),
                None,
            )
            if row is None or row["count"] == 0:
                cells.append("—")
            else:
                cells.append(
                    f"{row['correct']}/{row['count']}  "
                    f"({row['accuracy'] * 100:.0f}%)"
                )
        print(
            f"{band:<{label_w}}"
            + "".join(f"{v:>{col_w}}" for v in cells)
        )
    print()


def _print_diff(scorecards: dict[str, Scorecard]) -> None:
    """Per-scenario diff: which scenarios each provider got right/wrong."""
    if len(scorecards) < 2:
        return

    providers = list(scorecards.keys())
    by_file: dict[str, dict[str, dict]] = {}
    for provider, card in scorecards.items():
        for r in card.results:
            entry = by_file.setdefault(r.file, {})
            entry[provider] = {
                "actor": r.predicted_actor,
                "expected": r.expected_actor,
                "correct": r.actor_correct,
                "confidence": r.confidence,
            }

    print()
    print("Per-scenario attribution (✓ correct, ✗ wrong):")
    print()
    file_w = max(len(f) for f in by_file) + 2
    col_w = 28
    print(
        f"{'Scenario':<{file_w}}{'Expected':<14}"
        + "".join(f"{p:>{col_w}}" for p in providers)
    )
    print("-" * (file_w + 14 + col_w * len(providers)))
    for file in sorted(by_file):
        row = by_file[file]
        first = next(iter(row.values()))
        print(
            f"{file:<{file_w}}{first['expected']:<14}"
            + "".join(
                _format_cell(row.get(p), col_w) for p in providers
            )
        )


def _format_cell(entry: dict | None, width: int) -> str:
    if entry is None:
        return f"{'—':>{width}}"
    mark = "✓" if entry["correct"] else "✗"
    actor = entry["actor"] or "—"
    conf = entry["confidence"]
    conf_str = f"{conf:.2f}" if conf is not None else "—"
    cell = f"{mark} {actor} ({conf_str})"
    return f"{cell:>{width}}"


def _parse_label(label: str) -> tuple[str, bool, str]:
    """Split a provider label like ``anthropic+single`` into
    ``(provider, multi_agent, display_label)``.

    ``stub``                 → ("stub", True, "stub")
    ``stub+single``          → ("stub", False, "stub-single")
    ``anthropic``            → ("anthropic", True, "anthropic")
    ``anthropic+multi``      → ("anthropic", True, "anthropic-multi")
    ``anthropic+single``     → ("anthropic", False, "anthropic-single")
    """
    if "+" in label:
        provider, mode = label.split("+", 1)
        if mode not in {"single", "multi"}:
            raise SystemExit(
                f"unknown provider mode '{mode}' in '{label}' "
                "(expected 'single' or 'multi')"
            )
        multi = mode == "multi"
        display = f"{provider}-{mode}"
        return provider, multi, display
    return label, True, label


async def _run_one(
    label: str, provider: str, multi_agent: bool, *, seeds_only: bool
) -> Scorecard:
    log.info("=" * 60)
    log.info(
        "Running label=%s provider=%s multi_agent=%s seeds_only=%s",
        label, provider, multi_agent, seeds_only,
    )
    log.info("=" * 60)
    t0 = time.perf_counter()
    card = await _run(
        provider=provider,
        seeds_only=seeds_only,
        limit=None,
        multi_agent=multi_agent,
    )
    elapsed = time.perf_counter() - t0
    log.info(
        "%s done in %.1fs (attribution=%.0f%%, action=%.0f%%)",
        label,
        elapsed,
        card.attr_accuracy() * 100,
        card.action_accuracy() * 100,
    )
    return card


def _check_credentials(providers: list[str]) -> None:
    bare_providers = {p.split("+", 1)[0] for p in providers}
    if "anthropic" in bare_providers and not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit(
            "ANTHROPIC_API_KEY not set — required for --providers anthropic. "
            "Add it to .env at the repo root and retry."
        )


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--providers",
        nargs="+",
        default=["stub", "anthropic"],
        help="Providers to compare (default: stub anthropic)",
    )
    parser.add_argument(
        "--full",
        action="store_true",
        help="Run against seeds + 44 variants (~220 API calls for anthropic)",
    )
    parser.add_argument(
        "--skip-stub",
        action="store_true",
        help="Skip stub run if a stub scorecard already exists in compare/",
    )
    parser.add_argument(
        "--variants",
        type=int,
        default=4,
        help="Variants per seed when --full (default: 4)",
    )
    args = parser.parse_args()

    _check_credentials(args.providers)
    seeds_only = not args.full

    if args.full:
        bench_generate.generate(variants_per_seed=args.variants)

    COMPARE_DIR.mkdir(parents=True, exist_ok=True)
    scorecards: dict[str, Scorecard] = {}

    for raw_label in args.providers:
        provider, multi_agent, label = _parse_label(raw_label)
        cache_path = COMPARE_DIR / f"scorecard_{label}.json"

        if (
            args.skip_stub
            and provider == "stub"
            and cache_path.exists()
        ):
            log.info("Reusing cached %s scorecard at %s", label, cache_path)
            payload = json.loads(cache_path.read_text())
            card = _scorecard_from_dict(payload)
        else:
            card = asyncio.run(
                _run_one(label, provider, multi_agent, seeds_only=seeds_only)
            )
            cache_path.write_text(json.dumps(card.to_dict(), indent=2))
            log.info("Wrote %s", cache_path)

        scorecards[label] = card

    _print_table(scorecards)
    _print_diff(scorecards)

    summary_path = COMPARE_DIR / "comparison.json"
    summary_path.write_text(
        json.dumps(
            {p: c.to_dict() for p, c in scorecards.items()},
            indent=2,
        )
    )
    print()
    print(f"Saved per-provider scorecards under {COMPARE_DIR.relative_to(ROOT)}/")
    print(f"Combined comparison at {summary_path.relative_to(ROOT)}")
    return 0


def _scorecard_from_dict(payload: dict) -> Scorecard:
    """Reconstruct a Scorecard from its serialized dict."""
    from bench.scoring import ScenarioResult

    card = Scorecard()
    for r in payload.get("results", []):
        card.append(
            ScenarioResult(
                file=r["file"],
                expected_actor=r["expected_actor"],
                predicted_actor=r["predicted_actor"],
                expected_action=r["expected_action"],
                predicted_action=r["predicted_action"],
                expected_authority=r["expected_authority"],
                predicted_authority=r["predicted_authority"],
                confidence=r["confidence"],
                expected_confidence_band=r["expected_band"],
                latency_seconds=r["latency_seconds"],
                actor_correct=r["actor_correct"],
                action_correct=r["action_correct"],
                authority_correct=r["authority_correct"],
                calibrated=r["calibrated"],
                forbidden_action=r.get("forbidden_action", False),
                case_id=r.get("case_id"),
                family=r.get("family"),
                cluster_id=r.get("cluster_id"),
            )
        )
    return card


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
