"""Shared helpers for CANOPY ingest adapters."""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

Signal = dict[str, Any]

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
    "bus_health",
    "space_weather",
}

ALLOWED_REALISM = {
    "real_source",
    "mock_operational",
    "synthetic_orbital_overlay",
}


def read_jsonl(path: str | Path) -> Iterator[Signal]:
    """Yield JSON objects from a JSONL file."""
    with Path(path).open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            record = json.loads(stripped)
            if not isinstance(record, dict):
                raise ValueError(f"{path}:{line_no}: expected JSON object")
            yield record


def ensure_domain(signal: Signal, domain: str) -> Signal:
    """Return a signal after checking that it belongs to the adapter domain."""
    if domain not in ALLOWED_DOMAINS:
        raise ValueError(f"unknown adapter domain: {domain}")
    if signal.get("domain") != domain:
        raise ValueError(f"signal {signal.get('id')} has domain {signal.get('domain')}, expected {domain}")
    realism = signal.get("realism")
    if realism not in ALLOWED_REALISM:
        raise ValueError(f"signal {signal.get('id')} has invalid realism {realism}")
    return signal


def iter_domain_signals(path: str | Path, domain: str) -> Iterator[Signal]:
    """Yield only signals matching the requested domain from a JSONL file."""
    for signal in read_jsonl(path):
        if signal.get("domain") == domain:
            yield ensure_domain(signal, domain)


def build_signal(
    *,
    signal_id: str,
    ts: str,
    domain: str,
    source: str,
    realism: str,
    confidence: float,
    payload: dict[str, Any],
    provenance: dict[str, Any],
    location: dict[str, Any] | None = None,
) -> Signal:
    """Construct a canonical Signal object."""
    if domain not in ALLOWED_DOMAINS:
        raise ValueError(f"invalid domain: {domain}")
    if realism not in ALLOWED_REALISM:
        raise ValueError(f"invalid realism: {realism}")

    signal: Signal = {
        "id": signal_id,
        "ts": ts,
        "domain": domain,
        "source": source,
        "realism": realism,
        "confidence": confidence,
        "payload": payload,
        "provenance": provenance,
    }
    if location is not None:
        signal["location"] = location
    return signal

