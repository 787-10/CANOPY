import { useMemo } from 'react'
import { commanderSignalSummary, spacecraftDisplayName, verdictCopy } from '../lib/commanderLanguage'
import { attributionTimings, formatMs } from '../lib/timing'
import { useEventStore } from '../store/eventStore'
import type { Attribution, Signal } from '../types/canopy'

type StatusBannerProps = {
  report: Signal | null
  attribution: Attribution | null
}

/** One line that says what is happening: the spacecraft and its latest
 *  report on the left, the verdict badge with its confidence, revision
 *  state, actor and timing on the right, each stated once. The report's own
 *  confidence and the verdict headline live on their cards. */
export function StatusBanner({ report, attribution }: StatusBannerProps) {
  const traces = useEventStore((s) => s.traces)
  const timings = useMemo(
    () => (attribution ? attributionTimings(traces, attribution.id) : null),
    [traces, attribution],
  )
  const subject = attribution?.satellite_id
    ? spacecraftDisplayName(attribution.satellite_id)
    : report?.payload.satellite_id
      ? spacecraftDisplayName(report.payload.satellite_id)
      : report?.payload.asset ?? 'Awaiting the first report'
  const summary = report ? commanderSignalSummary(report) : null
  const verdict = attribution?.verdict ?? null
  const copy = verdict ? verdictCopy[verdict] : null
  const actor = attribution?.actor
  const showActor = !!actor && actor !== 'None' && actor !== 'Unknown'

  return (
    <section
      className={`status-banner${verdict ? ` status-banner--${verdict}` : ''}`}
      aria-label="Current status"
      data-testid="status-banner"
    >
      <div className="status-banner__report">
        <span className="status-banner__subject">
          {report ? `${subject} · latest report` : subject}
        </span>
        <strong className="status-banner__headline" title={summary?.oneLine}>
          {summary ? summary.oneLine : 'No reports received yet. Start a run from the launcher.'}
        </strong>
      </div>
      <div className="status-banner__verdict">
        {attribution && copy ? (
          <>
            <span className={`status-banner__badge status-banner__badge--${verdict}`} data-testid="status-verdict">
              {copy.label}
            </span>
            <span className="status-banner__line">
              <span className="status-banner__confidence">
                {Math.round(attribution.confidence * 100)}%
                {attribution.provisional ? ' · provisional' : ' · final'}
              </span>
              {showActor ? (
                <span className="status-banner__actor" data-testid="status-actor">{actor}</span>
              ) : null}
              <span className="status-banner__timing" data-testid="status-timing">
                {timings?.provisionalMs !== null && timings?.provisionalMs !== undefined
                  ? `provisional in ${formatMs(timings.provisionalMs)}`
                  : 'provisional pending'}
                {' · '}
                {timings?.finalMs !== null && timings?.finalMs !== undefined
                  ? `final in ${formatMs(timings.finalMs)}`
                  : 'final pending'}
              </span>
            </span>
          </>
        ) : (
          <span className="status-banner__badge status-banner__badge--absent">No verdict yet</span>
        )}
      </div>
    </section>
  )
}
