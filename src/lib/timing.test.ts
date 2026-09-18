import { describe, expect, it } from 'vitest'
import { attributionTimings, formatMs, stageTimings } from './timing'
import { makeAttribution, makeDecision, makeTrace } from '../test/factories'

const traces = [
  makeTrace('f-1', {
    stage: 'fusion',
    ts: '2026-09-17T14:32:12.000Z',
    ref_id: 'anom-1',
    message: 'new anomaly: bus_link_margin @ severity 0.81',
  }),
  makeTrace('f-2', {
    stage: 'fusion',
    ts: '2026-09-17T14:32:12.250Z',
    ref_id: 'anom-2',
    message: 'new anomaly: rf_anomaly @ severity 0.78',
  }),
  makeTrace('a-0', {
    stage: 'attrib_primary',
    level: 'decision',
    ref_id: 'att-1',
    message: 'provisional verdict=hostile_external ...',
    payload: { latency_ms: 38.2, stage_ms: 2.5, provisional: true, revision: 0 },
  }),
  makeTrace('a-1p', {
    stage: 'attrib_primary',
    ref_id: 'att-1',
    message: 'primary ...',
    payload: { latency_ms: 2100, stage_ms: 2000, provisional: false, revision: 1 },
  }),
  makeTrace('a-1', {
    stage: 'attrib_reconcile',
    ref_id: 'att-1',
    message: 'final actor=Actor-1 ...',
    payload: { latency_ms: 4480.7, stage_ms: 4400.1, provisional: false, revision: 1 },
  }),
  makeTrace('d-1', {
    stage: 'decide',
    level: 'decision',
    ref_id: 'dec-1',
    message: 'action=passive_defense authority=local target=SIM-01',
    payload: { latency_ms: 4602, stage_ms: 120, attribution_id: 'att-1', revision: 1 },
  }),
  makeTrace('u-1', {
    stage: 'decide',
    level: 'info',
    ref_id: 'uievt-dec-1',
    message: 'ui event published: threat_updated severity=high revision=1',
    payload: { latency_ms: 4610, stage_ms: 1.2 },
  }),
  makeTrace('x-1', {
    stage: 'attrib_reconcile',
    ref_id: 'att-other',
    payload: { latency_ms: 99999, revision: 3 },
  }),
]

describe('attributionTimings', () => {
  it('reads provisional (rev 0) and final (highest revision, reconcile preferred) latencies for one id', () => {
    expect(attributionTimings(traces, 'att-1')).toEqual({
      provisionalMs: 38.2,
      finalMs: 4480.7,
      finalRevision: 1,
      finalStageMs: 4400.1,
    })
  })

  it('returns nulls for an unknown id, a null id, or traces without latency_ms', () => {
    const empty = { provisionalMs: null, finalMs: null, finalRevision: null, finalStageMs: null }
    expect(attributionTimings(traces, 'nope')).toEqual(empty)
    expect(attributionTimings(traces, null)).toEqual(empty)
    expect(
      attributionTimings([makeTrace('t', { stage: 'attrib_primary', ref_id: 'a', payload: { revision: 0 } })], 'a'),
    ).toEqual(empty)
  })

  it('reports only the provisional latency while the final revision is pending', () => {
    const pending = attributionTimings(traces.slice(0, 3), 'att-1')
    expect(pending.provisionalMs).toBe(38.2)
    expect(pending.finalMs).toBeNull()
  })
})

describe('stageTimings', () => {
  it('lays out fusion, provisional, final, decide and console-event rows', () => {
    const rows = stageTimings(
      traces,
      makeAttribution('att-1', { anomaly_ids: ['anom-1', 'anom-2'] }),
      makeDecision('dec-1', { attribution_id: 'att-1', revision: 1 }),
    )
    expect(rows.map((row) => row.stage)).toEqual([
      'fusion',
      'attrib_provisional',
      'attrib_final',
      'decide',
      'ui_event',
    ])
    const byStage = Object.fromEntries(rows.map((row) => [row.stage, row]))
    expect(byStage.fusion.stageMs).toBe(250)
    expect(byStage.fusion.traceIds).toEqual(['f-1', 'f-2'])
    expect(byStage.attrib_provisional.latencyMs).toBe(38.2)
    expect(byStage.attrib_final.latencyMs).toBe(4480.7)
    expect(byStage.attrib_final.note).toBe('reasoning lane, revision 1')
    expect(byStage.decide.latencyMs).toBe(4602)
    expect(byStage.decide.stageMs).toBe(120)
    expect(byStage.ui_event.latencyMs).toBe(4610)
  })

  it('says what is missing instead of inventing a number', () => {
    const rows = stageTimings([], null, null)
    expect(rows.every((row) => row.latencyMs === null && row.stageMs === null)).toBe(true)
    expect(rows.find((row) => row.stage === 'fusion')?.note).toMatch(/no anomaly trace/)
    expect(formatMs(null)).toBe('n/a')
    expect(formatMs(38.2)).toBe('38 ms')
    expect(formatMs(4480.7)).toBe('4,481 ms')
    expect(formatMs(12_500)).toBe('12.5 s')
  })
})
