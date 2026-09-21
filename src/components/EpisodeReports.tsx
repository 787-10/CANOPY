import { spacecraftDisplayName } from '../lib/commanderLanguage'
import { REPORTS_STRIP_LIMIT, buildReportItems, type ReportItem } from '../lib/reports'
import { withCapture } from '../store/captureStore'
import { useEventStore } from '../store/eventStore'

type EpisodeReportsProps = {
  /** The episode's spacecraft; null lists every report. */
  satelliteId: string | null
  /** The signal whose card is open, marked in the list. */
  currentSignalId?: string | null
  /** Rows shown before the fold; the rest (up to the strip's cap) open
   *  behind "+k more" so nothing leaves the page without an affordance. */
  limit?: number
}

const formatTime = (ts: string) => {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  return `${d.toISOString().slice(11, 19)}Z`
}

function ReportRow({ item, current }: { item: ReportItem; current: boolean }) {
  return (
    <li
      className={`episode-report episode-report--${item.kind}${current ? ' episode-report--current' : ''}`}
      data-kind={item.kind}
      aria-current={current ? 'true' : undefined}
    >
      <a className="episode-report__link" href={withCapture(`/signal?id=${encodeURIComponent(item.signalId)}`)}>
        <span className="episode-report__time" title="Scenario clock, UTC">{formatTime(item.ts)}</span>
        <span className="episode-report__label">
          {item.kind === 'alert' ? <span className="episode-report__alert">Alert</span> : null}
          {item.label}
        </span>
        <span className="episode-report__meta">{item.source}</span>
      </a>
    </li>
  )
}

/** The console's Reports strip as a short vertical list for the detail
 *  pages: the newest reports and alerts on the episode's spacecraft, each
 *  opening its signal card, so the evidence chain stays one click away. The
 *  first `limit` rows are in view; the rest fold behind "+k more". */
export function EpisodeReports({ satelliteId, currentSignalId = null, limit = 8 }: EpisodeReportsProps) {
  const signals = useEventStore((s) => s.signals)
  const anomalies = useEventStore((s) => s.anomalies)
  const name = satelliteId ? spacecraftDisplayName(satelliteId) : null
  const items = buildReportItems(signals, anomalies, 200)
    .filter((item) => !name || item.satellite === name)
    .slice(0, REPORTS_STRIP_LIMIT)
  const shown = items.slice(0, limit)
  const rest = items.slice(limit)
  const isCurrent = (item: ReportItem) => item.kind === 'report' && item.signalId === currentSignalId
  return (
    <section
      className="panel episode-reports"
      aria-labelledby="episode-reports-title"
      data-testid="episode-reports"
      data-shown={shown.length}
      data-folded={rest.length}
    >
      <div className="panel__header">
        <h2 id="episode-reports-title">Reports{name ? ` · ${name}` : ''}</h2>
        <a className="summary-card__link" href={withCapture('/signals')}>All signals →</a>
      </div>
      {items.length ? (
        <>
          <ol className="episode-reports__list" data-testid="episode-reports-list">
            {shown.map((item) => (
              <ReportRow key={item.key} item={item} current={isCurrent(item)} />
            ))}
          </ol>
          {rest.length ? (
            <details className="fold episode-reports__more" data-testid="episode-reports-more">
              <summary>+{rest.length} more</summary>
              <ol className="episode-reports__list" data-testid="episode-reports-rest">
                {rest.map((item) => (
                  <ReportRow key={item.key} item={item} current={isCurrent(item)} />
                ))}
              </ol>
            </details>
          ) : null}
        </>
      ) : (
        <p className="episode-reports__empty">No reports on this spacecraft yet.</p>
      )}
    </section>
  )
}
