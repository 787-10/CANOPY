import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useCanopyMissionState } from './useCanopyMissionState'
import {
  makeSignal as buildSignal,
  makeUIEvent as buildUIEvent,
} from '../test/factories'
import type { Signal, UISeverity, UIEvent } from '../types/canopy'

// ---------------------------------------------------------------------------
// Auto-id wrappers over the shared factories. This suite never cares about a
// signal/event's specific id — only that each is unique (correlation tests
// read `.id` back) — so ids come from a per-file counter. The shared makeSignal
// defaults payload.event_type to the domain, which keeps commanderLanguage's
// `detail` output stable.
// ---------------------------------------------------------------------------

let signalSeq = 0
let eventSeq = 0

const makeSignal = (overrides: Partial<Signal> = {}): Signal =>
  buildSignal(`sig-${++signalSeq}`, overrides)

const makeUiEvent = (overrides: Partial<UIEvent> = {}): UIEvent =>
  buildUIEvent(`evt-${++eventSeq}`, overrides)

// Convenience: render the hook and return result.current.
type Options = Parameters<typeof useCanopyMissionState>[2]
const run = (signals: Signal[], uiEvents: UIEvent[], options?: Options) =>
  renderHook(() => useCanopyMissionState(signals, uiEvents, options)).result
    .current

describe('useCanopyMissionState — threatState / attribution.state from latest UI event severity', () => {
  const severityCases: Array<[UISeverity, 'white' | 'amber' | 'red']> = [
    ['critical', 'red'],
    ['high', 'red'],
    ['medium', 'amber'],
    ['low', 'white'],
  ]

  for (const [severity, expected] of severityCases) {
    it(`maps severity '${severity}' -> threatState '${expected}'`, () => {
      const state = run([], [makeUiEvent({ severity })])
      expect(state.threatState).toBe(expected)
      expect(state.statuses.attribution.state).toBe(expected)
    })
  }

  it("defaults threatState to 'white' when there is no UI event", () => {
    const state = run([makeSignal()], [])
    expect(state.threatState).toBe('white')
    expect(state.statuses.attribution.state).toBe('white')
  })

  it('uses only the FIRST (latest) UI event severity, ignoring older ones', () => {
    const latest = makeUiEvent({ severity: 'medium' })
    const older = makeUiEvent({ severity: 'critical' })
    const state = run([], [latest, older])
    // amber from the latest, not red from the older critical event.
    expect(state.threatState).toBe('amber')
  })
})

describe('useCanopyMissionState — domain bucketing (spaceLayer vs blosComms)', () => {
  it('spaceLayer aggregates only orbit/sda signals', () => {
    const orbit = makeSignal({ domain: 'orbit', confidence: 0.9 })
    const sda = makeSignal({ domain: 'sda', confidence: 0.8 })
    // A comms-domain signal must not leak into spaceLayer.
    const satcom = makeSignal({ domain: 'satcom', confidence: 0.95 })
    const state = run([orbit, sda, satcom], [])
    // 2 space signals, highest confidence 0.9 -> red.
    expect(state.statuses.spaceLayer.metric).toBe('90% / 2 live')
    expect(state.statuses.spaceLayer.state).toBe('red')
  })

  it('blosComms aggregates only satcom/rf_ew/cyber/pnt/drone signals', () => {
    const satcom = makeSignal({ domain: 'satcom', confidence: 0.75 })
    const rfEw = makeSignal({ domain: 'rf_ew', confidence: 0.6 })
    const cyber = makeSignal({ domain: 'cyber', confidence: 0.5 })
    const pnt = makeSignal({ domain: 'pnt', confidence: 0.5 })
    const drone = makeSignal({ domain: 'drone', confidence: 0.5 })
    // A space signal must not leak into blosComms.
    const orbit = makeSignal({ domain: 'orbit', confidence: 0.99 })
    const state = run([satcom, rfEw, cyber, pnt, drone, orbit], [])
    // 5 comms signals, highest 0.75 -> amber.
    expect(state.statuses.blosComms.metric).toBe('75% / 5 live')
    expect(state.statuses.blosComms.state).toBe('amber')
  })

  it("an unrelated domain (osint) influences neither bucket's confidence-derived state", () => {
    const osint = makeSignal({ domain: 'osint', confidence: 0.99 })
    const state = run([osint], [])
    // osint is in neither set -> both buckets stay empty.
    expect(state.statuses.spaceLayer.state).toBe('white')
    expect(state.statuses.spaceLayer.metric).toBe('No live hits')
    expect(state.statuses.blosComms.state).toBe('white')
    expect(state.statuses.blosComms.metric).toBe('No live hits')
  })

  it("humint and terrain are also outside both buckets", () => {
    const humint = makeSignal({ domain: 'humint', confidence: 0.95 })
    const terrain = makeSignal({ domain: 'terrain', confidence: 0.95 })
    const state = run([humint, terrain], [])
    expect(state.statuses.spaceLayer.metric).toBe('No live hits')
    expect(state.statuses.blosComms.metric).toBe('No live hits')
  })
})

describe('useCanopyMissionState — confidence -> state thresholds (via a bucket)', () => {
  it('confidence >= 0.86 -> red', () => {
    const state = run([makeSignal({ domain: 'orbit', confidence: 0.86 })], [])
    expect(state.statuses.spaceLayer.state).toBe('red')
  })

  it('confidence in [0.72, 0.86) -> amber (lower bound)', () => {
    const state = run([makeSignal({ domain: 'orbit', confidence: 0.72 })], [])
    expect(state.statuses.spaceLayer.state).toBe('amber')
  })

  it('confidence in [0.72, 0.86) -> amber (just below the red cutoff)', () => {
    const state = run([makeSignal({ domain: 'orbit', confidence: 0.8599 })], [])
    expect(state.statuses.spaceLayer.state).toBe('amber')
  })

  it('confidence < 0.72 -> white', () => {
    const state = run([makeSignal({ domain: 'orbit', confidence: 0.7199 })], [])
    expect(state.statuses.spaceLayer.state).toBe('white')
  })

  it("empty bucket -> metric 'No live hits' and state 'white'", () => {
    const state = run([], [])
    expect(state.statuses.spaceLayer.metric).toBe('No live hits')
    expect(state.statuses.spaceLayer.state).toBe('white')
    expect(state.statuses.blosComms.metric).toBe('No live hits')
    expect(state.statuses.blosComms.state).toBe('white')
  })

  it('uses the HIGHEST confidence in the bucket to derive state, not the latest', () => {
    // latest (first) is low, but a later high-confidence signal drives state red.
    const lowLatest = makeSignal({ domain: 'orbit', confidence: 0.3 })
    const highOlder = makeSignal({ domain: 'sda', confidence: 0.91 })
    const state = run([lowLatest, highOlder], [])
    expect(state.statuses.spaceLayer.state).toBe('red')
    // metric pct comes from the highest (91%), count is both signals.
    expect(state.statuses.spaceLayer.metric).toBe('91% / 2 live')
  })
})

describe('useCanopyMissionState — correlation bump (strongerState)', () => {
  it('a correlated in-bucket signal lifts a white bucket to at least amber', () => {
    // Confidence alone (0.3) would be white.
    const sig = makeSignal({ domain: 'orbit', confidence: 0.3 })
    const event = makeUiEvent({
      severity: 'low',
      source_signal_ids: [sig.id],
    })
    const state = run([sig], [event])
    expect(state.statuses.spaceLayer.state).toBe('amber')
  })

  it('correlation does NOT downgrade an already-red bucket', () => {
    const sig = makeSignal({ domain: 'orbit', confidence: 0.95 })
    const event = makeUiEvent({ source_signal_ids: [sig.id] })
    const state = run([sig], [event])
    // red (rank 2) is stronger than amber (rank 1) -> stays red.
    expect(state.statuses.spaceLayer.state).toBe('red')
  })

  it('correlation against a signal in the OTHER bucket does not bump this bucket', () => {
    const orbit = makeSignal({ domain: 'orbit', confidence: 0.3 })
    const satcom = makeSignal({ domain: 'satcom', confidence: 0.3 })
    // Correlate only the satcom (blosComms) signal.
    const event = makeUiEvent({ source_signal_ids: [satcom.id] })
    const state = run([orbit, satcom], [event])
    expect(state.statuses.spaceLayer.state).toBe('white') // not correlated
    expect(state.statuses.blosComms.state).toBe('amber') // correlated bump
  })

  it('correlation ids that match no in-bucket signal leave the bucket white', () => {
    const sig = makeSignal({ domain: 'orbit', confidence: 0.3 })
    const event = makeUiEvent({ source_signal_ids: ['does-not-exist'] })
    const state = run([sig], [event])
    expect(state.statuses.spaceLayer.state).toBe('white')
  })
})

describe('useCanopyMissionState — metric string format', () => {
  it('formats as "<roundedPct>% / <count> live" with rounding of highest confidence', () => {
    // 0.736 * 100 = 73.6 -> rounds to 74.
    const a = makeSignal({ domain: 'satcom', confidence: 0.736 })
    const b = makeSignal({ domain: 'rf_ew', confidence: 0.5 })
    const state = run([a, b], [])
    expect(state.statuses.blosComms.metric).toBe('74% / 2 live')
  })

  it('rounds half up at the .5 boundary', () => {
    // 0.725 * 100 = 72.5 -> Math.round -> 73.
    const state = run([makeSignal({ domain: 'orbit', confidence: 0.725 })], [])
    expect(state.statuses.spaceLayer.metric).toBe('73% / 1 live')
  })

  it('count reflects only in-bucket signals', () => {
    const state = run(
      [
        makeSignal({ domain: 'orbit', confidence: 0.4 }),
        makeSignal({ domain: 'sda', confidence: 0.9 }),
        makeSignal({ domain: 'satcom', confidence: 0.9 }), // other bucket
        makeSignal({ domain: 'osint', confidence: 0.9 }), // no bucket
      ],
      [],
    )
    expect(state.statuses.spaceLayer.metric).toBe('90% / 2 live')
  })
})

describe('useCanopyMissionState — correlatedSignalIds', () => {
  it("equals the latest UI event's source_signal_ids as an array", () => {
    const event = makeUiEvent({ source_signal_ids: ['a', 'b', 'c'] })
    const state = run([], [event])
    expect(state.correlatedSignalIds).toEqual(['a', 'b', 'c'])
    expect(Array.isArray(state.correlatedSignalIds)).toBe(true)
  })

  it('comes from the latest (first) event only', () => {
    const latest = makeUiEvent({ source_signal_ids: ['x'] })
    const older = makeUiEvent({ source_signal_ids: ['y', 'z'] })
    const state = run([], [latest, older])
    expect(state.correlatedSignalIds).toEqual(['x'])
  })

  it('is empty when there is no UI event', () => {
    const state = run([makeSignal()], [])
    expect(state.correlatedSignalIds).toEqual([])
  })

  it('de-duplicates ids (built from a Set)', () => {
    const event = makeUiEvent({ source_signal_ids: ['dup', 'dup', 'unique'] })
    const state = run([], [event])
    expect(state.correlatedSignalIds).toEqual(['dup', 'unique'])
  })
})

describe('useCanopyMissionState — latestSignal / latestUiEvent', () => {
  it('returns the first element of each input array', () => {
    const first = makeSignal({ domain: 'orbit' })
    const second = makeSignal({ domain: 'sda' })
    const firstEvent = makeUiEvent({ title: 'first' })
    const secondEvent = makeUiEvent({ title: 'second' })
    const state = run([first, second], [firstEvent, secondEvent])
    expect(state.latestSignal).toBe(first)
    expect(state.latestUiEvent).toBe(firstEvent)
  })

  it('returns null when the corresponding array is empty', () => {
    const state = run([], [])
    expect(state.latestSignal).toBeNull()
    expect(state.latestUiEvent).toBeNull()
  })

  it('latestSignal is independent of domain bucketing', () => {
    // osint is in no bucket but is still the latest signal.
    const osint = makeSignal({ domain: 'osint' })
    const state = run([osint], [])
    expect(state.latestSignal).toBe(osint)
  })
})

describe('useCanopyMissionState — mapFocusSignalId', () => {
  it('prefers a correlated high-confidence signal over the latest high-confidence one', () => {
    const latestHigh = makeSignal({ domain: 'orbit', confidence: 0.9 })
    const correlatedHigh = makeSignal({ domain: 'sda', confidence: 0.88 })
    const event = makeUiEvent({ source_signal_ids: [correlatedHigh.id] })
    const state = run([latestHigh, correlatedHigh], [event])
    expect(state.mapFocusSignalId).toBe(correlatedHigh.id)
  })

  it('falls back to the latest signal with confidence >= 0.86 when none is correlated', () => {
    const lowFirst = makeSignal({ domain: 'orbit', confidence: 0.5 })
    const highSecond = makeSignal({ domain: 'sda', confidence: 0.9 })
    const evenHigherThird = makeSignal({ domain: 'satcom', confidence: 0.95 })
    // No correlation -> picks the FIRST signal that clears the threshold.
    const state = run([lowFirst, highSecond, evenHigherThird], [])
    expect(state.mapFocusSignalId).toBe(highSecond.id)
  })

  it('returns null when no signal meets the default 0.86 threshold', () => {
    const state = run(
      [
        makeSignal({ domain: 'orbit', confidence: 0.85 }),
        makeSignal({ domain: 'satcom', confidence: 0.7 }),
      ],
      [],
    )
    expect(state.mapFocusSignalId).toBeNull()
  })

  it('includes a signal exactly at the 0.86 threshold', () => {
    const sig = makeSignal({ domain: 'orbit', confidence: 0.86 })
    const state = run([sig], [])
    expect(state.mapFocusSignalId).toBe(sig.id)
  })

  it('a correlated but LOW-confidence signal does not qualify; falls back to latest high', () => {
    const correlatedLow = makeSignal({ domain: 'orbit', confidence: 0.5 })
    const latestHigh = makeSignal({ domain: 'sda', confidence: 0.9 })
    const event = makeUiEvent({ source_signal_ids: [correlatedLow.id] })
    // correlatedLow is below threshold so it's not in highPrioritySignals;
    // the high-confidence latest signal wins instead.
    const state = run([latestHigh, correlatedLow], [event])
    expect(state.mapFocusSignalId).toBe(latestHigh.id)
  })

  it('is always null when enableMapAutoFocus is false, even with a strong correlated signal', () => {
    const sig = makeSignal({ domain: 'orbit', confidence: 0.99 })
    const event = makeUiEvent({ source_signal_ids: [sig.id] })
    const state = run([sig], [event], { enableMapAutoFocus: false })
    expect(state.mapFocusSignalId).toBeNull()
  })

  it('honors a custom mapFocusMinConfidence (0.5 lets a 0.6 signal qualify)', () => {
    const sig = makeSignal({ domain: 'orbit', confidence: 0.6 })
    const state = run([sig], [], { mapFocusMinConfidence: 0.5 })
    expect(state.mapFocusSignalId).toBe(sig.id)
  })

  it('with the default threshold a 0.6 signal does NOT qualify', () => {
    const sig = makeSignal({ domain: 'orbit', confidence: 0.6 })
    const state = run([sig], [])
    expect(state.mapFocusSignalId).toBeNull()
  })
})

describe('useCanopyMissionState — attribution status', () => {
  it("derives label from latestUiEvent.type with underscores -> spaces", () => {
    const event = makeUiEvent({ type: 'recommendation_created' })
    const state = run([], [event])
    expect(state.statuses.attribution.label).toBe('recommendation created')
  })

  it("label is 'Building picture' when there is no event", () => {
    const state = run([makeSignal()], [])
    expect(state.statuses.attribution.label).toBe('Building picture')
  })

  it('handles other event types (threat_updated, status_update)', () => {
    expect(
      run([], [makeUiEvent({ type: 'threat_updated' })]).statuses.attribution
        .label,
    ).toBe('threat updated')
    expect(
      run([], [makeUiEvent({ type: 'status_update' })]).statuses.attribution
        .label,
    ).toBe('status update')
  })

  it('metric reflects event confidence; detail reflects event title', () => {
    const event = makeUiEvent({
      confidence: 0.823,
      title: 'Convergence forming over the support window',
    })
    const state = run([], [event])
    // 0.823 * 100 = 82.3 -> 82.
    expect(state.statuses.attribution.metric).toBe('82% confidence')
    expect(state.statuses.attribution.detail).toBe(
      'Convergence forming over the support window',
    )
  })

  it("metric is 'No call yet' and detail is the empty placeholder without an event", () => {
    const state = run([makeSignal()], [])
    expect(state.statuses.attribution.metric).toBe('No call yet')
    expect(state.statuses.attribution.detail).toBe(
      'No commander-facing assessment yet.',
    )
  })

  it('attribution title is the fixed string', () => {
    const state = run([], [makeUiEvent()])
    expect(state.statuses.attribution.title).toBe('Assessment')
  })
})

describe('useCanopyMissionState — static titles/labels and detail wiring', () => {
  it('exposes the fixed titles and labels for the space and comms buckets', () => {
    const state = run([], [])
    expect(state.statuses.spaceLayer.title).toBe('Space Support')
    expect(state.statuses.spaceLayer.label).toBe('Satellites / Overhead')
    expect(state.statuses.blosComms.title).toBe('Comms and Navigation')
    expect(state.statuses.blosComms.label).toBe('SATCOM / GPS / Drones')
  })

  it('uses the per-bucket empty-detail copy when no in-bucket signal exists', () => {
    const state = run([], [])
    expect(state.statuses.spaceLayer.detail).toBe(
      'No space-support change has arrived.',
    )
    expect(state.statuses.blosComms.detail).toBe(
      'No communications or navigation degradation has arrived.',
    )
  })

  it('bucket detail derives from commanderSignalSummary of the latest in-bucket signal (non-empty)', () => {
    // event_type === domain -> plainEventName returns `${label} report`.
    const orbit = makeSignal({ domain: 'orbit', confidence: 0.4 })
    const state = run([orbit], [])
    expect(state.statuses.spaceLayer.detail).toBe('Satellite proximity report')
    expect(state.statuses.spaceLayer.detail.length).toBeGreaterThan(0)
  })

  it('bucket detail uses the FIRST in-bucket signal even if a later one has higher confidence', () => {
    // First space signal is orbit, second is sda with higher confidence.
    const orbit = makeSignal({ domain: 'orbit', confidence: 0.3 })
    const sda = makeSignal({ domain: 'sda', confidence: 0.95 })
    const state = run([orbit, sda], [])
    // detail follows the latest (first) in-bucket signal -> orbit's label.
    expect(state.statuses.spaceLayer.detail).toBe('Satellite proximity report')
  })

  it('bucket detail is a stable non-empty string for an event_type that hits the override table', () => {
    const sig = makeSignal({
      domain: 'satcom',
      confidence: 0.5,
      payload: {
        event_type: 'satcom_degradation',
        summary: 'SATCOM link quality is degrading on the primary path.',
      },
    })
    const state = run([sig], [])
    expect(typeof state.statuses.blosComms.detail).toBe('string')
    expect(state.statuses.blosComms.detail.length).toBeGreaterThan(0)
  })
})

describe('useCanopyMissionState — combined / integration behaviour', () => {
  it('threat is white but both buckets red when only confidence is high and no event exists', () => {
    const state = run(
      [
        makeSignal({ domain: 'orbit', confidence: 0.9 }),
        makeSignal({ domain: 'satcom', confidence: 0.9 }),
      ],
      [],
    )
    expect(state.threatState).toBe('white')
    expect(state.statuses.spaceLayer.state).toBe('red')
    expect(state.statuses.blosComms.state).toBe('red')
  })

  it('returns a memoized object that is stable across re-renders with identical inputs', () => {
    const signals = [makeSignal({ domain: 'orbit', confidence: 0.9 })]
    const uiEvents = [makeUiEvent({ severity: 'high' })]
    const { result, rerender } = renderHook(
      ({ s, e }: { s: Signal[]; e: UIEvent[] }) =>
        useCanopyMissionState(s, e),
      { initialProps: { s: signals, e: uiEvents } },
    )
    const first = result.current
    rerender({ s: signals, e: uiEvents })
    // useMemo deps are referentially identical -> same object reference.
    expect(result.current).toBe(first)
  })

  it('recomputes when the signals array reference changes', () => {
    const { result, rerender } = renderHook(
      ({ s }: { s: Signal[] }) => useCanopyMissionState(s, []),
      { initialProps: { s: [makeSignal({ domain: 'orbit', confidence: 0.4 })] } },
    )
    const first = result.current
    rerender({ s: [makeSignal({ domain: 'orbit', confidence: 0.9 })] })
    expect(result.current).not.toBe(first)
    expect(result.current.statuses.spaceLayer.state).toBe('red')
  })
})
