// The flight clock: scenario time for the globe (docs/INTERFACE-SPEC.md §2,
// 1.4.3). The gateway owns the timeline through the `replay` control
// envelope; this store evaluates one formula from it and never infers time
// from signal arrivals. No Cesium import, so vitest drives it in jsdom;
// CesiumGlobe mirrors it into viewer.clock.
//
//   view 'pass'   today's picture: spacecraft pinned at their pass, the
//                 clock not consulted for positions (capture mode, the film).
//   view 'flight' positions follow timeAt(wall):
//     free     no run: origin + (wall − originWall) × rate
//     flight   a run started: nowTs + (wall − receipt) × speed
//     holding  the run finished or was cancelled: lastTs, held
//     stale    the socket closed mid-run: held where it was
//     paused   the operator paused: held; resuming a run jumps to its time
import { create } from 'zustand'
import type { ReplayMarker } from '../types/canopy'
import { useCaptureStore } from './captureStore'

/** A marker whose send time is within this of its receipt was sent by a
 *  gateway on a clock in step with ours (the same host, or NTP): anchor at
 *  the send time so a busy tab that handles the message late does not run
 *  behind for the rest of the run. Further apart, trust receipt (spec §2). */
export const CLOCK_SKEW_TOLERANCE_MS = 2_000

export const FLIGHT_QUERY_PARAM = 'flight'
export const FLIGHT_VIEW_STORAGE_KEY = 'megalith-flight-view'

export type ClockView = 'pass' | 'flight'
export type ClockMode = 'free' | 'flight' | 'holding' | 'stale' | 'paused'
export type FlightRate = 1 | 10 | 60 | 600
export const FLIGHT_RATES: readonly FlightRate[] = [1, 10, 60, 600]
/** Rates a flight-coupled run may use (decision 2): 1× fragments an episode
 *  while the attribution window is wall time. */
export const COUPLED_RATES: readonly FlightRate[] = [10, 60, 600]

/** How far a signal's `ts` may sit from the clock before it is a diagnostic:
 *  a quarter second of wall time at the run's rate. */
export const DRIFT_TOLERANCE_WALL_MS = 250

type Anchor = {
  /** Scenario time (Unix ms) at the wall instant `wallMs`. */
  scenarioMs: number
  wallMs: number
  rate: number
}

export type ClockState = {
  view: ClockView
  mode: ClockMode
  /** The rate in free flight, or the run's speed while a run is known. */
  rate: number
  anchor: Anchor | null
  /** The current run, from the last `replay` envelope. */
  run: ReplayMarker | null
  /** The mode to return to when the operator resumes. */
  resumeMode: Exclude<ClockMode, 'paused'> | null
  reducedMotion: boolean

  setView: (view: ClockView) => void
  /** A `replay` control envelope, with the wall time it was received. */
  applyReplay: (marker: ReplayMarker, wallMs?: number) => void
  /** The `reset` control envelope: no run, free at wall now. */
  reset: (wallMs?: number) => void
  setRate: (rate: FlightRate, wallMs?: number) => void
  pause: (wallMs?: number) => void
  resume: (wallMs?: number) => void
  socketClosed: (wallMs?: number) => void
  /** Scenario time (Unix ms) at a wall instant. */
  timeAt: (wallMs?: number) => number
  /** Signal `ts` minus the clock, in scenario ms; null when no run is known. */
  driftMs: (signalTs: string, wallMs?: number) => number | null
}

const now = () => Date.now()

const hasWindow = () => typeof window !== 'undefined'

function persistView(view: ClockView) {
  if (!hasWindow()) return
  try {
    if (view === 'flight') window.sessionStorage.setItem(FLIGHT_VIEW_STORAGE_KEY, 'flight')
    else window.sessionStorage.removeItem(FLIGHT_VIEW_STORAGE_KEY)
  } catch {
    // Storage disabled: the view lives for this page only.
  }
}

/** `?flight=1` wins, then `?flight=0`, then the sessionStorage flag, else pass view.
 *  Header links are full-page loads, so the view has to survive them. */
export function readInitialFlightView(search: string = hasWindow() ? window.location.search : ''): ClockView {
  const params = new URLSearchParams(search)
  const fromQuery = params.get(FLIGHT_QUERY_PARAM)
  if (fromQuery !== null) {
    return fromQuery === '1' || fromQuery === 'true' || fromQuery === 'on' ? 'flight' : 'pass'
  }
  if (!hasWindow()) return 'pass'
  try {
    return window.sessionStorage.getItem(FLIGHT_VIEW_STORAGE_KEY) === 'flight' ? 'flight' : 'pass'
  } catch {
    return 'pass'
  }
}

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

const evaluate = (anchor: Anchor | null, wallMs: number): number =>
  anchor ? anchor.scenarioMs + (wallMs - anchor.wallMs) * anchor.rate : wallMs

/** Hold the clock where it is: an anchor with rate 0 at the current value. */
const held = (state: ClockState, wallMs: number): Anchor => ({
  scenarioMs: state.timeAt(wallMs),
  wallMs,
  rate: 0,
})

export const useClockStore = create<ClockState>()((set, get) => ({
  view: 'pass',
  mode: 'free',
  rate: 1,
  anchor: null,
  run: null,
  resumeMode: null,
  reducedMotion: prefersReducedMotion(),

  setView: (view) => {
    const state = get()
    // Persist even when unchanged: a capture forcing pass view clears the flag.
    persistView(view)
    if (view === state.view) return
    if (view === 'flight' && state.reducedMotion && state.mode !== 'paused') {
      // Reduced motion: flight opens paused, at the time it would show.
      const wallMs = now()
      set({ view, mode: 'paused', resumeMode: state.mode, anchor: held(state, wallMs) })
      return
    }
    set({ view })
  },

  applyReplay: (marker, wallMs = now()) => {
    const nowTs = Date.parse(marker.now_ts)
    const lastTs = Date.parse(marker.last_ts)
    if (!Number.isFinite(nowTs) || !Number.isFinite(lastTs)) return
    const state = get()
    const sentMs = Date.parse(marker.ts)
    const anchorWall =
      Number.isFinite(sentMs) && Math.abs(wallMs - sentMs) <= CLOCK_SKEW_TOLERANCE_MS ? sentMs : wallMs
    if (marker.state === 'started' && marker.max_delay_s !== null) {
      // A capped run (the storyboard's 20x with 6 s gaps) has no linear
      // timeline: its speed is not a clock rate. Remember the run for the
      // pacing readout, but keep the clock as it is (wall time, or the
      // operator's free flight).
      set({ run: marker })
      return
    }
    if (marker.state === 'started') {
      const anchor: Anchor = { scenarioMs: nowTs, wallMs: anchorWall, rate: marker.speed }
      if (state.mode === 'paused') {
        // Stay paused, but resume into the run at its time.
        set({ run: marker, rate: marker.speed, resumeMode: 'flight', anchor: held({ ...state, timeAt: () => nowTs } as ClockState, wallMs) })
        return
      }
      set({ run: marker, rate: marker.speed, mode: 'flight', anchor, resumeMode: null })
      return
    }
    // finished or cancelled: hold at the run's end (or where it was cut).
    const heldAt = marker.state === 'finished' ? lastTs : nowTs
    const anchor: Anchor = { scenarioMs: heldAt, wallMs, rate: 0 }
    if (state.mode === 'paused') {
      set({ run: marker, resumeMode: 'holding', anchor })
      return
    }
    set({ run: marker, mode: 'holding', anchor })
  },

  reset: (wallMs = now()) => {
    const state = get()
    const anchor: Anchor = { scenarioMs: wallMs, wallMs, rate: state.reducedMotion ? 0 : 1 }
    if (state.mode === 'paused') {
      set({ run: null, rate: 1, resumeMode: 'free', anchor: { ...anchor, rate: 0 } })
      return
    }
    set({ run: null, rate: 1, mode: 'free', anchor, resumeMode: null })
  },

  setRate: (rate, wallMs = now()) => {
    const state = get()
    // The rate is a property of the run (decision 2): locked while one is known.
    if (state.run && state.run.state === 'started') return
    const scenarioMs = state.timeAt(wallMs)
    if (state.mode === 'paused') {
      set({ rate, resumeMode: 'free', anchor: { scenarioMs, wallMs, rate: 0 } })
      return
    }
    set({ rate, mode: 'free', run: state.run?.state === 'started' ? state.run : null, anchor: { scenarioMs, wallMs, rate } })
  },

  pause: (wallMs = now()) => {
    const state = get()
    if (state.mode === 'paused') return
    set({ mode: 'paused', resumeMode: state.mode, anchor: held(state, wallMs) })
  },

  resume: (wallMs = now()) => {
    const state = get()
    if (state.mode !== 'paused') return
    const back = state.resumeMode ?? 'free'
    if (back === 'flight' && state.run && state.run.state === 'started') {
      // Rejoin the stream at its time: the run kept going while we held.
      const runNow = Date.parse(state.run.now_ts) + (wallMs - Date.parse(state.run.ts)) * state.run.speed
      set({ mode: 'flight', resumeMode: null, anchor: { scenarioMs: runNow, wallMs, rate: state.run.speed } })
      return
    }
    if (back === 'holding' || back === 'stale') {
      set({ mode: back, resumeMode: null, anchor: { ...state.anchor!, wallMs, rate: 0 } })
      return
    }
    const scenarioMs = state.timeAt(wallMs)
    set({ mode: 'free', resumeMode: null, anchor: { scenarioMs, wallMs, rate: state.rate } })
  },

  socketClosed: (wallMs = now()) => {
    const state = get()
    if (state.mode !== 'flight') return
    set({ mode: 'stale', anchor: held(state, wallMs) })
  },

  timeAt: (wallMs = now()) => evaluate(get().anchor, wallMs),

  driftMs: (signalTs, wallMs = now()) => {
    const state = get()
    if (!state.run || state.run.state !== 'started') return null
    const ts = Date.parse(signalTs)
    if (!Number.isFinite(ts)) return null
    return ts - state.timeAt(wallMs)
  },
}))

/** Whether a drift is worth a diagnostic at this rate. */
export const driftIsNotable = (driftMs: number, rate: number): boolean =>
  Math.abs(driftMs) > DRIFT_TOLERANCE_WALL_MS * Math.max(1, rate)

const pad = (value: number) => String(value).padStart(2, '0')

/** `HH:MM:SSZ` of a scenario time. */
export function clockText(scenarioMs: number): string {
  const d = new Date(scenarioMs)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`
}

/** The status line's clock: the time, the rate when it is not 1×, the state
 *  when it is not running, and the date when it differs from the wall date. */
export function flightClockLabel(state: Pick<ClockState, 'mode' | 'rate' | 'timeAt'>, wallMs = now()): string {
  const scenarioMs = state.timeAt(wallMs)
  const parts = [clockText(scenarioMs)]
  if (state.mode === 'paused') parts.push('paused')
  else if (state.mode === 'holding') parts.push('holding')
  else if (state.mode === 'stale') parts.push('stale')
  else if (state.rate !== 1) parts.push(`${state.rate}×`)
  const flightDate = new Date(scenarioMs).toISOString().slice(0, 10)
  const wallDate = new Date(wallMs).toISOString().slice(0, 10)
  if (flightDate !== wallDate) parts.push(flightDate)
  return parts.join(' · ')
}

/** Read the URL / storage once and apply it. Called by App on mount, after
 *  capture mode: a capture is always the pass view (decision 1). */
export function initialiseFlightView(search?: string) {
  const view = useCaptureStore.getState().enabled ? 'pass' : readInitialFlightView(search)
  useClockStore.getState().setView(view)
}

// Development aid, like the globe's `__megalithViewer`: a browser probe can
// read the flight clock (two consoles compared at one wall instant).
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as { __megalithClock?: typeof useClockStore }).__megalithClock = useClockStore
}
