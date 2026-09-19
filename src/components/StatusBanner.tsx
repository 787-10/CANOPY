import { useMemo } from 'react'
import { commanderSignalSummary, signalKindLabel, spacecraftDisplayName, verdictCopy, verdictHeadline } from '../lib/commanderLanguage'
import { attributionTimings, formatMs } from '../lib/timing'
import { useEventStore } from '../store/eventStore'
import type { Attribution, Signal } from '../types/canopy'

type StatusBannerProps = {
  report: Signal | null
  attribution: Attribution | null
}

/** One line that says what is happening: the spacecraft and its latest
 *  report on the left, the verdict with its confidence and timing on the
 *  right. Everything else is a page away. */
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

  return (
    <section
      className={`status-banner${verdict ? ` status-banner--${verdict}` : ''}`}
      aria-label="Current status"
      data-testid="status-banner"
    >
      <div className="status-banner__report">
        <span className="status-banner__subject">
          {report
            ? `${subject} · latest report: ${signalKindLabel(report)} · ${Math.round(report.confidence * 100)}% confidence`
            : subject}
        </span>
        <strong className="status-banner__headline">
          {summary ? summary.oneLine : 'No reports received yet. Start a run from the launcher.'}
        </strong>
      </div>
      <div className="status-banner__verdict">
        {attribution && copy ? (
          <>
            <span className={`status-banner__badge status-banner__badge--${verdict}`} data-testid="status-verdict">
              {copy.label}
            </span>
            <span className="status-banner__confidence">
              {Math.round(attribution.confidence * 100)}%
              {attribution.provisional ? ' · provisional' : ' · final'}
            </span>
            <span className="status-banner__meaning">{verdictHeadline(attribution)}</span>
            <span className="status-banner__timing" data-testid="status-timing">
              {timings?.provisionalMs !== null && timings?.provisionalMs !== undefined
                ? `provisional in ${formatMs(timings.provisionalMs)}`
                : 'provisional pending'}
              {' · '}
              {timings?.finalMs !== null && timings?.finalMs !== undefined
                ? `final in ${formatMs(timings.finalMs)}`
                : 'final pending'}
            </span>
          </>
        ) : (
          <span className="status-banner__badge status-banner__badge--absent">No verdict yet</span>
        )}
      </div>
    </section>
  )
}
