import { beforeEach, describe, expect, it } from 'vitest'
import { EPHEMERIS_FRESH_MS, freshEphemeris, useEphemerisStore } from './ephemerisStore'
import type { Ephemeris } from '../types/canopy'

const sample = (satellite_id: string, ts: string): Ephemeris => ({
  id: `e-${satellite_id}-${ts}`,
  ts,
  marking: 'U',
  satellite_id,
  source: 'circular-model',
  lat: -27.5,
  lng: 128.5,
  alt_km: 550,
  speed_km_s: 7.585,
  elements: { altitude_km: 550, inclination_deg: 97.6, pass_utc: '2026-09-20T15:08:00Z', pass_lat: -27.5, pass_lng: 128.5 },
  published_at: '2026-09-21T12:00:00Z',
})

describe('ephemeris store', () => {
  beforeEach(() => useEphemerisStore.getState().reset())

  it('keeps the latest sample per spacecraft and forgets on reset', () => {
    const store = useEphemerisStore.getState()
    store.ingest(sample('ctb://megalith.demo/sim-01', '2026-09-20T15:08:00Z'), 1000)
    store.ingest(sample('ctb://megalith.demo/sim-01', '2026-09-20T15:08:01Z'), 2000)
    store.ingest(sample('ctb://megalith.demo/obj-01', '2026-09-20T15:08:01Z'), 2000)
    const latest = useEphemerisStore.getState().latest
    expect(Object.keys(latest).sort()).toEqual(['ctb://megalith.demo/obj-01', 'ctb://megalith.demo/sim-01'])
    expect(latest['ctb://megalith.demo/sim-01']!.sample.ts).toBe('2026-09-20T15:08:01Z')
    useEphemerisStore.getState().reset()
    expect(useEphemerisStore.getState().latest).toEqual({})
  })

  it('counts a sample as the engine speaking only while it is fresh', () => {
    useEphemerisStore.getState().ingest(sample('ctb://megalith.demo/sim-01', '2026-09-20T15:08:00Z'), 10_000)
    const latest = useEphemerisStore.getState().latest
    expect(freshEphemeris(latest, 'ctb://megalith.demo/sim-01', 10_000 + EPHEMERIS_FRESH_MS)).not.toBeNull()
    expect(freshEphemeris(latest, 'ctb://megalith.demo/sim-01', 10_001 + EPHEMERIS_FRESH_MS)).toBeNull()
    expect(freshEphemeris(latest, 'ctb://megalith.demo/sim-02', 10_000)).toBeNull()
  })
})
