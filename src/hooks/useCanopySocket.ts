import { useEffect, useState } from 'react'
import { useEventStore } from '../store/eventStore'
import type {
  Anomaly,
  Attribution,
  CanopyMessage,
  CanopySocketState,
  Decision,
  OsintEmbeddingSnapshot,
  ReasoningTrace,
  Signal,
  UIEvent,
} from '../types/canopy'

export const MOCK_URL: string | null = null
// Backend gateway exposes /ws (see canopy/api/__init__.py). The earlier
// /ws/brigade URL pointed at a route that doesn't exist, so the socket
// never connected and everything fell back to the local demo stream.
const DEV_BRIDGE_URL = 'ws://127.0.0.1:8000/ws'
const configuredUrl = import.meta.env.VITE_CANOPY_WS_URL?.trim()
const DEFAULT_URL: string | null =
  configuredUrl || (import.meta.env.DEV ? DEV_BRIDGE_URL : MOCK_URL)

const initialState: CanopySocketState = {
  signals: [],
  anomalies: [],
  attributions: [],
  decisions: [],
  uiEvents: [],
  traces: [],
  isConnected: false,
  lastError: null,
}

const prependLimited = <T extends { id: string }>(
  items: T[],
  next: T,
  limit: number,
) => [next, ...items.filter((item) => item.id !== next.id)].slice(0, limit)

// The gateway sends {"topic", "kind", "data"} envelopes (see
// canopy/api/__init__.py:_fanout). Older fixtures used a {"type", "data"}
// shape — accept either so we don't drop real engine traffic on shape
// drift. Returns the normalized {type, data} value or null.
function normalizeMessage(value: unknown): CanopyMessage | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as {
    type?: unknown
    kind?: unknown
    data?: unknown
  }
  const discriminator =
    typeof candidate.type === 'string'
      ? candidate.type
      : typeof candidate.kind === 'string'
        ? candidate.kind
        : null
  if (!discriminator) return null
  if (
    ![
      'signal',
      'anomaly',
      'attribution',
      'decision',
      'ui_event',
      'trace',
      'embedding',
    ].includes(discriminator)
  ) {
    return null
  }
  if (typeof candidate.data !== 'object' || candidate.data === null) return null
  return { type: discriminator, data: candidate.data } as CanopyMessage
}

function reduceMessage(
  state: CanopySocketState,
  message: CanopyMessage,
): CanopySocketState {
  // Mirror every event into the global Zustand store so the Operator
  // page (and any other consumer reading from useEventStore) sees the
  // same data Brigade sees. The local CanopySocketState mirror is kept
  // because Brigade reads it directly for its decision-stack summary.
  const store = useEventStore.getState()
  switch (message.type) {
    case 'signal':
      store.ingestSignal(message.data as Signal)
      return {
        ...state,
        signals: prependLimited<Signal>(state.signals, message.data, 50),
      }
    case 'anomaly':
      store.ingestAnomaly(message.data as Anomaly)
      return {
        ...state,
        anomalies: prependLimited<Anomaly>(state.anomalies, message.data, 20),
      }
    case 'attribution':
      store.ingestAttribution(message.data as Attribution)
      return {
        ...state,
        attributions: prependLimited<Attribution>(
          state.attributions,
          message.data,
          20,
        ),
      }
    case 'decision':
      store.ingestDecision(message.data as Decision)
      return {
        ...state,
        decisions: prependLimited<Decision>(state.decisions, message.data, 20),
      }
    case 'ui_event':
      store.ingestUIEvent(message.data as UIEvent)
      return {
        ...state,
        uiEvents: prependLimited<UIEvent>(state.uiEvents, message.data, 20),
      }
    case 'trace':
      store.ingestTrace(message.data as ReasoningTrace)
      return {
        ...state,
        traces: [...state.traces, message.data as ReasoningTrace].slice(-500),
      }
    case 'embedding':
      store.ingestEmbeddingSnapshot(message.data as OsintEmbeddingSnapshot)
      // Embedding snapshots replace wholesale; we don't keep a history
      // because each one carries the full sliding window.
      return state
  }
}

export function useCanopySocket(url: string | null = DEFAULT_URL) {
  const [state, setState] = useState<CanopySocketState>(initialState)
  // Drive the global connection indicator (ConnectionStatus) from the only
  // live socket. setConnection is a stable Zustand action, so listing it in
  // the effect deps is safe and won't retrigger the connection.
  const setConnection = useEventStore((s) => s.setConnection)

  useEffect(() => {
    if (!url) {
      // No socket to open (e.g. a production build without VITE_CANOPY_WS_URL):
      // report offline rather than leaving the indicator stuck on "connecting".
      setConnection('offline')
      return
    }

    setConnection('connecting')
    const socket = new WebSocket(url)

    socket.addEventListener('open', () => {
      setConnection('live')
      setState((current) => ({
        ...current,
        isConnected: true,
        lastError: null,
      }))
    })

    socket.addEventListener('close', () => {
      setConnection('offline')
      setState((current) => ({
        ...current,
        isConnected: false,
      }))
    })

    socket.addEventListener('error', () => {
      setConnection('offline')
      setState((current) => ({
        ...current,
        lastError: 'CANOPY socket error',
      }))
    })

    socket.addEventListener('message', (event: MessageEvent<string>) => {
      try {
        const parsed: unknown = JSON.parse(event.data)
        const message = normalizeMessage(parsed)
        if (!message) {
          return
        }

        setState((current) => reduceMessage(current, message))
      } catch {
        setState((current) => ({
          ...current,
          lastError: 'Invalid CANOPY socket payload',
        }))
      }
    })

    return () => {
      socket.close()
    }
  }, [url, setConnection])

  return state
}
