import { describe, expect, it } from 'vitest'
import { BELIEF_BASIS, HOSTILE_BELIEF_BASIS } from '../test/factories'
import { causeLabel, causeSide, parsePhysicsBasis, rateMethodLabel } from './physicsBasis'

describe('parsePhysicsBasis — belief form (docs/INTERFACE-SPEC.md §3)', () => {
  it('reads the masses, the top cause and the shape fields', () => {
    const basis = parsePhysicsBasis(BELIEF_BASIS)
    expect(basis).not.toBeNull()
    expect(basis!.kind).toBe('belief')
    expect(basis!.internal).toBe(0.81)
    expect(basis!.external).toBe(0.08)
    expect(basis!.unknown).toBe(0.1)
    expect(basis!.top).toEqual({ id: 'amplifier_degradation', mass: 0.75, side: 'internal' })
    expect(basis!.wBelief).toBe(0.6)
    expect(basis!.shape).toBe('ramp')
    expect(basis!.shapeSupport).toBe(0.8)
    expect(basis!.fitQuality).toBe(1)
    expect(basis!.row).toBe('link_margin_drop')
    expect(basis!.rate).toBe('slope')
    expect(basis!.extra).toEqual({})
  })

  it('marks an external top cause by its name and by the mass split', () => {
    const basis = parsePhysicsBasis(HOSTILE_BELIEF_BASIS)!
    expect(basis.top).toEqual({ id: 'uplink_interference', mass: 0.56, side: 'external' })
    expect(basis.rate).toBe('step_per_interval')
    // An unrecognised cause id follows the mass when nearly all of it is external.
    expect(
      causeSide('mystery_cause', { internal: 0.1, external: 0.85, unknown: 0.05 }),
    ).toBe('external')
    expect(
      causeSide('mystery_cause', { internal: 0.6, external: 0.3, unknown: 0.1 }),
    ).toBe('internal')
    expect(causeSide('unknown', { internal: null, external: null, unknown: null })).toBe('unknown')
  })

  it('parses the spec example with the reaction wheel cause', () => {
    const basis = parsePhysicsBasis(
      'belief:internal=0.93;external=0.06;unknown=0.00;top=reaction_wheel_friction:0.93;w_belief=0.60;shape=drift;shape_support=0.85;fit_quality=1.00;row=link_margin_drop;rate=slope',
    )!
    expect(basis.top?.id).toBe('reaction_wheel_friction')
    expect(basis.top?.side).toBe('internal')
    expect(basis.unknown).toBe(0)
    expect(basis.shape).toBe('drift')
  })

  it('keeps unknown key=value pairs in extra', () => {
    const basis = parsePhysicsBasis('belief:internal=0.5;external=0.5;future_key=abc')!
    expect(basis.extra).toEqual({ future_key: 'abc' })
    expect(basis.unknown).toBeNull()
    expect(basis.top).toBeNull()
  })
})

describe('parsePhysicsBasis — shape form and non-basis input', () => {
  it('reads a shape-only basis with no masses', () => {
    const basis = parsePhysicsBasis(
      'shape:shape=ramp;shape_support=0.80;fit_quality=1.00;row=link_margin_drop;rate=slope',
    )!
    expect(basis.kind).toBe('shape')
    expect(basis.internal).toBeNull()
    expect(basis.external).toBeNull()
    expect(basis.top).toBeNull()
    expect(basis.shape).toBe('ramp')
    expect(basis.shapeSupport).toBe(0.8)
  })

  it('returns null for anything that is not a basis string', () => {
    expect(parsePhysicsBasis(undefined)).toBeNull()
    expect(parsePhysicsBasis(null)).toBeNull()
    expect(parsePhysicsBasis(42)).toBeNull()
    expect(parsePhysicsBasis('placeholder')).toBeNull()
    expect(parsePhysicsBasis('')).toBeNull()
  })

  it('labels causes and rate methods for operators', () => {
    expect(causeLabel('amplifier_degradation')).toBe('Amplifier degradation')
    expect(causeLabel('uplink-interference')).toBe('Uplink interference')
    expect(rateMethodLabel('step_per_interval')).toBe('step per interval')
    expect(rateMethodLabel(null)).toBeNull()
  })
})
