import { describe, expect, it } from 'vitest'
import { ConstantProperty, type Entity, type Viewer } from 'cesium'
import {
  addN2YOSatellite,
  deselectN2YOSatellite,
  isN2YOSpacecraftDrawnAt,
  orbitEntityIdForSatellite,
  selectN2YOSatellite,
  SYNTHETIC_SATELLITES,
  type N2YOPositionCache,
  type N2YOSatelliteConfig,
} from './n2yoSatelliteLayer'

// A viewer with an entity collection and nothing else: the layer helpers must
// not reach for the camera, so a helper that flies would throw here.
const fakeViewer = () => {
  const entities = new Map<string, Entity>()
  const viewer = {
    entities: {
      add: (options: { id: string }) => {
        const entity = options as unknown as Entity
        entities.set(options.id, entity)
        return entity
      },
      getById: (id: string) => entities.get(id),
      removeById: (id: string) => entities.delete(id),
    },
  }
  return { viewer: viewer as unknown as Viewer, entities }
}

const labelShown = (entity: Entity | undefined) => {
  const show = entity?.label?.show
  return show instanceof ConstantProperty ? Boolean(show.getValue()) : Boolean(show)
}

// SIM-01's synthetic track: three samples through the pass over Site A.
const simCache: N2YOPositionCache = {
  fetched_at: 'x',
  satellite: { id: 900001, name: 'SIM-01' },
  track: [
    { timestamp: 1_789_916_730, timestamp_utc: '2026-09-20T15:05:30Z', lat: -36.8, lng: 130.9, alt_km: 550 },
    { timestamp: 1_789_916_880, timestamp_utc: '2026-09-20T15:08:00Z', lat: -27.5, lng: 128.5, alt_km: 550 },
    { timestamp: 1_789_917_029, timestamp_utc: '2026-09-20T15:10:29Z', lat: -18.2, lng: 126.1, alt_km: 550 },
  ],
  synthetic: {
    pass: { site: 'Site A', site_lat: -27.5, site_lng: 128.5, closest_approach_utc: '2026-09-20T15:08:00Z' },
  },
}

const gssapConfig: N2YOSatelliteConfig = {
  family: 'GSSAP',
  id: 40099,
  label: 'GSSAP 1',
  cacheUrl: '/orbital/n2yo_40099_positions.json',
}
const gssapCache: N2YOPositionCache = {
  fetched_at: 'x',
  satellite: { id: 40099, name: 'GSSAP 1' },
  track: [
    { timestamp: 1_789_916_730, timestamp_utc: '2026-09-20T15:05:30Z', lat: 1, lng: 10, alt_km: 35_800 },
    { timestamp: 1_789_916_790, timestamp_utc: '2026-09-20T15:06:30Z', lat: 1.1, lng: 10.2, alt_km: 35_800 },
  ],
}

describe('select and deselect a track', () => {
  it('keeps the synthetic spacecraft label on after a deselect (the console names SIM-01 in every frame)', () => {
    const { viewer, entities } = fakeViewer()
    const layer = addN2YOSatellite(viewer, simCache, SYNTHETIC_SATELLITES[0], 55_000)
    expect(layer.entityIds[0]).toBe('n2yo-900001-satellite')
    expect(labelShown(entities.get('n2yo-900001-satellite'))).toBe(true)

    selectN2YOSatellite(viewer, layer)
    expect(labelShown(entities.get('n2yo-900001-satellite'))).toBe(true)
    expect(entities.has(orbitEntityIdForSatellite(900001))).toBe(true)

    deselectN2YOSatellite(viewer, layer)
    expect(labelShown(entities.get('n2yo-900001-satellite'))).toBe(true)
    expect(entities.has(orbitEntityIdForSatellite(900001))).toBe(false)
  })

  it('labels a catalogue object only while selected', () => {
    const { viewer, entities } = fakeViewer()
    const layer = addN2YOSatellite(viewer, gssapCache, gssapConfig, 3_000_000)
    expect(labelShown(entities.get('n2yo-40099-satellite'))).toBe(false)
    selectN2YOSatellite(viewer, layer)
    expect(labelShown(entities.get('n2yo-40099-satellite'))).toBe(true)
    deselectN2YOSatellite(viewer, layer)
    expect(labelShown(entities.get('n2yo-40099-satellite'))).toBe(false)
  })

  it('selecting never touches the camera (the fake viewer has none)', () => {
    const { viewer } = fakeViewer()
    const layer = addN2YOSatellite(viewer, simCache, SYNTHETIC_SATELLITES[0], 55_000)
    expect(() => selectN2YOSatellite(viewer, layer)).not.toThrow()
    expect(selectN2YOSatellite(viewer, layer)).toEqual([orbitEntityIdForSatellite(900001)])
  })
})

describe('isN2YOSpacecraftDrawnAt', () => {
  const layers = [{ cache: simCache, satelliteFamily: 'SIM' as const }]

  it('is true at the synthetic anchor (the pass over Site A), where the bus records are placed', () => {
    expect(isN2YOSpacecraftDrawnAt(layers, -27.5, 128.5)).toBe(true)
    expect(isN2YOSpacecraftDrawnAt(layers, -27.51, 128.49)).toBe(true)
  })

  it('is false for the RF emitter estimate 180 km away and with no layers', () => {
    expect(isN2YOSpacecraftDrawnAt(layers, -26.780895, 126.870233)).toBe(false)
    expect(isN2YOSpacecraftDrawnAt([], -27.5, 128.5)).toBe(false)
  })
})
