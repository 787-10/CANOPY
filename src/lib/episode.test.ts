import { describe, expect, it } from 'vitest'
import type { Anomaly, Attribution } from '../types/canopy'
import { isStaleRevision, selectEpisodeAttribution } from './episode'

const att = (over: Partial<Attribution>): Attribution =>
  ({
    id: 'att-1',
    ts: '2026-09-20T15:05:00Z',
    anomaly_ids: [],
    actor: 'None',
    confidence: 0.5,
    evidence: [],
    kb_citations: [],
    source_signal_ids: [],
    revision: 0,
    provisional: false,
    ...over,
  }) as Attribution

const anomaly = (id: string, kind: string, ts: string): Anomaly =>
  ({ id, kind, ts, source_signal: 's', source_signal_ids: [], severity: 0.5, payload: {} }) as Anomaly

describe('selectEpisodeAttribution', () => {
  const bus = anomaly('an-bus', 'bus_link_margin', '2026-09-20T15:06:00Z')
  const storm = anomaly('an-storm', 'space_weather_storm', '2026-09-20T15:07:00Z')
  const sat = 'ctb://megalith.demo/sim-01'

  it('prefers the satellite cluster over a later global storm attribution', () => {
    const final = att({ id: 'a1', satellite_id: sat, anomaly_ids: ['an-bus'], revision: 1, verdict: 'natural_external' })
    const stormAtt = att({ id: 'a2', anomaly_ids: ['an-storm'], verdict: 'unknown', ts: '2026-09-20T15:09:00Z' })
    expect(selectEpisodeAttribution([stormAtt, final], [bus, storm])?.id).toBe('a1')
  })

  it('takes the highest revision of the covering cluster', () => {
    const prov = att({ id: 'a1', satellite_id: sat, anomaly_ids: ['an-bus'], revision: 0, provisional: true })
    const final = att({ id: 'a1', satellite_id: sat, anomaly_ids: ['an-bus'], revision: 1 })
    expect(selectEpisodeAttribution([final, prov], [bus])?.revision).toBe(1)
  })

  it('falls back to the newest attribution when nothing carries a satellite id', () => {
    const older = att({ id: 'x', ts: '2026-09-20T15:00:00Z' })
    const newer = att({ id: 'y', ts: '2026-09-20T15:01:00Z' })
    expect(selectEpisodeAttribution([older, newer])?.id).toBe('y')
    expect(selectEpisodeAttribution([])).toBeNull()
  })

  it('flags a lower revision of a held id as stale', () => {
    const held = att({ id: 'a1', revision: 1 })
    expect(isStaleRevision(att({ id: 'a1', revision: 0 }), held)).toBe(true)
    expect(isStaleRevision(att({ id: 'a1', revision: 2 }), held)).toBe(false)
    expect(isStaleRevision(att({ id: 'a9', revision: 0 }), held)).toBe(false)
  })
})
