"""Generate controlled benchmark families from the versioned scenario registry."""
from __future__ import annotations

import argparse
import json
import logging
import random
from collections import Counter
from pathlib import Path
from typing import Any

from bench.specs import load_scenario_registry
from bench.transforms import (
    drop_domain,
    duplicate_signal,
    inject_untrusted_instruction,
    namespace_records,
    reorder_within,
)
from canopy.services.scenario_replay import load_scenario_signals
from canopy.services.schemas.events import Signal

BENCH_DIR = Path(__file__).resolve().parent
SCENARIOS_DIR = BENCH_DIR / "scenarios"

log = logging.getLogger(__name__)


def _source_records(case) -> list[dict[str, Any]]:
    return [
        signal.model_dump(mode="json", exclude_none=True)
        for signal in load_scenario_signals(case.scenario_path)
        if case.includes_as_input(signal)
    ]


def _target_for_untrusted(records: list[dict[str, Any]]) -> str:
    for record in records:
        if record["domain"] in {"osint", "humint"}:
            return record["id"]
    return records[0]["id"]


def _least_represented_domain(records: list[dict[str, Any]]) -> str:
    counts = Counter(record["domain"] for record in records)
    return min(counts, key=lambda domain: (counts[domain], domain))


def _transform(
    records: list[dict[str, Any]], index: int
) -> tuple[str, str, dict[str, Any], list[dict[str, Any]]]:
    kind = index % 4
    if kind == 0:
        target = records[0]["id"]
        return (
            "duplicate_signal",
            "invariant",
            {"signal_id": target},
            duplicate_signal(records, target),
        )
    if kind == 1:
        return (
            "reorder_within",
            "invariant",
            {"seconds": 120},
            reorder_within(records, seconds=120),
        )
    if kind == 2:
        domain = _least_represented_domain(records)
        transformed = drop_domain(records, domain)
        if not transformed:
            transformed = records
        return (
            "drop_domain",
            "confidence_nonincrease",
            {"domain": domain},
            transformed,
        )
    target = _target_for_untrusted(records)
    return (
        "inject_untrusted_instruction",
        "invariant",
        {"signal_id": target},
        inject_untrusted_instruction(records, target),
    )


def generate(
    *,
    variants_per_seed: int,
    seed: int = 1337,
    output_dir: str | Path = SCENARIOS_DIR,
) -> list[dict[str, Any]]:
    """Generate named variants and return their versioned label entries."""
    destination = Path(output_dir)
    destination.mkdir(parents=True, exist_ok=True)
    registry = load_scenario_registry()
    rng = random.Random(seed)
    labels: list[dict[str, Any]] = []

    for case in registry.benchmark_cases():
        records = _source_records(case)
        if not records:
            log.warning("benchmark parent has no stimulus records: %s", case.id)
            continue
        for index in range(variants_per_seed):
            transformation, relation, parameters, transformed = _transform(
                records, index
            )
            # The RNG is recorded and consumed so future stochastic named
            # transforms remain reproducible without changing this contract.
            variant_seed = rng.randrange(0, 2**31)
            suffix = f"v{index + 1:02d}"
            transformed = namespace_records(transformed, suffix)
            validated = [Signal.model_validate(record) for record in transformed]

            filename = f"{Path(case.file).stem}__{suffix}.jsonl"
            path = destination / filename
            with path.open("w", encoding="utf-8") as handle:
                for signal in validated:
                    handle.write(signal.model_dump_json(exclude_none=True))
                    handle.write("\n")

            expected = case.expected
            labels.append(
                {
                    "schema_version": 1,
                    "case_id": f"{case.id}-{suffix}",
                    "parent_id": case.id,
                    "family": case.family,
                    "filename": filename,
                    "file": f"scenarios/{filename}",
                    "seed_file": case.file,
                    "transformation": transformation,
                    "relation": relation,
                    "parameters": parameters,
                    "seed": variant_seed,
                    "expected_actor": expected.actors[0],
                    "expected_actors": expected.actors,
                    "expected_action": expected.actions[0],
                    "expected_actions": expected.actions,
                    "expected_authority": expected.authorities[0],
                    "expected_authorities": expected.authorities,
                    "confidence_band": expected.confidence_band,
                    "forbidden_actions": expected.forbidden_actions,
                }
            )

    labels_path = destination / "labels.json"
    labels_path.write_text(json.dumps(labels, indent=2) + "\n", encoding="utf-8")
    log.info(
        "generated %d controlled variants across %d parents → %s",
        len(labels),
        len(registry.benchmark_cases()),
        destination,
    )
    return labels


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser()
    parser.add_argument("--variants", type=int, default=4)
    parser.add_argument("--seed", type=int, default=1337)
    args = parser.parse_args()

    variants = generate(variants_per_seed=args.variants, seed=args.seed)
    print(f"generated {len(variants)} controlled variants under {SCENARIOS_DIR}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
