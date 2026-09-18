import { describe, expect, it } from 'vitest'
import { makeAttribution, makeSignal, makeTrace } from '../test/factories'
import { DOMAINS, type Verdict } from '../types/canopy'
import {
  BUS_HEALTH_EVENT_TYPES,
  SPACE_WEATHER_EVENT_TYPES,
  commanderQuestion,
  commanderSignalSummary,
  domainLabel,
  eventTypeCopy,
  eventTypeWatchTier,
  gateReasonLabel,
  noVerdictCopy,
  parseGateRationale,
  plainEventName,
  recoveryActionLabel,
  signalKindLabel,
  spacecraftDisplayName,
  spacecraftEnvironmentFacts,
  subsystemLabel,
  traceAnnotations,
  verdictBasisCopy,
  verdictCopy,
  verdictHeadline,
  verdictLabel,
} from './commanderLanguage'

// Bus symptoms and weather are described without naming an actor; the
// fault-versus-attack call is the verdict's, not the signal copy's. The
// event-type copy added in wave 2 avoids the words outright; the wave-1
// domain-level action ("do not assume attack") is checked with the same
// named-actor rule the domain suite already applies.
const HOSTILE_WORDING = /enemy|adversary|hostile|attack|jamm|spoof/i
const NAMED_ACTOR = /enemy|adversary|hostile/i

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

describe('commanderLanguage — event-type copy for the spacecraft-environment vocabularies', () => {
  it('covers exactly the seven bus_health and four space_weather event types of the spec', () => {
    expect([...BUS_HEALTH_EVENT_TYPES]).toEqual([
      'link_margin_drop',
      'sensor_saturation',
      'attitude_disturbance',
      'unexpected_reset',
      'power_thermal_excursion',
      'orbit_decay',
      'safe_mode_entry',
    ])
    expect([...SPACE_WEATHER_EVENT_TYPES]).toEqual([
      'geomagnetic_storm',
      'solar_radio_burst',
      'radiation_enhancement',
      'density_enhancement',
    ])
  })

  const cases = [
    ...BUS_HEALTH_EVENT_TYPES.map((eventType) => ['bus_health', eventType] as const),
    ...SPACE_WEATHER_EVENT_TYPES.map(
      (eventType) => ['space_weather', eventType] as const,
    ),
  ]

  for (const [domain, eventType] of cases) {
    it(`${eventType}: label, meaning and commander question, wired through every copy surface`, () => {
      const copy = eventTypeCopy(eventType)
      expect(copy).not.toBeNull()
      if (!copy) return
      expect(copy.label).toMatch(/\S/)
      expect(copy.meaning).toMatch(/\S/)
      expect(copy.commanderQuestion).toMatch(/\?$/)
      for (const text of [copy.label, copy.meaning, copy.commanderQuestion]) {
        expect(text, eventType).not.toMatch(HOSTILE_WORDING)
      }

      const signal = makeSignal(`sig-${eventType}`, {
        domain,
        payload: { event_type: eventType, summary: `${eventType} summary` },
      })
      expect(signalKindLabel(signal)).toBe(copy.label)
      expect(plainEventName(signal)).toBe(copy.meaning)
      expect(commanderQuestion(signal)).toBe(copy.commanderQuestion)
      const summary = commanderSignalSummary(signal)
      expect(summary.label).toBe(copy.label)
      expect(summary.detail).toBe(copy.meaning)
      expect(summary.whyItMatters).toBe(copy.meaning)
      expect(summary.oneLine).toMatch(/\S/)
      expect(summary.oneLine, eventType).not.toMatch(HOSTILE_WORDING)
      expect(summary.action, eventType).not.toMatch(NAMED_ACTOR)
    })
  }

  it('leaves every other event type to the domain copy', () => {
    expect(eventTypeCopy('gps_spoof')).toBeNull()
    expect(eventTypeCopy('nominal')).toBeNull()
    expect(eventTypeCopy('quiet')).toBeNull()
    const signal = makeSignal('sig-nominal', {
      domain: 'bus_health',
      payload: { event_type: 'nominal', summary: 'all nominal' },
    })
    expect(signalKindLabel(signal)).toBe('Spacecraft health')
    expect(commanderQuestion(signal)).toBe(
      'Is this an internal fault or something acting on the satellite?',
    )
  })

  it('tiers the events as the roadmap dictates', () => {
    expect(eventTypeWatchTier('link_margin_drop')).toBe('watch')
    expect(eventTypeWatchTier('attitude_disturbance')).toBe('watch')
    expect(eventTypeWatchTier('geomagnetic_storm')).toBe('watch')
    expect(eventTypeWatchTier('unexpected_reset')).toBe('danger')
    expect(eventTypeWatchTier('safe_mode_entry')).toBe('danger')
    expect(eventTypeWatchTier('nominal')).toBe('nominal')
    expect(eventTypeWatchTier('gps_spoof')).toBe('nominal')
    for (const eventType of [...BUS_HEALTH_EVENT_TYPES, ...SPACE_WEATHER_EVENT_TYPES]) {
      expect(eventTypeWatchTier(eventType), eventType).not.toBe('nominal')
    }
  })
})

describe('commanderLanguage — one-liners and row facts from observables', () => {
  const busSignal = makeSignal('sig-bus', {
    domain: 'bus_health',
    payload: {
      event_type: 'link_margin_drop',
      summary: 'raw summary',
      asset: 'LEO-SCIENCE-1',
      observables: {
        subsystem: 'comms',
        symptom: 'link_margin_db_drop',
        rate_of_change: -0.42,
        rate_unit: 'dB/s',
        physics_consistency: 0.83,
      },
    },
  })

  const stormSignal = makeSignal('sig-storm', {
    domain: 'space_weather',
    payload: {
      event_type: 'geomagnetic_storm',
      summary: 'raw summary',
      observables: { kp: 6.33, dst_nt: -112 },
    },
  })

  it('bus_health one-liner reads asset, subsystem, rate and physics consistency', () => {
    expect(commanderSignalSummary(busSignal).oneLine).toBe(
      'LEO-SCIENCE-1: link margin drop in comms at -0.42 dB/s; physics consistency 0.83.',
    )
  })

  it('bus_health facts are subsystem, symptom and physics', () => {
    expect(spacecraftEnvironmentFacts(busSignal)).toEqual([
      { key: 'subsystem', label: 'subsystem', value: 'Comms' },
      { key: 'symptom', label: 'symptom', value: 'link margin db drop' },
      { key: 'physics', label: 'physics', value: '0.83' },
    ])
  })

  it('space_weather one-liner and facts read event type, Kp and Dst', () => {
    expect(commanderSignalSummary(stormSignal).oneLine).toBe(
      'Geomagnetic storm with Kp 6.3, Dst -112 nT; weigh environmental cause.',
    )
    expect(spacecraftEnvironmentFacts(stormSignal)).toEqual([
      { key: 'event', label: 'event', value: 'Geomagnetic storm' },
      { key: 'kp', label: 'Kp', value: '6.3' },
    ])
  })

  it('degrades gracefully without observables', () => {
    const bare = makeSignal('sig-bare', {
      domain: 'bus_health',
      payload: { event_type: 'safe_mode_entry', summary: 'raw' },
    })
    expect(commanderSignalSummary(bare).oneLine).toBe(
      'Spacecraft: safe mode entry; check spacecraft recovery.',
    )
    expect(spacecraftEnvironmentFacts(bare).map((f) => f.value)).toEqual([
      'Unknown subsystem',
      'not stated',
      'not scored',
    ])
    const quiet = makeSignal('sig-quiet', {
      domain: 'space_weather',
      payload: { event_type: 'radiation_enhancement', summary: 'raw' },
    })
    expect(commanderSignalSummary(quiet).oneLine).toBe(
      'Radiation enhancement; weigh environmental cause.',
    )
    expect(spacecraftEnvironmentFacts(quiet).map((f) => f.value)).toEqual([
      'Radiation enhancement',
      'n/a',
    ])
  })

  it('returns no facts for other domains', () => {
    expect(spacecraftEnvironmentFacts(makeSignal('sig-orbit', { domain: 'orbit' }))).toEqual([])
  })

  it('spells the spec subsystems the way operators do', () => {
    expect(subsystemLabel('adcs')).toBe('ADCS')
    expect(subsystemLabel('cdh')).toBe('C&DH')
    expect(subsystemLabel('comms')).toBe('Comms')
    expect(subsystemLabel('propulsion')).toBe('Propulsion')
    expect(subsystemLabel('star_tracker')).toBe('Star Tracker')
    expect(subsystemLabel(null)).toBe('Unknown subsystem')
  })
})

describe('commanderLanguage — verdict copy', () => {
  const verdicts: Verdict[] = [
    'internal_fault',
    'natural_external',
    'hostile_external',
    'unknown',
  ]

  it('has a distinct label and meaning for every verdict plus the absent state', () => {
    const labels = new Set(verdicts.map((v) => verdictCopy[v].label))
    labels.add(noVerdictCopy.label)
    expect(labels.size).toBe(5)
    for (const verdict of verdicts) {
      expect(verdictLabel(verdict)).toBe(verdictCopy[verdict].label)
      expect(verdictCopy[verdict].meaning).toMatch(/\S/)
    }
    expect(verdictLabel(null)).toBe('No verdict yet')
    expect(verdictLabel(undefined)).toBe('No verdict yet')
  })

  it('keeps the internal and natural verdict copy free of actor wording', () => {
    for (const verdict of ['internal_fault', 'natural_external'] as const) {
      expect(verdictCopy[verdict].meaning).not.toMatch(/enemy|adversary|hostile|attack/i)
    }
  })

  it('names both lanes', () => {
    expect(verdictBasisCopy.rule.label).toBe('Rule lane')
    expect(verdictBasisCopy.reasoning.label).toBe('Reasoning lane')
  })

  it('headlines a legacy attribution by actor and a verdict attribution by verdict', () => {
    expect(verdictHeadline(makeAttribution('a', { actor: 'Ghost Lance cell' }))).toBe(
      'Ghost Lance cell pattern under review',
    )
    expect(
      verdictHeadline(
        makeAttribution('b', {
          verdict: 'internal_fault',
          satellite_id: 'ctb://centralblue.dev/leo-science-1',
        }),
      ),
    ).toBe('Internal fault on LEO-SCIENCE-1')
    expect(verdictHeadline(makeAttribution('c', { verdict: 'natural_external' }))).toBe(
      'Natural external on the affected spacecraft',
    )
    expect(
      verdictHeadline(
        makeAttribution('d', { verdict: 'hostile_external', actor: 'Ghost Lance cell' }),
      ),
    ).toBe('Hostile external: pattern consistent with Ghost Lance cell')
  })

  it('reads the spacecraft id out of a ctb:// uri', () => {
    expect(spacecraftDisplayName('ctb://centralblue.dev/leo-science-1')).toBe(
      'LEO-SCIENCE-1',
    )
    expect(spacecraftDisplayName('SAT-BRAVO')).toBe('SAT-BRAVO')
  })
})

describe('commanderLanguage — gate and recovery copy', () => {
  it('splits a gate-prefixed rationale into reason code and text', () => {
    expect(
      parseGateRationale(
        '[gate:threat/uplink_jamming_active] Recovery withheld while jamming is active.',
      ),
    ).toEqual({
      reasonCode: 'threat/uplink_jamming_active',
      text: 'Recovery withheld while jamming is active.',
    })
    expect(parseGateRationale('plain rationale')).toEqual({
      reasonCode: null,
      text: 'plain rationale',
    })
    expect(parseGateRationale('gate: not a prefix').reasonCode).toBeNull()
  })

  it('labels the spec reason codes and title-cases unknown ones', () => {
    expect(gateReasonLabel('threat/uplink_jamming_active')).toBe('Uplink jamming active')
    expect(gateReasonLabel('threat/hostile_close_approach')).toBe('Hostile close approach')
    expect(gateReasonLabel('policy/unselectable_action')).toBe('Action not selectable')
    expect(gateReasonLabel('policy/authority_mismatch')).toBe('Authority mismatch')
    expect(gateReasonLabel('policy/thermal_limit')).toBe('Thermal Limit')
  })

  it('turns a recovery action id into a sentence-case label', () => {
    expect(recoveryActionLabel('switch_redundant_amplifier')).toBe(
      'Switch redundant amplifier',
    )
    expect(recoveryActionLabel('safe_mode')).toBe('Safe mode')
  })
})

describe('commanderLanguage — trace annotations', () => {
  it('reads verdict and physics from an attrib trace payload', () => {
    expect(
      traceAnnotations(
        makeTrace('t', {
          stage: 'attrib_reconcile',
          payload: { verdict: 'natural_external', physics_consistency: 0.41 },
        }),
      ),
    ).toEqual({ verdict: 'natural_external', physicsConsistency: 0.41, gateReasonCode: null })
  })

  it('recognises a gate block only on a decide-stage warn that starts with "gate blocked"', () => {
    expect(
      traceAnnotations(
        makeTrace('t', {
          stage: 'decide',
          level: 'warn',
          message: 'gate blocked recovery_recommendation: threat/hostile_close_approach',
        }),
      ).gateReasonCode,
    ).toBe('threat/hostile_close_approach')
    expect(
      traceAnnotations(
        makeTrace('t', { stage: 'decide', level: 'info', message: 'gate blocked x: y' }),
      ).gateReasonCode,
    ).toBeNull()
    expect(
      traceAnnotations(
        makeTrace('t', { stage: 'tools', level: 'warn', message: 'gate blocked x: y' }),
      ).gateReasonCode,
    ).toBeNull()
  })

  it('ignores malformed payload values', () => {
    expect(
      traceAnnotations(
        makeTrace('t', { payload: { verdict: 'sabotage', physics_consistency: 'high' } }),
      ),
    ).toEqual({ verdict: null, physicsConsistency: null, gateReasonCode: null })
  })
})
