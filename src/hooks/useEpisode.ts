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
}

/** The one episode every page describes: the verdict on the satellite cluster
 *  and the decision taken on it, never simply the newest event received (the
 *  natural run's space-weather cluster publishes events of its own). */
export function useEpisode(): Episode {
  const signals = useEventStore((state) => state.signals)
  const anomalies = useEventStore((state) => state.anomalies)
  const attributions = useEventStore((state) => state.attributions)
  const decisions = useEventStore((state) => state.decisions)
  const attribution = selectEpisodeAttribution(attributions, anomalies)
  const decision = attribution
    ? (decisions.find((candidate) => candidate.attribution_id === attribution.id) ?? null)
    : null
  return { signals, report: latestReport(signals), attribution, decision }
}
