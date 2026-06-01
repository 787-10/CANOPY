import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useCanopySocket } from './useCanopySocket'
import { useEventStore } from '../store/eventStore'
import { MockWebSocket } from '../test/mockWebSocket'
import {
  makeAnomaly,
  makeAttribution,
  makeDecision,
  makeEmbeddingSnapshot,
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
})

describe('useCanopySocket', () => {
  it('opens a socket against the supplied url with the expected initial state', () => {
    const { result } = renderHook(() => useCanopySocket(TEST_URL))

    expect(MockWebSocket.instances).toHaveLength(1)
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
