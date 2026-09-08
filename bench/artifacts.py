"""Immutable, self-describing benchmark run bundles."""
from __future__ import annotations

import json
import platform
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from bench.scoring import Scorecard


def _git_sha() -> str:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        check=False,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip() or "unknown"


def _write_json_exclusive(path: Path, payload: dict) -> None:
    with path.open("x", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")


def write_run_bundle(
    card: Scorecard,
    *,
    output_root: str | Path,
    provider: str,
    model: str,
    suite_id: str,
    multi_agent: bool,
    metadata: dict | None = None,
) -> Path:
    """Persist an immutable run that can be inspected and rescored offline."""
    created_at = datetime.now(UTC)
    run_id = f"{created_at:%Y%m%dT%H%M%S%fZ}-{uuid4().hex[:8]}"
    run_dir = Path(output_root) / f"{run_id}-{suite_id}-{provider}"
    run_dir.mkdir(parents=True, exist_ok=False)

    run_manifest = {
        "run_id": run_id,
        "created_at": created_at.isoformat(),
        "git_sha": _git_sha(),
        "suite_id": suite_id,
        "provider": provider,
        "model": model,
        "multi_agent": multi_agent,
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        **(metadata or {}),
    }
    _write_json_exclusive(run_dir / "run.json", run_manifest)
    _write_json_exclusive(run_dir / "summary.json", card.to_dict())

    with (run_dir / "items.jsonl").open("x", encoding="utf-8") as handle:
        for item in card.items:
            handle.write(json.dumps(item, separators=(",", ":")))
            handle.write("\n")

    failures_dir = run_dir / "failures"
    failures_dir.mkdir()
    for result, item in zip(card.results, card.items, strict=False):
        if (
            result.actor_correct
            and result.action_correct
            and result.authority_correct
            and not result.forbidden_action
        ):
            continue
        case_id = result.case_id or Path(result.file).stem
        _write_json_exclusive(failures_dir / f"{case_id}.json", item)

    return run_dir
