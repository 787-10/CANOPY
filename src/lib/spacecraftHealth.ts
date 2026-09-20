// Spacecraft-page model: subsystem health from bus-health records, the
// symptom series for the sparkline, and the recovery state. Pure functions
// over store data so the page itself is a thin renderer and every state has
// a unit test.
import type { Attribution, Decision, Signal } from '../types/canopy'
import { busHealthRecords, type BusHealthRecord } from './busHealth'
import { parseGateRationale } from './commanderLanguage'

/** The seven subsystems of docs/INTERFACE-SPEC.md §3, in display order. */
export const SUBSYSTEMS = [
  'power',
  'thermal',
  'comms',
  'adcs',
  'propulsion',
  'cdh',
  'payload',
] as const

export type Subsystem = (typeof SUBSYSTEMS)[number]

export type SubsystemHealth =
  | 'nominal'
  | 'degraded'
  | 'faulted'
  | 'withheld-recovery'

export const HEALTH_LABEL: Record<SubsystemHealth, string> = {
  nominal: 'Nominal',
  degraded: 'Degraded',
  faulted: 'Faulted',
  'withheld-recovery': 'Recovery withheld',
}

export type SubsystemState = {
  subsystem: Subsystem
  health: SubsystemHealth
  /** Latest record that touched this subsystem, nominal or not. */
  latest: BusHealthRecord | null
  /** Why the state is what it is, one line. */
  reason: string
}

export const isSubsystem = (value: unknown): value is Subsystem =>
  typeof value === 'string' && (SUBSYSTEMS as readonly string[]).includes(value)

/** Latest record per subsystem (records oldest first). */
export function latestBySubsystem(
  records: BusHealthRecord[],
): Partial<Record<Subsystem, BusHealthRecord>> {
  const latest: Partial<Record<Subsystem, BusHealthRecord>> = {}
  for (const record of records) {
    if (isSubsystem(record.subsystem)) {
      latest[record.subsystem] = record
    }
  }
  return latest
}

/** Health of every subsystem given the records for one spacecraft, the
 *  latest verdict on it and the decision taken.
 *
 *  - withheld-recovery: the decision withheld a recovery targeting it
 *  - faulted: it shows a symptom and the verdict is `internal_fault`
 *  - degraded: it shows a symptom and the verdict is anything else
 *    (external cause, unknown, or no verdict yet)
 *  - nominal: its latest record is nominal, or it has none */
export function subsystemStates(
  records: BusHealthRecord[],
  attribution: Attribution | null,
  decision: Decision | null,
): SubsystemState[] {
  const latest = latestBySubsystem(records)
  const withheldTarget = decision?.withheld_recovery?.target_subsystem ?? null
  const verdict = attribution?.verdict ?? null

  return SUBSYSTEMS.map((subsystem) => {
    const record = latest[subsystem] ?? null
    if (withheldTarget === subsystem) {
      return {
        subsystem,
        health: 'withheld-recovery',
        latest: record,
        reason: `recovery ${decision?.withheld_recovery?.action_id ?? ''} withheld: ${decision?.withheld_recovery?.reason_code ?? ''}`.trim(),
      }
    }
    if (!record || record.isNominal) {
      return {
        subsystem,
        health: 'nominal',
        latest: record,
        reason: record ? 'latest record nominal' : 'no records',
      }
    }
    if (verdict === 'internal_fault') {
      return {
        subsystem,
        health: 'faulted',
        latest: record,
        reason: `${record.eventLabel}; verdict internal fault`,
      }
    }
    return {
      subsystem,
      health: 'degraded',
      latest: record,
      reason: `${record.eventLabel}; ${verdict ? `verdict ${verdict.replaceAll('_', ' ')}` : 'no verdict yet'}`,
    }
  })
}

export type SymptomPoint = {
  /** Epoch ms of the record. */
  t: number
  /** Measured value, or the rate-integrated value when no measurement exists. */
  value: number
  /** Whether this point came from a direct measurement. */
  measured: boolean
  record: BusHealthRecord
}

export type SymptomSeries = {
  points: SymptomPoint[]
  /** Unit of the values: the measurement unit, else the rate unit without `/s`. */
  unit: string | null
  /** Epoch ms of the first non-nominal record's onset, null when none. */
  onsetT: number | null
  /** Rate label of the latest record (`-0.42 dB/s`). */
  rateLabel: string | null
  /** Which method built the values. */
  method: 'measured' | 'rate-integrated' | 'empty'
  min: number
  max: number
}

const timeOf = (iso: string): number => {
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Symptom measurement over time. Uses the observable when every record
 *  carries one; otherwise integrates `rate_of_change` between records
 *  starting from 0 at the first record (the plotted quantity is then the
 *  cumulative change in the symptom, in the rate unit's numerator). */
export function buildSymptomSeries(records: BusHealthRecord[]): SymptomSeries {
  const empty: SymptomSeries = {
    points: [],
    unit: null,
    onsetT: null,
    rateLabel: null,
    method: 'empty',
    min: 0,
    max: 0,
  }
  if (!records.length) return empty

  const ordered = records.slice().sort((a, b) => timeOf(a.ts) - timeOf(b.ts))
  const firstSymptom = ordered.find((record) => !record.isNominal) ?? null
  const onsetT = firstSymptom
    ? timeOf(firstSymptom.onsetTs ?? firstSymptom.ts)
    : null
  const latest = ordered[ordered.length - 1]
  const allMeasured = ordered.every((record) => record.measurement !== null)

  let points: SymptomPoint[]
  let unit: string | null
  let method: SymptomSeries['method']

  if (allMeasured) {
    points = ordered.map((record) => ({
      t: timeOf(record.ts),
      value: record.measurement!.value,
      measured: true,
      record,
    }))
    unit = ordered.find((record) => record.measurement?.unit)?.measurement?.unit ?? null
    method = 'measured'
  } else {
    let value = 0
    let previousT = timeOf(ordered[0].ts)
    let previousRate = 0
    points = ordered.map((record, index) => {
      const t = timeOf(record.ts)
      if (index > 0) {
        value += previousRate * Math.max(0, (t - previousT) / 1000)
      }
      previousT = t
      previousRate = record.rateOfChange ?? 0
      return { t, value, measured: false, record }
    })
    // Extend the trend one step past the last record so a symptom that
    // just appeared still draws a visible slope.
    const lastRate = latest.rateOfChange ?? 0
    if (points.length === 1 && lastRate !== 0) {
      points.push({
        t: points[0].t + 60_000,
        value: points[0].value + lastRate * 60,
        measured: false,
        record: latest,
      })
    }
    const rateUnit = ordered.find((record) => record.rateUnit)?.rateUnit ?? null
    unit = rateUnit ? rateUnit.replace(/\/s(\^2)?$/, '') : null
    method = 'rate-integrated'
  }

  const values = points.map((point) => point.value)
  return {
    points,
    unit,
    onsetT,
    rateLabel: latest.rateLabel,
    method,
    min: Math.min(...values),
    max: Math.max(...values),
  }
}

export type RecoveryPhase =
  | 'none'
  | 'recommended'
  | 'routed'
  | 'withheld'
  | 'blocked'
  | 'approved'
  | 'denied'

export type RecoveryState = {
  phase: RecoveryPhase
  actionId: string | null
  targetSubsystem: string | null
  /** Withheld or gate reason code. */
  reasonCode: string | null
  requiresApproval: boolean | null
  rationale: string | null
  /** One-line description for the page. */
  headline: string
}

/** The recovery's life: recommended by the internal diagnosis (latest
 *  record), routed as a `recovery_recommendation` decision, withheld by the
 *  decide stage, or blocked by the gate. */
export function recoveryState(
  records: BusHealthRecord[],
  decision: Decision | null,
  /** The operator's call on the routed decision, from the console store. */
  operatorStatus: 'accepted' | 'denied' | null = null,
): RecoveryState {
  const recommended =
    records
      .slice()
      .reverse()
      .find((record) => record.recommendedRecovery)?.recommendedRecovery ?? null

  if (decision?.withheld_recovery) {
    const withheld = decision.withheld_recovery
    return {
      phase: 'withheld',
      actionId: withheld.action_id,
      targetSubsystem: withheld.target_subsystem,
      reasonCode: withheld.reason_code,
      requiresApproval: recommended?.requires_approval ?? null,
      rationale: recommended?.rationale ?? null,
      headline: `Withheld: ${withheld.action_id.replaceAll('_', ' ')} on ${withheld.target_subsystem}`,
    }
  }
  if (decision) {
    const gate = parseGateRationale(decision.rationale)
    if (gate.reasonCode) {
      return {
        phase: 'blocked',
        actionId: recommended?.action_id ?? null,
        targetSubsystem: recommended?.target_subsystem ?? null,
        reasonCode: gate.reasonCode,
        requiresApproval: recommended?.requires_approval ?? null,
        rationale: gate.text,
        headline: `Blocked by gate: ${gate.reasonCode}`,
      }
    }
    if (decision.action === 'recovery_recommendation' && decision.recovery) {
      const what = `${decision.recovery.action_id.replaceAll('_', ' ')} on ${decision.recovery.target_subsystem}`
      const phase: RecoveryPhase =
        operatorStatus === 'accepted' ? 'approved' : operatorStatus === 'denied' ? 'denied' : 'routed'
      return {
        phase,
        actionId: decision.recovery.action_id,
        targetSubsystem: decision.recovery.target_subsystem,
        reasonCode: null,
        requiresApproval: decision.recovery.requires_approval,
        rationale: decision.recovery.rationale,
        headline:
          phase === 'approved'
            ? `Approved by the operator: ${what}`
            : phase === 'denied'
              ? `Denied by the operator: ${what}`
              : `Routed as a decision: ${what}`,
      }
    }
  }
  if (recommended) {
    return {
      phase: 'recommended',
      actionId: recommended.action_id,
      targetSubsystem: recommended.target_subsystem,
      reasonCode: null,
      requiresApproval: recommended.requires_approval,
      rationale: recommended.rationale,
      headline: `Recommended by internal diagnosis: ${recommended.action_id.replaceAll('_', ' ')} on ${recommended.target_subsystem}`,
    }
  }
  return {
    phase: 'none',
    actionId: null,
    targetSubsystem: null,
    reasonCode: null,
    requiresApproval: null,
    rationale: null,
    headline: 'No recovery recommended',
  }
}

/** Records for one spacecraft (by `satellite_id`), oldest first. With no id,
 *  every bus-health record. */
export function recordsForSatellite(
  signals: Signal[],
  satelliteId: string | null,
): BusHealthRecord[] {
  const records = busHealthRecords(signals)
  return satelliteId
    ? records.filter((record) => record.satelliteId === satelliteId)
    : records
}

/** The spacecraft the page should show: the id in the query, else the id
 *  of the latest bus-health record, else null. */
export function pickSatelliteId(
  signals: Signal[],
  requested: string | null,
): string | null {
  if (requested) return requested
  const records = busHealthRecords(signals)
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index].satelliteId) return records[index].satelliteId
  }
  return null
}

/** Latest attribution and its decision for one spacecraft. */
export function latestVerdictFor(
  attributions: Attribution[],
  decisions: Decision[],
  satelliteId: string | null,
): { attribution: Attribution | null; decision: Decision | null } {
  const attribution =
    (satelliteId
      ? attributions.find((candidate) => candidate.satellite_id === satelliteId)
      : attributions[0]) ?? null
  const decision = attribution
    ? (decisions.find((candidate) => candidate.attribution_id === attribution.id) ?? null)
    : null
  return { attribution, decision }
}
