import { useEffect, useRef } from 'react'
import { useEventStore } from '../store/eventStore'
import {
  gateReasonLabel,
  traceAnnotations,
  verdictLabel,
  withheldTraceReasonCode,
} from '../lib/commanderLanguage'
import { traceCategory, traceHeadline } from '../lib/traceCopy'
import type { ReasoningTrace, TraceStage } from '../types/canopy'

const STAGE_COLORS: Record<TraceStage, string> = {
  fusion: 'var(--cyan)',
  attrib_primary: 'var(--green)',
  attrib_redteam: 'var(--red)',
  attrib_reconcile: 'var(--olive)',
  decide: 'var(--violet)',
  tools: 'var(--amber)',
  stress: 'var(--red)',
}

// Engine wall clock, UTC with a Z, the same style as the report times.
function formatTime(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '--:--:--' : `${d.toISOString().slice(11, 19)}Z`
}

interface Props {
  /** When true, the panel renders compact (Brigade footer); otherwise full-height. */
  compact?: boolean
}

export function ReasoningPanel({ compact = false }: Props) {
  const traces = useEventStore((s) => s.traces)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [traces.length])

  return (
    <section
      className={`reasoning-panel${compact ? ' reasoning-panel--compact' : ''}`}
      aria-labelledby="reasoning-title"
    >
      <div className="panel__header">
        <h2 id="reasoning-title">Reasoning trace</h2>
        <span>{traces.length} lines</span>
      </div>
      <div className="reasoning-panel__stream" ref={ref}>
        {traces.length === 0 ? (
          <div className="reasoning-panel__empty">
            waiting for engine output…
          </div>
        ) : (
          traces.map((trace) => <TraceLine key={trace.id} trace={trace} />)
        )}
      </div>
    </section>
  )
}

function TraceLine({ trace }: { trace: ReasoningTrace }) {
  const color = STAGE_COLORS[trace.stage] ?? 'var(--text-muted)'
  const { verdict, physicsConsistency, gateReasonCode } = traceAnnotations(trace)
  const withheldReasonCode = withheldTraceReasonCode(trace)
  const blocked = gateReasonCode !== null
  const withheld = withheldReasonCode !== null
  const hasChips =
    blocked || withheld || verdict !== null || physicsConsistency !== null
  // The stage in words with the engine's code beside it, a sentence saying
  // what happened, and the raw log line underneath as the record.
  const category = traceCategory(trace.stage)
  const headline = traceHeadline(trace)
  const showRaw = headline.trim() !== trace.message.trim()

  return (
    <div
      className={`reasoning-line reasoning-line--${trace.level}${
        blocked ? ' reasoning-line--blocked' : ''
      }${withheld ? ' reasoning-line--withheld' : ''}`}
      data-trace-id={trace.id}
      data-blocked={blocked ? 'true' : undefined}
      data-withheld={withheld ? 'true' : undefined}
    >
      <span className="reasoning-line__time">{formatTime(trace.ts)}</span>
      <span className="reasoning-line__stage" style={{ color }} title={category.code} data-testid="trace-stage">
        {category.label}
        <small className="reasoning-line__stage-code">{category.code}</small>
      </span>
      <span className="reasoning-line__msg" data-testid="trace-headline">{headline}</span>
      {showRaw ? (
        <details className="reasoning-line__details">
          <summary>raw</summary>
          <span className="reasoning-line__raw" data-testid="trace-raw">
            {trace.message}
          </span>
        </details>
      ) : null}
      {hasChips ? (
        <span className="reasoning-line__chips">
          {blocked ? (
            <span
              className="reasoning-line__chip reasoning-line__chip--blocked"
              title={gateReasonLabel(gateReasonCode)}
            >
              blocked · {gateReasonCode}
            </span>
          ) : null}
          {withheld ? (
            <span
              className="reasoning-line__chip reasoning-line__chip--withheld"
              title={gateReasonLabel(withheldReasonCode)}
            >
              withheld · {withheldReasonCode}
            </span>
          ) : null}
          {verdict ? (
            <span
              className={`reasoning-line__chip reasoning-line__chip--verdict reasoning-line__chip--${verdict}`}
              data-verdict={verdict}
            >
              verdict · {verdictLabel(verdict).toLowerCase()}
            </span>
          ) : null}
          {physicsConsistency !== null ? (
            <span className="reasoning-line__chip reasoning-line__chip--physics">
              physics · {physicsConsistency.toFixed(2)}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  )
}
