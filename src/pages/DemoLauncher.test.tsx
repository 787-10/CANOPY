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
  startDemoRun,
  startPendingReplay,
} from '../lib/demoRuns'
import { useCaptureStore } from '../store/captureStore'
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
    expect(body).toEqual({ status: 'pending', run: 'B', stem: 'megalith_link_margin_b.jsonl' })
    expect(useEventStore.getState().signals).toEqual([])
    expect(readPendingReplay()).toEqual({ run: 'B', stem: 'megalith_link_margin_b.jsonl' })
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
    expect(readPendingReplay()).toEqual({ run: 'A', stem: 'megalith_link_margin_a.jsonl' })
    expect(screen.getByTestId('demo-start')).toHaveTextContent('Started')
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
