// The overview's Reports strip: one card per signal, newest scenario time on
// the left (a record that lands out of order takes its place in time, not at
// the edge). A bus anomaly or hostile-kind
// external anomaly raised on a signal turns that signal's card into an
// alert; it does not add a twin card at the same timestamp. Pure over the
// store's buffers so the order, the cap and the alert classification each
// have a unit test.
import type { Anomaly, Domain, Signal } from '../types/canopy'
import {
  commanderSignalSummary,
  eventTypeCopy,
  signalKindLabel,
  spacecraftDisplayName,
} from './commanderLanguage'

export const REPORTS_STRIP_LIMIT = 24

export type ReportItem = {
  /** `signal:<id>` or `anomaly:<id>`. */
  key: string
  kind: 'report' | 'alert'
  ts: string
  domain: Domain | null
  /** Plain-language kind: `Link margin drop`, `RF anomaly`. */
  label: string
  /** Who reported it: the friendly source label, or the anomaly's fusion lane. */
  source: string
  /** `SIM-01`, or null when the item names no spacecraft. */
  satellite: string | null
  /** The signal whose card the item opens. */
  signalId: string
  /** Fusion severity for an alert, 0..1; null for a report. */
  severity: number | null
}

/** Anomaly kinds that earn an alert card. `bus_*` is every internal-diagnosis
 *  symptom (docs/INTERFACE-SPEC.md §3); the rest are the fusion lane's hostile
 *  cues (RF interference and jamming, GNSS spoofing, cyber probes, close
 *  approach and correlated collection). Space-weather and nominal echoes are
 *  reports, not alerts. */
const HOSTILE_KIND = /^(rf_|gnss_|cyber_probe|drone_spoofing|sda_counterspace|sda_overhead_ir)|rpo|proximity|close_approach|maneuver|collection_(overlap|correlated)/

export function isAlertAnomaly(anomaly: Anomaly): boolean {
  return anomaly.kind.startsWith('bus_') || HOSTILE_KIND.test(anomaly.kind)
}

// Fusion's bus kinds shorten the event type (`bus_link_margin` for
// `link_margin_drop`); map the abbreviated ones back to the event copy.
const BUS_KIND_EVENT: Record<string, string> = {
  bus_link_margin: 'link_margin_drop',
  bus_power_thermal: 'power_thermal_excursion',
  bus_safe_mode: 'safe_mode_entry',
}

const HOSTILE_KIND_LABELS: Record<string, string> = {
  rf_anomaly: 'RF interference',
  rf_gnss_jamming: 'GNSS jamming',
  rf_uas_control_link: 'UAS control link',
  rf_emission_posture_risk: 'Emission posture risk',
  rf_telemetry_degradation: 'Ground link frame loss',
  gnss_spoof: 'GNSS spoofing',
  cyber_probe_burst: 'Access probe burst',
  orbital_rpo_risk: 'Close approach',
  orbital_collection_overlap: 'Collection overlap',
  orbital_collection_correlated: 'Correlated collection',
}

/** `bus_link_margin` -> `Link margin drop`; `rf_anomaly` -> `RF interference`;
 *  anything else humanised from the slug. */
export function anomalyKindLabel(kind: string): string {
  if (kind.startsWith('bus_')) {
    const eventType = BUS_KIND_EVENT[kind] ?? kind.slice('bus_'.length)
    const copy = eventTypeCopy(eventType)
    if (copy) return copy.label
  }
  const known = HOSTILE_KIND_LABELS[kind]
  if (known) return known
  const spaced = kind.replaceAll(/[-_]+/g, ' ').trim()
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : kind
}

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null

const signalItem = (signal: Signal): ReportItem => ({
  key: `signal:${signal.id}`,
  kind: 'report',
  ts: signal.ts,
  domain: signal.domain,
  label: signalKindLabel(signal),
  source: commanderSignalSummary(signal).sourceLabel,
  satellite: signal.payload.satellite_id
    ? spacecraftDisplayName(signal.payload.satellite_id)
    : null,
  signalId: signal.id,
  severity: null,
})

const anomalyItem = (anomaly: Anomaly, source: Signal | undefined): ReportItem => {
  const satelliteId = str(anomaly.payload.satellite_id) ?? source?.payload.satellite_id ?? null
  return {
    key: `anomaly:${anomaly.id}`,
    kind: 'alert',
    ts: anomaly.ts,
    domain: source?.domain ?? (anomaly.kind.startsWith('bus_') ? 'bus_health' : null),
    label: anomalyKindLabel(anomaly.kind),
    source: anomaly.kind.startsWith('bus_') ? 'internal diagnosis' : 'fusion',
    satellite: satelliteId ? spacecraftDisplayName(satelliteId) : null,
    signalId: anomaly.source_signal || anomaly.source_signal_ids.at(-1) || anomaly.id,
    severity: anomaly.severity,
  }
}

/** The strip's items, newest first, capped to the newest `limit`. A signal
 *  with an alert anomaly on it is one alert card carrying the anomaly's
 *  severity; an alert whose source signal left the buffer stands alone at
 *  the front. */
export function buildReportItems(
  signals: readonly Signal[],
  anomalies: readonly Anomaly[],
  limit: number = REPORTS_STRIP_LIMIT,
): ReportItem[] {
  const signalsById = new Map(signals.map((signal) => [signal.id, signal]))
  const alertsBySignal = new Map<string, Anomaly[]>()
  const orphans: Anomaly[] = []
  // Store buffers are newest first; walk them oldest first.
  for (const anomaly of [...anomalies].reverse()) {
    if (!isAlertAnomaly(anomaly)) continue
    const sourceId = anomaly.source_signal || anomaly.source_signal_ids.at(-1) || ''
    if (signalsById.has(sourceId)) {
      const list = alertsBySignal.get(sourceId) ?? []
      list.push(anomaly)
      alertsBySignal.set(sourceId, list)
    } else {
      orphans.push(anomaly)
    }
  }

  const items: ReportItem[] = []
  for (const signal of [...signals].reverse()) {
    const item = signalItem(signal)
    const alerts = alertsBySignal.get(signal.id) ?? []
    if (alerts.length) {
      item.kind = 'alert'
      item.severity = Math.max(...alerts.map((anomaly) => anomaly.severity))
    }
    items.push(item)
  }
  for (const anomaly of orphans) {
    items.push(anomalyItem(anomaly, signalsById.get(anomaly.source_signal)))
  }
  // Arrival order first (newest arrival first), then by the records' own
  // time: the strip reads on the scenario clock, and a late or early arrival
  // sits where its timestamp puts it. Stable, so equal stamps keep arrival order.
  const newestFirst = items
    .reverse()
    .map((item, index) => ({ item, index, ms: Date.parse(item.ts) }))
    .sort((a, b) => {
      if (Number.isFinite(a.ms) && Number.isFinite(b.ms) && a.ms !== b.ms) return b.ms - a.ms
      return a.index - b.index
    })
    .map(({ item }) => item)
  return newestFirst.length > limit ? newestFirst.slice(0, limit) : newestFirst
}
