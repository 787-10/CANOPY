import { useEffect, useState } from 'react'
import { wsUrl, wsUrlWithToken } from '../lib/gateway'
import { useClockStore } from '../store/clockStore'
import { useEphemerisStore } from '../store/ephemerisStore'
import { useEventStore } from '../store/eventStore'
import type {
  Ephemeris,
  Anomaly,
  Attribution,
  CanopyMessage,
  CanopySocketState,
  Decision,
  OsintEmbeddingSnapshot,
  ReasoningTrace,
  ReplayMarker,
  Signal,
  UIEvent,
} from '../types/canopy'

// Where the socket goes is decided in one place, src/lib/gateway.ts:
// VITE_CANOPY_WS_URL, else the gateway's /ws on 127.0.0.1:8000 in
// development, else no socket at all.
const DEFAULT_URL: string | null = wsUrl()

/** Reconnect backoff after a close the hook did not ask for: the base delay
 *  doubles per failed attempt up to the cap and starts over after an open. */
export const RECONNECT_BASE_MS = 1_000
export const RECONNECT_MAX_MS = 10_000

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
      'replay',
      'ephemeris',
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
      useClockStore.getState().reset()
      useEphemerisStore.getState().reset()
      break
    case 'replay':
      // The run's timeline (spec §10, 1.4.3): the flight clock's only source.
      useClockStore.getState().applyReplay(message.data as ReplayMarker)
      break
    case 'embedding':
      store.ingestEmbeddingSnapshot(message.data as OsintEmbeddingSnapshot)
      return
    case 'ephemeris':
      // The engine's position sample (spec §10, 1.4.4): the flight layer's source of record.
      useEphemerisStore.getState().ingest(message.data as Ephemeris)
      return
  }
}

/** Pure: the hook's own bounded mirror of recent events. */
function mirrorMessage(state: CanopySocketState, message: CanopyMessage): CanopySocketState {
  switch (message.type) {
    case 'ephemeris':
      return state
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
    case 'replay':
      // Gateway state, not an event; the clock store holds it.
      return state
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

    // One live socket at a time. A close this effect did not ask for (the
    // gateway restarted, the link dropped) schedules a reconnect with capped
    // exponential backoff. The cleanup cancels the timer and closes the
    // socket; events from a socket that is no longer the current one are
    // ignored, so the asynchronous close of a socket the cleanup closed (or
    // that a reconnect replaced) can neither mark the store offline while the
    // next socket is live nor start a second reconnect chain.
    let disposed = false
    let socket: WebSocket | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0

    const connect = () => {
      retryTimer = null
      setConnection('connecting')
      // The deploy-time token rides in the query string: a browser cannot set
      // headers on a WebSocket handshake (docs/C2-API.md section 1). With no
      // token configured the URL is used exactly as given.
      const ws = new WebSocket(wsUrlWithToken(url))
      socket = ws
      const current = () => !disposed && socket === ws

      ws.addEventListener('open', () => {
        if (!current()) return
        attempt = 0
        setConnection('live')
        setState((state) => ({
          ...state,
          isConnected: true,
          lastError: null,
        }))
      })

      ws.addEventListener('close', () => {
        if (!current()) return
        setConnection('offline')
        // A run's clock cannot be trusted without its stream: hold it as stale
        // until the reconnect's snapshot says where the run is.
        useClockStore.getState().socketClosed()
        setState((state) => ({
          ...state,
          isConnected: false,
        }))
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt)
        attempt += 1
        retryTimer = setTimeout(connect, delay)
      })

      ws.addEventListener('error', () => {
        if (!current()) return
        setConnection('offline')
        setState((state) => ({
          ...state,
          lastError: 'CANOPY socket error',
        }))
      })

      ws.addEventListener('message', (event: MessageEvent<string>) => {
        if (!current()) return
        try {
          const parsed: unknown = JSON.parse(event.data)
          const message = normalizeMessage(parsed)
          if (!message) {
            return
          }

          ingestIntoStore(message)
          setState((state) => mirrorMessage(state, message))
        } catch {
          setState((state) => ({
            ...state,
            lastError: 'Invalid CANOPY socket payload',
          }))
        }
      })
    }

    connect()

    return () => {
      disposed = true
      if (retryTimer !== null) clearTimeout(retryTimer)
      socket?.close()
    }
  }, [url, setConnection])

  return state
}
