// @vitest-environment node
/// <reference types="node" />
//
// The marking grammar and combination rule live in
// canopy/services/schemas/events.py (docs/INTERFACE-SPEC.md §1.1) and are
// mirrored in lib/marking.ts. The last test reads the Python file from disk
// so the category grammar cannot drift silently.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  MARKING_CATEGORY,
  isValidMarking,
  markingCategories,
  mostRestrictiveMarking,
  validateMarking,
} from './marking'

const EVENTS_PY = fileURLToPath(
  new URL('../../canopy/services/schemas/events.py', import.meta.url),
)

describe('marking grammar', () => {
  it.each(['U', 'CUI', 'CUI//SP-A', 'CUI//SP-A/SP-B', 'CUI//SP-B/SP-A', 'CUI//SP-A-1/SP-B2'])(
    'accepts %s',
    (marking) => {
      expect(isValidMarking(marking)).toBe(true)
      expect(validateMarking(marking)).toBe(marking)
    },
  )

  it.each([
    'u',
    'cui',
    'CUI//',
    'CUI//SP-',
    'CUI//SP-a',
    'CUI/SP-A',
    'CUI//SP-A/',
    'CUI//SP-A/SP-A',
    '',
    ' U',
    'U ',
    'SECRET',
  ])('rejects %j', (marking) => {
    expect(isValidMarking(marking)).toBe(false)
    expect(() => validateMarking(marking)).toThrow(/marking/)
  })

  it('rejects non-strings', () => {
    expect(isValidMarking(1)).toBe(false)
    expect(isValidMarking(null)).toBe(false)
    expect(isValidMarking(undefined)).toBe(false)
  })

  it('lists the specified categories sorted, none for U and CUI', () => {
    expect(markingCategories('U')).toEqual([])
    expect(markingCategories('CUI')).toEqual([])
    expect(markingCategories('CUI//SP-B/SP-A')).toEqual(['A', 'B'])
  })
})

describe('mostRestrictiveMarking', () => {
  it('gives U for no inputs and for the default (missing) marking', () => {
    expect(mostRestrictiveMarking([])).toBe('U')
    expect(mostRestrictiveMarking([undefined, null])).toBe('U')
    expect(mostRestrictiveMarking(['U', undefined, 'U'])).toBe('U')
  })

  it('orders U < CUI < CUI//SP-*', () => {
    expect(mostRestrictiveMarking(['U', 'CUI'])).toBe('CUI')
    expect(mostRestrictiveMarking(['CUI', 'U'])).toBe('CUI')
    expect(mostRestrictiveMarking(['CUI', 'CUI//SP-A'])).toBe('CUI//SP-A')
    expect(mostRestrictiveMarking(['CUI//SP-A', 'U', 'CUI'])).toBe('CUI//SP-A')
  })

  it('combines specified categories as a sorted union', () => {
    expect(mostRestrictiveMarking(['CUI//SP-B', 'CUI//SP-A'])).toBe('CUI//SP-A/SP-B')
    expect(mostRestrictiveMarking(['CUI//SP-B/SP-A', 'CUI//SP-C', 'CUI//SP-A'])).toBe(
      'CUI//SP-A/SP-B/SP-C',
    )
    expect(mostRestrictiveMarking(['CUI//SP-A', 'CUI//SP-A'])).toBe('CUI//SP-A')
  })

  it('validates every input rather than guessing at a malformed one', () => {
    expect(() => mostRestrictiveMarking(['U', 'secret'])).toThrow(/marking/)
    expect(() => mostRestrictiveMarking(['CUI//SP-A/SP-A'])).toThrow(/marking/)
  })
})

describe('parity with events.py', () => {
  it('uses the same category grammar as the Python validator', () => {
    const source = readFileSync(EVENTS_PY, 'utf8')
    const match = /^_CATEGORY = r"([^"]+)"/m.exec(source)
    expect(match, `no _CATEGORY in ${EVENTS_PY}`).not.toBeNull()
    expect(MARKING_CATEGORY).toBe(match![1])
  })
})
