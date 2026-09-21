import { useEffect, useState } from 'react'
import { wsUrl, wsUrlWithToken } from '../lib/gateway'
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

// Where the socket goes is decided in one place, src/lib/gateway.ts:
// VITE_CANOPY_WS_URL, else the gateway's /ws on 127.0.0.1:8000 in
// development, else no socket at all.
const DEFAULT_URL: string | null = wsUrl()

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
      'reset',
    ].includes(discriminator)
  ) {
    return null
  }
  if (typeof candidate.data !== 'object' || candidate.data === null) return null
  return { type: discriminator, data: candidate.data } as CanopyMessage
}

/** Side effects of one envelope: the global store ingestion. Runs in the
 *  socket's message listener, never inside a React state updater (updaters
 *  run during render: a store write there is an update-during-render and the
 *  receipt stamp would measure render to commit, not receipt to display). */
function ingestIntoStore(message: CanopyMessage): void {
  const store = useEventStore.getState()
  switch (message.type) {
    case 'signal':
      store.ingestSignal(message.data as Signal)
      return
    case 'anomaly':
      store.ingestAnomaly(message.data as Anomaly)
      return
    case 'attribution': {
      // Stamp the client receipt before the store update so the verdict
      // panel can measure WebSocket receipt -> render (F3).
      const attribution = message.data as Attribution
      store.noteAttributionArrival(attribution.id, attribution.revision ?? 0, performance.now())
      store.ingestAttribution(attribution)
      return
    }
    case 'decision':
      store.ingestDecision(message.data as Decision)
      return
    case 'ui_event':
      store.ingestUIEvent(message.data as UIEvent)
      return
    case 'trace':
      store.ingestTrace(message.data as ReasoningTrace)
      return
    case 'reset':
      // The gateway cleared its engine (POST /reset from this console, a
      // second console or the film script): drop every event of the run
      // before so the next run's verdicts are the only ones on screen.
      store.reset()
      break
    case 'embedding':
      store.ingestEmbeddingSnapshot(message.data as OsintEmbeddingSnapshot)
      return
  }
}

/** Pure: the hook's own bounded mirror of recent events. */
function mirrorMessage(state: CanopySocketState, message: CanopyMessage): CanopySocketState {
  switch (message.type) {
    case 'signal':
      return { ...state, signals: prependLimited<Signal>(state.signals, message.data, 50) }
    case 'anomaly':
      return { ...state, anomalies: prependLimited<Anomaly>(state.anomalies, message.data, 20) }
    case 'attribution':
      return {
        ...state,
        attributions: prependLimited<Attribution>(state.attributions, message.data, 20),
      }
    case 'decision':
      return { ...state, decisions: prependLimited<Decision>(state.decisions, message.data, 20) }
    case 'ui_event':
      return { ...state, uiEvents: prependLimited<UIEvent>(state.uiEvents, message.data, 20) }
    case 'trace':
      return {
        ...state,
        traces: [...state.traces, message.data as ReasoningTrace].slice(-500),
      }
    case 'reset':
      return { ...initialState, isConnected: state.isConnected, lastError: state.lastError }
    case 'embedding':
      // Snapshots replace wholesale; the store holds the current one.
      return state
  }
}

export function useCanopySocket(url: string | null = DEFAULT_URL) {
  const [state, setState] = useState<CanopySocketState>(initialState)
  // Drive the subsystem strip's connection state from the only live socket.
  // setConnection is a stable Zustand action, so listing it in the effect
  // deps is safe and won't retrigger the connection.
  const setConnection = useEventStore((s) => s.setConnection)

  useEffect(() => {
    if (!url) {
      // No socket to open (e.g. a production build without VITE_CANOPY_WS_URL):
      // report offline rather than leaving the indicator stuck on "connecting".
      setConnection('offline')
      return
    }

    setConnection('connecting')
    // The deploy-time token rides in the query string: a browser cannot set
    // headers on a WebSocket handshake (docs/C2-API.md section 1). With no
    // token configured the URL is used exactly as given.
    const socket = new WebSocket(wsUrlWithToken(url))

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

        ingestIntoStore(message)
        setState((current) => mirrorMessage(current, message))
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
