import { describe, expect, it } from 'vitest'
import { makeSignal } from '../test/factories'
import { DOMAINS } from '../types/canopy'
import { signalEffectLabel, signalEffectState } from './signalEffects'

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
