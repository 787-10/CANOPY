import {
  gateReasonLabel,
  parseGateRationale,
  recoveryActionLabel,
  verdictCopy,
  verdictHeadline,
  withheldRecoveryLabel,
} from '../lib/commanderLanguage'
import { actionLabel } from '../lib/actionLabels'
import {
  ACCEPT_LOCKED_TITLE,
  STALE_DECISION_FLAG,
  acceptIsLocked,
  STALE_DECISION_TITLE,
  decisionIsStale,
  operatorOutcome,
  operatorStamps,
  recordOperatorDecision,
} from '../lib/operatorDecisions'
import { selectionSentence, selectionSummary } from '../lib/selectionBasis'
import { targetLabel } from '../lib/targetLabel'
import { withCapture } from '../store/captureStore'
import { useEventStore } from '../store/eventStore'
import type { Attribution, Decision } from '../types/canopy'

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/** Verdict in a few lines: the badge, a confidence bar, the headline and
 *  the actor when one is named, with a link to the full page. The revision
 *  and the timing are on the status line above; the card does not repeat
 *  them. */
export function VerdictSummaryCard({ attribution }: { attribution: Attribution | null }) {
  const verdict = attribution?.verdict ?? null
  const copy = verdict ? verdictCopy[verdict] : null
  const actor = attribution?.actor
  const showActor = actor && actor !== 'None' && actor !== 'Unknown'
  const confidence = attribution ? Math.round(clamp01(attribution.confidence) * 100) : 0
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
            <span className="summary-card__confidence">{confidence}% confidence</span>
            {attribution.provisional ? <span className="summary-card__flag">provisional</span> : null}
          </p>
          <div
            className="summary-card__bar"
            role="meter"
            aria-label="Confidence"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={confidence}
            data-testid="summary-confidence-bar"
          >
            <span className="summary-card__bar-fill" style={{ width: `${confidence}%` }} />
          </div>
          <p className="summary-card__text">{verdictHeadline(attribution)}</p>
          {showActor ? (
            <p className="summary-card__kv summary-card__kv--wide" data-testid="summary-actor">
              <span>Actor</span>
              <strong>{actor}</strong>
            </p>
          ) : null}
        </>
      ) : (
        <p className="summary-card__text summary-card__text--muted">The fast lane publishes a provisional verdict at the first anomalous report.</p>
      )}
    </section>
  )
}

type DecisionSummaryCardProps = {
  decision: Decision | null
  /** Revision of the episode attribution the card sits beside. A decision
   *  made for an earlier revision is flagged as based on the provisional
   *  verdict, and a recovery stays unacceptable until the decide stage
   *  catches up (C21). */
  attributionRevision?: number | null
  /** Render the Accept / Deny buttons. The overview passes `false`: the
   *  OperatorActionPanel above the card carries them. */
  actions?: boolean
}

/** The decision in a few lines: the action, its authority and target, the
 *  gate state and the selection basis in words, the withheld or routed
 *  recovery, and a link to the reasoning trace. */
export function DecisionSummaryCard({
  decision,
  attributionRevision = null,
  actions = true,
}: DecisionSummaryCardProps) {
  const accepted = useEventStore((s) => (decision ? s.acceptedDecisionIds.has(decision.id) : false))
  const denied = useEventStore((s) => (decision ? s.deferredDecisionIds.has(decision.id) : false))
  const statusAt = useEventStore((s) => (decision ? s.decisionStatusAt[decision.id] : undefined))
  const scenarioAt = useEventStore((s) => (decision ? s.decisionStatusScenarioAt[decision.id] : undefined))
  const withheld = decision?.withheld_recovery ?? null
  const recovery = decision?.recovery ?? null
  const selection = decision ? selectionSummary(decision) : null
  const gate = decision ? parseGateRationale(decision.rationale) : null
  const stale = decisionIsStale(decision, attributionRevision)
  const acceptLocked = acceptIsLocked(decision, attributionRevision)
  const gateState = !gate
    ? null
    : gate.reasonCode
      ? `Gate blocked: ${gateReasonLabel(gate.reasonCode)}`
      : 'Gate clear'
  // A gate-withheld basis repeats the gate line; keep the other bases.
  const basis = selection?.basis && !selection.basis.startsWith('gate withheld') ? selection.basis : null
  const action = decision ? actionLabel(decision.action) : null
  // The eyebrow names the kind of decision; when that is the action's own
  // name (a recovery recommendation) the title already says it.
  const kind = !decision
    ? null
    : withheld
      ? 'Recovery withheld'
      : decision.action === 'recovery_recommendation'
        ? null
        : 'Defensive response'
  return (
    <section
      className={`summary-card summary-card--decision${withheld ? ' summary-card--withheld' : ''}`}
      aria-labelledby="summary-decision-title"
      data-testid="decision-summary"
      data-gate={gate ? (gate.reasonCode ? 'blocked' : 'clear') : undefined}
      data-stale={stale ? 'true' : undefined}
    >
      <header className="summary-card__head">
        <h2 id="summary-decision-title">Decision</h2>
        <a className="summary-card__link" href={withCapture('/reasoning')}>Reasoning →</a>
      </header>
      {decision ? (
        <>
          {kind ? <p className="summary-card__eyebrow">{kind}</p> : null}
          <p className="summary-card__lead">
            <strong className="summary-card__action">{action}</strong>
            {stale ? (
              <span className="summary-card__flag summary-card__flag--stale" data-testid="decision-stale" title={STALE_DECISION_TITLE}>
                {STALE_DECISION_FLAG}
              </span>
            ) : null}
          </p>
          <p className="summary-card__kv"><span>Authority</span><strong>{decision.authority}</strong><span>Target</span><strong title={decision.target}>{targetLabel(decision.target)}</strong></p>
          <p className="summary-card__text summary-card__gate" data-testid="summary-gate">
            {gateState}
            {basis ? ` · ${basis}` : ''}
          </p>
          {withheld ? (
            <p className="summary-card__withheld" data-testid="summary-withheld">{withheldRecoveryLabel(withheld)}</p>
          ) : recovery ? (
            <p className="summary-card__text">
              {recoveryActionLabel(recovery.action_id)}
              {recovery.requires_approval ? ' · operator approval required' : ' · no approval required'}
            </p>
          ) : null}
          {selection ? (
            <p className="summary-card__text summary-card__text--muted summary-card__selection" data-testid="summary-selection" data-capture-hide>
              {selectionSentence(selection, { options: false })}
            </p>
          ) : null}
          {!actions ? null : accepted || denied ? (
            <p className="summary-card__resolved">
              <span>{accepted ? 'Accepted' : 'Denied'}</span>
              <small className="summary-card__outcome" data-testid="summary-outcome">
                {operatorStamps(statusAt, scenarioAt) ? `${operatorStamps(statusAt, scenarioAt)} · ` : ''}
                {operatorOutcome(decision, accepted ? 'accepted' : 'denied')}
              </small>
              <button type="button" className="summary-card__button summary-card__button--quiet" onClick={() => void recordOperatorDecision(decision, 'reconsidered')} data-key="R">Reconsider</button>
            </p>
          ) : (
            <p className="summary-card__buttons">
              <button
                type="button"
                className="summary-card__button summary-card__button--accept"
                onClick={() => void recordOperatorDecision(decision, 'accepted')}
                data-key="A"
                disabled={acceptLocked}
                title={acceptLocked ? ACCEPT_LOCKED_TITLE : undefined}
              >
                Accept
              </button>
              <button type="button" className="summary-card__button summary-card__button--deny" onClick={() => void recordOperatorDecision(decision, 'denied')} data-key="D">Deny</button>
            </p>
          )}
        </>
      ) : (
        <p className="summary-card__state" data-testid="decision-pending">Pending · computed when the verdict lands</p>
      )}
    </section>
  )
}
