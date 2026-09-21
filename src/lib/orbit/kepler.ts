// The synthetic spacecraft's orbit as the generator defines it
// (megalith/scenarios/demo/tracks.py, class OrbitSpec): a circular orbit over
// a spherical Earth with uniform sidereal rotation, fixed by an ascending pass
// through a recorded point at a recorded time. Enough for a plausible LEO
// ground track, not an ephemeris, and not an engine input. Pure functions on
// Unix milliseconds so vitest can pin them to the generated files.
import type { SyntheticTrackInfo } from '../positionCache'
import { gmstRad, posmod } from './gmst'

export const EARTH_RADIUS_KM = 6371.0
export const EARTH_MU_KM3_S2 = 398600.4418

export type OrbitElements = {
  altitudeKm: number
  inclinationDeg: number
  /** The ascending pass the orbit is defined by: the sub-satellite point... */
  passUtcMs: number
  /** ...at this latitude and longitude, degrees. */
  passLat: number
  passLng: number
}

export type Subpoint = { lat: number; lng: number; altKm: number }

const RAD = Math.PI / 180
const DEG = 180 / Math.PI

/** Longitude wrapped to [-180, 180) the way the generator does it. */
export const wrapLongitude = (degrees: number): number => posmod(degrees + 540.0, 360.0) - 180.0

/** The elements from a track file's `synthetic` block, or null when the file
 *  predates them (before 1.4.3 the block carried no defining pass). */
export function elementsFromSynthetic(block: SyntheticTrackInfo | undefined): OrbitElements | null {
  const orbit = block?.orbit
  if (!orbit) return null
  const { altitude_km, inclination_deg, pass_utc, pass_lat, pass_lng } = orbit
  if (
    typeof altitude_km !== 'number' ||
    typeof inclination_deg !== 'number' ||
    typeof pass_utc !== 'string' ||
    typeof pass_lat !== 'number' ||
    typeof pass_lng !== 'number'
  ) {
    return null
  }
  const passUtcMs = Date.parse(pass_utc)
  if (!Number.isFinite(passUtcMs)) return null
  return { altitudeKm: altitude_km, inclinationDeg: inclination_deg, passUtcMs, passLat: pass_lat, passLng: pass_lng }
}

export class CircularOrbit {
  readonly elements: OrbitElements
  readonly radiusKm: number
  readonly periodS: number
  readonly meanMotionRadS: number
  private readonly inclinationRad: number
  private readonly argumentAtPass: number
  private readonly raanRad: number

  constructor(elements: OrbitElements) {
    this.elements = elements
    this.radiusKm = EARTH_RADIUS_KM + elements.altitudeKm
    this.periodS = 2 * Math.PI * Math.sqrt(this.radiusKm ** 3 / EARTH_MU_KM3_S2)
    this.meanMotionRadS = (2 * Math.PI) / this.periodS
    this.inclinationRad = elements.inclinationDeg * RAD
    const ratio = Math.sin(elements.passLat * RAD) / Math.sin(this.inclinationRad)
    if (Math.abs(ratio) > 1) throw new RangeError('the pass latitude exceeds the orbit inclination')
    this.argumentAtPass = Math.asin(ratio) // ascending branch
    const lonInPlane = this.longitudeInPlane(this.argumentAtPass)
    this.raanRad = elements.passLng * RAD + gmstRad(elements.passUtcMs / 1000) - lonInPlane
  }

  private longitudeInPlane(u: number): number {
    return Math.atan2(Math.cos(this.inclinationRad) * Math.sin(u), Math.cos(u))
  }

  /** The Greenwich hour angle of the ascending node, radians (for tests). */
  get raan(): number {
    return this.raanRad
  }

  /** Argument of latitude at the defining pass, radians (for tests). */
  get argumentOfLatitudeAtPass(): number {
    return this.argumentAtPass
  }

  /** Sub-satellite point at a Unix millisecond time. */
  subpointAt(unixMs: number, result: Subpoint = { lat: 0, lng: 0, altKm: 0 }): Subpoint {
    const dt = (unixMs - this.elements.passUtcMs) / 1000
    const u = this.argumentAtPass + this.meanMotionRadS * dt
    result.lat = Math.asin(Math.sin(this.inclinationRad) * Math.sin(u)) * DEG
    result.lng = wrapLongitude((this.raanRad + this.longitudeInPlane(u) - gmstRad(unixMs / 1000)) * DEG)
    result.altKm = this.elements.altitudeKm
    return result
  }

  /** The instantaneous orbit as `count` sub-points in the Earth-fixed frame at
   *  one moment: the inertial circle rotated by that moment's sidereal time,
   *  so it drifts westward with the ground track rather than sitting still. */
  ring(unixMs: number, count = 240): Subpoint[] {
    const gmst = gmstRad(unixMs / 1000)
    const points: Subpoint[] = []
    for (let index = 0; index <= count; index += 1) {
      const u = (index / count) * 2 * Math.PI
      points.push({
        lat: Math.asin(Math.sin(this.inclinationRad) * Math.sin(u)) * DEG,
        lng: wrapLongitude((this.raanRad + this.longitudeInPlane(u) - gmst) * DEG),
        altKm: this.elements.altitudeKm,
      })
    }
    return points
  }
}
