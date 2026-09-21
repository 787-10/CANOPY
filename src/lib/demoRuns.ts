// The three demo runs (MEGALITH demo plan §1) and the launcher logic behind
// `/demo?run=A|B|C`. Kept out of the page component so the fetch and the
// navigation can be unit-tested with doubles.
import { useCaptureStore, withCapture } from '../store/captureStore'
import { COUPLED_RATES, useClockStore, type FlightRate } from '../store/clockStore'
import { useEventStore } from '../store/eventStore'
import { apiUrl, fetchGateway } from './gateway'

/** The gateway's REST base, from src/lib/gateway.ts. */
export const DEMO_API_URL: string = apiUrl()

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
// gaps at 20x that is 4.5 to 7 s per record, about 50 s for the run; the
// engine's reasoning time (tens of seconds per pass) sets the rest of the
// pace.
export const REPLAY_SPEED = 20
export const REPLAY_MAX_DELAY_S = 6

export const LAST_RUN_KEY = 'megalith-last-run'
/** Set by the launcher, consumed by the console once its socket is open: the
 *  replay must not start before the page that shows it is listening, or the
 *  first record (the space-weather context) is published to nobody. */
export const PENDING_REPLAY_KEY = 'megalith-pending-replay'

/** The reset must never hold the Start button: a decide call in flight on a
 *  local model can take a minute, and the gateway drops its result anyway. */
// Longer than the gateway's worst case (two bounded 3 s drains): the abort is
// for a gateway that hangs, not for a reset that is merely slow.
export const RESET_TIMEOUT_MS = 8000

const RESET_PATH = '/reset'

export function resetUrl(apiUrl: string = DEMO_API_URL): string {
  return `${apiUrl}${RESET_PATH}`
}

export function replayPath(spec: DemoRunSpec, flight: FlightRate | null = null): string {
  // A flight run (docs/MEGALITH-Flight-Plan.md §2.3): the replay is paced by
  // the flight clock, speed = rate and no inter-signal cap, so signals land at
  // their scenario times. The default path is the storyboard's.
  if (flight) return `/scenarios/${encodeURIComponent(spec.stem)}/replay?speed=${flight}&no_cap=1`
  return `/scenarios/${encodeURIComponent(spec.stem)}/replay?speed=${REPLAY_SPEED}&max_delay_s=${REPLAY_MAX_DELAY_S}`
}

export function replayUrl(spec: DemoRunSpec, apiUrl: string = DEMO_API_URL, flight: FlightRate | null = null): string {
  return `${apiUrl}${replayPath(spec, flight)}`
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
  /** Fly the run on the scenario clock at this rate (1, 10, 60 or 600); null is the storyboard's pacing. */
  flight?: FlightRate | null
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
    flight = null,
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
      await fetchGateway(
        RESET_PATH,
        { method: 'POST', signal: controller.signal },
        { fetchImpl, baseUrl: apiUrl },
      )
    } finally {
      clearTimeout(timer)
    }
  } catch {
    // unreachable or slow gateway: the replay call below reports it
  }
  try {
    sessionStorage.setItem(PENDING_REPLAY_KEY, JSON.stringify({ run, stem: spec.stem, flight }))
    sessionStorage.setItem(
      LAST_RUN_KEY,
      JSON.stringify({ run, stem: spec.stem, startedAt: new Date().toISOString(), flight }),
    )
  } catch {
    // storage unavailable: the console cannot pick the replay up; start it by hand
  }
  // A flight run opens the console flying and out of capture mode (a capture
  // is always the pass view); the storyboard's path is unchanged.
  useClockStore.getState().setView(flight ? 'flight' : 'pass')
  useCaptureStore.getState().setEnabled(!flight)
  navigate(flight ? `/brigade?run=${run}&flight=1` : withCapture(`/brigade?run=${run}`, true))
  return { status: 'pending', run, stem: spec.stem, flight }
}

type PendingReplay = { run: DemoRun; stem: string; flight: FlightRate | null }

const parseFlight = (value: unknown): FlightRate | null =>
  (COUPLED_RATES as readonly number[]).includes(value as number) ? (value as FlightRate) : null

export function readPendingReplay(): PendingReplay | null {
  try {
    const raw = sessionStorage.getItem(PENDING_REPLAY_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PendingReplay>
    const run = parseRun(parsed.run ?? null)
    return run ? { run, stem: DEMO_RUNS[run].stem, flight: parseFlight(parsed.flight) } : null
  } catch {
    return null
  }
}

/** Start the replay the launcher left pending, once. Called by the console
 *  when its socket connects; the flag is cleared before the request so a
 *  second effect run (development-mode double invoke, a reconnect) cannot
 *  start the run twice. Resolves to the gateway body, or null when nothing
 *  was pending. */
export async function startPendingReplay({
  fetchImpl = fetch,
  apiUrl = DEMO_API_URL,
}: { fetchImpl?: typeof fetch; apiUrl?: string } = {}): Promise<unknown> {
  const pending = readPendingReplay()
  if (!pending) return null
  try {
    sessionStorage.removeItem(PENDING_REPLAY_KEY)
  } catch {
    // storage unavailable
  }
  const spec = DEMO_RUNS[pending.run]
  const response = await fetchGateway(
    replayPath(spec, pending.flight),
    { method: 'POST' },
    { fetchImpl, baseUrl: apiUrl },
  )
  if (!response.ok) {
    throw new Error(`gateway refused replay of ${spec.stem}: HTTP ${response.status}`)
  }
  return response.json().catch(() => ({}))
}
