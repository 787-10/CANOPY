import { beforeEach, describe, expect, it } from 'vitest'
import type { ReplayMarker } from '../types/canopy'
import { DRIFT_TOLERANCE_WALL_MS, clockText, driftIsNotable, flightClockLabel, useClockStore } from './clockStore'

const T0 = Date.parse('2026-09-21T10:00:00.000Z') // wall
const S0 = Date.parse('2026-09-20T14:48:28Z') // scenario
const S_LAST = Date.parse('2026-09-20T15:14:42Z')

const marker = (over: Partial<ReplayMarker> = {}): ReplayMarker => ({
  state: 'started',
  scenario: 'megalith_link_margin_a.jsonl',
  speed: 60,
  max_delay_s: null,
  first_ts: '2026-09-20T14:48:28Z',
  last_ts: '2026-09-20T15:14:42Z',
  now_ts: '2026-09-20T14:48:28Z',
  started_at: '2026-09-21T10:00:00.000Z',
  ts: '2026-09-21T10:00:00.000Z',
  ...over,
})

const fresh = () => {
  useClockStore.setState({
    view: 'pass',
    mode: 'free',
    rate: 1,
    anchor: null,
    run: null,
    resumeMode: null,
    reducedMotion: false,
  })
  return useClockStore.getState()
}

beforeEach(() => {
  fresh()
})

describe('free flight', () => {
  it('reads wall time at 1x with no anchor and no run', () => {
    expect(useClockStore.getState().timeAt(T0)).toBe(T0)
  })

  it('accelerates from the moment the rate is set', () => {
    useClockStore.getState().setRate(60, T0)
    expect(useClockStore.getState().timeAt(T0 + 1000)).toBe(T0 + 60_000)
    expect(useClockStore.getState().mode).toBe('free')
  })
})

describe('a run', () => {
  it('started: evaluates now_ts + (wall - receipt) x speed, statelessly', () => {
    useClockStore.getState().applyReplay(marker(), T0)
    const s = useClockStore.getState()
    expect(s.mode).toBe('flight')
    expect(s.rate).toBe(60)
    expect(s.timeAt(T0)).toBe(S0)
    expect(s.timeAt(T0 + 10_000)).toBe(S0 + 600_000)
    // A hidden tab changes nothing: the same wall instant gives the same time.
    expect(s.timeAt(T0 + 3_600_000)).toBe(S0 + 216_000_000)
  })

  it('a snapshot mid-run anchors at the newest published time, not the first', () => {
    const late = marker({ now_ts: '2026-09-20T15:08:42Z', ts: '2026-09-21T10:00:20.000Z' })
    useClockStore.getState().applyReplay(late, T0 + 20_000)
    expect(useClockStore.getState().timeAt(T0 + 20_000)).toBe(Date.parse('2026-09-20T15:08:42Z'))
  })

  it('locks the rate while the run is live', () => {
    useClockStore.getState().applyReplay(marker(), T0)
    useClockStore.getState().setRate(600, T0 + 1000)
    expect(useClockStore.getState().rate).toBe(60)
    expect(useClockStore.getState().mode).toBe('flight')
  })

  it('finished: holds at last_ts until reset', () => {
    useClockStore.getState().applyReplay(marker(), T0)
    useClockStore.getState().applyReplay(marker({ state: 'finished', now_ts: '2026-09-20T15:14:42Z' }), T0 + 26_000)
    const s = useClockStore.getState()
    expect(s.mode).toBe('holding')
    expect(s.timeAt(T0 + 26_000)).toBe(S_LAST)
    expect(s.timeAt(T0 + 999_000)).toBe(S_LAST)
  })

  it('cancelled: holds where the run was cut', () => {
    useClockStore.getState().applyReplay(marker(), T0)
    useClockStore.getState().applyReplay(marker({ state: 'cancelled', now_ts: '2026-09-20T15:03:11Z' }), T0 + 5000)
    expect(useClockStore.getState().mode).toBe('holding')
    expect(useClockStore.getState().timeAt(T0 + 60_000)).toBe(Date.parse('2026-09-20T15:03:11Z'))
  })

  it('reset: no run, free at wall now', () => {
    useClockStore.getState().applyReplay(marker(), T0)
    useClockStore.getState().reset(T0 + 30_000)
    const s = useClockStore.getState()
    expect(s.mode).toBe('free')
    expect(s.run).toBeNull()
    expect(s.rate).toBe(1)
    expect(s.timeAt(T0 + 31_000)).toBe(T0 + 31_000)
  })

  it('socket loss mid-run goes stale and holds; the next snapshot resumes', () => {
    useClockStore.getState().applyReplay(marker(), T0)
    useClockStore.getState().socketClosed(T0 + 10_000)
    const s = useClockStore.getState()
    expect(s.mode).toBe('stale')
    expect(s.timeAt(T0 + 50_000)).toBe(S0 + 600_000)
    useClockStore.getState().applyReplay(marker({ now_ts: '2026-09-20T15:03:11Z', ts: '2026-09-21T10:00:50.000Z' }), T0 + 50_000)
    expect(useClockStore.getState().mode).toBe('flight')
  })

  it('reports signal drift against the clock, and when it is notable', () => {
    useClockStore.getState().applyReplay(marker(), T0)
    const s = useClockStore.getState()
    expect(s.driftMs('2026-09-20T14:48:28Z', T0)).toBe(0)
    expect(s.driftMs('2026-09-20T14:49:28Z', T0)).toBe(60_000)
    expect(driftIsNotable(60_000, 60)).toBe(true)
    expect(driftIsNotable(10_000, 60)).toBe(false)
    expect(driftIsNotable(DRIFT_TOLERANCE_WALL_MS + 1, 1)).toBe(true)
    useClockStore.getState().reset(T0)
    expect(useClockStore.getState().driftMs('2026-09-20T14:48:28Z', T0)).toBeNull()
  })
})

describe('pause', () => {
  it('is display only: resuming a run rejoins the stream at its current time', () => {
    useClockStore.getState().applyReplay(marker(), T0)
    useClockStore.getState().pause(T0 + 10_000)
    const paused = useClockStore.getState()
    expect(paused.mode).toBe('paused')
    expect(paused.timeAt(T0 + 10_000)).toBe(S0 + 600_000)
    expect(paused.timeAt(T0 + 40_000)).toBe(S0 + 600_000)
    useClockStore.getState().resume(T0 + 40_000)
    const s = useClockStore.getState()
    expect(s.mode).toBe('flight')
    expect(s.timeAt(T0 + 40_000)).toBe(S0 + 2_400_000)
  })

  it('in free flight resumes from where it paused', () => {
    useClockStore.getState().setRate(10, T0)
    useClockStore.getState().pause(T0 + 5000)
    useClockStore.getState().resume(T0 + 65_000)
    expect(useClockStore.getState().timeAt(T0 + 66_000)).toBe(T0 + 50_000 + 10_000)
  })

  it('a run that ends while paused is held at its end after resume', () => {
    useClockStore.getState().applyReplay(marker(), T0)
    useClockStore.getState().pause(T0 + 1000)
    useClockStore.getState().applyReplay(marker({ state: 'finished', now_ts: '2026-09-20T15:14:42Z' }), T0 + 26_000)
    expect(useClockStore.getState().mode).toBe('paused')
    useClockStore.getState().resume(T0 + 30_000)
    expect(useClockStore.getState().mode).toBe('holding')
    expect(useClockStore.getState().timeAt(T0 + 99_000)).toBe(S_LAST)
  })

  it('reduced motion opens flight paused', () => {
    useClockStore.setState({ reducedMotion: true })
    useClockStore.getState().setView('flight')
    expect(useClockStore.getState().mode).toBe('paused')
  })
})

describe('labels', () => {
  it('names the clock, the rate when not 1x, the state, and a differing date', () => {
    expect(clockText(S0)).toBe('14:48:28Z')
    const s = fresh()
    expect(flightClockLabel(s, T0)).toBe('10:00:00Z')
    useClockStore.getState().applyReplay(marker(), T0)
    expect(flightClockLabel(useClockStore.getState(), T0)).toBe('14:48:28Z · 60× · 2026-09-20')
    useClockStore.getState().pause(T0)
    expect(flightClockLabel(useClockStore.getState(), T0)).toBe('14:48:28Z · paused · 2026-09-20')
    useClockStore.getState().resume(T0)
    useClockStore.getState().applyReplay(marker({ state: 'finished', now_ts: '2026-09-20T15:14:42Z' }), T0)
    expect(flightClockLabel(useClockStore.getState(), T0)).toBe('15:14:42Z · holding · 2026-09-20')
  })
})
