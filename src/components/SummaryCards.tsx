import { commanderSignalSummary, recoveryActionLabel, signalKindLabel, verdictCopy, verdictHeadline, withheldRecoveryLabel } from '../lib/commanderLanguage'
import { spacecraftEnvironmentFacts } from '../lib/commanderLanguage'
import { actionLabel } from '../lib/actionLabels'
import { withCapture } from '../store/captureStore'
import { useEventStore } from '../store/eventStore'
import type { Attribution, Decision, Signal } from '../types/canopy'

const formatTime = (ts: string) =>
  new Date(ts).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** Verdict in four lines with a link to the full page. */
export function VerdictSummaryCard({ attribution }: { attribution: Attribution | null }) {
  const verdict = attribution?.verdict ?? null
  const copy = verdict ? verdictCopy[verdict] : null
  const actor = attribution?.actor
  const showActor = actor && actor !== 'None' && actor !== 'Unknown'
  return (
    <section
      className={`summary-card summary-card--verdict${verdict ? ` summary-card--${verdict}` : ''}`}
      aria-labelledby="summary-verdict-title"
      data-testid="verdict-summary"
      data-verdict={verdict ?? 'absent'}
      data-provisional={attribution?.provisional ? 'true' : undefined}
    >
      <header className="summary-card__head">
        <h2 id="summary-verdict-title">Verdict</h2>
        <a className="summary-card__link" href={withCapture('/verdict')}>Full verdict →</a>
      </header>
      {attribution && copy ? (
        <>
          <p className="summary-card__lead">
            <span className={`summary-card__badge summary-card__badge--${verdict}`}>{copy.label}</span>
            <span className="summary-card__confidence">{Math.round(attribution.confidence * 100)}% confidence</span>
            {attribution.provisional ? <span className="summary-card__flag">provisional</span> : null}
          </p>
          <p className="summary-card__text">{verdictHeadline(attribution)}</p>
          {showActor ? (
            <p className="summary-card__kv"><span>Actor</span><strong>{actor}</strong></p>
          ) : null}
        </>
      ) : (
        <p className="summary-card__text summary-card__text--muted">The fast lane publishes a provisional verdict at the first anomalous report.</p>
      )}
    </section>
  )
}

/** The decision in four lines, Accept and Deny, and a link to the detail. */
export function DecisionSummaryCard({ decision }: { decision: Decision | null }) {
  const accepted = useEventStore((s) => (decision ? s.acceptedDecisionIds.has(decision.id) : false))
  const denied = useEventStore((s) => (decision ? s.deferredDecisionIds.has(decision.id) : false))
  const acceptDecision = useEventStore((s) => s.acceptDecision)
  const deferDecision = useEventStore((s) => s.deferDecision)
  const clearDecisionStatus = useEventStore((s) => s.clearDecisionStatus)
  const withheld = decision?.withheld_recovery ?? null
  const recovery = decision?.recovery ?? null
  const kind = !decision
    ? null
    : withheld
      ? 'Recovery withheld'
      : decision.action === 'recovery_recommendation'
        ? 'Recovery recommendation'
        : 'Defensive response'
  return (
    <section className={`summary-card summary-card--decision${withheld ? ' summary-card--withheld' : ''}`} aria-labelledby="summary-decision-title" data-testid="decision-summary">
      <header className="summary-card__head">
        <h2 id="summary-decision-title">Decision</h2>
        <a className="summary-card__link" href={withCapture('/verdict')}>Details →</a>
      </header>
      {decision ? (
        <>
          <p className="summary-card__eyebrow">{kind}</p>
          <p className="summary-card__lead"><strong className="summary-card__action">{actionLabel(decision.action)}</strong></p>
          <p className="summary-card__kv"><span>Authority</span><strong>{decision.authority}</strong><span>Target</span><strong>{decision.target}</strong></p>
          {withheld ? (
            <p className="summary-card__withheld" data-testid="summary-withheld">{withheldRecoveryLabel(withheld)}</p>
          ) : recovery ? (
            <p className="summary-card__text">
              {recoveryActionLabel(recovery.action_id)}
              {recovery.requires_approval ? ' · operator approval required' : ' · no approval required'}
            </p>
          ) : null}
          {accepted || denied ? (
            <p className="summary-card__resolved">
              <span>{accepted ? 'Accepted' : 'Denied'}</span>
              <button type="button" className="summary-card__button summary-card__button--quiet" onClick={() => clearDecisionStatus(decision.id)}>Reconsider</button>
            </p>
          ) : (
            <p className="summary-card__buttons">
              <button type="button" className="summary-card__button summary-card__button--accept" onClick={() => acceptDecision(decision.id)}>Accept</button>
              <button type="button" className="summary-card__button summary-card__button--deny" onClick={() => deferDecision(decision.id)}>Deny</button>
            </p>
          )}
        </>
      ) : (
        <p className="summary-card__text summary-card__text--muted">The decision follows the verdict: a recovery on the spacecraft, or a defensive response with its authority.</p>
      )}
    </section>
  )
}

/** The newest few reports in large type, with a link to the full list. */
export function LatestReports({ signals, limit = 4 }: { signals: Signal[]; limit?: number }) {
  const rows = signals.slice(0, limit)
  return (
    <section className="summary-card summary-card--reports" aria-labelledby="summary-reports-title" data-testid="latest-reports">
      <header className="summary-card__head">
        <h2 id="summary-reports-title">Latest reports</h2>
        <a className="summary-card__link" href={withCapture('/signals')}>All {signals.length} signals →</a>
      </header>
      {rows.length ? (
        <ol className="reports">
          {rows.map((signal) => {
            const summary = commanderSignalSummary(signal)
            const physics = spacecraftEnvironmentFacts(signal).find((fact) => fact.key === 'physics')
            return (
              <li key={signal.id} className={`reports__row reports__row--${signal.domain}`} data-domain={signal.domain}>
                <a href={withCapture(`/signal?id=${encodeURIComponent(signal.id)}`)} className="reports__link">
                  <span className="reports__time">{formatTime(signal.ts)}</span>
                  <span className="reports__kind">{signalKindLabel(signal)}</span>
                  <span className="reports__summary">{summary.oneLine}</span>
                  {physics ? <span className="reports__physics">physics {physics.value}</span> : null}
                </a>
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="summary-card__text summary-card__text--muted">Waiting for signals.</p>
      )}
    </section>
  )
}
