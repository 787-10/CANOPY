import type { Anomaly, Attribution } from '../types/canopy'

/**
 * The attribution an episode's verdict is read from (INTERFACE-SPEC §5.0):
 * the satellite cluster's final revision. The fast lane publishes a
 * provisional attribution and revisions under one id, and the global
 * space-weather cluster (no satellite id) publishes its own attribution, so
 * "the newest attribution received" is not the episode's verdict.
 *
 * Mirrors bench/scoring.py select_final_attribution: prefer attributions
 * with a satellite id whose anomaly_ids cover the latest scored bus anomaly;
 * among candidates take the highest revision, then the latest ts; fall back
 * to the newest attribution with a satellite id, then the newest of all.
 */
export function selectEpisodeAttribution(
  attributions: readonly Attribution[],
  anomalies: readonly Anomaly[] = [],
  satelliteId?: string | null,
): Attribution | null {
  if (!attributions.length) return null
  const scoped = satelliteId
    ? attributions.filter((a) => a.satellite_id === satelliteId)
    : attributions
  const withSatellite = scoped.filter((a) => a.satellite_id)
  const pool = withSatellite.length ? withSatellite : scoped.length ? scoped : attributions

  const busAnomalies = anomalies
    .filter((a) => a.kind.startsWith('bus_'))
    .sort((a, b) => a.ts.localeCompare(b.ts))
  const latestBus = busAnomalies.length ? busAnomalies[busAnomalies.length - 1] : null
  const covering = latestBus ? pool.filter((a) => a.anomaly_ids.includes(latestBus.id)) : []
  const candidates = covering.length ? covering : pool

  return candidates.reduce<Attribution | null>((best, a) => {
    if (!best) return a
    const rev = a.revision ?? 0
    const bestRev = best.revision ?? 0
    if (rev !== bestRev) return rev > bestRev ? a : best
    return a.ts.localeCompare(best.ts) >= 0 ? a : best
  }, null)
}

/** A revision lower than the one already held for the same id is stale. */
export function isStaleRevision(incoming: Attribution, held: Attribution | undefined): boolean {
  if (!held || held.id !== incoming.id) return false
  return (incoming.revision ?? 0) < (held.revision ?? 0)
}
