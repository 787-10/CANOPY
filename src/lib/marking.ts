// Marking (docs/INTERFACE-SPEC.md §1.1, spec 1.4). Mirrors `validate_marking`
// and `most_restrictive` in canopy/services/schemas/events.py so the console
// combines markings exactly as the engine does: `U` < `CUI` < `CUI//SP-*`;
// specified categories combine as a sorted union joined by `/`; no inputs
// give `U`. Nothing acts on the marking; the console displays it.
// `marking.test.ts` checks the category grammar against the Python file.

export const MARKING_UNCLASSIFIED = 'U'
export const MARKING_CUI = 'CUI'

const SP_PREFIX = 'CUI//SP-'
/** One specified category: uppercase letters, digits and hyphens. */
export const MARKING_CATEGORY = '[A-Z0-9][A-Z0-9-]*'
export const MARKING_PATTERN = new RegExp(
  `^(U|CUI|CUI//SP-${MARKING_CATEGORY}(/SP-${MARKING_CATEGORY})*)$`,
)

/** The specified categories of a marking, sorted; empty for `U` and `CUI`. */
export function markingCategories(marking: string): string[] {
  if (!marking.startsWith(SP_PREFIX)) return []
  return marking
    .slice('CUI//'.length)
    .split('/')
    .map((part) => part.slice('SP-'.length))
    .sort()
}

/** True for a well-formed marking: the grammar above with no repeated category. */
export function isValidMarking(value: unknown): value is string {
  if (typeof value !== 'string' || !MARKING_PATTERN.test(value)) return false
  const categories = markingCategories(value)
  return new Set(categories).size === categories.length
}

/** `value` when it is a well-formed marking; throws otherwise. */
export function validateMarking(value: unknown): string {
  if (!isValidMarking(value)) {
    throw new Error(
      `marking ${JSON.stringify(value)} must be U, CUI or ` +
        'CUI//SP-<CATEGORY>[/SP-<CATEGORY>...] with no repeated category',
    )
  }
  return value
}

/**
 * The marking a derivation of `markings` must carry: never lower than the
 * most restrictive input. `undefined` and `null` stand for the default `U`
 * (fixtures predate the field); a malformed string throws, as the engine's
 * validator does, so a bad value is never displayed as something milder.
 */
export function mostRestrictiveMarking(
  markings: Iterable<string | null | undefined>,
): string {
  let level = 0
  const categories = new Set<string>()
  for (const raw of markings) {
    if (raw === undefined || raw === null) continue
    const marking = validateMarking(raw)
    if (marking === MARKING_UNCLASSIFIED) continue
    if (marking === MARKING_CUI) {
      level = Math.max(level, 1)
      continue
    }
    level = 2
    for (const category of markingCategories(marking)) categories.add(category)
  }
  if (level === 0) return MARKING_UNCLASSIFIED
  if (level === 1) return MARKING_CUI
  return (
    'CUI//' +
    [...categories]
      .sort()
      .map((category) => `SP-${category}`)
      .join('/')
  )
}
