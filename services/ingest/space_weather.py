"""Space-weather adapter for NOAA SWPC-derived geospace signals.

Space weather is global: every Signal carries ``location = {"label": "geospace"}``
and no ``satellite_id``. ``build_space_weather_signal`` emits a Signal that
matches ``services/bus/schemas/payloads/space_weather.schema.json``
(docs/INTERFACE-SPEC.md §4). Fixture-backed signals use source ``noaa-swpc``
with realism ``mock_operational``; the live path uses ``noaa-swpc-live`` with
realism ``real_source``.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

from .common import Signal, build_signal, iter_domain_signals


DOMAIN = "space_weather"
SOURCE_FIXTURE = "noaa-swpc"
SOURCE_LIVE = "noaa-swpc-live"
COLLECTOR = "megalith-space-weather-adapter"
LOCATION = {"label": "geospace"}
PRODUCTION_REPLACEMENT = "NOAA SWPC real-time feeds"

# Vocabulary from docs/INTERFACE-SPEC.md §4. ``quiet`` is a valid event type
# that fusion deliberately ignores.
EVENT_TYPES = frozenset(
    {
        "geomagnetic_storm",
        "solar_radio_burst",
        "radiation_enhancement",
        "density_enhancement",
        "quiet",
    }
)
STORM_KP_THRESHOLD = 5.0
SCALE_MAX = 5  # G5 / S5 map to severity 1.0


def iter_signals(path: str | Path) -> Iterator[Signal]:
    """Yield space-weather signals from JSONL demo feeds."""
    yield from iter_domain_signals(path, DOMAIN)


def severity_from_scale(level: int) -> float:
    """Map a NOAA G- or S-scale level (0..5) to the 0..1 severity used in §4."""
    if not 0 <= level <= SCALE_MAX:
        raise ValueError(f"scale level must be between 0 and {SCALE_MAX}: {level!r}")
    return level / SCALE_MAX


def event_type_for_kp(kp: float) -> str:
    """Geomagnetic storm when Kp reaches the §4 trigger, otherwise quiet."""
    return "geomagnetic_storm" if kp >= STORM_KP_THRESHOLD else "quiet"


def build_space_weather_signal(
    *,
    signal_id: str,
    ts: str,
    event_type: str,
    summary: str,
    kp: float,
    dst_nt: float | None,
    f107: float | None,
    severity: float,
    valid_from: str,
    valid_to: str,
    confidence: float = 0.9,
    live: bool = False,
    citation: str | None = None,
    notes: str | None = None,
    generated_at: str | None = None,
    method: str | None = None,
) -> Signal:
    """Construct a canonical ``space_weather`` Signal (docs/INTERFACE-SPEC.md §4)."""
    if event_type not in EVENT_TYPES:
        raise ValueError(f"invalid space_weather event_type: {event_type!r}")
    if not 0.0 <= kp <= 9.0:
        raise ValueError("kp must be between 0 and 9")
    if not 0.0 <= severity <= 1.0:
        raise ValueError("severity must be between 0 and 1")

    source = SOURCE_LIVE if live else SOURCE_FIXTURE
    realism = "real_source" if live else "mock_operational"

    observables: dict[str, Any] = {
        "kp": float(kp),
        "dst_nt": None if dst_nt is None else float(dst_nt),
        "f107": None if f107 is None else float(f107),
        "severity": float(severity),
        "valid_from": valid_from,
        "valid_to": valid_to,
    }

    provenance: dict[str, Any] = {
        "source_id": source,
        "collector": COLLECTOR,
        "method": method or ("live_fetch" if live else "fixture"),
    }
    if citation is not None:
        provenance["citation"] = citation
    if generated_at is not None:
        provenance["generated_at"] = generated_at
    if notes is not None:
        provenance["notes"] = notes

    return build_signal(
        signal_id=signal_id,
        ts=ts,
        domain=DOMAIN,
        source=source,
        realism=realism,
        confidence=confidence,
        payload={
            "event_type": event_type,
            "summary": summary,
            "observables": observables,
        },
        provenance=provenance,
        location=dict(LOCATION),
    )
