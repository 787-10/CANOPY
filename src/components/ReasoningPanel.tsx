import { useEffect, useRef } from 'react'
import { useCaptureStore } from '../store/captureStore'
import { useEventStore } from '../store/eventStore'
import {
  gateReasonLabel,
  traceAnnotations,
  verdictLabel,
  withheldTraceReasonCode,
} from '../lib/commanderLanguage'
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

const STAGE_LABEL: Record<TraceStage, string> = {
  fusion: 'fusion',
  attrib_primary: 'attrib.primary',
  attrib_redteam: 'attrib.redteam',
  attrib_reconcile: 'attrib.reconcile',
  decide: 'decide',
  tools: 'tools',
  stress: 'stress',
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts)
    return d.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
  } catch {
    return '--:--:--'
  }
}

interface Props {
  /** When true, the panel renders compact (Brigade footer); otherwise full-height. */
  compact?: boolean
}

export function ReasoningPanel({ compact = false }: Props) {
  const traces = useEventStore((s) => s.traces)
  const capture = useCaptureStore((s) => s.enabled)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [traces.length])

  const clear = () => {
    // Full session reset — wipes every engine event slice the demo
    // accumulates (traces, anomalies, decisions, attributions, signals,
    // ui_events, OSINT embedding snapshot, lookup tables, pending
    // approval) but preserves KB (fetched once at mount) and live
    // connection state. Persisted sessionStorage gets updated on the
    // next setState since the persist middleware writes through.
    useEventStore.setState({
      signals: [],
      anomalies: [],
      attributions: [],
      decisions: [],
      uiEvents: [],
      traces: [],
      embeddingSnapshot: null,
      signalsById: {},
      attributionsById: {},
      decisionsById: {},
      pendingApproval: null,
      takeoverEvent: null,
      selectedEventId: null,
      approvedEventIds: new Set(),
    })
  }

  return (
    <section
      className={`reasoning-panel${compact ? ' reasoning-panel--compact' : ''}`}
      aria-labelledby="reasoning-title"
    >
      <div className="panel__header">
        <h2 id="reasoning-title">Reasoning trace</h2>
        <div className="reasoning-panel__head-actions">
          <span>{traces.length} lines</span>
          {capture ? null : (
            <button
              type="button"
              className="reasoning-panel__clear"
              onClick={clear}
              title="Reset all engine state — traces, anomalies, decisions, embeddings, action log, approvals"
              data-capture-hide
            >
              reset
            </button>
          )}
        </div>
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
      <span className="reasoning-line__stage" style={{ color }}>
        [{STAGE_LABEL[trace.stage] ?? trace.stage}]
      </span>
      <span className="reasoning-line__msg">{trace.message}</span>
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
