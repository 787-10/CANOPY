// Ground-station markers derived from the signal stream. The demo scenarios
// carry the station's position on the rf_ew report that a ground monitor
// produced (its `location` is the monitor, the bearing line starts there);
// the name arrives as `observables.ground_station` when the scenario sets
// one, else in the location label ("Site A ..."), else the source is a
// ground-station monitor and the marker is called "Ground station".
import type { Signal } from '../types/canopy'
import type { N2YOPositionCache } from './positionCache'
import { signalCoordinate } from './signalLocation'

export type GroundStation = {
  /** Stable id for map entities: `station-site-a`. */
  id: string
  label: string
  lat: number
  lng: number
  altM: number
  /** Signal ids that placed this station. */
  signalIds: string[]
  /** Spacecraft ids the station reported on, when known. */
  satelliteIds: string[]
}

const SITE_LABEL = /\b(site\s+[a-z0-9]+|ground\s+station[^,;]*|gateway\s+[a-z0-9]+)\b/i

type StationHint = {
  name: string
  /** The station's own position when the observable carries one. */
  lat: number | null
  lng: number | null
  altM: number | null
}

const numberOr = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** `observables.ground_station` is either a name or `{name|label, lat, lng,
 *  alt_m}` (the demo scenarios use the object: the signal's own location is
 *  the emitter estimate, not the site). */
const stationHint = (signal: Signal): StationHint | null => {
  const observables = signal.payload.observables ?? {}
  for (const key of ['ground_station', 'station', 'site']) {
    const value = observables[key]
    if (typeof value === 'string' && value.trim()) {
      return { name: value.trim(), lat: null, lng: null, altM: null }
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      const name =
        typeof record.name === 'string'
          ? record.name
          : typeof record.label === 'string'
            ? record.label
            : typeof record.id === 'string'
              ? record.id
              : null
      if (name?.trim()) {
        return {
          name: name.trim(),
          lat: numberOr(record.lat),
          lng: numberOr(record.lng ?? record.lon),
          altM: numberOr(record.alt_m),
        }
      }
    }
  }
  const label = signal.location.label
  if (typeof label === 'string') {
    const match = label.match(SITE_LABEL)
    if (match) return { name: titleCase(match[1].trim()), lat: null, lng: null, altM: null }
  }
  if (/ground[-_ ]?station|spectrum-monitor/i.test(signal.source)) {
    return { name: 'Ground station', lat: null, lng: null, altM: null }
  }
  return null
}

const titleCase = (value: string) =>
  value.replace(/\b\w/g, (character) => character.toUpperCase())

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

export const stationId = (name: string) => `station-${slug(name)}`

/** Stations present in the signal list, in signal order, merged by name. */
export function groundStationsFromSignals(signals: Signal[]): GroundStation[] {
  const byId = new Map<string, GroundStation>()
  for (const signal of signals) {
    const hint = stationHint(signal)
    if (!hint) continue
    let lat = hint.lat
    let lng = hint.lng
    let altM = hint.altM ?? 0
    if (lat === null || lng === null) {
      // No position on the observable: the signal's own location is the
      // station, unless it is a pass footprint at orbital altitude.
      const point = signalCoordinate(signal)
      const altKm = signal.location.alt_km
      if (!point || (typeof altKm === 'number' && altKm > 50)) continue
      lng = point[0]
      lat = point[1]
      altM =
        typeof signal.location.alt_m === 'number'
          ? signal.location.alt_m
          : typeof altKm === 'number'
            ? altKm * 1000
            : 0
    }
    const id = stationId(hint.name)
    const existing = byId.get(id)
    const satelliteId =
      typeof signal.payload.satellite_id === 'string' ? signal.payload.satellite_id : null
    if (existing) {
      existing.signalIds.push(signal.id)
      if (satelliteId && !existing.satelliteIds.includes(satelliteId)) {
        existing.satelliteIds.push(satelliteId)
      }
      continue
    }
    byId.set(id, {
      id,
      label: hint.name,
      lat,
      lng,
      altM,
      signalIds: [signal.id],
      satelliteIds: satelliteId ? [satelliteId] : [],
    })
  }
  return [...byId.values()]
}

/** The pass site a synthetic position file names (`synthetic.pass.site`),
 *  so the globe shows Site A even in a run with no ground-segment signal. */
export function groundStationFromPositionCache(
  cache: N2YOPositionCache,
  satelliteId: string | null = null,
): GroundStation | null {
  const pass = cache.synthetic?.pass
  if (!pass) return null
  const lat = numberOr(pass.site_lat)
  const lng = numberOr(pass.site_lng)
  if (lat === null || lng === null) return null
  const label = typeof pass.site === 'string' && pass.site.trim() ? pass.site.trim() : 'Ground station'
  return {
    id: stationId(label),
    label,
    lat,
    lng,
    altM: numberOr(pass.site_alt_m) ?? 0,
    signalIds: [],
    satelliteIds: satelliteId ? [satelliteId] : [],
  }
}

/** Merge stations by id, keeping the first occurrence's position and
 *  accumulating signal and spacecraft ids. */
export function mergeGroundStations(...lists: Array<GroundStation[]>): GroundStation[] {
  const byId = new Map<string, GroundStation>()
  for (const list of lists) {
    for (const station of list) {
      const existing = byId.get(station.id)
      if (!existing) {
        byId.set(station.id, {
          ...station,
          signalIds: [...station.signalIds],
          satelliteIds: [...station.satelliteIds],
        })
        continue
      }
      for (const id of station.signalIds) if (!existing.signalIds.includes(id)) existing.signalIds.push(id)
      for (const id of station.satelliteIds) {
        if (!existing.satelliteIds.includes(id)) existing.satelliteIds.push(id)
      }
    }
  }
  return [...byId.values()]
}
