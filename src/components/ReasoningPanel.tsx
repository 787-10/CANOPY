import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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

/** How far above the end of the stream (px) still counts as "at the newest
 *  line": fractional scroll positions and a wheel notch that stops just
 *  short must not turn following off. */
const FOLLOW_TOLERANCE_PX = 6

// Engine wall clock, UTC with a Z, the same style as the report times.
function formatTime(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '--:--:--' : `${d.toISOString().slice(11, 19)}Z`
}

/** Pin a scroll container to its end with no animation, whatever
 *  `scroll-behavior` the stylesheet sets. jsdom has no `scrollTo`. */
function pinToEnd(el: HTMLElement) {
  if (typeof el.scrollTo === 'function') {
    el.scrollTo({ top: el.scrollHeight, behavior: 'instant' })
  } else {
    el.scrollTop = el.scrollHeight
  }
}

function distanceFromEnd(el: HTMLElement): number {
  return el.scrollHeight - el.clientHeight - el.scrollTop
}

interface Props {
  /** When true, the panel renders compact (Brigade footer); otherwise full-height. */
  compact?: boolean
}

export function ReasoningPanel({ compact = false }: Props) {
  const traces = useEventStore((s) => s.traces)
  const streamRef = useRef<HTMLDivElement | null>(null)
  const linesRef = useRef<HTMLDivElement | null>(null)
  // The stream follows the newest line until the operator scrolls up; it
  // resumes when they scroll back to the end or press "latest".
  const [following, setFollowing] = useState(true)
  // Line count at the moment following stopped, so the affordance can say
  // how many lines have arrived since.
  const [seenCount, setSeenCount] = useState(0)

  // Before paint, so the page opens on the newest line instead of scrolling
  // there: on mount (the store rehydrates the whole history from
  // sessionStorage synchronously, so it is all in the first render), on
  // every new line while following, and when "latest" re-engages following.
  useLayoutEffect(() => {
    const el = streamRef.current
    if (el && following) pinToEnd(el)
  }, [traces, following])

  // The content height also moves without a new line: the mono font swapping
  // in after first paint, a raw line unfolding, the panel resizing. Stay
  // pinned through those as well.
  useEffect(() => {
    const el = streamRef.current
    const lines = linesRef.current
    if (!following || !el || !lines || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => pinToEnd(el))
    observer.observe(lines)
    observer.observe(el)
    return () => observer.disconnect()
  }, [following])

  const handleScroll = () => {
    const el = streamRef.current
    if (!el) return
    const atEnd = distanceFromEnd(el) <= FOLLOW_TOLERANCE_PX
    if (atEnd === following) return
    setFollowing(atEnd)
    if (!atEnd) setSeenCount(traces.length)
  }

  // The layout effect above does the jump once `following` is true again.
  const resumeFollowing = () => setFollowing(true)

  const unseen = following ? 0 : Math.max(0, traces.length - seenCount)

  return (
    <section
      className={`reasoning-panel${compact ? ' reasoning-panel--compact' : ''}`}
      aria-labelledby="reasoning-title"
    >
      <div className="panel__header">
        <h2 id="reasoning-title">Reasoning trace</h2>
        <span>
          {traces.length} lines
          <small
            className="clock-domain"
            title="Trace times are the engine's wall clock, UTC; report times are the scenario clock."
          >
            engine clock, UTC
          </small>
        </span>
      </div>
      <div className="reasoning-panel__stream" ref={streamRef} onScroll={handleScroll}>
        <div className="reasoning-panel__lines" ref={linesRef}>
          {traces.length === 0 ? (
            <div className="reasoning-panel__empty">
              waiting for engine output…
            </div>
          ) : (
            traces.map((trace) => <TraceLine key={trace.id} trace={trace} />)
          )}
        </div>
        {following ? null : (
          // Docked inside the stream (sticky, zero height) rather than over
          // it, so a wheel turned while the pointer rests on the button still
          // scrolls the stream.
          <div className="reasoning-panel__latest-dock">
            <button
              type="button"
              className="reasoning-panel__latest"
              onClick={resumeFollowing}
              title="Jump to the newest line and follow new lines again"
              data-testid="trace-latest"
            >
              {unseen > 0 ? `${unseen} new · latest ↓` : 'latest ↓'}
            </button>
          </div>
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
