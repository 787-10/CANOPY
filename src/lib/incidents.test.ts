import { describe, expect, it } from 'vitest'
import { deriveIncidents, relativeTime } from './incidents'
import { selectEpisodeAttribution } from './episode'
import { makeAnomaly, makeAttribution, SIM01 } from '../test/factories'

const SIM02 = 'ctb://megalith.demo/sim-02'

describe('deriveIncidents', () => {
  it("groups attributions by satellite and keeps the episode's highest revision per satellite", () => {
    const rows = deriveIncidents([
      makeAttribution('a1', { satellite_id: SIM01, revision: 1, provisional: false, verdict: 'hostile_external', ts: '2026-09-20T15:05:00Z' }),
      makeAttribution('a1', { satellite_id: SIM01, revision: 0, provisional: true, verdict: 'unknown', ts: '2026-09-20T15:06:00Z' }),
      makeAttribution('a2', { satellite_id: SIM02, revision: 2, verdict: 'natural_external', ts: '2026-09-20T15:07:00Z' }),
    ])
    expect(rows.map((row) => row.label)).toEqual(['SIM-02', 'SIM-01'])
    const sim01 = rows.find((row) => row.satelliteId === SIM01)
    expect(sim01?.attribution.revision).toBe(1)
    expect(sim01?.attribution.verdict).toBe('hostile_external')
    expect(sim01?.unresolved).toBe(false)
  })

  it('breaks a revision tie by the later timestamp', () => {
    const rows = deriveIncidents([
      makeAttribution('old', { satellite_id: SIM01, revision: 1, ts: '2026-09-20T15:05:00Z' }),
      makeAttribution('new', { satellite_id: SIM01, revision: 1, ts: '2026-09-20T15:09:00Z' }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].attribution.id).toBe('new')
  })

  it('follows the episode the rest of the screen shows, not a higher revision from an earlier run', () => {
    // Run B (hostile) reached revision 2 on SIM-01; run A (internal fault)
    // came after it and ended at revision 1. The status line reads the
    // attribution covering the latest bus anomaly; the row must agree.
    const runB = makeAttribution('run-b', {
      satellite_id: SIM01, revision: 2, verdict: 'hostile_external',
      anomaly_ids: ['anom-b'], ts: '2026-09-20T15:13:42Z',
    })
    const runA = makeAttribution('run-a', {
      satellite_id: SIM01, revision: 1, verdict: 'internal_fault',
      anomaly_ids: ['anom-a'], ts: '2026-09-20T15:13:00Z',
    })
    const anomalies = [
      makeAnomaly('anom-b', { kind: 'bus_link_margin', ts: '2026-09-20T15:13:42Z' }),
      makeAnomaly('anom-a', { kind: 'bus_link_margin', ts: '2026-09-20T15:13:50Z' }),
    ]
    const rows = deriveIncidents([runB, runA], anomalies)
    expect(rows).toHaveLength(1)
    expect(rows[0].attribution.id).toBe('run-a')
    expect(rows[0].attribution.verdict).toBe('internal_fault')
    expect(rows[0].attribution).toBe(selectEpisodeAttribution([runB, runA], anomalies))
  })

  it('adds one unresolved row per attribution with candidates and no satellite id', () => {
    const rows = deriveIncidents([
      makeAttribution('cue', { satellite_id: null, candidate_satellite_ids: [SIM01, SIM02], ts: '2026-09-20T15:08:00Z' }),
      makeAttribution('sat', { satellite_id: SIM01, ts: '2026-09-20T15:05:00Z' }),
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      key: 'unresolved:cue',
      satelliteId: null,
      label: 'SIM-01 or SIM-02, unresolved',
      unresolved: true,
    })
  })

  it('leaves out the global cluster (no satellite id, no candidates) and is empty with no attributions', () => {
    expect(deriveIncidents([])).toEqual([])
    expect(deriveIncidents([makeAttribution('storm', { satellite_id: null })])).toEqual([])
  })

  it('still lists a single incident', () => {
    expect(deriveIncidents([makeAttribution('a', { satellite_id: SIM01 })])).toHaveLength(1)
  })
})

describe('relativeTime', () => {
  const now = Date.parse('2026-09-20T15:10:00Z')
  it('reads in seconds, minutes and hours, "just now" for a moment ahead, and clock time for a scenario clock', () => {
    expect(relativeTime('2026-09-20T15:09:48Z', now)).toBe('12 s ago')
    expect(relativeTime('2026-09-20T15:07:00Z', now)).toBe('3 min ago')
    expect(relativeTime('2026-09-20T13:10:00Z', now)).toBe('2 h ago')
    expect(relativeTime('2026-09-20T15:10:30Z', now)).toBe('just now')
    // Ten hours ahead: a replayed scenario's clock, shown as a time of day.
    expect(relativeTime('2026-09-21T01:10:00Z', now)).toMatch(/^\d{2}:\d{2}:\d{2}Z$/)
    expect(relativeTime('not a date', now)).toBe('unknown')
  })
})
