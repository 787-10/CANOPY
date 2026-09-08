#!/usr/bin/env python3
"""Validate CANOPY scenario JSONL files against the Signal data contract."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SCHEMA = ROOT / "services" / "bus" / "schemas" / "signal.schema.json"
DEFAULT_SCENARIOS = ROOT / "scenarios"
DEFAULT_BENCHMARK_SCENARIOS = ROOT / "bench" / "scenarios"

ALLOWED_DOMAINS = {
    "sda",
    "orbit",
    "osint",
    "humint",
    "rf_ew",
    "cyber",
    "pnt",
    "satcom",
    "drone",
    "terrain",
}

ALLOWED_REALISM = {
    "real_source",
    "mock_operational",
    "synthetic_orbital_overlay",
}


def load_json_schema_validator(schema_path: Path):
    if not schema_path.exists():
        return None, f"schema not found: {schema_path}"

    try:
        import jsonschema  # type: ignore
    except ImportError:
        return None, "jsonschema package not installed; running semantic checks only"

    with schema_path.open("r", encoding="utf-8") as handle:
        schema = json.load(handle)

    validator = jsonschema.Draft202012Validator(schema)
    return validator, None


def parse_ts(value: Any) -> datetime:
    if not isinstance(value, str):
        raise ValueError("ts must be a string")
    normalized = value.replace("Z", "+00:00")
    return datetime.fromisoformat(normalized)


def validate_semantics(record: dict[str, Any], path: Path, line_no: int) -> list[str]:
    errors: list[str] = []

    for field in ("id", "ts", "domain", "source", "realism", "confidence", "payload", "provenance"):
        if field not in record:
            errors.append(f"{path}:{line_no}: missing required field '{field}'")

    domain = record.get("domain")
    if domain not in ALLOWED_DOMAINS:
        errors.append(f"{path}:{line_no}: invalid domain {domain!r}")

    realism = record.get("realism")
    if realism not in ALLOWED_REALISM:
        errors.append(f"{path}:{line_no}: invalid realism {realism!r}")

    confidence = record.get("confidence")
    if not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
        errors.append(f"{path}:{line_no}: confidence must be a number from 0 to 1")

    try:
        parse_ts(record.get("ts"))
    except Exception as exc:  # noqa: BLE001 - user-facing validation script
        errors.append(f"{path}:{line_no}: invalid ts: {exc}")

    if not isinstance(record.get("payload"), dict):
        errors.append(f"{path}:{line_no}: payload must be an object")

    provenance = record.get("provenance")
    if not isinstance(provenance, dict):
        errors.append(f"{path}:{line_no}: provenance must be an object")
    else:
        if "source_id" not in provenance:
            errors.append(f"{path}:{line_no}: provenance.source_id is required")

    location = record.get("location")
    if location is not None and not isinstance(location, dict):
        errors.append(f"{path}:{line_no}: location must be an object when present")

    return errors


def validate_file(path: Path, validator: Any | None) -> tuple[int, list[str]]:
    errors: list[str] = []
    records = 0
    previous_ts: datetime | None = None

    with path.open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, start=1):
            stripped = line.strip()
            if not stripped:
                continue

            records += 1
            try:
                record = json.loads(stripped)
            except json.JSONDecodeError as exc:
                errors.append(f"{path}:{line_no}: invalid JSON: {exc}")
                continue

            if not isinstance(record, dict):
                errors.append(f"{path}:{line_no}: record must be a JSON object")
                continue

            if validator is not None:
                for error in sorted(validator.iter_errors(record), key=lambda err: list(err.path)):
                    loc = ".".join(str(part) for part in error.path) or "<root>"
                    errors.append(f"{path}:{line_no}: schema error at {loc}: {error.message}")

            errors.extend(validate_semantics(record, path, line_no))

            try:
                ts = parse_ts(record.get("ts"))
                reordered = (
                    record.get("provenance", {}).get("notes")
                    == "adversarial_reordered_arrival"
                )
                if previous_ts is not None and ts < previous_ts and not reordered:
                    errors.append(f"{path}:{line_no}: timestamp moved backward")
                previous_ts = ts
            except Exception:
                pass

    if records == 0:
        errors.append(f"{path}: no records found")

    return records, errors


def discover_scenarios(paths: list[str]) -> list[Path]:
    if paths:
        return [Path(path).resolve() for path in paths]
    discovered = []
    for directory in (DEFAULT_SCENARIOS, DEFAULT_BENCHMARK_SCENARIOS):
        if directory.exists():
            discovered.extend(directory.glob("*.jsonl"))
    return sorted(discovered)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*", help="Scenario JSONL files to validate")
    parser.add_argument("--schema", default=str(DEFAULT_SCHEMA), help="Path to signal.schema.json")
    args = parser.parse_args()

    validator, warning = load_json_schema_validator(Path(args.schema))
    if warning:
        print(f"warning: {warning}", file=sys.stderr)

    files = discover_scenarios(args.paths)
    if not files:
        print("error: no scenario files found", file=sys.stderr)
        return 2

    total_records = 0
    all_errors: list[str] = []
    for path in files:
        records, errors = validate_file(path, validator)
        total_records += records
        all_errors.extend(errors)

    if all_errors:
        for error in all_errors:
            print(error, file=sys.stderr)
        print(f"failed: {len(all_errors)} errors across {len(files)} files", file=sys.stderr)
        return 1

    print(f"ok: {total_records} records across {len(files)} files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
