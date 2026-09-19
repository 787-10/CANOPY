import { describe, expect, it } from 'vitest'
import {
  groundStationFromPositionCache,
  groundStationsFromSignals,
  mergeGroundStations,
} from './groundStations'
import { makeSignal } from '../test/factories'

const rf = (id: string, overrides: Parameters<typeof makeSignal>[1] = {}) =>
  makeSignal(id, {
    domain: 'rf_ew',
    source: 'ground-station-spectrum-monitor',
    location: { label: 'Uplink interference bearing line', lat: 34.39, lng: 36.32, alt_m: 260 },
    payload: {
      event_type: 'rf_interference',
      summary: 'Directional S-band interference on the SIM-01 uplink frequency.',
      asset: 'SIM-01',
      satellite_id: 'ctb://megalith.demo/sim-01',
      observables: { bearing_deg: 212, radius_m: 16000 },
    },
    ...overrides,
  })

describe('groundStationsFromSignals', () => {
  it('places the station at the ground_station object position, not at the emitter estimate (demo Run B)', () => {
    const stations = groundStationsFromSignals([
      rf('demo-b-003', {
        source: 'site-a-spectrum-monitor',
        location: { label: 'Estimated emitter, bearing 296 deg from Site A', lat: -26.780895, lng: 126.870233, alt_m: 260 },
        payload: {
          event_type: 'rf_interference',
          summary: 's',
          satellite_id: 'ctb://megalith.demo/sim-01',
          observables: {
            bearing_deg: 296,
            emitter_estimate: { lat: -26.780895, lng: 126.870233 },
            ground_station: { name: 'Site A', lat: -27.5, lng: 128.5, alt_m: 310 },
          },
        },
      }),
      rf('demo-b-005', {
        source: 'site-a-telemetry-downlink',
        location: { label: 'SIM-01 pass footprint over Site A', lat: -27.5, lng: 128.5, alt_km: 550 },
        payload: {
          event_type: 'telemetry_degradation',
          summary: 's',
          satellite_id: 'ctb://megalith.demo/sim-01',
          observables: { ground_station: { name: 'Site A', lat: -27.5, lng: 128.5, alt_m: 310 } },
        },
      }),
    ])
    expect(stations).toEqual([
      {
        id: 'station-site-a',
        label: 'Site A',
        lat: -27.5,
        lng: 128.5,
        altM: 310,
        signalIds: ['demo-b-003', 'demo-b-005'],
        satelliteIds: ['ctb://megalith.demo/sim-01'],
      },
    ])
  })

  it('names the station from a string observables.ground_station at the rf_ew signal location', () => {
    const stations = groundStationsFromSignals([
      rf('rf-1', {
        payload: {
          event_type: 'rf_interference',
          summary: 's',
          satellite_id: 'ctb://megalith.demo/sim-01',
          observables: { ground_station: 'Site A', bearing_deg: 212 },
        },
      }),
    ])
    expect(stations).toEqual([
      {
        id: 'station-site-a',
        label: 'Site A',
        lat: 34.39,
        lng: 36.32,
        altM: 260,
        signalIds: ['rf-1'],
        satelliteIds: ['ctb://megalith.demo/sim-01'],
      },
    ])
  })

  it('reads a "Site A" label from the location label when there is no observable', () => {
    const stations = groundStationsFromSignals([
      rf('rf-2', { location: { label: 'Site A uplink monitor', lat: 1, lng: 2 } }),
    ])
    expect(stations[0].label).toBe('Site A')
    expect(stations[0].id).toBe('station-site-a')
  })

  it('falls back to "Ground station" for a ground-station source and merges repeats', () => {
    const stations = groundStationsFromSignals([rf('rf-3'), rf('rf-4')])
    expect(stations).toHaveLength(1)
    expect(stations[0].label).toBe('Ground station')
    expect(stations[0].signalIds).toEqual(['rf-3', 'rf-4'])
  })

  it('ignores signals without a name or a coordinate, and pass footprints at orbital altitude', () => {
    const stations = groundStationsFromSignals([
      makeSignal('orbit-1', { domain: 'orbit' }),
      rf('rf-5', { location: { label: 'Uplink interference bearing line' } }),
      rf('rf-6', {
        source: 'leo-telemetry-downlink',
        location: { label: 'SIM-01 pass footprint', lat: 34.42, lng: 36.38, alt_km: 550 },
        payload: { event_type: 'telemetry_degradation', summary: 's', observables: { ground_station: 'Site A' } },
      }),
    ])
    expect(stations).toEqual([])
  })
})

describe('groundStationFromPositionCache and mergeGroundStations', () => {
  const cache = {
    fetched_at: 'x',
    satellite: { id: 900001, name: 'SIM-01' },
    track: [{ timestamp: 1, timestamp_utc: '2026-09-20T15:05:30Z', lat: 0, lng: 0, alt_km: 550 }],
    synthetic: {
      pass: { site: 'Site A', site_lat: -27.5, site_lng: 128.5, closest_approach_utc: '2026-09-20T15:08:00Z' },
    },
  }

  it('reads the pass site of a synthetic track file', () => {
    expect(groundStationFromPositionCache(cache, 'ctb://megalith.demo/sim-01')).toEqual({
      id: 'station-site-a',
      label: 'Site A',
      lat: -27.5,
      lng: 128.5,
      altM: 0,
      signalIds: [],
      satelliteIds: ['ctb://megalith.demo/sim-01'],
    })
    expect(groundStationFromPositionCache({ ...cache, synthetic: undefined })).toBeNull()
  })

  it('merges the same site from signals and files into one marker', () => {
    const fromSignals = groundStationsFromSignals([
      rf('rf-9', {
        payload: {
          event_type: 'rf_interference',
          summary: 's',
          satellite_id: 'ctb://megalith.demo/sim-01',
          observables: { ground_station: { name: 'Site A', lat: -27.5, lng: 128.5 } },
        },
      }),
    ])
    const merged = mergeGroundStations(fromSignals, [groundStationFromPositionCache(cache, 'ctb://megalith.demo/sim-02')!])
    expect(merged).toHaveLength(1)
    expect(merged[0].signalIds).toEqual(['rf-9'])
    expect(merged[0].satelliteIds).toEqual(['ctb://megalith.demo/sim-01', 'ctb://megalith.demo/sim-02'])
  })
})
