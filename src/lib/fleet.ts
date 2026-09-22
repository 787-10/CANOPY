// The fleet the console watches, known before any report arrives: the
// synthetic spacecraft with their roles. The left column lists them, the
// Spacecraft page opens on the primary, and the globe pins them at their
// pass, so an operator sees what is being observed when nothing is wrong yet.
import { signalKindLabel } from './commanderLanguage'
import { SYNTHETIC_SATELLITES, syntheticSatelliteFor, type SpacecraftBodyId } from './syntheticSatellites'
import type { Anomaly, Signal } from '../types/canopy'

export type FleetRole = 'primary' | 'sibling' | 'object'

export type FleetMember = {
  /** `ctb://` spacecraft id (the payload's `satellite_id`). */
  satelliteId: string
  /** `SIM-01`. */
  name: string
  role: FleetRole
  roleLabel: string
  note: string
  /** Drawn in flight view only, and pinned only when the stream names it. */
  flightOnly: boolean
  /** The archive body that draws it. */
  body: SpacecraftBodyId
}

const ROLES: Record<string, { role: FleetRole; roleLabel: string; note: string }> = {
  'SIM-01': { role: 'primary', roleLabel: 'monitored', note: 'the monitored spacecraft; every demo run reports from it' },
  'SIM-02': { role: 'sibling', roleLabel: 'fleet sibling', note: 'a neighbouring plane, 610 km east of Site A at its pass' },
  'OBJ-1': { role: 'object', roleLabel: 'closely-spaced object', note: "SIM-01's plane, 3 s behind it" },
}

export const FLEET: FleetMember[] = SYNTHETIC_SATELLITES.map((satellite) => {
  const role = ROLES[satellite.label] ?? { role: 'object' as const, roleLabel: 'object', note: '' }
  return {
    satelliteId: satellite.satelliteId,
    name: satellite.label,
    flightOnly: satellite.flightOnly === true,
    body: satellite.body ?? 'gpm',
    ...role,
  }
})

export const FLEET_PRIMARY: FleetMember = FLEET.find((member) => member.role === 'primary') ?? FLEET[0]!

/** The member a `ctb://` id or a display name belongs to, else null. */
export function fleetMember(idOrName: string | null | undefined): FleetMember | null {
  const id = syntheticSatelliteFor(idOrName)?.satelliteId ?? idOrName ?? null
  return FLEET.find((member) => member.satelliteId === id) ?? null
}

export type FleetStatus = {
  member: FleetMember
  /** Bus-health records received for it this run. */
  reportCount: number
  /** The newest bus-health record: its time and kind, in words. */
  latest: { ts: string; kindLabel: string } | null
  /** A bus anomaly names it. */
  symptomatic: boolean
  state: 'quiet' | 'reporting' | 'symptomatic'
}

const idOf = (value: unknown): string | null =>
  typeof value === 'string' ? (syntheticSatelliteFor(value)?.satelliteId ?? value) : null

/** One status per fleet member from the store's buffers (newest first, as kept). */
export function fleetStatus(signals: readonly Signal[], anomalies: readonly Anomaly[]): FleetStatus[] {
  return FLEET.map((member) => {
    const reports = signals.filter(
      (signal) => signal.domain === 'bus_health' && idOf(signal.payload.satellite_id) === member.satelliteId,
    )
    const newest = reports.reduce<Signal | null>((best, signal) => (!best || signal.ts > best.ts ? signal : best), null)
    const symptomatic = anomalies.some(
      (anomaly) => anomaly.kind.startsWith('bus_') && idOf(anomaly.payload.satellite_id) === member.satelliteId,
    )
    return {
      member,
      reportCount: reports.length,
      latest: newest ? { ts: newest.ts, kindLabel: signalKindLabel(newest) } : null,
      symptomatic,
      state: symptomatic ? 'symptomatic' : reports.length ? 'reporting' : 'quiet',
    }
  })
}

/** `15:03:14Z` from an ISO stamp; the stamp itself if it does not parse. */
export function fleetClock(ts: string): string {
  const ms = Date.parse(ts)
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(11, 19)}Z` : ts
}
