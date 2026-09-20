import { useMemo } from 'react'
import {
  gateReasonLabel,
  parseGateRationale,
  recoveryActionLabel,
  verdictCopy,
  verdictHeadline,
  withheldRecoveryLabel,
} from '../lib/commanderLanguage'
import { actionLabel } from '../lib/actionLabels'
import { selectionSentence, selectionSummary } from '../lib/selectionBasis'
import { attributionTimings, formatMs } from '../lib/timing'
import { withCapture } from '../store/captureStore'
import { useEventStore } from '../store/eventStore'
import type { Attribution, Decision } from '../types/canopy'

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/** Verdict in a few lines: the badge, a confidence bar, the revision, the
 *  provisional-versus-final timing and the headline, with a link to the
 *  full page. */
export function VerdictSummaryCard({ attribution }: { attribution: Attribution | null }) {
  const traces = useEventStore((s) => s.traces)
  const timings = useMemo(
    () => (attribution ? attributionTimings(traces, attribution.id) : null),
    [traces, attribution],
  )
  const verdict = attribution?.verdict ?? null
  const copy = verdict ? verdictCopy[verdict] : null
  const actor = attribution?.actor
  const showActor = actor && actor !== 'None' && actor !== 'Unknown'
  const confidence = attribution ? Math.round(clamp01(attribution.confidence) * 100) : 0
  const revision = attribution?.revision ?? 0
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
          <p className="summary-card__kv summary-card__kv--wide" data-testid="summary-timing">
            <span>Revision</span>
            <strong>
              rev {revision}
              {attribution.provisional ? ' · provisional' : ' · final'}
            </strong>
            <span>Timing</span>
            <strong>
              {timings?.provisionalMs !== null && timings?.provisionalMs !== undefined
                ? `provisional in ${formatMs(timings.provisionalMs)}`
                : 'provisional pending'}
              {' · '}
              {timings?.finalMs !== null && timings?.finalMs !== undefined
                ? `final in ${formatMs(timings.finalMs)}`
                : 'final pending'}
            </strong>
            {showActor ? (
              <>
                <span>Actor</span>
                <strong>{actor}</strong>
              </>
            ) : null}
          </p>
        </>
      ) : (
        <p className="summary-card__text summary-card__text--muted">The fast lane publishes a provisional verdict at the first anomalous report.</p>
      )}
    </section>
  )
}

type DecisionSummaryCardProps = {
  decision: Decision | null
  /** Render the Accept / Deny buttons. The overview passes `false`: the
   *  OperatorActionPanel above the card carries them. */
  actions?: boolean
}

/** The decision in a few lines: the action, its authority and target, the
 *  gate state and the selection basis in words, the withheld or routed
 *  recovery, and a link to the reasoning trace. */
export function DecisionSummaryCard({ decision, actions = true }: DecisionSummaryCardProps) {
  const accepted = useEventStore((s) => (decision ? s.acceptedDecisionIds.has(decision.id) : false))
  const denied = useEventStore((s) => (decision ? s.deferredDecisionIds.has(decision.id) : false))
  const acceptDecision = useEventStore((s) => s.acceptDecision)
  const deferDecision = useEventStore((s) => s.deferDecision)
  const clearDecisionStatus = useEventStore((s) => s.clearDecisionStatus)
  const withheld = decision?.withheld_recovery ?? null
  const recovery = decision?.recovery ?? null
  const selection = decision ? selectionSummary(decision) : null
  const gate = decision ? parseGateRationale(decision.rationale) : null
  const gateState = !gate
    ? null
    : gate.reasonCode
      ? `Gate blocked: ${gateReasonLabel(gate.reasonCode)}`
      : 'Gate clear'
  // A gate-withheld basis repeats the gate line; keep the other bases.
  const basis = selection?.basis && !selection.basis.startsWith('gate withheld') ? selection.basis : null
  const kind = !decision
    ? null
    : withheld
      ? 'Recovery withheld'
      : decision.action === 'recovery_recommendation'
        ? 'Recovery recommendation'
        : 'Defensive response'
  return (
    <section
      className={`summary-card summary-card--decision${withheld ? ' summary-card--withheld' : ''}`}
      aria-labelledby="summary-decision-title"
      data-testid="decision-summary"
      data-gate={gate ? (gate.reasonCode ? 'blocked' : 'clear') : undefined}
    >
      <header className="summary-card__head">
        <h2 id="summary-decision-title">Decision</h2>
        <a className="summary-card__link" href={withCapture('/reasoning')}>Reasoning →</a>
      </header>
      {decision ? (
        <>
          <p className="summary-card__eyebrow">{kind}</p>
          <p className="summary-card__lead"><strong className="summary-card__action">{actionLabel(decision.action)}</strong></p>
          <p className="summary-card__kv"><span>Authority</span><strong>{decision.authority}</strong><span>Target</span><strong>{decision.target}</strong></p>
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
