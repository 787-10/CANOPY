// The three demo runs (MEGALITH demo plan §1) and the launcher logic behind
// `/demo?run=A|B|C`. Kept out of the page component so the fetch and the
// navigation can be unit-tested with doubles.
import { useCaptureStore, withCapture } from '../store/captureStore'
import { useEventStore } from '../store/eventStore'

export const DEMO_API_URL: string =
  import.meta.env.VITE_CANOPY_API_URL ?? 'http://localhost:8000'

export type DemoRun = 'A' | 'B' | 'C'

export type DemoRunSpec = {
  run: DemoRun
  /** Scenario file stem registered with the gateway (demo-scenario lane). */
  stem: string
  title: string
  groundTruth: string
  expectedVerdict: string
}

// Names from the roadmap row for the demo-scenario lane
// (`external/canopy/scenarios/megalith_link_margin_{a,b,c}.jsonl`).
export const DEMO_RUNS: Record<DemoRun, DemoRunSpec> = {
  A: {
    run: 'A',
    stem: 'megalith_link_margin_a.jsonl',
    title: 'Run A · amplifier degradation',
    groundTruth: 'Gradual margin decline; rising amplifier temperature; no external activity.',
    expectedVerdict: 'internal fault → recovery recommendation',
  },
  B: {
    run: 'B',
    stem: 'megalith_link_margin_b.jsonl',
    title: 'Run B · uplink jamming',
    groundTruth: 'Step change in margin; RF interference report near the Site A footprint.',
    expectedVerdict: 'hostile external → Actor-1, defensive response, recovery withheld',
  },
  C: {
    run: 'C',
    stem: 'megalith_link_margin_c.jsonl',
    title: 'Run C · geomagnetic storm',
    groundTruth: 'Fleet-wide safe-mode pattern on SIM-02; elevated Kp and Dst.',
    expectedVerdict: 'natural external → no escalation',
  },
}

// Pacing for a live recording (demo plan §7: roughly 50 s per run). The
// gateway caps every inter-record sleep at `max_delay_s`; its default cap of
// 0.5 s would drain a run in a few seconds regardless of speed, so the
// launcher asks for a 6 s cap: with the link-margin scenario's 90 to 140 s
// gaps at 20x that is 4.5 to 7 s per record, about 50 s for the run. The
// current gateway ignores the extra query parameter (request to the backend
// lane in the hand-back); the replay then drains quickly and the pace of the
// recording is the engine's reasoning time.
export const REPLAY_SPEED = 20
export const REPLAY_MAX_DELAY_S = 6

export const LAST_RUN_KEY = 'megalith-last-run'

/** The reset must never hold the Start button: a decide call in flight on a
 *  local model can take a minute, and the gateway drops its result anyway. */
export const RESET_TIMEOUT_MS = 5000

export function resetUrl(apiUrl: string = DEMO_API_URL): string {
  return `${apiUrl}/reset`
}

export function replayUrl(spec: DemoRunSpec, apiUrl: string = DEMO_API_URL): string {
  return `${apiUrl}/scenarios/${encodeURIComponent(spec.stem)}/replay?speed=${REPLAY_SPEED}&max_delay_s=${REPLAY_MAX_DELAY_S}`
}

export function parseRun(value: string | null | undefined): DemoRun | null {
  const upper = value?.trim().toUpperCase()
  return upper === 'A' || upper === 'B' || upper === 'C' ? upper : null
}

export type StartDemoRunOptions = {
  fetchImpl?: typeof fetch
  navigate?: (url: string) => void
  apiUrl?: string
  /** Clear the console's event buffers first (default true). */
  clearState?: boolean
}

/** POST the replay and move to the Brigade view in capture mode. Returns
 *  the gateway's response body on success; throws on a non-2xx response. */
export async function startDemoRun(
  run: DemoRun,
  {
    fetchImpl = fetch,
    navigate = (url) => window.location.assign(url),
    apiUrl = DEMO_API_URL,
    clearState = true,
  }: StartDemoRunOptions = {},
): Promise<unknown> {
  const spec = DEMO_RUNS[run]
  if (clearState) {
    useEventStore.getState().reset()
    try {
      sessionStorage.removeItem('canopy-event-store')
    } catch {
      // storage unavailable: the in-memory reset is enough
    }
  }
  // Clear the engine's in-process state first (fusion correlates, attrib context,
  // decide anomaly cache): a previous run's RF anomaly on the same satellite
  // would otherwise leak into this run's verdict. A gateway without /reset is
  // tolerated so the replay still starts.
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), RESET_TIMEOUT_MS)
    try {
      await fetchImpl(resetUrl(apiUrl), { method: 'POST', signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  } catch {
    // unreachable or slow gateway: the replay call below reports it
  }
  const response = await fetchImpl(replayUrl(spec, apiUrl), { method: 'POST' })
  if (!response.ok) {
    throw new Error(`gateway refused replay of ${spec.stem}: HTTP ${response.status}`)
  }
  const body: unknown = await response.json().catch(() => ({}))
  try {
    sessionStorage.setItem(
      LAST_RUN_KEY,
      JSON.stringify({ run, stem: spec.stem, startedAt: new Date().toISOString() }),
    )
  } catch {
    // storage unavailable
  }
  useCaptureStore.getState().setEnabled(true)
  navigate(withCapture(`/brigade?run=${run}`, true))
  return body
}
