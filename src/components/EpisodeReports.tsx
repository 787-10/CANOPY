import { spacecraftDisplayName } from '../lib/commanderLanguage'
import { buildReportItems } from '../lib/reports'
import { withCapture } from '../store/captureStore'
import { useEventStore } from '../store/eventStore'

type EpisodeReportsProps = {
  /** The episode's spacecraft; null lists every report. */
  satelliteId: string | null
  /** The signal whose card is open, marked in the list. */
  currentSignalId?: string | null
  limit?: number
}

const formatTime = (ts: string) => {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  return `${d.toISOString().slice(11, 19)}Z`
}

/** The console's Reports strip as a short vertical list for the detail
 *  pages: the newest reports and alerts on the episode's spacecraft, each
 *  opening its signal card, so the evidence chain stays one click away. */
export function EpisodeReports({ satelliteId, currentSignalId = null, limit = 8 }: EpisodeReportsProps) {
  const signals = useEventStore((s) => s.signals)
  const anomalies = useEventStore((s) => s.anomalies)
  const name = satelliteId ? spacecraftDisplayName(satelliteId) : null
  const items = buildReportItems(signals, anomalies, 200)
    .filter((item) => !name || item.satellite === name)
    .slice(0, limit)
  return (
    <section className="panel episode-reports" aria-labelledby="episode-reports-title" data-testid="episode-reports">
      <div className="panel__header">
        <h2 id="episode-reports-title">Reports{name ? ` · ${name}` : ''}</h2>
        <a className="summary-card__link" href={withCapture('/signals')}>All signals →</a>
      </div>
      {items.length ? (
        <ol className="episode-reports__list">
          {items.map((item) => {
            const current = item.kind === 'report' && item.signalId === currentSignalId
            return (
              <li
                key={item.key}
                className={`episode-report episode-report--${item.kind}${current ? ' episode-report--current' : ''}`}
                data-kind={item.kind}
                aria-current={current ? 'true' : undefined}
              >
                <a className="episode-report__link" href={withCapture(`/signal?id=${encodeURIComponent(item.signalId)}`)}>
                  <span className="episode-report__time">{formatTime(item.ts)}</span>
                  <span className="episode-report__label">
                    {item.kind === 'alert' ? <span className="episode-report__alert">Alert</span> : null}
                    {item.label}
                  </span>
                  <span className="episode-report__meta">{item.source}</span>
                </a>
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="episode-reports__empty">No reports on this spacecraft yet.</p>
      )}
    </section>
  )
}
