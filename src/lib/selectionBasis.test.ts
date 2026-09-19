import { describe, expect, it } from 'vitest'
import { makeDecision } from '../test/factories'
import {
  GATE_WITHHELD_PREFIX,
  SELECTION_BASES,
  selectionBasisLabel,
  selectionSentence,
  selectionSummary,
} from './selectionBasis'

describe('selectionBasis (spec 1.4 bounded response)', () => {
  it('labels every basis in the vocabulary and a gate block by its reason', () => {
    for (const basis of SELECTION_BASES) {
      expect(selectionBasisLabel(basis)).not.toBe(basis)
    }
    expect(selectionBasisLabel(`${GATE_WITHHELD_PREFIX}threat/uplink_jamming_active`)).toBe(
      'gate withheld: Active jamming detected',
    )
    expect(selectionBasisLabel('something-new')).toBe('something-new')
  })

  it('summarises the set with action labels and pluralises the count', () => {
    const summary = selectionSummary(
      makeDecision('d', {
        selectable_set: ['passive_defense', 'threat_warning'],
        selection_basis: 'model-within-set',
      }),
    )
    expect(summary).toEqual({
      count: 2,
      options: 'Passive defense, Threat warning',
      basis: 'model choice within the approved set',
    })
    expect(selectionSentence(summary!)).toBe('Selected from 2 options: Passive defense, Threat warning')
    expect(selectionSentence(summary!, { options: false })).toBe('Selected from 2 options')
    const single = selectionSummary(
      makeDecision('g', { selectable_set: ['threat_warning'], selection_basis: 'gate-withheld:policy/unselectable_action' }),
    )
    expect(selectionSentence(single!)).toBe('Selected from 1 option: Threat warning')
  })

  it('returns null for a decision recorded before spec 1.4', () => {
    expect(selectionSummary(makeDecision('old'))).toBeNull()
    expect(selectionSummary(makeDecision('nulls', { selectable_set: null, selection_basis: null }))).toBeNull()
  })
})
