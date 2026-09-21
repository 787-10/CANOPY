// View model for a bus_health Signal (docs/INTERFACE-SPEC.md §3). One place
// that reads the observables so the feed card, the zoomed card and the
// spacecraft page agree on every field and its fallback.
import { eventTypeCopy, formatRate, spacecraftDisplayName, subsystemLabel } from './commanderLanguage'
import { parsePhysicsBasis, type PhysicsBasis } from './physicsBasis'
import type { RecoveryBlock, Signal } from '../types/canopy'

export type BusHealthRecommendedRecovery = Omit<RecoveryBlock, 'source' | 'satellite_id'>

export type BusHealthRecord = {
  signalId: string
  /** Signal timestamp (ISO). */
  ts: string
  /** `ctb://<authority>/<spacecraft-id>` when present. */
  satelliteId: string | null
  /** Operator-facing spacecraft name: `SIM-01` from the id, else the asset. */
  displayName: string
  eventType: string
  /** Plain-language event label ("Link margin drop"). */
  eventLabel: string
  isNominal: boolean
  subsystem: string | null
  subsystemLabel: string
  symptom: string | null
  /** `link_margin_db_drop` -> `link margin db drop`. */
  symptomLabel: string
  onsetTs: string | null
  onsetClockDomain: string | null
  simTimeS: number | null
  rateOfChange: number | null
  rateUnit: string | null
  /** `-0.42 dB/s`, or null when the adapter had no window. */
  rateLabel: string | null
  physicsConsistency: number | null
  physicsBasis: PhysicsBasis | null
  shape: string | null
  recommendedRecovery: BusHealthRecommendedRecovery | null
  /** A direct measurement when the record carries one (e.g. `link_margin_db`). */
  measurement: { value: number; unit: string | null; key: string } | null
  summary: string
  confidence: number
}

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

// Observable keys that carry the symptom's own measurement, checked in
// order. The adapter does not standardise one, so the sparkline takes the
// first it finds and falls back to rate integration.
const MEASUREMENT_KEYS: Array<{ key: string; unit: string | null }> = [
  { key: 'link_margin_db', unit: 'dB' },
  { key: 'margin_db', unit: 'dB' },
  { key: 'measurement', unit: null },
  { key: 'value', unit: null },
  { key: 'wheel_speed_rad_s', unit: 'rad/s' },
  { key: 'bus_voltage_v', unit: 'V' },
  { key: 'temperature_c', unit: 'C' },
  { key: 'altitude_km', unit: 'km' },
]

export const isBusHealthSignal = (signal: Signal): boolean =>
  signal.domain === 'bus_health'

export function recommendedRecoveryOf(
  observables: Record<string, unknown>,
): BusHealthRecommendedRecovery | null {
  const raw = observables.recommended_recovery
  if (!raw || typeof raw !== 'object') return null
  const block = raw as Record<string, unknown>
  const actionId = str(block.action_id)
  if (!actionId) return null
  return {
    action_id: actionId,
    target_subsystem: str(block.target_subsystem) ?? 'unknown',
    requires_approval: block.requires_approval === true,
    rationale: str(block.rationale) ?? '',
  }
}

export function busHealthRecord(signal: Signal): BusHealthRecord {
  const observables = signal.payload.observables ?? {}
  const satelliteId = str(signal.payload.satellite_id)
  const asset = str(signal.payload.asset)
  const subsystem = str(observables.subsystem)
  const symptom = str(observables.symptom)
  const rateOfChange = num(observables.rate_of_change)
  const rateUnit = str(observables.rate_unit)
  const eventType = signal.payload.event_type
  const measurementKey = MEASUREMENT_KEYS.find(
    ({ key }) => num(observables[key]) !== null,
  )
  const measurementUnit = str(observables.measurement_unit)

  return {
    signalId: signal.id,
    ts: signal.ts,
    satelliteId,
    displayName: satelliteId
      ? spacecraftDisplayName(satelliteId)
      : (asset ?? str(signal.location.label) ?? 'Spacecraft'),
    eventType,
    eventLabel:
      eventType === 'nominal'
        ? 'Nominal'
        : (eventTypeCopy(eventType)?.label ?? eventType.replaceAll('_', ' ')),
    isNominal: eventType === 'nominal',
    subsystem,
    subsystemLabel: subsystemLabel(subsystem),
    symptom,
    symptomLabel: symptom ? symptom.replaceAll('_', ' ') : 'not stated',
    onsetTs: str(observables.onset_ts),
    onsetClockDomain: str(observables.onset_clock_domain),
    simTimeS: num(observables.sim_time_s),
    rateOfChange,
    rateUnit,
    rateLabel:
      rateOfChange === null
        ? null
        : `${rateOfChange > 0 ? '+' : ''}${formatRate(rateOfChange, rateUnit)}`,
    physicsConsistency: num(observables.physics_consistency),
    physicsBasis: parsePhysicsBasis(observables.physics_basis),
    shape: str(observables.shape),
    recommendedRecovery: recommendedRecoveryOf(observables),
    measurement: measurementKey
      ? {
          value: num(observables[measurementKey.key]) as number,
          unit: measurementUnit ?? measurementKey.unit,
          key: measurementKey.key,
        }
      : null,
    summary: signal.payload.summary,
    confidence: signal.confidence,
  }
}

/** All bus_health records in a signal list, oldest first. */
export function busHealthRecords(signals: Signal[]): BusHealthRecord[] {
  return signals
    .filter(isBusHealthSignal)
    .map(busHealthRecord)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
}

/** Formats an ISO onset as `14:32:10Z` plus the clock domain when known. */
export function formatOnset(
  onsetTs: string | null,
  clockDomain: string | null,
): string {
  if (!onsetTs) return 'not stated'
  const date = new Date(onsetTs)
  if (Number.isNaN(date.getTime())) return onsetTs
  const time = date.toISOString().slice(11, 19)
  return clockDomain ? `${time}Z (${clockDomain} clock)` : `${time}Z`
}
