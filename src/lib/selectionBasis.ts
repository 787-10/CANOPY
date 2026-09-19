import { actionLabel } from './actionLabels'
import { gateReasonLabel } from './commanderLanguage'
import type { Decision } from '../types/canopy'

// Spec 1.4 bounded response (docs/INTERFACE-SPEC.md §6): the closed
// `selection_basis` vocabulary set by canopy/services/decide. A gate block
// carries its reason code after the prefix.
export const SELECTION_BASES = [
  'recovery-routed',
  'model-within-set',
  'model-outside-set-repaired',
] as const
export const GATE_WITHHELD_PREFIX = 'gate-withheld:'

const BASIS_LABELS: Record<(typeof SELECTION_BASES)[number], string> = {
  'recovery-routed': 'recovery routed by the decision rule',
  'model-within-set': 'model choice within the approved set',
  'model-outside-set-repaired': 'model choice outside the set, repaired',
}

/** Plain-language label for a `selection_basis` value; a gate block reads
 *  as "gate withheld: <reason label>"; an unknown value is shown as is. */
export function selectionBasisLabel(basis: string): string {
  if (basis.startsWith(GATE_WITHHELD_PREFIX)) {
    return `gate withheld: ${gateReasonLabel(basis.slice(GATE_WITHHELD_PREFIX.length))}`
  }
  return (BASIS_LABELS as Record<string, string | undefined>)[basis] ?? basis
}

export type SelectionSummary = {
  count: number
  /** Action labels in menu order, comma separated; empty when the set is empty. */
  options: string
  basis: string | null
}

/** The set and basis of a decision, ready to render; null when the decision
 *  predates spec 1.4 and carries neither field. */
export function selectionSummary(decision: Decision): SelectionSummary | null {
  const set = decision.selectable_set ?? null
  const basis = decision.selection_basis ?? null
  if (set === null && basis === null) {
    return null
  }
  const options = set ?? []
  return {
    count: options.length,
    options: options.map((action) => actionLabel(action)).join(', '),
    basis: basis ? selectionBasisLabel(basis) : null,
  }
}

/** "Selected from N options: a, b, c" (or without the list). */
export function selectionSentence(
  summary: SelectionSummary,
  { options = true }: { options?: boolean } = {},
): string {
  const noun = summary.count === 1 ? 'option' : 'options'
  const head = `Selected from ${summary.count} ${noun}`
  return options && summary.options ? `${head}: ${summary.options}` : head
}
