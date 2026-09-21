import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearPositionCacheMemory,
  fetchN2YOPositionCache,
  loadN2YOPositionCaches,
  syntheticAnchorPoint,
} from './positionCache'
import { SYNTHETIC_SATELLITES, resolveRequestedSatellite, syntheticSatelliteFor } from './syntheticSatellites'

const track = [
  { timestamp: 1_777_823_306, timestamp_utc: '2026-05-03T15:48:26Z', lat: 10, lng: 20, alt_km: 550 },
  { timestamp: 1_777_823_366, timestamp_utc: '2026-05-03T15:49:26Z', lat: 11, lng: 21, alt_km: 550 },
]

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as unknown as Response
const notFound = () => ({ ok: false, status: 404, json: () => Promise.resolve({}) }) as unknown as Response

beforeEach(() => {
  clearPositionCacheMemory()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('synthetic satellite layer entries', () => {
  it('registers SIM-01, SIM-02 and the flight-only OBJ-1 with synthetic ids, display names and the demo position files', () => {
    expect(SYNTHETIC_SATELLITES.map((satellite) => satellite.label)).toEqual(['SIM-01', 'SIM-02', 'OBJ-1'])
    expect(SYNTHETIC_SATELLITES.map((satellite) => satellite.cacheUrl)).toEqual([
      '/orbital/sim01_positions.json',
      '/orbital/sim02_positions.json',
      '/orbital/obj01_positions.json',
    ])
    // Only the closely-spaced object stays out of the pinned frame by default.
    expect(SYNTHETIC_SATELLITES.filter((satellite) => satellite.flightOnly).map((s) => s.label)).toEqual(['OBJ-1'])
    for (const satellite of SYNTHETIC_SATELLITES) {
      expect(satellite.synthetic).toBe(true)
      expect(satellite.family).toBe('SIM')
      // Never a real catalogue number.
      expect(satellite.id).toBeGreaterThanOrEqual(900000)
      expect(satellite.satelliteId).toMatch(/^ctb:\/\/megalith\.demo\//)
    }
  })

  it('resolves the demo spacecraft by ctb id, display name or short id', () => {
    expect(syntheticSatelliteFor('ctb://megalith.demo/sim-01')?.label).toBe('SIM-01')
    expect(syntheticSatelliteFor('SIM-02')?.cacheUrl).toBe('/orbital/sim02_positions.json')
    expect(syntheticSatelliteFor('sim-01')?.id).toBe(900001)
    expect(syntheticSatelliteFor('ctb://centralblue.dev/leo-science-1')).toBeNull()
    expect(resolveRequestedSatellite('SIM-01')).toBe('ctb://megalith.demo/sim-01')
    expect(resolveRequestedSatellite('ctb://x/y')).toBe('ctb://x/y')
    expect(resolveRequestedSatellite(null)).toBeNull()
  })
})

describe('loadN2YOPositionCaches — missing file guard', () => {
  it('keeps the entries that load and reports the missing synthetic file without failing the layer', async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        url.includes('sim02')
          ? notFound()
          : okJson({ fetched_at: 'x', satellite: { id: 900001, name: 'SIM-01' }, track }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await loadN2YOPositionCaches(SYNTHETIC_SATELLITES)
    expect(result.loaded.map(({ config }) => config.label)).toEqual(['SIM-01', 'OBJ-1'])
    expect(result.loaded[0].cache.track).toHaveLength(2)
    expect(result.missing.map(({ config }) => config.label)).toEqual(['SIM-02'])
    expect(result.missing[0].error).toMatch(/synthetic track not present: HTTP 404/)
  })

  it('treats a file without track points and a network failure as missing too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.includes('sim01')
          ? Promise.resolve(okJson({ fetched_at: 'x', satellite: { id: 1, name: 'x' }, track: [] }))
          : Promise.reject(new Error('offline')),
      ),
    )
    const result = await loadN2YOPositionCaches(SYNTHETIC_SATELLITES)
    expect(result.loaded).toEqual([])
    expect(result.missing).toHaveLength(3)
    expect(result.missing[0].error).toMatch(/did not contain track points/)
    expect(result.missing[1].error).toBe('offline')
    expect(result.missing[2].error).toBe('offline')
  })

  it('caches a parsed file so a second fetch of the same url does not hit the network', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(okJson({ fetched_at: 'x', satellite: { id: 900001, name: 'SIM-01' }, track })),
    )
    vi.stubGlobal('fetch', fetchMock)
    await fetchN2YOPositionCache(SYNTHETIC_SATELLITES[0])
    await fetchN2YOPositionCache(SYNTHETIC_SATELLITES[0])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('syntheticAnchorPoint', () => {
  const cache = {
    fetched_at: 'x',
    satellite: { id: 900001, name: 'SIM-01' },
    track: [
      { timestamp: 1_789_916_730, timestamp_utc: '2026-09-20T15:05:30Z', lat: -36.8, lng: 130.9, alt_km: 550 },
      { timestamp: 1_789_916_880, timestamp_utc: '2026-09-20T15:08:00Z', lat: -27.5, lng: 128.5, alt_km: 550 },
      { timestamp: 1_789_917_029, timestamp_utc: '2026-09-20T15:10:29Z', lat: -18.2, lng: 126.1, alt_km: 550 },
    ],
  }

  it('pins the spacecraft at the sample nearest the pass closest approach', () => {
    const anchored = { ...cache, synthetic: { pass: { closest_approach_utc: '2026-09-20T15:08:05Z' } } }
    expect(syntheticAnchorPoint(anchored).lat).toBe(-27.5)
  })

  it('falls back to the middle of the track without a pass', () => {
    expect(syntheticAnchorPoint(cache).timestamp_utc).toBe('2026-09-20T15:08:00Z')
  })
})
