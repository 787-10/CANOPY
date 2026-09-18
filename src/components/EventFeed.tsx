import { useEffect, useRef, useState } from 'react'
import {
  commanderSignalSummary,
  plainEventName,
  signalKindLabel,
  spacecraftEnvironmentFacts,
} from '../lib/commanderLanguage'
import { useCaptureStore, withCapture } from '../store/captureStore'
import { useEventStore } from '../store/eventStore'
import type { Decision, Signal } from '../types/canopy'
import { BusHealthCard } from './BusHealthCard'

type EventFeedProps = {
  /** Signals newest first, as the store keeps them. */
  signals: Signal[]
  /** The episode's decision, for the recovery chips on an opened bus-health
   *  card; left out, the newest decision in the store. */
  decision?: Decision | null
}

const SIGNAL_LIMIT = 30

const priorityForSignal = (signal: Signal) =>
  signal.confidence >= 0.86 ? 'high' : signal.confidence >= 0.74 ? 'watch' : 'low'

const formatTime = (ts: string) =>
  new Date(ts).toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

/** The signal stream (demo plan F2): one row per signal the engine received,
 *  newest first, with the subsystem, symptom and physics-consistency facts of
 *  a bus-health record inline. A bus-health row opens its card in place, and
 *  the card links to the zoomed view for capture S2. */
export function EventFeed({ signals, decision }: EventFeedProps) {
  const capture = useCaptureStore((s) => s.enabled)
  const newestDecision = useEventStore((s) => s.decisions[0] ?? null)
  const latestDecision = decision === undefined ? newestDecision : decision
  const [selectedSignalId, setSelectedSignalId] = useState<string | null>(null)
  const streamRef = useRef<HTMLDivElement>(null)
  const latestSignalId = signals[0]?.id

  useEffect(() => {
    streamRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [latestSignalId])

  const rows = signals.slice(0, SIGNAL_LIMIT)

  return (
    <section className="event-feed" aria-label="Incoming signals">
      <div className="event-feed__header">
        <div>
          <span>Signals received</span>
          <h2>Signal stream</h2>
        </div>
        <div className="event-feed__status event-feed__status--live" aria-label="Signal count">
          <strong>{signals.length.toString().padStart(2, '0')}</strong>
        </div>
      </div>

      <div className="event-feed__raw-view">
        <div
          className="event-feed__stream event-feed__stream--raw"
          ref={streamRef}
          role="log"
          aria-label="Signal live tail"
          aria-live="polite"
        >
          {rows.length ? (
            rows.map((signal, index) => {
              const priority = priorityForSignal(signal)
              const isSelected = signal.id === selectedSignalId
              const summary = commanderSignalSummary(signal)
              // Subsystem / symptom / physics for bus health, event type /
              // Kp for space weather; empty for every other domain.
              const facts = spacecraftEnvironmentFacts(signal)

              return (
                <article
                  className={`event-feed__raw-entry event-feed__raw-entry--${priority}`}
                  data-newest={index === 0 ? 'true' : undefined}
                  data-domain={signal.domain}
                  key={signal.id}
                >
                  <button
                    className="event-feed__raw-row"
                    onClick={() => setSelectedSignalId(isSelected ? null : signal.id)}
                    type="button"
                    aria-expanded={isSelected}
                  >
                    <span className="event-feed__raw-time">{formatTime(signal.ts)}</span>
                    <span className="event-feed__raw-domain">{signalKindLabel(signal)}</span>
                    <span className="event-feed__raw-source">{summary.sourceLabel}</span>
                    <span className="event-feed__raw-payload">
                      {summary.oneLine}
                      {facts.length ? (
                        <span className="event-feed__raw-facts" data-testid="raw-facts">
                          {facts.map((fact) => (
                            <span
                              className={`event-feed__raw-fact event-feed__raw-fact--${fact.key}`}
                              key={fact.key}
                            >
                              <em>{fact.label}</em> {fact.value}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </span>
                    <span className="event-feed__raw-confidence">
                      {Math.round(signal.confidence * 100)}%
                    </span>
                    <span className="event-feed__raw-event">{plainEventName(signal)}</span>
                  </button>
                  {isSelected && signal.domain === 'bus_health' ? (
                    <div className="event-feed__raw-card">
                      <BusHealthCard
                        signal={signal}
                        compact
                        decision={latestDecision}
                        zoomHref={withCapture(
                          `/signal?id=${encodeURIComponent(signal.id)}`,
                          capture,
                        )}
                      />
                    </div>
                  ) : null}
                </article>
              )
            })
          ) : (
            <p className="event-feed__empty">Waiting for signals…</p>
          )}
        </div>
      </div>
    </section>
  )
}
