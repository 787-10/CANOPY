// Stage timings read from the reasoning trace (docs/INTERFACE-SPEC.md §5.0).
// Every attrib, decide and UI trace carries `latency_ms` (wall-clock ms since
// the batch's first anomaly arrival) and `stage_ms` (the emitting stage's
// own duration). The attrib traces reference the attribution id in `ref_id`
// and carry `revision` / `provisional` in the payload; decide traces
// reference the decision id and carry `attribution_id`.
import type { Attribution, Decision, ReasoningTrace } from '../types/canopy'

export type AttributionTimings = {
  /** `latency_ms` of the revision-0 (provisional) attrib trace. */
  provisionalMs: number | null
  /** `latency_ms` of the highest non-provisional attrib trace. */
  finalMs: number | null
  /** Revision the final timing belongs to. */
  finalRevision: number | null
  /** `stage_ms` of the final attrib trace (reasoning-lane duration). */
  finalStageMs: number | null
}

const numberOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const ATTRIB_STAGES = new Set(['attrib_primary', 'attrib_redteam', 'attrib_reconcile'])

const revisionOf = (trace: ReasoningTrace): number =>
  numberOf(trace.payload?.revision) ?? 0

const isProvisionalTrace = (trace: ReasoningTrace): boolean =>
  trace.payload?.provisional === true

/** Provisional and final latencies for one attribution id. */
export function attributionTimings(
  traces: ReasoningTrace[],
  attributionId: string | null | undefined,
): AttributionTimings {
  const empty: AttributionTimings = {
    provisionalMs: null,
    finalMs: null,
    finalRevision: null,
    finalStageMs: null,
  }
  if (!attributionId) return empty
  const own = traces.filter(
    (trace) =>
      trace.ref_id === attributionId &&
      ATTRIB_STAGES.has(trace.stage) &&
      numberOf(trace.payload?.latency_ms) !== null,
  )
  if (!own.length) return empty

  const provisional = own.find(
    (trace) => isProvisionalTrace(trace) || revisionOf(trace) === 0,
  )
  const finals = own.filter((trace) => !isProvisionalTrace(trace) && revisionOf(trace) > 0)
  // Prefer the reconcile trace (the published revision); fall back to the
  // latest attrib trace of the highest revision.
  const final = finals
    .slice()
    .sort((a, b) => {
      const byRevision = revisionOf(b) - revisionOf(a)
      if (byRevision !== 0) return byRevision
      const rank = (trace: ReasoningTrace) => (trace.stage === 'attrib_reconcile' ? 1 : 0)
      return rank(b) - rank(a)
    })[0]

  return {
    provisionalMs: provisional ? numberOf(provisional.payload.latency_ms) : null,
    finalMs: final ? numberOf(final.payload.latency_ms) : null,
    finalRevision: final ? revisionOf(final) : null,
    finalStageMs: final ? numberOf(final.payload.stage_ms) : null,
  }
}

export type StageTiming = {
  stage: 'fusion' | 'attrib_provisional' | 'attrib_final' | 'decide' | 'ui_event'
  label: string
  /** ms since the first anomaly arrived; null when the trace carries none. */
  latencyMs: number | null
  /** the stage's own duration; null when the trace carries none. */
  stageMs: number | null
  /** trace ids the timing was read from. */
  traceIds: string[]
  note: string | null
}

/** The four stage timings the run scorecard shows for one attribution and
 *  the decision taken on it. Fusion traces carry no `latency_ms` (their
 *  origin is the signal arrival), so fusion is reported as wall-clock span
 *  between the first and last `new anomaly` trace of the cluster. */
export function stageTimings(
  traces: ReasoningTrace[],
  attribution: Attribution | null,
  decision: Decision | null,
): StageTiming[] {
  const timings = attributionTimings(traces, attribution?.id)
  const anomalyIds = new Set(attribution?.anomaly_ids ?? [])
  const fusion = traces.filter(
    (trace) =>
      trace.stage === 'fusion' &&
      trace.ref_id !== null &&
      anomalyIds.has(trace.ref_id) &&
      trace.message.startsWith('new anomaly'),
  )
  const fusionTimes = fusion
    .map((trace) => Date.parse(trace.ts))
    .filter((time) => Number.isFinite(time))
  const fusionSpan =
    fusionTimes.length >= 1
      ? Math.max(...fusionTimes) - Math.min(...fusionTimes)
      : null

  const provisionalTrace = traces.find(
    (trace) =>
      attribution &&
      trace.ref_id === attribution.id &&
      ATTRIB_STAGES.has(trace.stage) &&
      (isProvisionalTrace(trace) || revisionOf(trace) === 0),
  )
  const finalTraces = traces.filter(
    (trace) =>
      attribution &&
      trace.ref_id === attribution.id &&
      ATTRIB_STAGES.has(trace.stage) &&
      !isProvisionalTrace(trace) &&
      revisionOf(trace) > 0,
  )
  const decideTrace = decision
    ? traces
        .filter(
          (trace) =>
            trace.stage === 'decide' &&
            trace.ref_id === decision.id &&
            trace.level === 'decision',
        )
        .at(-1) ?? null
    : null
  const uiTrace = decision
    ? traces
        .filter(
          (trace) =>
            trace.stage === 'decide' &&
            trace.ref_id === `uievt-${decision.id}` &&
            trace.message.startsWith('ui event'),
        )
        .at(-1) ?? null
    : null

  return [
    {
      stage: 'fusion',
      label: 'Fusion',
      latencyMs: null,
      stageMs: fusionSpan,
      traceIds: fusion.map((trace) => trace.id),
      note:
        fusionSpan === null
          ? 'no anomaly trace for this cluster'
          : `${fusion.length} anomaly ${fusion.length === 1 ? 'trace' : 'traces'}; span of trace timestamps`,
    },
    {
      stage: 'attrib_provisional',
      label: 'Attribution, provisional',
      latencyMs: timings.provisionalMs,
      stageMs: provisionalTrace ? numberOf(provisionalTrace.payload.stage_ms) : null,
      traceIds: provisionalTrace ? [provisionalTrace.id] : [],
      note: provisionalTrace ? 'rule lane, revision 0' : 'no provisional trace',
    },
    {
      stage: 'attrib_final',
      label: 'Attribution, final',
      latencyMs: timings.finalMs,
      stageMs: timings.finalStageMs,
      traceIds: finalTraces.map((trace) => trace.id),
      note:
        timings.finalRevision === null
          ? 'no final revision yet'
          : `reasoning lane, revision ${timings.finalRevision}`,
    },
    {
      stage: 'decide',
      label: 'Decide',
      latencyMs: decideTrace ? numberOf(decideTrace.payload.latency_ms) : null,
      stageMs: decideTrace ? numberOf(decideTrace.payload.stage_ms) : null,
      traceIds: decideTrace ? [decideTrace.id] : [],
      note: decideTrace
        ? `revision ${numberOf(decideTrace.payload.revision) ?? decision?.revision ?? 0}`
        : 'no decide trace',
    },
    {
      stage: 'ui_event',
      label: 'Console event',
      latencyMs: uiTrace ? numberOf(uiTrace.payload.latency_ms) : null,
      stageMs: uiTrace ? numberOf(uiTrace.payload.stage_ms) : null,
      traceIds: uiTrace ? [uiTrace.id] : [],
      note: uiTrace ? null : 'no UI-event trace',
    },
  ]
}

/** `1234.5` -> `1,235 ms`; `null` -> `n/a`. */
export function formatMs(value: number | null): string {
  if (value === null) return 'n/a'
  if (value >= 10_000) return `${(value / 1000).toFixed(1)} s`
  // The fast lane publishes in a fraction of a millisecond; keep that visible.
  if (value > 0 && value < 10) return `${value.toFixed(1)} ms`
  return `${Math.round(value).toLocaleString('en-US')} ms`
}
