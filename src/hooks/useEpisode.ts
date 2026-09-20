import { useEventStore } from '../store/eventStore'
import { selectEpisodeAttribution } from '../lib/episode'
import { latestReport } from '../lib/signalEffects'
import type { Attribution, Decision, Signal } from '../types/canopy'

export type Episode = {
  /** Signals newest first, as the store keeps them. */
  signals: Signal[]
  /** The newest substantive report (not a nominal or quiet placeholder). */
  report: Signal | null
  /** The satellite cluster's final revision (INTERFACE-SPEC section 5.0). */
  attribution: Attribution | null
  /** The decision taken on that attribution, newest first. */
  decision: Decision | null
  /** The satellite the operator pinned from the Theaters list, or null. */
  pinnedSatelliteId: string | null
}

/** The one episode every page describes: the verdict on the satellite cluster
 *  and the decision taken on it, never simply the newest event received (the
 *  natural run's space-weather cluster publishes events of its own). A pin
 *  set from the overview's Theaters list scopes the verdict to that
 *  satellite until it is cleared. */
export function useEpisode(): Episode {
  const signals = useEventStore((state) => state.signals)
  const anomalies = useEventStore((state) => state.anomalies)
  const attributions = useEventStore((state) => state.attributions)
  const decisions = useEventStore((state) => state.decisions)
  const pinnedSatelliteId = useEventStore((state) => state.pinnedSatelliteId)
  const attribution = selectEpisodeAttribution(attributions, anomalies, pinnedSatelliteId)
  const decision = attribution
    ? (decisions.find((candidate) => candidate.attribution_id === attribution.id) ?? null)
    : null
  return { signals, report: latestReport(signals), attribution, decision, pinnedSatelliteId }
}
