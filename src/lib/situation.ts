// Facts for the overview's Spacecraft and Environment sections, read from the
// store's anomaly and signal buffers. Fusion copies `subsystem`, `symptom`
// and `physics_consistency` to the top of a bus anomaly's payload
// (canopy/services/fusion, `_BUS_PAYLOAD_FIELDS`); older records carry them
// under `observables`, so both places are read.
import type { Anomaly, Signal } from '../types/canopy'
import { eventTypeCopy, subsystemLabel } from './commanderLanguage'
import { anomalyKindLabel } from './reports'

export const PHYSICS_TREND_POINTS = 12

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null

const observablesOf = (anomaly: Anomaly): Record<string, unknown> => {
  const raw = anomaly.payload.observables
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
}

const field = (anomaly: Anomaly, key: string): unknown =>
  anomaly.payload[key] ?? observablesOf(anomaly)[key]

export const anomalySatelliteId = (anomaly: Anomaly): string | null =>
  str(anomaly.payload.satellite_id)

/** Bus anomalies for one spacecraft, oldest first; every bus anomaly when
 *  `satelliteId` is null. */
export function busAnomaliesFor(
  anomalies: readonly Anomaly[],
  satelliteId: string | null,
): Anomaly[] {
  return anomalies
    .filter(
      (anomaly) =>
        anomaly.kind.startsWith('bus_') &&
        (satelliteId === null || anomalySatelliteId(anomaly) === satelliteId),
    )
    .sort((a, b) => a.ts.localeCompare(b.ts))
}

export type SpacecraftFacts = {
  satelliteId: string | null
  /** `Link margin drop` from the anomaly kind. */
  kindLabel: string
  subsystem: string
  symptom: string
  physicsConsistency: number | null
  /** The last `PHYSICS_TREND_POINTS` physics-consistency scores, oldest first. */
  trend: number[]
  latest: Anomaly | null
}

/** The latest bus anomaly of a spacecraft and its physics trend. With no
 *  satellite id the latest bus anomaly of all names the spacecraft. */
export function spacecraftFacts(
  anomalies: readonly Anomaly[],
  satelliteId: string | null,
): SpacecraftFacts {
  const own = busAnomaliesFor(anomalies, satelliteId)
  const latest = own.at(-1) ?? null
  const resolvedId = satelliteId ?? (latest ? anomalySatelliteId(latest) : null)
  const series = resolvedId && !satelliteId ? busAnomaliesFor(anomalies, resolvedId) : own
  const trend = series
    .map((anomaly) => num(field(anomaly, 'physics_consistency')))
    .filter((value): value is number => value !== null)
    .slice(-PHYSICS_TREND_POINTS)
  const symptom = latest ? str(field(latest, 'symptom')) : null
  return {
    satelliteId: resolvedId,
    kindLabel: latest ? anomalyKindLabel(latest.kind) : 'No bus symptom',
    subsystem: subsystemLabel(latest ? str(field(latest, 'subsystem')) : null),
    symptom: symptom ? symptom.replaceAll('_', ' ') : 'not stated',
    physicsConsistency: latest ? num(field(latest, 'physics_consistency')) : null,
    trend,
    latest,
  }
}

export type EnvironmentFacts = {
  signal: Signal | null
  /** `Geomagnetic storm`, `Quiet`. */
  eventLabel: string
  kp: number | null
}

/** The newest space-weather signal and what it says. */
export function environmentFacts(signals: readonly Signal[]): EnvironmentFacts {
  const signal = signals.find((candidate) => candidate.domain === 'space_weather') ?? null
  if (!signal) return { signal: null, eventLabel: 'No space-weather report', kp: null }
  const eventType = signal.payload.event_type
  const label =
    eventTypeCopy(eventType)?.label ??
    (eventType === 'quiet'
      ? 'Quiet'
      : eventType.replaceAll('_', ' ').replace(/^\w/, (c) => c.toUpperCase()))
  return { signal, eventLabel: label, kp: num(signal.payload.observables?.kp) }
}
