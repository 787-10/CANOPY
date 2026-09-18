import { describe, expect, it } from 'vitest'
import { makeSignal } from '../test/factories'
import { DOMAINS } from '../types/canopy'
import { commanderSignalSummary, domainLabel } from './commanderLanguage'

describe('commanderLanguage — domain coverage', () => {
  it('has a label, action, and why-it-matters line for every domain', () => {
    for (const domain of DOMAINS) {
      const summary = commanderSignalSummary(
        makeSignal(`sig-${domain}`, { domain }),
      )
      expect(domainLabel(domain), domain).toMatch(/\S/)
      expect(summary.label, domain).toMatch(/\S/)
      expect(summary.action, domain).toMatch(/\S/)
      expect(summary.whyItMatters, domain).toMatch(/\S/)
      expect(summary.oneLine, domain).toMatch(/\S/)
    }
  })

  it('labels the two spacecraft-environment domains in plain language', () => {
    expect(domainLabel('bus_health')).toBe('Spacecraft health')
    expect(domainLabel('space_weather')).toBe('Space weather')
  })

  it('does not name a hostile actor in bus-health or space-weather copy', () => {
    for (const domain of ['bus_health', 'space_weather'] as const) {
      const summary = commanderSignalSummary(makeSignal(`sig-${domain}`, { domain }))
      expect(summary.action).not.toMatch(/enemy|adversary|hostile/i)
      expect(summary.whyItMatters).not.toMatch(/enemy|adversary|hostile/i)
    }
  })
})
