import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ENGINE_DISAGREEMENT_KM, LABEL_OFFSETS, engineCheck, flightBodyFor, flightReadout, flightSatelliteNumber, isFlightSatelliteEntityId, flightSatelliteId, labelOffsetFor } from './flightLayer'
import type { N2YOLayerState } from './n2yoSatelliteLayer'
import type { N2YOPositionCache } from './positionCache'

const cache: N2YOPositionCache = JSON.parse(
  readFileSync(resolve(process.cwd(), 'public', 'orbital', 'sim01_positions.json'), 'utf8'),
)
const layer: N2YOLayerState = {
  cache,
  displayAltitudeM: 55_000,
  entityIds: ['n2yo-900001-satellite', 'n2yo-900001-footprint'],
  point: cache.track[0]!,
  satelliteFamily: 'SIM',
  satelliteId: 900001,
  satelliteName: 'SIM-01',
}

describe('flight body', () => {
  it('reads the defining pass, the site and the mask from the track file', () => {
    const body = flightBodyFor(layer)!
    expect(body).not.toBeNull()
    expect(body.site).toEqual({ lat: -27.5, lng: 128.5, altM: 310 })
    expect(body.maskDeg).toBe(5)
    expect(body.entityIds).toEqual(['flight-900001-satellite', 'flight-900001-ring', 'flight-900001-footprint'])
  })

  it('stays pinned (null) for a file without the defining pass', () => {
    const legacy = { ...layer, cache: { ...cache, synthetic: { ...cache.synthetic, orbit: { altitude_km: 550 } } } }
    expect(flightBodyFor(legacy)).toBeNull()
  })

  it('maps entity ids back to the layer', () => {
    expect(isFlightSatelliteEntityId(flightSatelliteId(900001))).toBe(true)
    expect(isFlightSatelliteEntityId('n2yo-900001-satellite')).toBe(false)
    expect(flightSatelliteNumber('flight-900001-satellite')).toBe(900001)
    expect(flightSatelliteNumber('flight-900001-ring')).toBe(900001)
    expect(flightSatelliteNumber('station-site-a')).toBeNull()
  })
})

describe('flight readout', () => {
  const body = flightBodyFor(layer)!
  const passMs = Date.parse(cache.synthetic!.orbit!.pass_utc!)

  it('at the pass: overhead, visible, and sets at the recorded LOS', () => {
    const readout = flightReadout(body, passMs)!
    expect(readout.visible).toBe(true)
    expect(readout.elevationDeg).toBeGreaterThan(89.9)
    expect(readout.losMs).toBe(Date.parse(cache.synthetic!.pass!.los_utc!))
    expect(readout.nextAosMs).toBeNull()
  })

  it('two hours before the pass: below the horizon, next acquisition at the recorded AOS', () => {
    const readout = flightReadout(body, passMs - 2 * 3600_000)!
    expect(readout.visible).toBe(false)
    expect(readout.losMs).toBeNull()
    expect(Math.abs(readout.nextAosMs! - Date.parse(cache.synthetic!.pass!.aos_utc!))).toBeLessThanOrEqual(1000)
  })

  it('is null for a body whose file names no site', () => {
    const noSite = flightBodyFor({ ...layer, cache: { ...cache, synthetic: { ...cache.synthetic, pass: undefined } } })!
    expect(noSite.site).toBeNull()
    expect(flightReadout(noSite, passMs)).toBeNull()
  })
})

describe('label placement for N bodies', () => {
  it('cycles above, below, right, left so closely-spaced marks keep their names apart', () => {
    expect(LABEL_OFFSETS).toHaveLength(4)
    expect([labelOffsetFor(0).x, labelOffsetFor(0).y]).toEqual([0, -42])
    expect([labelOffsetFor(1).x, labelOffsetFor(1).y]).toEqual([0, 46])
    expect(labelOffsetFor(2).x).toBeGreaterThan(0)
    expect(labelOffsetFor(3).x).toBeLessThan(0)
    expect([labelOffsetFor(4).x, labelOffsetFor(4).y]).toEqual([0, -42])
  })
})

describe('engine check', () => {
  const body = flightBodyFor(layer)!
  it('agrees with an engine sample of the same model to metres, and measures a disagreement', () => {
    const at = Date.parse(cache.synthetic!.orbit!.pass_utc!) + 400_000
    const ours = body.orbit.subpointAt(at)
    const same = engineCheck(body, { ts: new Date(at).toISOString(), lat: ours.lat, lng: ours.lng })!
    expect(same.sampleMs).toBe(at)
    expect(same.separationKm).toBeLessThan(0.001)
    const off = engineCheck(body, { ts: new Date(at).toISOString(), lat: ours.lat + 0.1, lng: ours.lng })!
    expect(off.separationKm).toBeGreaterThan(ENGINE_DISAGREEMENT_KM)
    expect(off.separationKm).toBeCloseTo(11.1, 0)
    expect(engineCheck(body, { ts: 'nope', lat: 0, lng: 0 })).toBeNull()
  })
})
