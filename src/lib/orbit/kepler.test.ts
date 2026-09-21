import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { N2YOPositionCache } from '../positionCache'
import { gmstRad, posmod } from './gmst'
import { CircularOrbit, elementsFromSynthetic, wrapLongitude } from './kepler'
import { footprintRadiusKm, lookAngles, visibilityWindow } from './lookAngles'

// The oracle is the generated files themselves (megalith/scenarios/demo/tracks.py
// writes them; CI compares them byte for byte across platforms). The port never
// writes JSON; it must reproduce every point the generator wrote.
const load = (name: string): N2YOPositionCache =>
  JSON.parse(readFileSync(resolve(process.cwd(), 'public', 'orbital', `${name}_positions.json`), 'utf8'))

const SIM01 = load('sim01')
const SIM02 = load('sim02')
const SITE_A = { lat: -27.5, lng: 128.5, altM: 310 }

// From the generator, python: tracks._gmst_rad(spec.pass_time), spec._raan_rad(),
// spec._argument_of_latitude_at_pass(), spec.subpoint(pass + 1000 s).
const PY = {
  sim01: { gmst: 3.9535542996500417, raan: 6.126787942532909, u0: -0.48458454065884854, plus1000: [34.70871654680497, 115.0361804579635] },
  sim02: { gmst: 3.9666801074207183, raan: 6.2487352713657875, u0: -0.47046521021360765, plus1000: [35.507052123051224, 121.11131605238711] },
}

const orbitOf = (cache: N2YOPositionCache) => {
  const elements = elementsFromSynthetic(cache.synthetic)
  if (!elements) throw new Error('synthetic block lacks the defining pass')
  return new CircularOrbit(elements)
}

describe('gmst and modulo', () => {
  it('posmod takes the sign of the divisor like Python', () => {
    expect(posmod(-1, 360)).toBe(359)
    expect(posmod(361, 360)).toBe(1)
    expect(posmod(-540, 360)).toBe(180)
  })

  it('reproduces the generator at both pass epochs', () => {
    expect(gmstRad(Date.parse(SIM01.synthetic!.orbit!.pass_utc!) / 1000)).toBeCloseTo(PY.sim01.gmst, 12)
    expect(gmstRad(Date.parse(SIM02.synthetic!.orbit!.pass_utc!) / 1000)).toBeCloseTo(PY.sim02.gmst, 12)
  })

  it('wraps longitude to [-180, 180) as the generator does', () => {
    expect(wrapLongitude(180)).toBe(-180)
    expect(wrapLongitude(-180)).toBe(-180)
    expect(wrapLongitude(190)).toBe(-170)
    expect(wrapLongitude(-190)).toBe(170)
    expect(wrapLongitude(128.5)).toBeCloseTo(128.5, 12)
  })
})

describe.each([
  ['SIM-01', SIM01, PY.sim01],
  ['SIM-02', SIM02, PY.sim02],
])('circular orbit port: %s', (_name, cache, py) => {
  const orbit = orbitOf(cache)

  it('derives the same node and phase as the generator', () => {
    expect(orbit.argumentOfLatitudeAtPass).toBeCloseTo(py.u0, 12)
    expect(orbit.raan).toBeCloseTo(py.raan, 12)
    expect(orbit.periodS).toBeCloseTo(cache.synthetic!.orbit!.period_s!, 1)
  })

  it('reproduces every track point within 1e-6 degrees', () => {
    let worst = 0
    for (const point of cache.track) {
      const sub = orbit.subpointAt(point.timestamp * 1000)
      worst = Math.max(worst, Math.abs(sub.lat - point.lat), Math.abs(sub.lng - point.lng))
      expect(sub.altKm).toBe(point.alt_km)
    }
    expect(worst).toBeLessThanOrEqual(1e-6)
  })

  it('reproduces every orbit point within 1e-6 degrees', () => {
    // The generator samples one period from the epoch in 360 equal steps and
    // writes each timestamp to whole seconds; near the poles a second is
    // almost half a degree of longitude, so the sample times are rebuilt from
    // the epoch and the step rather than parsed from the truncated strings.
    const epochMs = Date.parse(cache.synthetic!.epoch_utc!)
    const stepMs = (orbit.periodS / (cache.orbit.length - 1)) * 1000
    let worst = 0
    cache.orbit.forEach((point, index) => {
      const sampleMs = epochMs + index * stepMs
      expect(Math.abs(Date.parse(point.timestamp_utc) - sampleMs)).toBeLessThan(1000)
      const sub = orbit.subpointAt(sampleMs)
      worst = Math.max(worst, Math.abs(sub.lat - point.lat), Math.abs(sub.lng - point.lng))
    })
    expect(worst).toBeLessThanOrEqual(1e-6)
  })

  it('matches the generator far from the pass and across the antimeridian', () => {
    const passMs = orbit.elements.passUtcMs
    const sub = orbit.subpointAt(passMs + 1000 * 1000)
    expect(sub.lat).toBeCloseTo(py.plus1000[0], 9)
    expect(sub.lng).toBeCloseTo(py.plus1000[1], 9)
    for (const point of orbit.ring(passMs)) {
      expect(point.lng).toBeGreaterThanOrEqual(-180)
      expect(point.lng).toBeLessThan(180)
    }
  })

  it('reproduces the recorded max elevation, AOS and LOS from Site A', () => {
    const pass = cache.synthetic!.pass!
    let best = -90
    for (const point of cache.track) {
      best = Math.max(best, lookAngles(orbit.subpointAt(point.timestamp * 1000), SITE_A).elevationDeg)
    }
    expect(best).toBeCloseTo(pass.max_elevation_deg!, 1)
    const window = visibilityWindow(orbit, SITE_A, orbit.elements.passUtcMs, pass.mask_deg!)
    expect(window.aosMs).toBe(Date.parse(pass.aos_utc!))
    expect(window.losMs).toBe(Date.parse(pass.los_utc!))
  })
})

describe('footprint', () => {
  it('gives the red team\'s radii for 550 km', () => {
    expect(footprintRadiusKm(550, 0)).toBeCloseTo(2557, 0)
    expect(footprintRadiusKm(550, 5)).toBeCloseTo(2058, 0)
    expect(footprintRadiusKm(550, 10)).toBeCloseTo(1664, 0)
  })
})
