import { useEventStore } from "../store/eventStore";

interface Props {
  citationId: string;
}

export function KBCitationCard({ citationId }: Props) {
  const entry = useEventStore((s) => s.kb[citationId]);

  if (!entry) {
    return (
      <div className="kb-card">
        <div className="kb-card__head">
          <span className="kb-card__id">{citationId}</span>
          <span>unresolved</span>
        </div>
      </div>
    );
  }

  return (
    <div className="kb-card">
      <div className="kb-card__head">
        <span className="kb-card__id">{entry.id}</span>
        <span>
          {entry.actor} · {entry.capability_type}
        </span>
      </div>
      <div className="kb-card__title">{entry.title}</div>
      {/* The entry text is the record behind the citation; it opens on demand
          so the card reads as one line until the operator wants the detail. */}
      <details className="kb-card__more">
        <summary>Entry text</summary>
        <div className="kb-card__summary">{entry.summary}</div>
        {entry.decision_implications && entry.decision_implications.length > 0 ? (
          <ul className="kb-card__implications">
            {entry.decision_implications.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        ) : null}
      </details>
    </div>
  );
}
