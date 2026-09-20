import { causeLabel, type PhysicsBasis } from '../../lib/physicsBasis'

const pct = (value: number | null) =>
  value === null ? '--' : `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`

type BeliefBarProps = {
  basis: PhysicsBasis | null
  physicsConsistency: number | null
}

/** Belief masses from `physics_basis`: onboard (internal) causes against
 *  external ones, the unexplained remainder, and the scorer's top cause. */
export function BeliefBar({ basis, physicsConsistency }: BeliefBarProps) {
  if (!basis) {
    return (
      <div className="belief belief--empty" data-testid="belief-bar" data-kind="none">
        No physics basis on the latest record.
      </div>
    )
  }
  const rows: Array<{
    key: 'internal' | 'external' | 'unknown'
    label: string
    value: number | null
    cause: string | null
  }> = [
    {
      key: 'internal',
      label: 'Onboard cause',
      value: basis.internal,
      cause: basis.top?.side === 'internal' ? basis.top.id : null,
    },
    {
      key: 'external',
      label: 'External cause',
      value: basis.external,
      cause: basis.top?.side === 'external' ? basis.top.id : null,
    },
    {
      key: 'unknown',
      label: 'Unexplained',
      value: basis.unknown,
      cause: null,
    },
  ]

  return (
    <div className="belief" data-testid="belief-bar" data-kind={basis.kind}>
      {basis.kind === 'belief' ? (
        <>
          <ul className="belief__rows" aria-label={`internal ${pct(basis.internal)}, external ${pct(basis.external)}, unknown ${pct(basis.unknown)}`}>
            {rows.map((row) => (
              <li key={row.key} className={`belief__row belief__row--${row.key}`} data-testid={`belief-${row.key}`}>
                <span className="belief__row-label">{row.label}</span>
                <span className="belief__row-bar">
                  <i style={{ width: pct(row.value) === '--' ? 0 : pct(row.value) }} />
                </span>
                <strong>{pct(row.value)}</strong>
                {row.cause ? <em>{causeLabel(row.cause)}</em> : null}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="belief__note">
          Shape evidence only ({basis.shape ?? 'unknown shape'}); no belief was available.
        </p>
      )}
      <dl className="belief__facts">
        {basis.top ? (
          <div>
            <dt>Top cause</dt>
            <dd data-testid="belief-top" className={`belief__cause belief__cause--${basis.top.side}`}>
              {causeLabel(basis.top.id)} · {pct(basis.top.mass)}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Physics consistency</dt>
          <dd data-testid="belief-physics">
            {physicsConsistency === null ? 'not scored' : physicsConsistency.toFixed(2)}
          </dd>
        </div>
        {basis.shape ? (
          <div>
            <dt>Shape</dt>
            <dd>
              {basis.shape}
              {basis.shapeSupport !== null ? ` · support ${basis.shapeSupport.toFixed(2)}` : ''}
              {basis.fitQuality !== null ? ` · fit ${basis.fitQuality.toFixed(2)}` : ''}
            </dd>
          </div>
        ) : null}
        {basis.wBelief !== null ? (
          <div>
            <dt>Belief weight</dt>
            <dd>{basis.wBelief.toFixed(2)}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  )
}
