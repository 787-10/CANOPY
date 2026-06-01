import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  useEngineSocket,
  triggerReplay,
  listScenarios,
} from './useEngineSocket'
import { useEventStore } from '../store/eventStore'
import { MockWebSocket } from '../test/mockWebSocket'
import {
  makeAnomaly,
  makeAttribution,
  makeDecision,
  makeKBEntry,
  makeSignal,
  makeTrace,
  makeUIEvent,
} from '../test/factories'
import type { UIEvent, WSEnvelope } from '../types/canopy'

// ---------------------------------------------------------------------------
// Test-specific fixtures (the shared factories live in ../test/factories).
// ---------------------------------------------------------------------------
const KB_ENTRY = makeKBEntry('kb-actor-001', {
  actor: 'Red Forces',
  title: 'Co-orbital interceptor doctrine',
  summary: 'Synthetic KB entry for tests.',
})

// A fixture UIEvent whose source_signal_ids match an entry in the hook's
// FIXTURE_SIGNAL_LOCATIONS table, so fixture mode synthesises a marker signal.
const FIXTURE_EVENT: UIEvent = makeUIEvent('fixture-evt-1', {
  source_signal_ids: ['canopy-beat1-001'],
  type: 'threat_updated',
  title: 'Fixture replay event',
  // Deliberately stale timestamp — the hook must overwrite it with a fresh one.
  timestamp: '2000-01-01T00:00:00.000Z',
  ts: '2000-01-01T00:00:00.000Z',
})

// ---------------------------------------------------------------------------
// Fetch mock routed by URL.
// ---------------------------------------------------------------------------

// Minimal fetch Response stand-in carrying a JSON body.
function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: () => Promise.resolve(body) } as unknown as Response
}

function makeFetchMock() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/kb')) {
      return Promise.resolve(jsonResponse({ entries: [KB_ENTRY] }))
    }
    if (url.includes('/fixture/ui_events')) {
      return Promise.resolve(jsonResponse({ events: [FIXTURE_EVENT] }))
    }
    if (url.includes('/scenarios')) {
      return Promise.resolve(jsonResponse(['beat1']))
    }
    return Promise.resolve(jsonResponse({}))
  })
}

let fetchMock: ReturnType<typeof makeFetchMock>

beforeEach(() => {
  fetchMock = makeFetchMock()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket)
  MockWebSocket.instances = []
  useEventStore.getState().reset()
  sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const store = () => useEventStore.getState()

describe('useEngineSocket — mount + KB load', () => {
  it('fetches /kb on mount and keys the store kb by entry id', async () => {
    renderHook(() => useEngineSocket())

    // The KB fetch fires synchronously in the effect; flush its promise chain.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8000/kb')
    expect(store().kb).toEqual({ [KB_ENTRY.id]: KB_ENTRY })
    expect(store().kb[KB_ENTRY.id].title).toBe(KB_ENTRY.title)
  })

  it('opens a WebSocket to the derived ws:// URL on mount', () => {
    renderHook(() => useEngineSocket())

    expect(MockWebSocket.instances).toHaveLength(1)
    expect(MockWebSocket.last?.url).toBe('ws://localhost:8000/ws')
  })

  it('does not crash if the /kb fetch rejects', async () => {
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error('boom')))

    renderHook(() => useEngineSocket())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // KB stays empty; the socket is still established.
    expect(store().kb).toEqual({})
    expect(MockWebSocket.instances).toHaveLength(1)
  })
})

describe('useEngineSocket — connection lifecycle', () => {
  it('sets connecting on mount then live once the socket opens', () => {
    renderHook(() => useEngineSocket())

    // connect() runs synchronously and sets "connecting".
    expect(store().connection).toBe('connecting')

    act(() => {
      MockWebSocket.last?.emitOpen()
    })
    expect(store().connection).toBe('live')
  })

  it('an error on the socket closes it (so reconnect logic can run)', () => {
    renderHook(() => useEngineSocket())
    const sock = MockWebSocket.last
    expect(sock?.closed).toBe(false)

    act(() => {
      sock?.emitError()
    })
    expect(sock?.closed).toBe(true)
  })
})

describe('useEngineSocket — message handling per WSEnvelope.kind', () => {
  it('ingests each envelope kind into the matching store buffer', () => {
    renderHook(() => useEngineSocket())
    const sock = MockWebSocket.last
    act(() => sock?.emitOpen())

    const envelopes: WSEnvelope[] = [
      { topic: 'signal', kind: 'signal', data: makeSignal('sig-1') },
      { topic: 'anomaly', kind: 'anomaly', data: makeAnomaly('an-1') },
      {
        topic: 'attribution',
        kind: 'attribution',
        data: makeAttribution('at-1'),
      },
      { topic: 'decision', kind: 'decision', data: makeDecision('dec-1') },
      { topic: 'ui_event', kind: 'ui_event', data: makeUIEvent('uie-1') },
      { topic: 'trace', kind: 'trace', data: makeTrace('tr-1') },
    ]

    act(() => {
      for (const env of envelopes) sock?.emitMessage(env)
    })

    const s = store()
    expect(s.signals).toHaveLength(1)
    expect(s.signals[0].id).toBe('sig-1')
    expect(s.signalsById['sig-1']).toBeDefined()

    expect(s.anomalies).toHaveLength(1)
    expect(s.anomalies[0].id).toBe('an-1')

    expect(s.attributions).toHaveLength(1)
    expect(s.attributionsById['at-1']).toBeDefined()

    expect(s.decisions).toHaveLength(1)
    expect(s.decisionsById['dec-1']).toBeDefined()

    expect(s.uiEvents).toHaveLength(1)
    expect(s.uiEvents[0].id).toBe('uie-1')

    expect(s.traces).toHaveLength(1)
    expect(s.traces[0].id).toBe('tr-1')
  })

  it('pops the approval banner for a recommendation_created ui_event', () => {
    renderHook(() => useEngineSocket())
    const sock = MockWebSocket.last
    act(() => sock?.emitOpen())

    const recEvent = makeUIEvent('rec-1', {
      type: 'recommendation_created',
      recommendation: {
        id: 'r-1',
        summary: 'Recommend escort burn',
        approveLabel: 'Approve',
      },
    })
    const envelope: WSEnvelope = {
      topic: 'ui_event',
      kind: 'ui_event',
      data: recEvent,
    }

    act(() => sock?.emitMessage(envelope))

    expect(store().pendingApproval?.id).toBe('rec-1')
  })

  it('does not throw on a malformed (non-JSON) message and keeps working', () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderHook(() => useEngineSocket())
    const sock = MockWebSocket.last
    act(() => sock?.emitOpen())

    expect(() =>
      act(() => {
        sock?.emitMessage('not json')
      }),
    ).not.toThrow()

    // It logged the parse failure and ingested nothing.
    expect(consoleErr).toHaveBeenCalled()
    expect(store().signals).toHaveLength(0)
    expect(store().uiEvents).toHaveLength(0)

    // A subsequent valid message is still handled — the socket isn't poisoned.
    const env: WSEnvelope = {
      topic: 'signal',
      kind: 'signal',
      data: makeSignal('sig-after'),
    }
    act(() => sock?.emitMessage(env))
    expect(store().signals).toHaveLength(1)
    expect(store().signals[0].id).toBe('sig-after')

    consoleErr.mockRestore()
  })
})

describe('useEngineSocket — reconnect backoff + fixture fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('reconnects with [500, 1500, 4000] backoffs then falls back to fixture mode on the 4th failure', async () => {
    renderHook(() => useEngineSocket())
    expect(MockWebSocket.instances).toHaveLength(1)

    const backoffs = [500, 1500, 4000]
    for (let cycle = 0; cycle < backoffs.length; cycle++) {
      const sockCount = MockWebSocket.instances.length
      // Close the current socket → schedules a reconnect.
      act(() => {
        MockWebSocket.last?.emitClose()
      })
      // While the timer is pending the hook reports "connecting".
      expect(store().connection).toBe('connecting')
      // No new socket yet — must wait the backoff.
      expect(MockWebSocket.instances).toHaveLength(sockCount)

      // Advancing just under the delay still produces no new socket.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(backoffs[cycle] - 1)
      })
      expect(MockWebSocket.instances).toHaveLength(sockCount)

      // Crossing the delay constructs exactly one new socket.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(MockWebSocket.instances).toHaveLength(sockCount + 1)
    }

    // 1 initial + 3 reconnects.
    expect(MockWebSocket.instances).toHaveLength(4)
    expect(store().connection).toBe('connecting')

    // The FOURTH consecutive failure (failures >= 3) triggers fixture mode.
    await act(async () => {
      MockWebSocket.last?.emitClose()
      // Flush the fixture fetch promise chain.
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(store().connection).toBe('fixture')
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/fixture/ui_events',
    )
    // No further socket was constructed by entering fixture mode.
    expect(MockWebSocket.instances).toHaveLength(4)
  })

  it('resets the failure counter when a reconnect opens successfully', async () => {
    renderHook(() => useEngineSocket())

    // Two failures (uses [500, 1500]).
    act(() => MockWebSocket.last?.emitClose())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    act(() => MockWebSocket.last?.emitClose())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(MockWebSocket.instances).toHaveLength(3)

    // This reconnect opens — counter resets to 0.
    act(() => MockWebSocket.last?.emitOpen())
    expect(store().connection).toBe('live')

    // The very next close starts the backoff sequence again at 500ms.
    act(() => MockWebSocket.last?.emitClose())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(499)
    })
    expect(MockWebSocket.instances).toHaveLength(3)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(MockWebSocket.instances).toHaveLength(4)
    // Still reconnecting (would need 3 more failures to fall back), not fixture.
    expect(store().connection).toBe('connecting')
  })
})

describe('useEngineSocket — fixture replay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  // Drives the hook into fixture mode via 4 consecutive socket failures.
  async function enterFixtureMode() {
    for (const delay of [500, 1500, 4000]) {
      act(() => MockWebSocket.last?.emitClose())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay)
      })
    }
    await act(async () => {
      MockWebSocket.last?.emitClose()
      await vi.advanceTimersByTimeAsync(0)
    })
  }

  it('replays fixture UIEvents on the 3000ms interval with fresh ISO timestamps', async () => {
    renderHook(() => useEngineSocket())
    await enterFixtureMode()
    expect(store().connection).toBe('fixture')

    // The first tick fires immediately once the fixture file resolves.
    expect(store().uiEvents).toHaveLength(1)
    const first = store().uiEvents[0]
    expect(first.id).toBe(FIXTURE_EVENT.id)
    // Timestamp was synthesised fresh — a valid ISO string, NOT the stale one.
    expect(first.timestamp).not.toBe(FIXTURE_EVENT.timestamp)
    expect(Number.isNaN(Date.parse(first.timestamp))).toBe(false)
    expect(new Date(first.timestamp).toISOString()).toBe(first.timestamp)

    // The fixture event references a known signal id → a marker signal appears.
    expect(store().signals).toHaveLength(1)
    expect(store().signals[0].id).toBe('canopy-beat1-001')
    expect(store().signals[0].source).toBe('fixture')

    // Each FIXTURE_REPLAY_INTERVAL_MS advance replays another event.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(store().uiEvents).toHaveLength(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(store().uiEvents).toHaveLength(3)
  })

  it('goes offline if the fixture file fetch rejects', async () => {
    // Make only the fixture fetch reject; /kb and the initial calls still work.
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/fixture/ui_events')) {
        return Promise.reject(new Error('no fixture'))
      }
      if (url.endsWith('/kb')) {
        return Promise.resolve(jsonResponse({ entries: [KB_ENTRY] }))
      }
      return Promise.resolve(jsonResponse({}))
    })

    renderHook(() => useEngineSocket())
    await enterFixtureMode()

    expect(store().connection).toBe('offline')
    expect(store().uiEvents).toHaveLength(0)
  })
})

describe('useEngineSocket — cleanup on unmount', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('closes the active socket and stops reconnect timers', async () => {
    const { unmount } = renderHook(() => useEngineSocket())
    const sock = MockWebSocket.last
    expect(sock?.closed).toBe(false)

    // Schedule a reconnect, then unmount before it fires.
    act(() => sock?.emitClose())
    unmount()

    expect(sock?.closed).toBe(true)

    // Advancing past every backoff must NOT create another socket.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('stops the fixture replay timer on unmount (no further ingests)', async () => {
    const { unmount } = renderHook(() => useEngineSocket())

    // Enter fixture mode.
    for (const delay of [500, 1500, 4000]) {
      act(() => MockWebSocket.last?.emitClose())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay)
      })
    }
    await act(async () => {
      MockWebSocket.last?.emitClose()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(store().connection).toBe('fixture')
    const eventsBefore = store().uiEvents.length
    expect(eventsBefore).toBeGreaterThan(0)
    const socketsBefore = MockWebSocket.instances.length

    unmount()

    // Time passing after unmount replays nothing and builds no new sockets.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(store().uiEvents).toHaveLength(eventsBefore)
    expect(MockWebSocket.instances).toHaveLength(socketsBefore)
  })
})

describe('triggerReplay', () => {
  it('POSTs to /scenarios/<name>/replay with the given speed', async () => {
    await triggerReplay('beatX', 7)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [
      RequestInfo | URL,
      RequestInit?,
    ]
    expect(String(url)).toBe(
      'http://localhost:8000/scenarios/beatX/replay?speed=7',
    )
    expect(init?.method).toBe('POST')
  })

  it('defaults speed to 5 when omitted', async () => {
    await triggerReplay('beat1')

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'http://localhost:8000/scenarios/beat1/replay?speed=5',
    )
  })

  it('URL-encodes the scenario name', async () => {
    await triggerReplay('beat 1/special', 3)

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'http://localhost:8000/scenarios/beat%201%2Fspecial/replay?speed=3',
    )
  })
})

describe('listScenarios', () => {
  it('returns the parsed array when the response is ok', async () => {
    const result = await listScenarios()

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8000/scenarios')
    expect(result).toEqual(['beat1'])
  })

  it('returns [] when the response is not ok', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(['should-not-be-used'], false))

    expect(await listScenarios()).toEqual([])
  })

  it('returns [] when the fetch rejects', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'))

    expect(await listScenarios()).toEqual([])
  })
})
