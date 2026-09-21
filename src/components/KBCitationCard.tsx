import { useEventStore } from '../store/eventStore'

interface Props {
  citationId: string
}

/** One knowledge-base citation as a single line: the entry id and its title
 *  on a `<details>` toggle, the record (actor, capability, entry text and
 *  decision implications) behind it. A row of these stays one line each
 *  until the operator opens one, so the Verdict page keeps its height. */
export function KBCitationCard({ citationId }: Props) {
  const entry = useEventStore((s) => s.kb[citationId])

  if (!entry) {
    return (
      <div className="kb-card kb-card--unresolved" data-testid="kb-card" data-kb-id={citationId}>
        <div className="kb-card__head">
          <span className="kb-card__id">{citationId}</span>
          <span className="kb-card__title kb-card__title--unresolved">unresolved</span>
        </div>
      </div>
    )
  }

  return (
    <details className="kb-card" data-testid="kb-card" data-kb-id={entry.id}>
      <summary className="kb-card__head" title={entry.title}>
        <span className="kb-card__id">{entry.id}</span>
        <span className="kb-card__title">{entry.title}</span>
      </summary>
      <div className="kb-card__body">
        <div className="kb-card__meta">
          {entry.actor} · {entry.capability_type}
        </div>
        <div className="kb-card__summary">{entry.summary}</div>
        {entry.decision_implications && entry.decision_implications.length > 0 ? (
          <ul className="kb-card__implications">
            {entry.decision_implications.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </details>
  )
}
