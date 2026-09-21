"""Engine-owned ephemeris (docs/MEGALITH-Flight-Plan.md stage 5, spec §10 1.4.4).

The synthetic spacecraft fly a circular Keplerian orbit over a spherical
Earth with uniform sidereal rotation, defined by one ascending pass over a
point (``megalith/scenarios/demo/tracks.py`` writes the track files and the
console's ``src/lib/orbit`` port draws them). This module is the engine's
copy of that model, read from the same track files, so positions can be
published on the bus as ``Ephemeris`` events: one authority, and the console
consumes rather than computes while a run is in progress. Oracle tests pin
it to every point of every file. Synthetic bodies only: no TLE, no SGP4.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from canopy.services.bus import Bus
from canopy.services.schemas.events import Ephemeris

log = logging.getLogger(__name__)

__all__ = [
    "Body",
    "CircularOrbit",
    "DEFAULT_CADENCE_S",
    "EphemerisService",
    "gmst_rad",
    "load_bodies",
]

EARTH_RADIUS_KM = 6371.0
EARTH_MU_KM3_S2 = 398600.4418
#: Wall seconds between samples while a run is in progress.
DEFAULT_CADENCE_S = 1.0


def gmst_rad(when: datetime) -> float:
    """Greenwich mean sidereal time (IAU 1982) on Unix seconds; the generator's formula."""
    unix = when.timestamp()
    days = unix / 86400.0
    t = days / 36525.0
    gmst_s = 67310.54841 + (876600.0 * 3600.0 + 8640184.812866) * t + 0.093104 * t * t - 6.2e-6 * t**3
    seconds = gmst_s % 86400.0
    return (seconds / 86400.0) * 2.0 * math.pi


@dataclass(frozen=True)
class CircularOrbit:
    """One body's circular orbit from its defining ascending pass."""

    altitude_km: float
    inclination_deg: float
    pass_time: datetime
    pass_lat: float
    pass_lng: float

    @classmethod
    def from_synthetic_block(cls, block: dict[str, Any]) -> CircularOrbit | None:
        orbit = block.get("orbit") if isinstance(block, dict) else None
        if not isinstance(orbit, dict):
            return None
        try:
            return cls(
                altitude_km=float(orbit["altitude_km"]),
                inclination_deg=float(orbit["inclination_deg"]),
                pass_time=datetime.fromisoformat(str(orbit["pass_utc"]).replace("Z", "+00:00")),
                pass_lat=float(orbit["pass_lat"]),
                pass_lng=float(orbit["pass_lng"]),
            )
        except (KeyError, TypeError, ValueError):
            return None

    @property
    def radius_km(self) -> float:
        return EARTH_RADIUS_KM + self.altitude_km

    @property
    def period_s(self) -> float:
        return 2 * math.pi * math.sqrt(self.radius_km**3 / EARTH_MU_KM3_S2)

    @property
    def mean_motion_rad_s(self) -> float:
        return 2 * math.pi / self.period_s

    @property
    def speed_km_s(self) -> float:
        return self.radius_km * self.mean_motion_rad_s

    def argument_of_latitude_at_pass(self) -> float:
        inc = math.radians(self.inclination_deg)
        ratio = math.sin(math.radians(self.pass_lat)) / math.sin(inc)
        if abs(ratio) > 1.0:
            raise ValueError("the pass latitude exceeds the orbit's inclination")
        return math.asin(ratio)

    def raan_rad(self) -> float:
        inc = math.radians(self.inclination_deg)
        u = self.argument_of_latitude_at_pass()
        lon_in_plane = math.atan2(math.cos(inc) * math.sin(u), math.cos(u))
        return math.radians(self.pass_lng) + gmst_rad(self.pass_time) - lon_in_plane

    def subpoint(self, when: datetime) -> tuple[float, float, float]:
        """(lat, lng, alt_km) of the sub-satellite point at ``when``."""
        inc = math.radians(self.inclination_deg)
        dt = (when - self.pass_time).total_seconds()
        u = self.argument_of_latitude_at_pass() + self.mean_motion_rad_s * dt
        lat = math.asin(math.sin(inc) * math.sin(u))
        lon_in_plane = math.atan2(math.cos(inc) * math.sin(u), math.cos(u))
        lng = self.raan_rad() + lon_in_plane - gmst_rad(when)
        lng_deg = ((math.degrees(lng) + 540.0) % 360.0) - 180.0
        return math.degrees(lat), lng_deg, self.altitude_km

    def elements(self) -> dict[str, Any]:
        return {
            "altitude_km": self.altitude_km,
            "inclination_deg": self.inclination_deg,
            "pass_utc": self.pass_time.astimezone(UTC).isoformat().replace("+00:00", "Z"),
            "pass_lat": self.pass_lat,
            "pass_lng": self.pass_lng,
            "period_s": round(self.period_s, 1),
        }


@dataclass(frozen=True)
class Body:
    """A synthetic spacecraft the engine propagates."""

    satellite_id: str
    name: str
    orbit: CircularOrbit

    @property
    def topic(self) -> str:
        return f"ephemeris.{self.satellite_id.rsplit('/', 1)[-1]}"

    def sample(self, when: datetime) -> Ephemeris:
        lat, lng, alt = self.orbit.subpoint(when)
        return Ephemeris(
            ts=when,
            satellite_id=self.satellite_id,
            lat=lat,
            lng=lng,
            alt_km=alt,
            speed_km_s=self.orbit.speed_km_s,
            elements=self.orbit.elements(),
        )


def load_bodies(orbital_dir: str | Path) -> list[Body]:
    """The synthetic bodies whose track files carry a defining pass, by file name."""
    bodies: list[Body] = []
    for path in sorted(Path(orbital_dir).glob("*_positions.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            log.warning("ephemeris: skipping %s: %s", path.name, exc)
            continue
        synthetic = payload.get("synthetic") if isinstance(payload, dict) else None
        if not isinstance(synthetic, dict):
            continue  # a real cache (not present on the demo branch), never propagated here
        orbit = CircularOrbit.from_synthetic_block(synthetic)
        satellite_id = synthetic.get("satellite_id")
        if orbit is None or not isinstance(satellite_id, str) or not satellite_id:
            continue
        name = str((payload.get("satellite") or {}).get("name") or satellite_id)
        bodies.append(Body(satellite_id=satellite_id, name=name, orbit=orbit))
    return bodies


class EphemerisService:
    """Publishes an ``Ephemeris`` per body on a wall cadence while a run is in progress.

    ``scenario_time`` returns the run's current scenario time (the gateway's
    replay timeline, ``_replay_now_ts``) or ``None`` when no run is in
    progress; nothing is published then and the console falls back to its own
    model. ``cadence_s`` is wall time, so the stream is one sample per body per
    second at every rate.
    """

    def __init__(
        self,
        bus: Bus,
        bodies: Iterable[Body],
        *,
        scenario_time: Callable[[], datetime | None],
        cadence_s: float = DEFAULT_CADENCE_S,
    ) -> None:
        if cadence_s <= 0:
            raise ValueError("cadence_s must be positive")
        self._bus = bus
        self._bodies = list(bodies)
        self._scenario_time = scenario_time
        self._cadence_s = cadence_s
        self.published = 0

    @property
    def bodies(self) -> list[Body]:
        return list(self._bodies)

    async def publish_once(self, when: datetime | None = None) -> int:
        """Publish one sample per body at ``when`` (default: the run's time). Returns the count."""
        at = when if when is not None else self._scenario_time()
        if at is None:
            return 0
        for body in self._bodies:
            await self._bus.publish(body.topic, body.sample(at))
            self.published += 1
        return len(self._bodies)

    async def run(self) -> None:
        while True:
            try:
                await self.publish_once()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - the stream must outlive one bad tick
                log.exception("ephemeris: publish failed")
            await asyncio.sleep(self._cadence_s)
