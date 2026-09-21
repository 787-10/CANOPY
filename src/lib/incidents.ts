import { utcClock } from './timing'
// Incidents ("theaters") for the overview's Situation column: one row per
// satellite cluster the engine has attributed, plus one row per attribution
// it could not key to a satellite but narrowed to a candidate set (closely
// spaced objects, docs/INTERFACE-SPEC.md §5.4). Pure functions over the
// store's attribution buffer so the list has a unit test for every shape.
import type { Attribution } from '../types/canopy'
import { spacecraftDisplayName } from './commanderLanguage'

export type Incident = {
  /** Stable row key: the satellite id, or `unresolved:<attribution id>`. */
  key: string
  /** The satellite this incident is keyed to; null for an unresolved cue. */
  satelliteId: string | null
  /** Operator-facing name: `SIM-01`, or `SIM-01 or SIM-02, unresolved`. */
  label: string
  /** The highest revision (then latest ts) the cluster has published. */
  attribution: Attribution
  unresolved: boolean
}

const newer = (a: Attribution, b: Attribution): boolean => {
  const rev = a.revision ?? 0
  const bestRev = b.revision ?? 0
  if (rev !== bestRev) return rev > bestRev
  return a.ts.localeCompare(b.ts) >= 0
}

/** Rows for the Theaters section, newest activity first. Attributions with a
 *  satellite id are grouped by it and the highest revision wins; an
 *  attribution with no satellite id but a candidate set is its own row; an
 *  attribution with neither (the global space-weather cluster) is not an
 *  incident and is left out. */
export function deriveIncidents(attributions: readonly Attribution[]): Incident[] {
  const bySatellite = new Map<string, Attribution>()
  const unresolved: Attribution[] = []
  for (const attribution of attributions) {
    const satelliteId = attribution.satellite_id ?? null
    if (satelliteId) {
      const held = bySatellite.get(satelliteId)
      if (!held || newer(attribution, held)) bySatellite.set(satelliteId, attribution)
      continue
    }
    if (attribution.candidate_satellite_ids?.length) unresolved.push(attribution)
  }

  const rows: Incident[] = []
  for (const [satelliteId, attribution] of bySatellite) {
    rows.push({
      key: satelliteId,
      satelliteId,
      label: spacecraftDisplayName(satelliteId),
      attribution,
      unresolved: false,
    })
  }
  for (const attribution of unresolved) {
    const names = (attribution.candidate_satellite_ids ?? []).map(spacecraftDisplayName)
    rows.push({
      key: `unresolved:${attribution.id}`,
      satelliteId: null,
      label: `${names.join(' or ')}, unresolved`,
      attribution,
      unresolved: true,
    })
  }
  return rows.sort((a, b) => b.attribution.ts.localeCompare(a.attribution.ts))
}

/** Timestamps more than this far ahead of the wall clock are on a scenario
 *  clock (a replay), not late arrivals: they read as clock time instead. */
export const FUTURE_TOLERANCE_MS = 60_000

const clockTime = (ms: number) => utcClock(ms)

/** `12 s ago`, `3 min ago`, `2 h ago`; `just now` within a minute either
 *  side of now; the clock time (`15:07:00Z`, UTC) for a timestamp further in
 *  the future, which is a scenario clock rather than a delay. */
export function relativeTime(ts: string, now: number = Date.now()): string {
  const then = Date.parse(ts)
  if (!Number.isFinite(then)) return 'unknown'
  if (then - now > FUTURE_TOLERANCE_MS) return clockTime(then)
  const seconds = Math.round((now - then) / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds} s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`
  return `${Math.round(seconds / 86_400)} d ago`
}
