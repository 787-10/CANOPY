import { describe, expect, it } from 'vitest'
import { environmentFacts, PHYSICS_TREND_POINTS, spacecraftFacts } from './situation'
import { makeAnomaly, makeSignal, SIM01 } from '../test/factories'

const SIM02 = 'ctb://megalith.demo/sim-02'

const bus = (id: string, ts: string, physics: number, satellite = SIM01) =>
  makeAnomaly(id, {
    kind: 'bus_link_margin',
    ts,
    payload: { satellite_id: satellite, subsystem: 'comms', symptom: 'link_margin_db_drop', physics_consistency: physics },
  })

describe('spacecraftFacts', () => {
  it('reads the latest bus anomaly of the satellite and the last twelve physics scores, oldest first', () => {
    const anomalies = Array.from({ length: 15 }, (_, index) =>
      bus(`b${index}`, `2026-09-20T15:${String(index).padStart(2, '0')}:00Z`, index / 20),
    ).reverse()
    anomalies.unshift(bus('other', '2026-09-20T15:30:00Z', 0.9, SIM02))
    const facts = spacecraftFacts(anomalies, SIM01)
    expect(facts.latest?.id).toBe('b14')
    expect(facts.kindLabel).toBe('Link margin drop')
    expect(facts.subsystem).toBe('Comms')
    expect(facts.symptom).toBe('link margin db drop')
    expect(facts.physicsConsistency).toBeCloseTo(0.7)
    expect(facts.trend).toHaveLength(PHYSICS_TREND_POINTS)
    expect(facts.trend[0]).toBeCloseTo(3 / 20)
    expect(facts.trend.at(-1)).toBeCloseTo(14 / 20)
  })

  it('falls back to the observables block and to the latest bus anomaly of all when no satellite is given', () => {
    const anomalies = [
      makeAnomaly('obs', {
        kind: 'bus_safe_mode',
        ts: '2026-09-20T15:05:00Z',
        payload: { satellite_id: SIM02, observables: { subsystem: 'power', physics_consistency: 0.42 } },
      }),
      makeAnomaly('storm', { kind: 'space_weather_storm', ts: '2026-09-20T15:09:00Z' }),
    ]
    const facts = spacecraftFacts(anomalies, null)
    expect(facts.satelliteId).toBe(SIM02)
    expect(facts.kindLabel).toBe('Safe mode entry')
    expect(facts.subsystem).toBe('Power')
    expect(facts.symptom).toBe('not stated')
    expect(facts.physicsConsistency).toBeCloseTo(0.42)
    expect(facts.trend).toEqual([0.42])
  })

  it('is empty with no bus anomaly', () => {
    const facts = spacecraftFacts([makeAnomaly('storm', { kind: 'space_weather_storm' })], SIM01)
    expect(facts.latest).toBeNull()
    expect(facts.trend).toEqual([])
    expect(facts.physicsConsistency).toBeNull()
  })
})

describe('environmentFacts', () => {
  it('reads the newest space-weather signal, its event label and Kp', () => {
    const facts = environmentFacts([
      makeSignal('later', { domain: 'space_weather', payload: { event_type: 'geomagnetic_storm', summary: 'storm', observables: { kp: 7.3 } } }),
      makeSignal('earlier', { domain: 'space_weather', payload: { event_type: 'quiet', summary: 'quiet' } }),
      makeSignal('bus', { domain: 'bus_health' }),
    ])
    expect(facts.signal?.id).toBe('later')
    expect(facts.eventLabel).toBe('Geomagnetic storm')
    expect(facts.kp).toBe(7.3)
    expect(environmentFacts([makeSignal('q', { domain: 'space_weather', payload: { event_type: 'quiet', summary: 'quiet' } })]).eventLabel).toBe('Quiet')
  })

  it('says so when no space-weather report arrived', () => {
    expect(environmentFacts([makeSignal('bus', { domain: 'bus_health' })])).toEqual({ signal: null, eventLabel: 'No space-weather report', kp: null })
  })
})
