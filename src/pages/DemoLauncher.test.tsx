import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DemoLauncher } from './DemoLauncher'
import {
  DEMO_RUNS,
  LAST_RUN_KEY,
  PENDING_REPLAY_KEY,
  REPLAY_MAX_DELAY_S,
  REPLAY_SPEED,
  parseRun,
  readPendingReplay,
  replayUrl,
  restartDemo,
  startDemoRun,
  startPendingReplay,
} from '../lib/demoRuns'
import { useCaptureStore } from '../store/captureStore'
import { useClockStore } from '../store/clockStore'
import { useEventStore } from '../store/eventStore'
import { makeSignal } from '../test/factories'

const okResponse = (body: unknown = { status: 'replaying' }) =>
  ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as unknown as Response

beforeEach(() => {
  sessionStorage.clear()
  useCaptureStore.getState().setEnabled(false)
  useEventStore.getState().reset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('demo runs', () => {
  it('names the three scenario stems from the demo-scenario lane', () => {
    expect(DEMO_RUNS.A.stem).toBe('megalith_link_margin_a.jsonl')
    expect(DEMO_RUNS.B.stem).toBe('megalith_link_margin_b.jsonl')
    expect(DEMO_RUNS.C.stem).toBe('megalith_link_margin_c.jsonl')
    expect(parseRun('b')).toBe('B')
    expect(parseRun('D')).toBeNull()
    expect(parseRun(null)).toBeNull()
  })

  it('builds the replay URL with the encoded stem, the speed and the delay cap', () => {
    expect(replayUrl(DEMO_RUNS.A, 'http://gw:8000')).toBe(
      `http://gw:8000/scenarios/megalith_link_margin_a.jsonl/replay?speed=${REPLAY_SPEED}&max_delay_s=${REPLAY_MAX_DELAY_S}`,
    )
    expect(REPLAY_SPEED).toBe(20)
    expect(REPLAY_MAX_DELAY_S).toBe(6)
  })

  it('startDemoRun clears the store, resets the engine, leaves the replay pending and navigates in capture mode', async () => {
    useEventStore.getState().ingestSignal(makeSignal('old'))
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ status: 'reset' }))
    const navigate = vi.fn()
    const body = await startDemoRun('B', { fetchImpl, navigate, apiUrl: 'http://gw:8000' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][0]).toBe('http://gw:8000/reset')
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'POST' })
    expect(body).toEqual({ status: 'pending', run: 'B', stem: 'megalith_link_margin_b.jsonl', flight: null })
    expect(useEventStore.getState().signals).toEqual([])
    expect(readPendingReplay()).toEqual({ run: 'B', stem: 'megalith_link_margin_b.jsonl', flight: null })
    expect(JSON.parse(sessionStorage.getItem(LAST_RUN_KEY)!)).toMatchObject({
      run: 'B',
      stem: 'megalith_link_margin_b.jsonl',
    })
    expect(useCaptureStore.getState().enabled).toBe(true)
    expect(navigate).toHaveBeenCalledWith('/brigade?run=B&capture=1')
  })

  it('startPendingReplay POSTs the pending replay once and clears the flag first', async () => {
    sessionStorage.setItem(PENDING_REPLAY_KEY, JSON.stringify({ run: 'B' }))
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ status: 'replaying', scenario: 'x' }))
    const body = await startPendingReplay({ fetchImpl, apiUrl: 'http://gw:8000' })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://gw:8000/scenarios/megalith_link_margin_b.jsonl/replay?speed=20&max_delay_s=6',
      { method: 'POST' },
    )
    expect(body).toEqual({ status: 'replaying', scenario: 'x' })
    expect(sessionStorage.getItem(PENDING_REPLAY_KEY)).toBeNull()
    // A second effect run finds nothing pending and does not start the run twice.
    expect(await startPendingReplay({ fetchImpl, apiUrl: 'http://gw:8000' })).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('carries the deploy-time bearer token on the reset and the replay (C11)', async () => {
    vi.stubEnv('VITE_CANOPY_API_TOKEN', 'deploy-secret')
    const fetchImpl = vi.fn().mockResolvedValue(okResponse())
    await startDemoRun('A', { fetchImpl, navigate: vi.fn(), apiUrl: 'http://gw:8000' })
    expect(fetchImpl.mock.calls[0][0]).toBe('http://gw:8000/reset')
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer deploy-secret' },
    })
    await startPendingReplay({ fetchImpl, apiUrl: 'http://gw:8000' })
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'http://gw:8000/scenarios/megalith_link_margin_a.jsonl/replay?speed=20&max_delay_s=6',
      { method: 'POST', headers: { Authorization: 'Bearer deploy-secret' } },
    )
  })

  it('a flight run paces the replay by the rate with no cap, opens the console flying and out of capture mode', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ status: 'reset' }))
    const navigate = vi.fn()
    const body = await startDemoRun('A', { fetchImpl, navigate, apiUrl: 'http://gw:8000', flight: 60 })
    expect(body).toEqual({ status: 'pending', run: 'A', stem: 'megalith_link_margin_a.jsonl', flight: 60 })
    expect(readPendingReplay()).toEqual({ run: 'A', stem: 'megalith_link_margin_a.jsonl', flight: 60 })
    expect(useCaptureStore.getState().enabled).toBe(false)
    expect(useClockStore.getState().view).toBe('flight')
    expect(navigate).toHaveBeenCalledWith('/brigade?run=A&flight=1')
    await startPendingReplay({ fetchImpl, apiUrl: 'http://gw:8000' })
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'http://gw:8000/scenarios/megalith_link_margin_a.jsonl/replay?speed=60&no_cap=1',
      { method: 'POST' },
    )
    expect(replayUrl(DEMO_RUNS.B, 'http://gw:8000', 600)).toBe(
      'http://gw:8000/scenarios/megalith_link_margin_b.jsonl/replay?speed=600&no_cap=1',
    )
    // The storyboard's path is unchanged by the option existing.
    useClockStore.getState().setView('pass')
  })

  it('a pending flight rate outside 1/10/60/600 falls back to the storyboard pacing', async () => {
    sessionStorage.setItem(PENDING_REPLAY_KEY, JSON.stringify({ run: 'C', flight: 7 }))
    expect(readPendingReplay()).toEqual({ run: 'C', stem: DEMO_RUNS.C.stem, flight: null })
  })

  it('restartDemo resets the gateway, forgets the run on this console and opens the launcher', async () => {
    useEventStore.getState().ingestSignal(makeSignal('old'))
    sessionStorage.setItem(LAST_RUN_KEY, JSON.stringify({ run: 'B', stem: 'x', startedAt: 'y' }))
    sessionStorage.setItem(PENDING_REPLAY_KEY, JSON.stringify({ run: 'B' }))
    useClockStore.getState().setView('flight')
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ status: 'reset' }))
    const navigate = vi.fn()
    const result = await restartDemo({ fetchImpl, navigate, apiUrl: 'http://gw:8000' })
    expect(result).toEqual({ status: 'restarted', gatewayReset: true })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][0]).toBe('http://gw:8000/reset')
    expect(useEventStore.getState().signals).toEqual([])
    expect(sessionStorage.getItem(LAST_RUN_KEY)).toBeNull()
    expect(sessionStorage.getItem(PENDING_REPLAY_KEY)).toBeNull()
    expect(useClockStore.getState().view).toBe('pass')
    expect(navigate).toHaveBeenCalledWith('/demo')
    // An unreachable gateway still clears the console and opens the launcher, and says so.
    const offline = vi.fn().mockRejectedValue(new Error('offline'))
    expect(await restartDemo({ fetchImpl: offline, navigate, apiUrl: 'http://gw:8000' })).toEqual({ status: 'restarted', gatewayReset: false })
  })

  it('startPendingReplay throws on a non-2xx gateway response', async () => {
    sessionStorage.setItem(PENDING_REPLAY_KEY, JSON.stringify({ run: 'C' }))
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404, json: () => Promise.resolve({}) })
    await expect(startPendingReplay({ fetchImpl })).rejects.toThrow(/HTTP 404/)
    expect(readPendingReplay()).toBeNull()
  })
})

describe('DemoLauncher route', () => {
  it('preselects the run from ?run= and shows its stem', () => {
    render(<DemoLauncher run="b" />)
    expect(screen.getByTestId('demo-title')).toHaveTextContent('Run B · uplink jamming')
    expect(screen.getByTestId('demo-stem')).toHaveTextContent('megalith_link_margin_b.jsonl')
    expect(screen.getByRole('radio', { name: /Run B/ })).toHaveAttribute('aria-checked', 'true')
  })

  it('resets the engine on click, leaves the replay pending and navigates to the console in capture mode', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse())
    const navigate = vi.fn()
    render(<DemoLauncher run="A" fetchImpl={fetchImpl} navigate={navigate} />)
    fireEvent.click(screen.getByTestId('demo-start'))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/brigade?run=A&capture=1'))
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][0]).toMatch(/\/reset$/)
    expect(readPendingReplay()).toEqual({ run: 'A', stem: 'megalith_link_margin_a.jsonl', flight: null })
    expect(screen.getByTestId('demo-start')).toHaveTextContent('Started')
  })

  it('offers the flight rates, reads ?flight= and passes the rate to the start', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse())
    const navigate = vi.fn()
    render(<DemoLauncher run="A" flight="60" fetchImpl={fetchImpl} navigate={navigate} />)
    expect(screen.getByTestId('demo-flight-60')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('demo-pacing')).toHaveTextContent('flight at 60x scenario time, no cap')
    fireEvent.click(screen.getByTestId('demo-flight-off'))
    expect(screen.getByTestId('demo-pacing')).toHaveTextContent('speed 20x, gaps capped at 6 s')
    fireEvent.click(screen.getByTestId('demo-flight-600'))
    fireEvent.click(screen.getByTestId('demo-start'))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/brigade?run=A&flight=1'))
    expect(readPendingReplay()).toEqual({ run: 'A', stem: 'megalith_link_margin_a.jsonl', flight: 600 })
    useClockStore.getState().setView('pass')
  })

  it('switches run with the radio group before starting', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse())
    const navigate = vi.fn()
    render(<DemoLauncher run="A" fetchImpl={fetchImpl} navigate={navigate} />)
    fireEvent.click(screen.getByRole('radio', { name: /Run C/ }))
    expect(screen.getByTestId('demo-stem')).toHaveTextContent('megalith_link_margin_c.jsonl')
    fireEvent.click(screen.getByTestId('demo-start'))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/brigade?run=C&capture=1'))
  })

  it('autostarts when asked', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse())
    const navigate = vi.fn()
    await act(async () => {
      render(<DemoLauncher run="B" autostart fetchImpl={fetchImpl} navigate={navigate} />)
    })
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/brigade?run=B&capture=1'))
  })
})
