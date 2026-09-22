import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RunSummary } from './RunSummary'
import { LAST_RUN_KEY } from '../lib/demoRuns'
import { pacingLabel } from '../lib/runSummary'
import { useClockStore } from '../store/clockStore'
import { providerFromClass, scenarioIdFromSignals, summariseHealth } from '../lib/runSummary'
import { resolveRoute } from '../lib/routes'
import { useCaptureStore } from '../store/captureStore'
import { useEventStore } from '../store/eventStore'
import { MockWebSocket } from '../test/mockWebSocket'
import { SIM01, makeAttribution, makeDecision, makeSignal, makeTrace } from '../test/factories'

const response = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }) as unknown as Response

const HEALTH = { status: 'ok', llm: 'StubLLMClient' }

/** Two rows in the shape of `GET /archive` (docs/C2-API.md section 8). */
const ARCHIVE = {
  count: 2,
  runs: [
    {
      run_id: '20260918T225802Z-run-b-anthropic',
      run: 'B',
      scenario_id: 'demo-link-margin-b',
      satellite_id: SIM01,
      created_at: '2026-09-18T22:58:02.246451Z',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      verdict: 'hostile_external',
      expected_verdict: 'hostile_external',
      verdict_correct: true,
      decision: 'space_link_interdiction_request',
      links: {
        detail: '/archive/20260918T225802Z-run-b-anthropic',
        files: '/archive/20260918T225802Z-run-b-anthropic/files/',
      },
    },
    {
      run_id: '20260918T225231Z-run-a-local',
      run: 'A',
      scenario_id: 'demo-link-margin-a',
      satellite_id: SIM01,
      created_at: '2026-09-18T22:52:31.578248Z',
      provider: 'ollama',
      model: 'demo-model',
      verdict: 'natural_external',
      expected_verdict: 'internal_fault',
      verdict_correct: false,
      decision: 'recovery_recommendation',
      links: {
        detail: '/archive/20260918T225231Z-run-a-local',
        files: '/archive/20260918T225231Z-run-a-local/files/',
      },
    },
  ],
}

beforeEach(() => {
  MockWebSocket.instances = []
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket)
  useEventStore.getState().reset()
  sessionStorage.clear()
  useCaptureStore.getState().setEnabled(false)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('run summary helpers', () => {
  it('maps the gateway health body to a provider label', () => {
    expect(summariseHealth({ status: 'ok', llm: 'OllamaClient', kb_entries: 12, osint_cluster: { model_name: 'all-MiniLM' } })).toEqual({
      status: 'ok',
      llm: 'OllamaClient',
      provider: 'local model via Ollama',
      kbEntries: 12,
      osintModel: 'all-MiniLM',
    })
    expect(providerFromClass('StubLLMClient')).toBe('stub (functionality checks only)')
    expect(providerFromClass('AnthropicClient')).toBe('Anthropic API')
    expect(providerFromClass(null)).toBe('unknown')
    expect(summariseHealth(null).provider).toBe('unknown')
  })

  it('guesses the scenario id from signal ids', () => {
    expect(scenarioIdFromSignals(['heldout-link-margin-hostile-005', 'x'])).toBe('heldout-link-margin-hostile')
    expect(scenarioIdFromSignals(['nope'])).toBeNull()
  })

  it('routes /run, /demo, /spacecraft, /signal and falls back to the Brigade view', () => {
    expect(resolveRoute('/runs', '')).toEqual({ page: 'run' })
    expect(resolveRoute('/demo', '?run=B&autostart=1')).toEqual({ page: 'demo', run: 'B', autostart: true, flight: null })
    expect(resolveRoute('/demo', '?run=A&flight=60')).toEqual({ page: 'demo', run: 'A', autostart: false, flight: '60' })
    expect(resolveRoute('/spacecraft', '?sat=SIM-01')).toEqual({ page: 'spacecraft', sat: 'SIM-01' })
    expect(resolveRoute('/signal', '?id=sig-1')).toEqual({ page: 'signal', id: 'sig-1' })
    expect(resolveRoute('/operator', '')).toEqual({ page: 'brigade' })
    expect(resolveRoute('/verdict', '?capture=1')).toEqual({ page: 'verdict' })
    expect(resolveRoute('/reasoning', '')).toEqual({ page: 'reasoning' })
    expect(resolveRoute('/signals', '')).toEqual({ page: 'signals' })
    expect(resolveRoute('/anything', '?capture=1')).toEqual({ page: 'brigade' })
  })
})

describe('RunSummary page (S8)', () => {
  it('renders stage timings from the trace and the provider from /health', async () => {
    const store = useEventStore.getState()
    store.ingestSignal(makeSignal('megalith-link-margin-b-003'))
    store.ingestAttribution(
      makeAttribution('att-1', {
        actor: 'Actor-1',
        confidence: 0.81,
        verdict: 'hostile_external',
        satellite_id: SIM01,
        revision: 1,
        anomaly_ids: ['anom-1'],
      }),
    )
    store.ingestDecision(
      makeDecision('dec-1', {
        attribution_id: 'att-1',
        action: 'passive_defense',
        authority: 'local',
        withheld_recovery: {
          action_id: 'reset_transponder_chain',
          target_subsystem: 'comms',
          reason_code: 'verdict/hostile_external',
        },
      }),
    )
    store.ingestTrace(
      makeTrace('f-1', { stage: 'fusion', ref_id: 'anom-1', message: 'new anomaly: bus_link_margin @ severity 0.8' }),
    )
    store.ingestTrace(
      makeTrace('a-0', {
        stage: 'attrib_primary',
        ref_id: 'att-1',
        payload: { latency_ms: 40, provisional: true, revision: 0 },
      }),
    )
    store.ingestTrace(
      makeTrace('a-1', {
        stage: 'attrib_reconcile',
        ref_id: 'att-1',
        payload: { latency_ms: 5200, stage_ms: 5100, provisional: false, revision: 1 },
      }),
    )
    store.ingestTrace(
      makeTrace('d-1', {
        stage: 'decide',
        level: 'decision',
        ref_id: 'dec-1',
        payload: { latency_ms: 5300, stage_ms: 90, revision: 1 },
      }),
    )
    const fetchImpl = vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith('/health')
          ? response(200, { status: 'ok', llm: 'OllamaClient', kb_entries: 9, osint_cluster: {} })
          : response(404, { detail: 'Not Found' }),
      ),
    )

    render(<RunSummary fetchImpl={fetchImpl as unknown as typeof fetch} />)

    await waitFor(() => expect(screen.getByTestId('run-provider')).toHaveTextContent('local model via Ollama'))
    expect(screen.getByTestId('run-provider')).toHaveTextContent('OllamaClient')
    expect(screen.getByTestId('run-scenario')).toHaveTextContent('megalith-link-margin-b')
    expect(screen.getByTestId('run-verdict')).toHaveTextContent('Hostile external · 81% · rev 1')
    expect(screen.getByTestId('timing-attrib_provisional-latency')).toHaveTextContent('40 ms')
    expect(screen.getByTestId('timing-attrib_final-latency')).toHaveTextContent('5,200 ms')
    expect(screen.getByTestId('timing-attrib_final-stage')).toHaveTextContent('5,100 ms')
    expect(screen.getByTestId('timing-decide-latency')).toHaveTextContent('5,300 ms')
    expect(screen.getByTestId('timing-fusion-stage')).toHaveTextContent('0 ms')
    expect(screen.getByText(/Recovery withheld: Reset transponder chain on Comms/)).toBeInTheDocument()
    // /health for the provider and /archive for the bundle list: nothing else.
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringMatching(/\/health$/))
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringMatching(/\/archive\?limit=20$/))
    // A gateway without the archive routes reads as an HTTP error, not as an empty archive.
    await waitFor(() => expect(screen.getByTestId('run-archive')).toHaveTextContent('archive HTTP 404'))
    expect(screen.queryByTestId('run-archive-table')).not.toBeInTheDocument()
  })

  it('prefers the launched run for the scenario id and prints its pacing', async () => {
    sessionStorage.setItem(LAST_RUN_KEY, JSON.stringify({ run: 'A', stem: 'megalith_link_margin_a.jsonl', startedAt: 'x' }))
    const fetchImpl = vi.fn(() => Promise.resolve(response(200, HEALTH)))
    render(<RunSummary fetchImpl={fetchImpl as unknown as typeof fetch} />)
    expect(screen.getByTestId('run-scenario')).toHaveTextContent('megalith_link_margin_a.jsonl')
    expect(screen.getByTestId('run-pacing')).toHaveTextContent('speed 20× · gaps capped at 6 s · posted by the launcher')
    expect(screen.queryByText(/run-bundle endpoint/)).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('run-provider')).toHaveTextContent('stub'))
  })

  it("prints the gateway's replay marker as the pacing when the console has one", async () => {
    sessionStorage.setItem(LAST_RUN_KEY, JSON.stringify({ run: 'A', stem: 'megalith_link_margin_a.jsonl', startedAt: 'x', flight: 60 }))
    useClockStore.getState().applyReplay(
      {
        state: 'finished',
        scenario: 'megalith_link_margin_a.jsonl',
        speed: 60,
        max_delay_s: null,
        first_ts: '2026-09-20T14:48:28Z',
        last_ts: '2026-09-20T15:14:42Z',
        now_ts: '2026-09-20T15:14:42Z',
        started_at: '2026-09-21T11:26:00Z',
        ts: '2026-09-21T11:26:27Z',
      },
      Date.now(),
    )
    const fetchImpl = vi.fn(() => Promise.resolve(response(200, HEALTH)))
    render(<RunSummary fetchImpl={fetchImpl as unknown as typeof fetch} />)
    expect(screen.getByTestId('run-pacing')).toHaveTextContent('speed 60× · no cap · finished')
    useClockStore.getState().reset()
    // Without the marker the launcher's flight rate is what is known.
    expect(pacingLabel(null, { run: 'A', stem: 'x', startedAt: '', flight: 600 })).toBe('flight 600× · no cap · posted by the launcher')
    expect(pacingLabel(null, null)).toBe('unknown')
  })

  it('restarts the demo from scratch on a confirmed click: gateway reset, console cleared, launcher opened', async () => {
    sessionStorage.setItem(LAST_RUN_KEY, JSON.stringify({ run: 'A', stem: 'megalith_link_margin_a.jsonl', startedAt: 'x' }))
    const fetchImpl = vi.fn((url: string) =>
      Promise.resolve(url.endsWith('/reset') ? response(200, { status: 'reset' }) : response(200, HEALTH)),
    )
    const navigate = vi.fn()
    render(<RunSummary fetchImpl={fetchImpl as unknown as typeof fetch} navigate={navigate} />)
    const button = screen.getByTestId('run-restart')
    expect(button).toHaveTextContent('Restart demo from scratch')
    fireEvent.click(button)
    expect(button).toHaveAttribute('data-state', 'confirm')
    expect(button).toHaveTextContent(/Confirm restart/)
    expect(fetchImpl.mock.calls.map(([url]) => url)).not.toContainEqual(expect.stringMatching(/\/reset$/))
    fireEvent.click(button)
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/demo'))
    expect(fetchImpl.mock.calls.map(([url]) => url)).toContainEqual(expect.stringMatching(/\/reset$/))
    expect(sessionStorage.getItem(LAST_RUN_KEY)).toBeNull()
  })

  it('asks /health and /archive with the bearer header when the console carries a deploy-time token (C11)', async () => {
    vi.stubEnv('VITE_CANOPY_API_TOKEN', 'deploy-secret')
    const fetchImpl = vi.fn(() => Promise.resolve(response(200, HEALTH)))
    render(<RunSummary fetchImpl={fetchImpl as unknown as typeof fetch} />)
    await waitFor(() => expect(screen.getByTestId('run-provider')).toHaveTextContent('stub'))
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringMatching(/\/health$/), {
      headers: { Authorization: 'Bearer deploy-secret' },
    })
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringMatching(/\/archive\?limit=20$/), {
      headers: { Authorization: 'Bearer deploy-secret' },
    })
  })

  it('says the gateway is unreachable rather than guessing a provider', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('connection refused')))
    render(<RunSummary fetchImpl={fetchImpl as unknown as typeof fetch} />)
    await waitFor(() => expect(screen.getByTestId('run-provider')).toHaveTextContent('gateway connection refused'))
    expect(screen.getByTestId('run-verdict')).toHaveTextContent('none yet')
    await waitFor(() => expect(screen.getByTestId('run-archive')).toHaveTextContent('archive connection refused'))
  })
})

describe('RunSummary archive panel (C13)', () => {
  const gateway = (archive: Response) =>
    vi.fn((url: string) => Promise.resolve(url.includes('/archive') ? archive : response(200, HEALTH)))

  it('lists the archived bundles from GET /archive, newest first as served', async () => {
    const fetchImpl = gateway(response(200, ARCHIVE))
    render(<RunSummary fetchImpl={fetchImpl as unknown as typeof fetch} />)

    await waitFor(() => expect(screen.getByTestId('run-archive')).toHaveTextContent('2 bundles from GET /archive'))
    const rows = screen.getByTestId('run-archive-table').querySelectorAll('tbody tr')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveAttribute('data-run-id', '20260918T225802Z-run-b-anthropic')
    expect(rows[0]).toHaveTextContent('2026-09-18 22:58 UTC')
    expect(rows[0]).toHaveTextContent('anthropic · claude-sonnet-4-6')
    expect(rows[0]).toHaveTextContent('hostile external correct')
    expect(rows[0]).toHaveTextContent('space link interdiction request')
    expect(rows[1]).toHaveTextContent('natural external missed (expected internal fault)')
    expect(rows[1]).toHaveTextContent('recovery recommendation')
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringMatching(/\/archive\?limit=20$/))
  })

  it('reads an empty archive as empty, not as an error', async () => {
    const fetchImpl = gateway(response(200, { count: 0, runs: [] }))
    render(<RunSummary fetchImpl={fetchImpl as unknown as typeof fetch} />)
    await waitFor(() => expect(screen.getByTestId('run-archive')).toHaveTextContent('0 bundles from GET /archive'))
    expect(screen.getByText('No bundles in the archive directory yet.')).toBeInTheDocument()
    expect(screen.queryByTestId('run-archive-table')).not.toBeInTheDocument()
  })

  it('says the archive is not configured when the gateway answers 503', async () => {
    const fetchImpl = gateway(response(503, { detail: 'archive unavailable: MEGALITH_ARCHIVE_DIR is not set' }))
    render(<RunSummary fetchImpl={fetchImpl as unknown as typeof fetch} />)
    await waitFor(() =>
      expect(screen.getByTestId('run-archive')).toHaveTextContent('archive not configured on this gateway'),
    )
    expect(screen.queryByTestId('run-archive-table')).not.toBeInTheDocument()
  })

  it('leaves the panel out in capture mode and does not ask the gateway for it', async () => {
    useCaptureStore.getState().setEnabled(true)
    const fetchImpl = gateway(response(200, ARCHIVE))
    render(<RunSummary fetchImpl={fetchImpl as unknown as typeof fetch} />)
    await waitFor(() => expect(screen.getByTestId('run-provider')).toHaveTextContent('stub'))
    expect(screen.queryByTestId('run-archive')).not.toBeInTheDocument()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringMatching(/\/health$/))
  })
})
