// Look angles and visibility from a ground site, ported from `_look_angles`
// in megalith/scenarios/demo/tracks.py: spherical Earth, the site's
// east-north-up frame. Elevation is always computed here, from the
// propagator's latitude, longitude and true altitude, never from rendered
// Cartesians, so the mask and the generator agree.
import { EARTH_RADIUS_KM, type CircularOrbit, type Subpoint } from './kepler'

export type Site = { lat: number; lng: number; altM: number }
export type LookAngles = { azimuthDeg: number; elevationDeg: number; rangeKm: number }

const RAD = Math.PI / 180
const DEG = 180 / Math.PI

export function lookAngles(sub: Subpoint, site: Site): LookAngles {
  const ro = EARTH_RADIUS_KM + site.altM / 1000
  const rs = EARTH_RADIUS_KM + sub.altKm
  const po = site.lat * RAD
  const lo = site.lng * RAD
  const ps = sub.lat * RAD
  const ls = sub.lng * RAD
  const ox = ro * Math.cos(po) * Math.cos(lo)
  const oy = ro * Math.cos(po) * Math.sin(lo)
  const oz = ro * Math.sin(po)
  const dx = rs * Math.cos(ps) * Math.cos(ls) - ox
  const dy = rs * Math.cos(ps) * Math.sin(ls) - oy
  const dz = rs * Math.sin(ps) - oz
  const ux = ox / ro
  const uy = oy / ro
  const uz = oz / ro
  const ex = -Math.sin(lo)
  const ey = Math.cos(lo)
  const nx = -Math.sin(po) * Math.cos(lo)
  const ny = -Math.sin(po) * Math.sin(lo)
  const nz = Math.cos(po)
  const de = dx * ex + dy * ey
  const dn = dx * nx + dy * ny + dz * nz
  const du = dx * ux + dy * uy + dz * uz
  const rangeKm = Math.sqrt(de * de + dn * dn + du * du)
  return {
    azimuthDeg: ((Math.atan2(de, dn) * DEG) % 360 + 360) % 360,
    elevationDeg: Math.asin(du / rangeKm) * DEG,
    rangeKm,
  }
}

/** Ground radius of the circle from which a spacecraft at `altKm` is seen at
 *  or above `maskDeg`: ψ = acos(R / (R + h) · cos e) − e, times R. */
export function footprintRadiusKm(altKm: number, maskDeg: number): number {
  const e = maskDeg * RAD
  const psi = Math.acos((EARTH_RADIUS_KM / (EARTH_RADIUS_KM + altKm)) * Math.cos(e)) - e
  return EARTH_RADIUS_KM * psi
}

export type VisibilityWindow = { aosMs: number | null; losMs: number | null }

/** AOS and LOS at `maskDeg` within `scanS` seconds either side of `aroundMs`,
 *  scanned at one second like the generator's `visibility_window`. */
export function visibilityWindow(
  orbit: CircularOrbit,
  site: Site,
  aroundMs: number,
  maskDeg: number,
  scanS = 900,
): VisibilityWindow {
  let aosMs: number | null = null
  let losMs: number | null = null
  let above = false
  const sub: Subpoint = { lat: 0, lng: 0, altKm: 0 }
  for (let offset = -scanS; offset <= scanS; offset += 1) {
    const t = aroundMs + offset * 1000
    const { elevationDeg } = lookAngles(orbit.subpointAt(t, sub), site)
    // The generator compares an elevation rounded to two decimals.
    const nowAbove = Math.round(elevationDeg * 100) / 100 >= maskDeg
    if (nowAbove && !above && aosMs === null) aosMs = t
    if (above && !nowAbove && aosMs !== null && losMs === null) losMs = t
    above = nowAbove
  }
  return { aosMs, losMs }
}

/** The next acquisition at or above `maskDeg` after `fromMs`, within a day:
 *  a coarse forward scan then a one-second refinement. */
export function nextAos(orbit: CircularOrbit, site: Site, fromMs: number, maskDeg: number): number | null {
  const sub: Subpoint = { lat: 0, lng: 0, altKm: 0 }
  const isAbove = (t: number) => lookAngles(orbit.subpointAt(t, sub), site).elevationDeg >= maskDeg
  let t = fromMs
  const end = fromMs + 86400 * 1000
  let wasAbove = isAbove(t)
  for (; t <= end; t += 10_000) {
    const above = isAbove(t)
    if (above && !wasAbove) {
      for (let fine = t - 10_000; fine <= t; fine += 1000) if (isAbove(fine)) return fine
      return t
    }
    wasAbove = above
  }
  return null
}
