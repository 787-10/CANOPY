import { useEffect, useMemo, useState } from 'react'
import { TopBar } from '../components/TopBar'
import { useCanopySocket } from '../hooks/useCanopySocket'
import { actionLabel } from '../lib/actionLabels'
import { spacecraftDisplayName, verdictLabel, withheldRecoveryLabel } from '../lib/commanderLanguage'
import { restartDemo } from '../lib/demoRuns'
import { fetchGateway } from '../lib/gateway'
import {
  pacingLabel,
  readLastRun,
  scenarioIdFromSignals,
  summariseHealth,
  type HealthSummary,
} from '../lib/runSummary'
import { formatMs, stageTimings } from '../lib/timing'
import { useCaptureStore } from '../store/captureStore'
import { useClockStore } from '../store/clockStore'
import { useEventStore } from '../store/eventStore'
import { selectEpisodeAttribution } from '../lib/episode'
import '../styles/run.css'

/** One row of `GET /archive` (docs/C2-API.md section 8): the headline of a
 *  bundle's run.json. Not a bus event, so not in the generated types. */
type ArchiveRow = {
  run_id: string
  run: string | null
  scenario_id: string | null
  created_at: string
  provider: string | null
  model: string | null
  verdict: string | null
  expected_verdict: string | null
  verdict_correct: boolean | null
  decision: string | null
}

const ARCHIVE_PATH = '/archive?limit=20'

/** The rows of an archive list body; anything else (a body without `runs`,
 *  a health body handed back by a permissive mock) is an empty archive. */
function archiveRows(body: unknown): ArchiveRow[] {
  if (!body || typeof body !== 'object') return []
  const runs = (body as { runs?: unknown }).runs
  if (!Array.isArray(runs)) return []
  return runs.filter(
    (row): row is ArchiveRow =>
      !!row && typeof row === 'object' && typeof (row as ArchiveRow).run_id === 'string',
  )
}

/** `2026-09-18T22:58:02.246451Z` -> `2026-09-18 22:58 UTC`; a value that is
 *  not an ISO timestamp is shown as it came. */
function recordedAt(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : iso
}

function scoreLabel(row: ArchiveRow): string {
  if (row.verdict_correct === true) return 'correct'
  if (row.verdict_correct === false) return `missed (expected ${(row.expected_verdict ?? '?').replaceAll('_', ' ')})`
  return 'unscored'
}

/** S8: run scorecard. Stage timings from the reasoning trace, the verdict
 *  and decision from the store, the model provider from `GET /health`, and
 *  the archived bundles written by `make demo-run` (inputs, outputs, commit
 *  hashes, model digest) from `GET /archive`, when the gateway serves one.
 *  The archive panel is left out in capture mode so the pinned layout does
 *  not shift. */
/** Second click within this many ms confirms a restart; otherwise the button relaxes. */
const RESTART_CONFIRM_MS = 6000

export function RunSummary({
  fetchImpl = fetch,
  navigate,
}: {
  fetchImpl?: typeof fetch
  navigate?: (url: string) => void
}) {
  useCanopySocket()
  const [restart, setRestart] = useState<'idle' | 'confirm' | 'working' | 'failed'>('idle')
  useEffect(() => {
    if (restart !== 'confirm') return
    const timer = setTimeout(() => setRestart('idle'), RESTART_CONFIRM_MS)
    return () => clearTimeout(timer)
  }, [restart])
  const onRestart = async () => {
    if (restart === 'idle') {
      setRestart('confirm')
      return
    }
    if (restart !== 'confirm') return
    setRestart('working')
    const result = await restartDemo({ fetchImpl, navigate })
    if (!result.gatewayReset) setRestart('failed')
  }
  const capture = useCaptureStore((s) => s.enabled)
  const traces = useEventStore((s) => s.traces)
  const attributions = useEventStore((s) => s.attributions)
  const anomalies = useEventStore((s) => s.anomalies)
  const decisions = useEventStore((s) => s.decisions)
  const signals = useEventStore((s) => s.signals)
  const [health, setHealth] = useState<HealthSummary | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [archive, setArchive] = useState<ArchiveRow[] | null>(null)
  const [archiveError, setArchiveError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchGateway('/health', undefined, { fetchImpl })
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

  useEffect(() => {
    if (capture) return
    let cancelled = false
    fetchGateway(ARCHIVE_PATH, undefined, { fetchImpl })
      .then(async (response) => {
        // 503 is the gateway's "no archive directory configured" (C2-API section 8).
        if (response.status === 503) throw new Error('not configured on this gateway')
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      })
      .then((body) => {
        if (!cancelled) setArchive(archiveRows(body))
      })
      .catch((cause: unknown) => {
        if (!cancelled) setArchiveError(cause instanceof Error ? cause.message : 'unreachable')
      })
    return () => {
      cancelled = true
    }
  }, [fetchImpl, capture])

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
  const replayMarker = useClockStore((s) => s.run)
  const scenarioId =
    lastRun?.stem ?? scenarioIdFromSignals(signals.map((signal) => signal.id)) ?? 'unknown'

  return (
    <main className="run-shell" data-testid="run-summary">
      <TopBar title="Run scorecard" current="run" />
      <section className="run-grid">
        <section className="panel run-panel run-panel--identity">
          <div className="panel__header">
            <h2>Run</h2>
            <span>{lastRun ? `run ${lastRun.run}` : 'from console state'}</span>
          </div>
          <div className="run-panel__body">
            <dl className="run-facts">
              <div>
                <dt>Scenario</dt>
                <dd data-testid="run-scenario">{scenarioId}</dd>
              </div>
              <div>
                <dt>Pacing</dt>
                <dd data-testid="run-pacing">{pacingLabel(replayMarker, lastRun)}</dd>
              </div>
              <div className="run-facts__wide run-restart">
                <dt>Demo</dt>
                <dd>
                  <button
                    type="button"
                    className={`run-restart__button${restart === 'confirm' ? ' run-restart__button--confirm' : ''}`}
                    onClick={() => void onRestart()}
                    disabled={restart === 'working'}
                    data-testid="run-restart"
                    data-state={restart}
                    title="Clears the engine on the gateway (every connected console drops the run), forgets this console's copy, and opens the launcher"
                  >
                    {restart === 'confirm'
                      ? 'Confirm restart: clears this run on every console'
                      : restart === 'working'
                        ? 'Restarting…'
                        : restart === 'failed'
                          ? 'Gateway did not answer; console cleared. Retry'
                          : 'Restart demo from scratch'}
                  </button>
                  <small className="run-restart__note">
                    Resets the gateway and this console, then opens the launcher. Nothing replays until Start.
                  </small>
                </dd>
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
                  {decision ? `${actionLabel(decision.action)} · ${decision.authority} authority` : 'none yet'}
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
                <dt>Console</dt>
                <dd>{signals.length} signals · {traces.length} trace lines</dd>
              </div>
            </dl>
          </div>
        </section>

        <section className="panel run-panel run-panel--timings">
          <div className="panel__header">
            <h2>Stage timings</h2>
            <span>from the reasoning trace</span>
          </div>
          <div className="run-panel__body">
            <table className="run-timings run-timings--stages" data-testid="run-timings">
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
                        // One line; a long list is cut with an ellipsis and kept in the tooltip.
                        <code
                          className="run-timings__ids"
                          data-capture-hide
                          title={timing.traceIds.join(', ')}
                        >
                          {timing.traceIds.join(', ')}
                        </code>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <details className="run-more">
              <summary>About these numbers</summary>
              <p className="run-note">
                Wall-clock milliseconds stamped by the engine on each trace: the time since the
                cluster's first anomaly arrived and the emitting stage's own duration. Current
                prototype timings; nothing is rounded to a target.
              </p>
            </details>
          </div>
        </section>

        {!capture ? (
          <section className="panel run-panel run-panel--archive" data-testid="run-archive">
            <div className="panel__header">
              <h2>Archived runs</h2>
              <span>
                {archive
                  ? `${archive.length} bundle${archive.length === 1 ? '' : 's'} from GET /archive`
                  : archiveError
                    ? `archive ${archiveError}`
                    : 'loading…'}
              </span>
            </div>
            <div className="run-panel__body">
              {archive && archive.length ? (
                <table className="run-timings run-timings--archive" data-testid="run-archive-table">
                  <thead>
                    <tr>
                      <th>Recorded</th>
                      <th>Run</th>
                      <th>Scenario</th>
                      <th>Model</th>
                      <th>Verdict</th>
                      <th>Decision</th>
                      <th>Bundle</th>
                    </tr>
                  </thead>
                  <tbody>
                    {archive.map((row) => {
                      const model = [row.provider, row.model].filter(Boolean).join(' · ') || 'n/a'
                      const scenario = row.scenario_id ?? 'n/a'
                      return (
                        <tr key={row.run_id} data-run-id={row.run_id}>
                          <td>{recordedAt(row.created_at)}</td>
                          <td>{row.run ?? 'n/a'}</td>
                          <td title={scenario}>{scenario}</td>
                          <td title={model}>{model}</td>
                          <td>
                            {(row.verdict ?? 'none').replaceAll('_', ' ')} <small>{scoreLabel(row)}</small>
                          </td>
                          <td>{(row.decision ?? 'none').replaceAll('_', ' ')}</td>
                          <td title={row.run_id}>
                            <code>{row.run_id}</code>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              ) : archive ? (
                <p className="run-note">No bundles in the archive directory yet.</p>
              ) : null}
              <p className="run-note">
                Each row is one bundle written by <code>make demo-run</code> and served read-only by
                the gateway (<code>GET /archive/&lt;run-id&gt;</code> for the run record, scorecard,
                timings and files). The bundle is the retention unit; nothing here is editable.
              </p>
            </div>
          </section>
        ) : null}
      </section>
    </main>
  )
}
