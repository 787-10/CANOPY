import { useEffect, useRef, useState } from 'react'
import { domainLabel } from '../../lib/commanderLanguage'
import { relativeTime } from '../../lib/incidents'
import { buildReportItems, REPORTS_STRIP_LIMIT } from '../../lib/reports'
import { withCapture } from '../../store/captureStore'
import type { Anomaly, Signal } from '../../types/canopy'

type ReportsStripProps = {
  /** Newest first, as the store keeps them. */
  signals: Signal[]
  anomalies: Anomaly[]
  limit?: number
}

// Within this many px of the right edge the strip counts as "at the end"
// and follows new cards; further left the operator is reading history.
const STICK_TOLERANCE_PX = 12

const formatTime = (ts: string) =>
  new Date(ts).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })

type EnterMarks = {
  /** Every key that has been on screen. */
  known: Set<string>
  /** Keys that arrived after the first commit: they carry the enter class
   *  for as long as they are shown, so the animation runs once and whole. */
  entering: Set<string>
}

/** The bottom row: the last reports as cards from left (oldest) to right
 *  (newest), alerts with an accent border. Scrolls horizontally and follows
 *  the newest card unless the operator has scrolled back. */
export function ReportsStrip({ signals, anomalies, limit = REPORTS_STRIP_LIMIT }: ReportsStripProps) {
  const items = buildReportItems(signals, anomalies, limit)
  const alerts = items.filter((item) => item.kind === 'alert').length
  const stripRef = useRef<HTMLOListElement | null>(null)
  const stuckToEnd = useRef(true)
  const [marks, setMarks] = useState<EnterMarks | null>(null)
  const newestKey = items.at(-1)?.key ?? null
  const keyList = items.map((item) => item.key).join('|')

  // The initial batch (a page load, a restored session) does not animate;
  // a key first seen after that does.
  useEffect(() => {
    const keys = keyList ? keyList.split('|') : []
    setMarks((previous) => {
      if (!previous) return { known: new Set(keys), entering: new Set() }
      const fresh = keys.filter((key) => !previous.known.has(key))
      if (!fresh.length) return previous
      return {
        known: new Set([...previous.known, ...fresh]),
        entering: new Set([...previous.entering, ...fresh]),
      }
    })
  }, [keyList])

  // Follow the newest card while the operator has not scrolled back.
  useEffect(() => {
    const el = stripRef.current
    if (el && stuckToEnd.current && el.scrollWidth > el.clientWidth) {
      el.scrollLeft = el.scrollWidth
    }
  }, [newestKey])

  const onScroll = () => {
    const el = stripRef.current
    if (!el) return
    stuckToEnd.current = el.scrollLeft + el.clientWidth >= el.scrollWidth - STICK_TOLERANCE_PX
  }

  return (
    <section className="reports-strip" aria-labelledby="reports-strip-title" data-testid="reports-strip" data-newest={newestKey ?? undefined}>
      <div className="reports-strip__edge reports-strip__edge--left">
        <h2 id="reports-strip-title" className="reports-strip__title">
          Reports · <span data-testid="reports-count">{signals.length}</span>
        </h2>
        {alerts ? <span className="reports-strip__alerts" data-testid="alerts-count">{alerts} {alerts === 1 ? 'alert' : 'alerts'}</span> : null}
      </div>
      {items.length ? (
        <ol className="reports-strip__track" ref={stripRef} onScroll={onScroll} data-testid="reports-track">
          {items.map((item) => (
            <li
              key={item.key}
              className={`report-card report-card--${item.kind}${marks?.entering.has(item.key) ? ' report-card--enter' : ''}`}
              data-kind={item.kind}
              data-domain={item.domain ?? undefined}
            >
              <a className="report-card__link" href={withCapture(`/signal?id=${encodeURIComponent(item.signalId)}`)} title={`${item.label} · ${formatTime(item.ts)}`}>
                <span className="report-card__top">
                  {item.kind === 'alert' ? (
                    <span className="report-card__alert">Alert</span>
                  ) : item.domain ? (
                    <span className={`report-card__domain report-card__domain--${item.domain}`}>{domainLabel(item.domain)}</span>
                  ) : null}
                  <span className="report-card__time">{relativeTime(item.ts)}</span>
                </span>
                <span className="report-card__label">{item.label}</span>
                <span className="report-card__meta">
                  {item.satellite ? <b>{item.satellite}</b> : null}
                  {item.satellite ? ' · ' : ''}
                  {item.source}
                </span>
              </a>
            </li>
          ))}
        </ol>
      ) : (
        <p className="reports-strip__empty">Waiting for the first report.</p>
      )}
      <div className="reports-strip__edge reports-strip__edge--right">
        <a className="summary-card__link" href={withCapture('/signals')}>All signals →</a>
      </div>
    </section>
  )
}
