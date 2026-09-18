// Parser for the bus_health `physics_basis` observable
// (docs/INTERFACE-SPEC.md §3). Two formats:
//
//   belief:internal=0.93;external=0.06;unknown=0.00;top=reaction_wheel_friction:0.93;
//          w_belief=0.60;shape=drift;shape_support=0.85;fit_quality=1.00;
//          row=link_margin_drop;rate=slope
//   shape:shape=ramp;shape_support=0.80;fit_quality=1.00;row=link_margin_drop;rate=slope
//
// The `belief:` form carries the internal/external/unknown masses and the
// top cause; the `shape:` form is what the scorer emits when no belief was
// available. Every field is optional on the way out so a partial or future
// basis string still renders what it does carry.

export type PhysicsBasisKind = 'belief' | 'shape'

export type PhysicsBasisCause = {
  /** Cause id as the scorer spelled it, e.g. `amplifier_degradation`. */
  id: string
  /** Posterior mass 0..1. */
  mass: number
  /** Which mass bucket the cause belongs to when it is inferable. */
  side: 'internal' | 'external' | 'unknown'
}

export type PhysicsBasis = {
  kind: PhysicsBasisKind
  internal: number | null
  external: number | null
  unknown: number | null
  top: PhysicsBasisCause | null
  wBelief: number | null
  shape: string | null
  shapeSupport: number | null
  fitQuality: number | null
  row: string | null
  rate: string | null
  /** Any `key=value` pair the parser did not recognise. */
  extra: Record<string, string>
}

// Cause ids the diagnosis side names for external effects. Anything else
// with a belief prefix is treated as an onboard (internal) cause; the
// masses decide the verdict, this only picks the colour of the chip.
const EXTERNAL_CAUSE_HINTS = [
  'interference',
  'jamming',
  'jam',
  'storm',
  'geomagnetic',
  'radiation',
  'drag',
  'density',
  'solar',
  'external',
  'rpo',
  'close_approach',
  'spoof',
]

const numberField = (value: string | undefined): number | null => {
  if (value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function causeSide(
  causeId: string,
  masses: { internal: number | null; external: number | null; unknown: number | null },
): PhysicsBasisCause['side'] {
  const lower = causeId.toLowerCase()
  if (lower === 'unknown' || lower === 'unexplained') return 'unknown'
  if (EXTERNAL_CAUSE_HINTS.some((hint) => lower.includes(hint))) return 'external'
  if (
    masses.internal !== null &&
    masses.external !== null &&
    masses.external > masses.internal &&
    masses.internal < 0.2
  ) {
    // The scorer only names one top cause; when nearly all of the mass is
    // external and the cause id is not recognisably onboard, follow the mass.
    return 'external'
  }
  return 'internal'
}

/** `physics_basis` -> structured basis, or null when the string is not a
 *  basis at all (no `belief:` or `shape:` prefix). */
export function parsePhysicsBasis(basis: unknown): PhysicsBasis | null {
  if (typeof basis !== 'string') return null
  const trimmed = basis.trim()
  const match = trimmed.match(/^(belief|shape):(.*)$/s)
  if (!match) return null
  const kind = match[1] as PhysicsBasisKind
  const fields: Record<string, string> = {}
  for (const pair of match[2].split(';')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    fields[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
  }

  const internal = numberField(fields.internal)
  const external = numberField(fields.external)
  const unknown = numberField(fields.unknown)
  const masses = { internal, external, unknown }

  let top: PhysicsBasisCause | null = null
  if (fields.top) {
    const colon = fields.top.lastIndexOf(':')
    const id = colon > 0 ? fields.top.slice(0, colon) : fields.top
    const mass = colon > 0 ? numberField(fields.top.slice(colon + 1)) : null
    if (id) {
      top = { id, mass: mass ?? 0, side: causeSide(id, masses) }
    }
  }

  const known = new Set([
    'internal',
    'external',
    'unknown',
    'top',
    'w_belief',
    'shape',
    'shape_support',
    'fit_quality',
    'row',
    'rate',
  ])
  const extra = Object.fromEntries(
    Object.entries(fields).filter(([key]) => !known.has(key)),
  )

  return {
    kind,
    internal,
    external,
    unknown,
    top,
    wBelief: numberField(fields.w_belief),
    shape: fields.shape ?? null,
    shapeSupport: numberField(fields.shape_support),
    fitQuality: numberField(fields.fit_quality),
    row: fields.row ?? null,
    rate: fields.rate ?? null,
    extra,
  }
}

/** `amplifier_degradation` -> `Amplifier degradation`. */
export function causeLabel(causeId: string): string {
  const spaced = causeId.replaceAll(/[-_]+/g, ' ').trim()
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : causeId
}

/** `slope` -> `slope`, `step_per_interval` -> `step per interval`. */
export function rateMethodLabel(rate: string | null): string | null {
  return rate ? rate.replaceAll('_', ' ') : null
}
