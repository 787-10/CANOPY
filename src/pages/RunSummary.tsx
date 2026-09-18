import { useEffect, useMemo, useState } from 'react'
import { TopBar } from '../components/TopBar'
import { useCanopySocket } from '../hooks/useCanopySocket'
import { spacecraftDisplayName, verdictLabel, withheldRecoveryLabel } from '../lib/commanderLanguage'
import {
  readLastRun,
  scenarioIdFromSignals,
  summariseHealth,
  type HealthSummary,
} from '../lib/runSummary'
import { formatMs, stageTimings } from '../lib/timing'
import { useCaptureStore } from '../store/captureStore'
import { useEventStore } from '../store/eventStore'
import { selectEpisodeAttribution } from '../lib/episode'

const API_URL = import.meta.env.VITE_CANOPY_API_URL ?? 'http://localhost:8000'

/** S8: run scorecard. Stage timings from the reasoning trace, the verdict
 *  and decision from the store, the model provider from `GET /health`. The
 *  bundle written by `make demo-run` (inputs, outputs, commit hashes, model
 *  digest) lives on disk under docs/demo/runs/<run-id>/. */
export function RunSummary({ fetchImpl = fetch }: { fetchImpl?: typeof fetch }) {
  useCanopySocket()
  const capture = useCaptureStore((s) => s.enabled)
  const traces = useEventStore((s) => s.traces)
  const attributions = useEventStore((s) => s.attributions)
  const anomalies = useEventStore((s) => s.anomalies)
  const decisions = useEventStore((s) => s.decisions)
  const signals = useEventStore((s) => s.signals)
  const [health, setHealth] = useState<HealthSummary | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchImpl(`${API_URL}/health`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      })
      .then((body) => {
        if (!cancelled) setHealth(summariseHealth(body))
      })
      .catch((cause: unknown) => {
        if (!cancelled) setHealthError(cause instanceof Error ? cause.message : 'unreachable')
      })
    return () => {
      cancelled = true
    }
  }, [fetchImpl])

  // Episode verdict: the newest attribution that carries a satellite id (the
  // satellite cluster's latest revision), else the newest of all.
  const attribution = selectEpisodeAttribution(attributions, anomalies)
  const decision = attribution
    ? decisions.find((candidate) => candidate.attribution_id === attribution.id) ?? null
    : null
  const timings = useMemo(
    () => stageTimings(traces, attribution, decision),
    [traces, attribution, decision],
  )
  const lastRun = readLastRun()
  const scenarioId =
    lastRun?.stem ?? scenarioIdFromSignals(signals.map((signal) => signal.id)) ?? 'unknown'

  return (
    <main className="run-shell" data-testid="run-summary">
      <TopBar title="Run scorecard" current="run" subsystems={false} />
      <section className="run-grid">
        <section className="panel run-panel run-panel--identity">
          <div className="panel__header">
            <h2>Run</h2>
            <span>{lastRun ? `run ${lastRun.run}` : 'from console state'}</span>
          </div>
          <dl className="run-facts">
            <div>
              <dt>Scenario</dt>
              <dd data-testid="run-scenario">{scenarioId}</dd>
            </div>
            <div>
              <dt>Spacecraft</dt>
              <dd>
                {attribution?.satellite_id
                  ? spacecraftDisplayName(attribution.satellite_id)
                  : 'not identified'}
              </dd>
            </div>
            <div>
              <dt>Verdict</dt>
              <dd data-testid="run-verdict">
                {attribution
                  ? `${verdictLabel(attribution.verdict)} · ${Math.round(attribution.confidence * 100)}% · rev ${attribution.revision ?? 0}${attribution.provisional ? ' (provisional)' : ''}`
                  : 'none yet'}
              </dd>
            </div>
            <div>
              <dt>Actor</dt>
              <dd>{attribution?.actor ?? 'n/a'}</dd>
            </div>
            <div>
              <dt>Decision</dt>
              <dd>
                {decision ? `${decision.action.replaceAll('_', ' ')} · ${decision.authority}` : 'none yet'}
              </dd>
            </div>
            {decision?.withheld_recovery ? (
              <div className="run-facts__wide">
                <dt>Withheld</dt>
                <dd>{withheldRecoveryLabel(decision.withheld_recovery)}</dd>
              </div>
            ) : null}
            <div>
              <dt>Model provider</dt>
              <dd data-testid="run-provider">
                {health ? health.provider : healthError ? `gateway ${healthError}` : 'loading…'}
                {health?.llm ? <small> {health.llm}</small> : null}
              </dd>
            </div>
            <div>
              <dt>Knowledge base</dt>
              <dd>{health?.kbEntries !== null && health?.kbEntries !== undefined ? `${health.kbEntries} entries` : 'n/a'}</dd>
            </div>
            <div>
              <dt>Model digest</dt>
              <dd>recorded in the run bundle on disk</dd>
            </div>
            <div>
              <dt>Console</dt>
              <dd>{signals.length} signals · {traces.length} trace lines</dd>
            </div>
          </dl>
        </section>

        <section className="panel run-panel run-panel--timings">
          <div className="panel__header">
            <h2>Stage timings</h2>
            <span>from the reasoning trace</span>
          </div>
          <table className="run-timings" data-testid="run-timings">
            <thead>
              <tr>
                <th>Stage</th>
                <th>Since first anomaly</th>
                <th>Stage duration</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {timings.map((timing) => (
                <tr key={timing.stage} data-stage={timing.stage}>
                  <th scope="row">{timing.label}</th>
                  <td className="num" data-testid={`timing-${timing.stage}-latency`}>
                    {formatMs(timing.latencyMs)}
                  </td>
                  <td className="num" data-testid={`timing-${timing.stage}-stage`}>
                    {formatMs(timing.stageMs)}
                  </td>
                  <td>
                    {timing.note}
                    {!capture && timing.traceIds.length ? (
                      <code className="run-timings__ids" data-capture-hide>
                        {timing.traceIds.join(', ')}
                      </code>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="run-note">
            Wall-clock milliseconds stamped by the engine on each trace: the time since the
            cluster's first anomaly arrived and the emitting stage's own duration. Current
            prototype timings; nothing is rounded to a target.
          </p>
        </section>
      </section>
    </main>
  )
}
