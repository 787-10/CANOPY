"""Bus-health adapter: internal-diagnosis signals about a monitored spacecraft.

Demo feeds are JSONL like every other adapter. ``build_bus_health_signal`` is
the dict-shaped builder the production adapter, scenario generators, and tests
use to emit a Signal that matches
``services/bus/schemas/payloads/bus_health.schema.json`` (docs/INTERFACE-SPEC.md §3).
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any

from .common import Signal, build_signal, iter_domain_signals


DOMAIN = "bus_health"
SOURCE = "internal-diagnosis"
COLLECTOR = "megalith-bus-health-adapter"
DEFAULT_METHOD = "rule_fdir+belief"
PRODUCTION_REPLACEMENT = "internal-diagnosis adapter (megalith/adapters/bus_health.py)"

# Vocabulary from docs/INTERFACE-SPEC.md §3. ``nominal`` is a valid event type
# that fusion deliberately ignores.
EVENT_TYPES = frozenset(
    {
        "link_margin_drop",
        "sensor_saturation",
        "attitude_disturbance",
        "unexpected_reset",
        "power_thermal_excursion",
        "orbit_decay",
        "safe_mode_entry",
        "nominal",
    }
)
SUBSYSTEMS = frozenset({"power", "thermal", "comms", "adcs", "propulsion", "cdh", "payload"})
CLOCK_DOMAINS = frozenset({"utc", "tai", "gps", "spacecraft_onboard", "simulation"})
SHAPES = frozenset({"step", "ramp", "drift", "unknown"})
RECOVERY_FIELDS = ("action_id", "target_subsystem", "requires_approval", "rationale")
SATELLITE_ID_PREFIX = "ctb://"


def iter_signals(path: str | Path) -> Iterator[Signal]:
    """Yield bus-health signals from JSONL demo feeds."""
    yield from iter_domain_signals(path, DOMAIN)


def _check_recovery(recovery: Mapping[str, Any] | None) -> dict[str, Any] | None:
    if recovery is None:
        return None
    missing = [key for key in RECOVERY_FIELDS if key not in recovery]
    if missing:
        raise ValueError(f"recommended_recovery is missing fields: {missing}")
    if not isinstance(recovery["requires_approval"], bool):
        raise ValueError("recommended_recovery.requires_approval must be a bool")
    return {key: recovery[key] for key in RECOVERY_FIELDS}


def build_bus_health_signal(
    *,
    signal_id: str,
    ts: str,
    event_type: str,
    summary: str,
    asset: str,
    satellite_id: str,
    subsystem: str,
    symptom: str,
    onset_ts: str,
    onset_clock_domain: str,
    physics_consistency: float,
    confidence: float,
    sim_time_s: float | None = None,
    rate_of_change: float | None = None,
    rate_unit: str | None = None,
    physics_basis: str | None = None,
    shape: str | None = None,
    recommended_recovery: Mapping[str, Any] | None = None,
    norad_cat_id: str | None = None,
    cospar_id: str | None = None,
    sim_identity: str | None = None,
    realism: str = "mock_operational",
    generated_at: str | None = None,
    epoch_utc: str | None = None,
    method: str = DEFAULT_METHOD,
) -> Signal:
    """Construct a canonical ``bus_health`` Signal (docs/INTERFACE-SPEC.md §3).

    ``rate_of_change``, ``rate_unit``, ``shape`` and ``recommended_recovery``
    are always present in the observables and are ``None`` when no window or
    recovery is available. ``sim_time_s`` is required when the onset clock
    domain is ``simulation``; ``epoch_utc`` is recorded in ``provenance.notes``
    so consumers can convert sim time to UTC.
    """
    if event_type not in EVENT_TYPES:
        raise ValueError(f"invalid bus_health event_type: {event_type!r}")
    if subsystem not in SUBSYSTEMS:
        raise ValueError(f"invalid subsystem: {subsystem!r}")
    if onset_clock_domain not in CLOCK_DOMAINS:
        raise ValueError(f"invalid onset_clock_domain: {onset_clock_domain!r}")
    if onset_clock_domain == "simulation" and sim_time_s is None:
        raise ValueError("sim_time_s is required when onset_clock_domain is 'simulation'")
    if shape is not None and shape not in SHAPES:
        raise ValueError(f"invalid shape: {shape!r}")
    if not 0.0 <= physics_consistency <= 1.0:
        raise ValueError("physics_consistency must be between 0 and 1")
    if not satellite_id.startswith(SATELLITE_ID_PREFIX):
        raise ValueError(f"satellite_id must start with {SATELLITE_ID_PREFIX!r}: {satellite_id!r}")

    observables: dict[str, Any] = {
        "subsystem": subsystem,
        "symptom": symptom,
        "onset_ts": onset_ts,
        "onset_clock_domain": onset_clock_domain,
    }
    if sim_time_s is not None:
        observables["sim_time_s"] = float(sim_time_s)
    observables["rate_of_change"] = None if rate_of_change is None else float(rate_of_change)
    observables["rate_unit"] = rate_unit
    observables["physics_consistency"] = float(physics_consistency)
    if physics_basis is not None:
        observables["physics_basis"] = physics_basis
    observables["shape"] = shape
    observables["recommended_recovery"] = _check_recovery(recommended_recovery)
    if norad_cat_id is not None:
        observables["norad_cat_id"] = str(norad_cat_id)
    if cospar_id is not None:
        observables["cospar_id"] = str(cospar_id)
    if sim_identity is not None:
        observables["sim_identity"] = sim_identity

    provenance: dict[str, Any] = {
        "source_id": SOURCE,
        "collector": COLLECTOR,
        "method": method,
    }
    if generated_at is not None:
        provenance["generated_at"] = generated_at
    if epoch_utc is not None:
        provenance["notes"] = f"epoch={epoch_utc}"

    return build_signal(
        signal_id=signal_id,
        ts=ts,
        domain=DOMAIN,
        source=SOURCE,
        realism=realism,
        confidence=confidence,
        payload={
            "event_type": event_type,
            "summary": summary,
            "asset": asset,
            "satellite_id": satellite_id,
            "observables": observables,
        },
        provenance=provenance,
        location={"label": asset},
    )
