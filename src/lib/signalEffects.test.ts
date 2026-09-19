import { describe, expect, it } from 'vitest'
import { makeSignal } from '../test/factories'
import { DOMAINS } from '../types/canopy'
import { latestReport, signalEffectLabel, signalEffectState } from './signalEffects'

describe('signalEffects — domain coverage', () => {
  it('returns a non-empty label for every domain in the vocabulary', () => {
    for (const domain of DOMAINS) {
      const label = signalEffectLabel(makeSignal(`sig-${domain}`, { domain }))
      expect(label, domain).toMatch(/\S/)
    }
  })

  it('reads bus health as spacecraft health and space weather as environment', () => {
    expect(signalEffectLabel(makeSignal('a', { domain: 'bus_health' }))).toBe(
      'Spacecraft health change',
    )
    expect(
      signalEffectLabel(makeSignal('b', { domain: 'space_weather' })),
    ).toBe('Space weather activity')
  })

  it('treats an unknown low-confidence event in a new domain as nominal', () => {
    const signal = makeSignal('c', {
      domain: 'bus_health',
      confidence: 0.5,
      payload: { event_type: 'nominal', summary: 'nominal' },
    })
    expect(signalEffectState(signal)).toBe('nominal')
  })
})

describe('latestReport — the alert card skips quiet placeholders', () => {
  const quiet = makeSignal('wx-quiet', {
    domain: 'space_weather',
    payload: { event_type: 'quiet', summary: 'quiet', observables: {} },
  })
  const nominal = makeSignal('bus-nominal', {
    domain: 'bus_health',
    payload: { event_type: 'nominal', summary: 'nominal', observables: {} },
  })
  const drop = makeSignal('bus-drop', {
    domain: 'bus_health',
    payload: { event_type: 'link_margin_drop', summary: 'drop', observables: {} },
  })

  it('returns the newest non-quiet report when the stream ends on a quiet record', () => {
    expect(latestReport([quiet, nominal, drop])).toBe(drop)
  })

  it('falls back to the newest signal when every record is quiet', () => {
    expect(latestReport([quiet, nominal])).toBe(quiet)
    expect(latestReport([])).toBeNull()
  })
})
