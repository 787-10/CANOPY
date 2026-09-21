import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { RECONNECT_BASE_MS, RECONNECT_MAX_MS, useCanopySocket } from './useCanopySocket'
import { useEventStore } from '../store/eventStore'
import { MockWebSocket } from '../test/mockWebSocket'
import {
  makeAnomaly,
  makeAttribution,
  makeDecision,
  makeEmbeddingSnapshot,
  makeKBEntry,
  makeSignal,
  makeTrace,
  makeUIEvent,
} from '../test/factories'
import type { Signal } from '../types/canopy'

const TEST_URL = 'ws://test/ws'

beforeEach(() => {
  MockWebSocket.instances = []
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket)
  // Isolate the global Zustand store: reset() restores initial state and
  // clearing sessionStorage stops the persist middleware from rehydrating
  // a previous test's buffers into this one.
  useEventStore.getState().reset()
  sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('useCanopySocket', () => {
  it('opens a socket against the supplied url with the expected initial state', () => {
    const { result } = renderHook(() => useCanopySocket(TEST_URL))

    expect(MockWebSocket.instances).toHaveLength(1)
    // No deploy-time token: the URL is used exactly as given.
    expect(MockWebSocket.last?.url).toBe(TEST_URL)

    expect(result.current.isConnected).toBe(false)
    expect(result.current.lastError).toBeNull()
    expect(result.current.signals).toEqual([])
    expect(result.current.anomalies).toEqual([])
    expect(result.current.attributions).toEqual([])
    expect(result.current.decisions).toEqual([])
    expect(result.current.uiEvents).toEqual([])
    expect(result.current.traces).toEqual([])
  })

  it('appends the deploy-time token, URL-encoded, when the console carries one (C11)', () => {
    vi.stubEnv('VITE_CANOPY_API_TOKEN', 'tok en')
    renderHook(() => useCanopySocket(TEST_URL))

    expect(MockWebSocket.instances).toHaveLength(1)
    expect(MockWebSocket.last?.url).toBe(`${TEST_URL}?token=tok%20en`)
  })

  it('does not construct a WebSocket when url is null', () => {
    const { result } = renderHook(() => useCanopySocket(null))

    expect(MockWebSocket.instances).toHaveLength(0)
    // State stays at the untouched initial snapshot.
    expect(result.current.isConnected).toBe(false)
    expect(result.current.lastError).toBeNull()
    expect(result.current.signals).toEqual([])
  })

  it('marks isConnected true and clears lastError on open', () => {
    const { result } = renderHook(() => useCanopySocket(TEST_URL))

    // Seed an error first so we can prove open clears it.
    act(() => MockWebSocket.last!.emitError())
    expect(result.current.lastError).toBe('CANOPY socket error')

    act(() => MockWebSocket.last!.emitOpen())
    expect(result.current.isConnected).toBe(true)
    expect(result.current.lastError).toBeNull()
  })

  it('marks isConnected false on close', () => {
    const { result } = renderHook(() => useCanopySocket(TEST_URL))

    act(() => MockWebSocket.last!.emitOpen())
    expect(result.current.isConnected).toBe(true)

    act(() => MockWebSocket.last!.emitClose())
    expect(result.current.isConnected).toBe(false)
  })

  it('sets lastError on error without touching isConnected', () => {
    const { result } = renderHook(() => useCanopySocket(TEST_URL))

    act(() => MockWebSocket.last!.emitOpen())
    expect(result.current.isConnected).toBe(true)

    act(() => MockWebSocket.last!.emitError())
    expect(result.current.lastError).toBe('CANOPY socket error')
    // Error alone does not flip the connection flag.
    expect(result.current.isConnected).toBe(true)
  })

  it('ingests a kind:signal envelope into local state and the global store', () => {
    const { result } = renderHook(() => useCanopySocket(TEST_URL))
    const signal = makeSignal('sig-1')

    act(() =>
      MockWebSocket.last!.emitMessage({ kind: 'signal', data: signal }),
    )

    expect(result.current.signals).toEqual([signal])

    const store = useEventStore.getState()
    expect(store.signals).toEqual([signal])
    expect(store.signalsById['sig-1']).toEqual(signal)
  })

  it('ingests an anomaly envelope into local state and the global store', () => {
    const { result } = renderHook(() => useCanopySocket(TEST_URL))
    const anomaly = makeAnomaly('anom-1')

    act(() =>
      MockWebSocket.last!.emitMessage({ kind: 'anomaly', data: anomaly }),
    )

    expect(result.current.anomalies).toEqual([anomaly])
    expect(useEventStore.getState().anomalies).toEqual([anomaly])
  })

  it('ingests an attribution envelope into local state and the global store', () => {
    const { result } = renderHook(() => useCanopySocket(TEST_URL))
    const attribution = makeAttribution('attr-1')

    act(() =>
      MockWebSocket.last!.emitMessage({
        kind: 'attribution',
        data: attribution,
      }),
    )

    expect(result.current.attributions).toEqual([attribution])

    const store = useEventStore.getState()
    expect(store.attributions).toEqual([attribution])
    expect(store.attributionsById['attr-1']).toEqual(attribution)
  })

  it('ingests a decision envelope into local state and the global store', () => {
    const { result } = renderHook(() => useCanopySocket(TEST_URL))
    const decision = makeDecision('dec-1')

    act(() =>
      MockWebSocket.last!.emitMessage({ kind: 'decision', data: decision }),
    )

    expect(result.current.decisions).toEqual([decision])

    const store = useEventStore.getState()
    expect(store.decisions).toEqual([decision])
    expect(store.decisionsById['dec-1']).toEqual(decision)
  })

  it('ingests a ui_event envelope into local state and the global store', () => {
    const { result } = renderHook(() => useCanopySocket(TEST_URL))
    const uiEvent = makeUIEvent('ui-1')

    act(() =>
      MockWebSocket.last!.emitMessage({ kind: 'ui_event', data: uiEvent }),
    )

    expect(result.current.uiEvents).toEqual([uiEvent])
    expect(useEventStore.getState().uiEvents).toEqual([uiEvent])
  })

  it('ingests a trace envelope into local state and the global store', () => {
    const { result } = renderHook(() => useCanopySocket(TEST_URL))
    const trace = makeTrace('trace-1')

    act(() => MockWebSocket.last!.emitMessage({ kind: 'trace', data: trace }))

    expect(result.current.traces).toEqual([trace])
    expect(useEventStore.getState().traces).toEqual([trace])
  })

  it('routes an embedding envelope to the store snapshot without changing local arrays', () => {
    const { result } = renderHook(() => useCanopySocket(TEST_URL))
    const snapshot = makeEmbeddingSnapshot('emb-1')

    const before = result.current

    act(() =>
      MockWebSocket.last!.emitMessage({ kind: 'embedding', data: snapshot }),
    )

    // Store receives the snapshot wholesale...
    expect(useEventStore.getState().embeddingSnapshot).toEqual(snapshot)

    // ...but no CanopySocketState array is mutated.
    expect(result.current.signals).toEqual([])
    expect(result.current.anomalies).toEqual([])
    expect(result.current.attributions).toEqual([])
    expect(result.current.decisions).toEqual([])
    expect(result.current.uiEvents).toEqual([])
    expect(result.current.traces).toEqual([])
    // reduceMessage returns the same state object for embeddings.
    expect(result.current).toBe(before)
  })

  it('clears the global store and the local mirror on a reset control envelope', () => {
    const { result } = renderHook(() => useCanopySocket(TEST_URL))
    const signal = makeSignal('sig-1')
    const attribution = makeAttribution('att-1')
    act(() => {
      MockWebSocket.last!.emitOpen()
      MockWebSocket.last!.emitMessage({ kind: 'signal', data: signal })
      MockWebSocket.last!.emitMessage({ kind: 'attribution', data: attribution })
    })
    useEventStore.getState().pinEpisode(attribution.satellite_id ?? 'ctb://megalith.demo/sim-01')
    useEventStore.getState().setKB([makeKBEntry('kb-1')])
    expect(result.current.signals).toHaveLength(1)
    expect(useEventStore.getState().attributions).toHaveLength(1)

    // The gateway reset its engine (POST /reset from any client): the run
    // before is gone from this console, the connection state is kept.
    act(() =>
      MockWebSocket.last!.emitMessage({
        kind: 'reset',
        topic: 'control.reset',
        data: { ts: '2026-09-21T00:00:00Z', replay_cancelled: false, cleared: {} },
      }),
    )

    expect(result.current.signals).toEqual([])
    expect(result.current.attributions).toEqual([])
    expect(result.current.isConnected).toBe(true)
    const store = useEventStore.getState()
    expect(store.signals).toEqual([])
    expect(store.attributions).toEqual([])
    expect(store.pinnedSatelliteId).toBeNull()
    // The socket that carried the marker is still open: the header must keep
    // reading "engine live", and the knowledge base (fetched once at mount)
    // must still resolve the next run's citations.
    expect(store.connection).toBe('live')
    expect(store.kb['kb-1']).toBeDefined()
  })

  it('accepts the legacy {type:...} envelope identically to {kind:...}', () => {
    const { result } = renderHook(() => useCanopySocket(TEST_URL))
    const signal = makeSignal('legacy-1')

    act(() =>
      MockWebSocket.last!.emitMessage({ type: 'signal', data: signal }),
    )

    expect(result.current.signals).toEqual([signal])
    expect(useEventStore.getState().signalsById['legacy-1']).toEqual(signal)
  })

  it('prefers the string `type` discriminator when both type and kind are present', () => {
    const { result } = renderHook(() => useCanopySocket(TEST_URL))
    const signal = makeSignal('both-1')

    // normalizeMessage checks `type` first; with type:'signal' this must be
    // routed as a signal regardless of the bogus `kind`.
    act(() =>
      MockWebSocket.last!.emitMessage({
        type: 'signal',
        kind: 'anomaly',
        data: signal,
      }),
    )

    expect(result.current.signals).toEqual([signal])
    expect(result.current.anomalies).toEqual([])
  })

  it('ignores an envelope with an unknown discriminator', () => {
    const { result } = renderHook(() => useCanopySocket(TEST_URL))
    const before = result.current

    act(() =>
      MockWebSocket.last!.emitMessage({
        kind: 'bogus',
        data: { id: 'x' },
      }),
    )

    // No throw, no state change, no error recorded.
    expect(result.current).toBe(before)
    expect(result.current.lastError).toBeNull()
    expect(useEventStore.getState().signals).toEqual([])
  })

  it('ignores an envelope whose data is not an object', () => {
    const { result } = renderHook(() => useCanopySocket(TEST_URL))
    const before = result.current

    act(() =>
      MockWebSocket.last!.emitMessage({ kind: 'signal', data: 'not-an-object' }),
    )

    expect(result.current).toBe(before)
    expect(result.current.signals).toEqual([])
    expect(result.current.lastError).toBeNull()
  })

  it('ignores an envelope whose data is null', () => {
    const { result } = renderHook(() => useCanopySocket(TEST_URL))
    const before = result.current

    act(() =>
      MockWebSocket.last!.emitMessage({ kind: 'signal', data: null }),
    )

    expect(result.current).toBe(before)
    expect(result.current.signals).toEqual([])
    expect(result.current.lastError).toBeNull()
  })

  it('ignores an envelope missing both type and kind', () => {
    const { result } = renderHook(() => useCanopySocket(TEST_URL))
    const before = result.current

    act(() =>
      MockWebSocket.last!.emitMessage({ data: makeSignal('orphan') }),
    )

    expect(result.current).toBe(before)
    expect(result.current.signals).toEqual([])
    expect(result.current.lastError).toBeNull()
  })

  it('records lastError on invalid JSON without throwing', () => {
    const { result } = renderHook(() => useCanopySocket(TEST_URL))

    act(() => MockWebSocket.last!.emitMessage('not json'))

    expect(result.current.lastError).toBe('Invalid CANOPY socket payload')
    // Buffers untouched by the parse failure.
    expect(result.current.signals).toEqual([])
    expect(useEventStore.getState().signals).toEqual([])
  })

  it('dedups signals by id and moves the repeat to the front (prependLimited)', () => {
    const { result } = renderHook(() => useCanopySocket(TEST_URL))

    const a = makeSignal('A')
    const b = makeSignal('B')
    const aUpdated: Signal = { ...makeSignal('A'), confidence: 0.42 }

    act(() => MockWebSocket.last!.emitMessage({ kind: 'signal', data: a }))
    act(() => MockWebSocket.last!.emitMessage({ kind: 'signal', data: b }))
    // Re-send id 'A' with new contents: dedup to a single entry, moved front.
    act(() =>
      MockWebSocket.last!.emitMessage({ kind: 'signal', data: aUpdated }),
    )

    expect(result.current.signals).toHaveLength(2)
    expect(result.current.signals.map((s) => s.id)).toEqual(['A', 'B'])
    // The kept 'A' is the latest version.
    expect(result.current.signals[0]).toEqual(aUpdated)
    expect(result.current.signals[0].confidence).toBe(0.42)
  })

  it('caps local signals at 50, newest first, after 55 distinct arrivals', () => {
    const { result } = renderHook(() => useCanopySocket(TEST_URL))

    for (let i = 0; i < 55; i++) {
      const sig = makeSignal(`sig-${i}`)
      act(() => MockWebSocket.last!.emitMessage({ kind: 'signal', data: sig }))
    }

    const signals = result.current.signals
    expect(signals).toHaveLength(50)
    // Newest first: the last id sent (54) is at the head.
    expect(signals[0].id).toBe('sig-54')
    // The oldest survivor is id 5 (0..4 fell off the 50-item window).
    expect(signals[49].id).toBe('sig-5')
    expect(signals.map((s) => s.id)).not.toContain('sig-4')
    expect(signals.map((s) => s.id)).not.toContain('sig-0')
  })

  it('closes the socket on unmount', () => {
    const { unmount } = renderHook(() => useCanopySocket(TEST_URL))

    const socket = MockWebSocket.last!
    expect(socket.closed).toBe(false)

    unmount()

    expect(socket.closed).toBe(true)
  })
})

describe('useCanopySocket — attribution receipt stamps (F3)', () => {
  it('records performance.now() per attribution revision on receipt, first stamp wins', () => {
    const now = vi.spyOn(performance, 'now')
    renderHook(() => useCanopySocket(TEST_URL))

    now.mockReturnValue(1000)
    act(() =>
      MockWebSocket.last!.emitMessage({
        kind: 'attribution',
        data: makeAttribution('att-1', { provisional: true, revision: 0 }),
      }),
    )
    now.mockReturnValue(1500)
    act(() =>
      MockWebSocket.last!.emitMessage({
        kind: 'attribution',
        data: makeAttribution('att-1', { provisional: false, revision: 1 }),
      }),
    )
    // A replayed revision-0 message must not move the original stamp.
    now.mockReturnValue(1600)
    act(() =>
      MockWebSocket.last!.emitMessage({
        kind: 'attribution',
        data: makeAttribution('att-1', { provisional: true, revision: 0 }),
      }),
    )

    expect(useEventStore.getState().attributionArrivals['att-1']).toEqual({ 0: 1000, 1: 1500 })
    now.mockRestore()
  })
})

describe('useCanopySocket — reconnect after a close', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens a new socket after the backoff and reports connecting, then live again', () => {
    const { result } = renderHook(() => useCanopySocket(TEST_URL))
    act(() => MockWebSocket.last!.emitOpen())
    expect(MockWebSocket.instances).toHaveLength(1)

    // The gateway restarted: the socket closes.
    act(() => MockWebSocket.last!.emitClose())
    expect(result.current.isConnected).toBe(false)
    expect(useEventStore.getState().connection).toBe('offline')

    // Nothing happens before the first backoff elapses.
    act(() => vi.advanceTimersByTime(RECONNECT_BASE_MS - 1))
    expect(MockWebSocket.instances).toHaveLength(1)

    act(() => vi.advanceTimersByTime(1))
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(MockWebSocket.last?.url).toBe(TEST_URL)
    expect(useEventStore.getState().connection).toBe('connecting')

    act(() => MockWebSocket.last!.emitOpen())
    expect(result.current.isConnected).toBe(true)
    expect(useEventStore.getState().connection).toBe('live')

    // The new socket feeds the same store and mirror.
    const signal = makeSignal('after-reconnect')
    act(() => MockWebSocket.last!.emitMessage({ kind: 'signal', data: signal }))
    expect(result.current.signals).toEqual([signal])
    expect(useEventStore.getState().signalsById['after-reconnect']).toEqual(signal)
  })

  it('doubles the delay up to the cap while the gateway stays down and starts over after an open', () => {
    renderHook(() => useCanopySocket(TEST_URL))
    const expectRetryAfter = (delay: number) => {
      const before = MockWebSocket.instances.length
      act(() => MockWebSocket.last!.emitClose())
      act(() => vi.advanceTimersByTime(delay - 1))
      expect(MockWebSocket.instances).toHaveLength(before)
      act(() => vi.advanceTimersByTime(1))
      expect(MockWebSocket.instances).toHaveLength(before + 1)
    }
    expectRetryAfter(RECONNECT_BASE_MS)
    expectRetryAfter(RECONNECT_BASE_MS * 2)
    expectRetryAfter(RECONNECT_BASE_MS * 4)
    // Keep failing: the delay never exceeds the cap.
    for (let i = 0; i < 6; i += 1) {
      const before = MockWebSocket.instances.length
      act(() => MockWebSocket.last!.emitClose())
      act(() => vi.advanceTimersByTime(RECONNECT_MAX_MS))
      expect(MockWebSocket.instances).toHaveLength(before + 1)
    }
    // A successful open resets the backoff to the base delay.
    act(() => MockWebSocket.last!.emitOpen())
    expectRetryAfter(RECONNECT_BASE_MS)
  })

  it('does not reconnect once the hook has unmounted', () => {
    const { unmount } = renderHook(() => useCanopySocket(TEST_URL))
    act(() => MockWebSocket.last!.emitOpen())
    act(() => MockWebSocket.last!.emitClose())
    unmount()
    act(() => vi.advanceTimersByTime(RECONNECT_MAX_MS * 4))
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('ignores the late close of a socket the cleanup closed, so it neither reconnects nor marks the store offline', () => {
    // A real close() fires its close event asynchronously; in development
    // React mounts, unmounts and remounts the effect, so the first socket's
    // close lands after the second socket is live.
    const { unmount } = renderHook(() => useCanopySocket(TEST_URL))
    const first = MockWebSocket.last!
    unmount()
    expect(first.closed).toBe(true)

    renderHook(() => useCanopySocket(TEST_URL))
    const second = MockWebSocket.last!
    expect(second).not.toBe(first)
    act(() => second.emitOpen())
    expect(useEventStore.getState().connection).toBe('live')

    act(() => first.emitClose())
    expect(useEventStore.getState().connection).toBe('live')
    act(() => vi.advanceTimersByTime(RECONNECT_MAX_MS * 4))
    expect(MockWebSocket.instances).toHaveLength(2)
  })
})
