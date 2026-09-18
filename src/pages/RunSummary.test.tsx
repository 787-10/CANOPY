import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { RunSummary } from './RunSummary'
import { LAST_RUN_KEY } from '../lib/demoRuns'
import { providerFromClass, scenarioIdFromSignals, summariseHealth } from '../lib/runSummary'
import { resolveRoute } from '../lib/routes'
import { useEventStore } from '../store/eventStore'
import { MockWebSocket } from '../test/mockWebSocket'
import { SIM01, makeAttribution, makeDecision, makeSignal, makeTrace } from '../test/factories'

const response = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }) as unknown as Response

beforeEach(() => {
  MockWebSocket.instances = []
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket)
  useEventStore.getState().reset()
  sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
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
    expect(resolveRoute('/run', '')).toEqual({ page: 'run' })
    expect(resolveRoute('/demo', '?run=B&autostart=1')).toEqual({ page: 'demo', run: 'B', autostart: true })
    expect(resolveRoute('/spacecraft', '?sat=SIM-01')).toEqual({ page: 'spacecraft', sat: 'SIM-01' })
    expect(resolveRoute('/signal', '?id=sig-1')).toEqual({ page: 'signal', id: 'sig-1' })
    expect(resolveRoute('/operator', '')).toEqual({ page: 'operator' })
    expect(resolveRoute('/anything', '?capture=1')).toEqual({ page: 'brigade' })
  })
})

describe('RunSummary page (S8)', () => {
  it('renders stage timings from the trace and the provider from /health when no bundle endpoint exists', async () => {
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
    await waitFor(() => expect(screen.getByTestId('bundle-state')).toHaveTextContent('absent'))
    expect(screen.getByTestId('bundle-note')).toHaveTextContent(/no run-bundle endpoint/)
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringMatching(/\/runs\/latest$/))
  })

  it('prefers the launched run for the scenario id and renders a bundle when the gateway has one', async () => {
    sessionStorage.setItem(LAST_RUN_KEY, JSON.stringify({ run: 'A', stem: 'megalith_link_margin_a.jsonl', startedAt: 'x' }))
    const fetchImpl = vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith('/health')
          ? response(200, { status: 'ok', llm: 'StubLLMClient' })
          : response(200, { run_id: 'run-a-001', model_digest: 'sha256:abc', nested: { ignored: true } }),
      ),
    )
    render(<RunSummary fetchImpl={fetchImpl as unknown as typeof fetch} />)
    expect(screen.getByTestId('run-scenario')).toHaveTextContent('megalith_link_margin_a.jsonl')
    await waitFor(() => expect(screen.getByTestId('bundle-state')).toHaveTextContent('present'))
    expect(screen.getByText('run-a-001')).toBeInTheDocument()
    expect(screen.getByText('sha256:abc')).toBeInTheDocument()
    expect(screen.queryByText('[object Object]')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('run-provider')).toHaveTextContent('stub'))
  })

  it('says the gateway is unreachable rather than guessing a provider', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('connection refused')))
    render(<RunSummary fetchImpl={fetchImpl as unknown as typeof fetch} />)
    await waitFor(() => expect(screen.getByTestId('run-provider')).toHaveTextContent('gateway connection refused'))
    expect(screen.getByTestId('run-verdict')).toHaveTextContent('none yet')
  })
})
