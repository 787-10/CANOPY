import { useEventStore } from '../store/eventStore'
import {
  gateReasonLabel,
  parseGateRationale,
  recoveryActionLabel,
  subsystemLabel,
} from '../lib/commanderLanguage'
import { actionLabel } from '../lib/actionLabels'
import type { Decision } from '../types/canopy'
import { WithheldRecoveryChip } from './WithheldRecoveryChip'

type OperatorActionPanelProps = {
  /** The decision to review. The console passes the episode's decision
   *  (the one taken on the satellite cluster's verdict); left out, the
   *  newest decision in the store is shown. */
  decision?: Decision | null
}

/** Operator-facing review surface for the decide-stage output: the action,
 *  its authority and target, the recovery block or the withheld recovery,
 *  and ACCEPT (authorize) / DENY (refuse). Status persists per decision in
 *  the store. Accepting records the decision and nothing else: a recovery
 *  runs on the friendly bus and a defensive response is routed to the
 *  authority named, neither is animated. */
export function OperatorActionPanel({ decision: episodeDecision }: OperatorActionPanelProps = {}) {
  const newestDecision = useEventStore((s) => s.decisions[0] ?? null)
  const decision = episodeDecision === undefined ? newestDecision : episodeDecision
  const accepted = useEventStore((s) =>
    decision ? s.acceptedDecisionIds.has(decision.id) : false,
  )
  const deferred = useEventStore((s) =>
    decision ? s.deferredDecisionIds.has(decision.id) : false,
  )
  const acceptDecision = useEventStore((s) => s.acceptDecision)
  const deferDecision = useEventStore((s) => s.deferDecision)
  const clearDecisionStatus = useEventStore((s) => s.clearDecisionStatus)

  // Render nothing until the engine produces a decision. The empty
  // space stays empty rather than carrying placeholder chrome — the
  // panel only takes screen real estate once it has something
  // actionable to show.
  if (!decision) {
    return null
  }

  const status: 'accepted' | 'denied' | 'pending' = accepted
    ? 'accepted'
    : deferred
      ? 'denied'
      : 'pending'
  const isRecovery = decision.action === 'recovery_recommendation'
  const recovery = isRecovery ? (decision.recovery ?? null) : null
  const gate = parseGateRationale(decision.rationale)
  const isBlocked = gate.reasonCode !== null
  const withheld = decision.withheld_recovery ?? null
  const eyebrow = isRecovery
    ? 'Internal diagnosis recommendation'
    : isBlocked
      ? 'Gate blocked'
      : withheld
        ? 'Recovery withheld'
        : 'Engine recommendation'

  const accept = () => acceptDecision(decision.id)

  return (
    <section
      className={[
        'operator-action',
        `operator-action--${status}`,
        isRecovery ? 'operator-action--recovery' : '',
        isBlocked ? 'operator-action--blocked' : '',
        withheld ? 'operator-action--withheld' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-labelledby="operator-action-title"
      data-decision-kind={isRecovery ? 'recovery' : isBlocked ? 'blocked' : 'action'}
      data-withheld={withheld ? withheld.reason_code : undefined}
    >
      <header className="operator-action__head">
        <span className="operator-action__eyebrow">{eyebrow}</span>
        <h2 id="operator-action-title">{actionLabel(decision.action)}</h2>
        {isBlocked ? (
          <span
            className="operator-action__chip operator-action__chip--blocked"
            data-testid="gate-chip"
            title={gateReasonLabel(gate.reasonCode ?? '')}
          >
            <b>blocked</b> {gate.reasonCode}
          </span>
        ) : null}
        {withheld ? (
          <WithheldRecoveryChip withheld={withheld} variant="operator-action" />
        ) : null}
      </header>

      <dl className="operator-action__meta">
        <div>
          <dt>Authority</dt>
          <dd>{decision.authority}</dd>
        </div>
        <div>
          <dt>Target</dt>
          <dd>{decision.target}</dd>
        </div>
      </dl>

      {recovery ? (
        <dl className="operator-action__recovery" data-testid="recovery-block">
          <div>
            <dt>Action id</dt>
            <dd>
              <code>{recovery.action_id}</code>
              <span>{recoveryActionLabel(recovery.action_id)}</span>
            </dd>
          </div>
          <div>
            <dt>Target subsystem</dt>
            <dd>{subsystemLabel(recovery.target_subsystem)}</dd>
          </div>
          <div>
            <dt>Requires approval</dt>
            <dd
              className={
                recovery.requires_approval
                  ? 'operator-action__flag operator-action__flag--required'
                  : 'operator-action__flag'
              }
            >
              {recovery.requires_approval ? 'Yes' : 'No'}
            </dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>internal diagnosis</dd>
          </div>
          <div className="operator-action__recovery-wide">
            <dt>Recovery rationale</dt>
            <dd>{recovery.rationale}</dd>
          </div>
        </dl>
      ) : isRecovery ? (
        <p className="operator-action__rationale operator-action__rationale--missing">
          Recovery block missing from this decision; nothing to execute.
        </p>
      ) : null}

      {!recovery || recovery.rationale !== gate.text ? (
        <p className="operator-action__rationale">{gate.text}</p>
      ) : null}

      {status === 'pending' ? (
        <div className="operator-action__buttons" role="group">
          <button
            type="button"
            className="operator-action__btn operator-action__btn--accept"
            onClick={accept}
          >
            Accept
          </button>
          <button
            type="button"
            className="operator-action__btn operator-action__btn--deny"
            onClick={() => deferDecision(decision.id)}
          >
            Deny
          </button>
        </div>
      ) : (
        <div className="operator-action__resolved">
          <span className="operator-action__resolved-tag">
            {status === 'accepted' ? 'Accepted' : 'Denied'}
          </span>
          <button
            type="button"
            className="operator-action__btn operator-action__btn--undo"
            onClick={() => clearDecisionStatus(decision.id)}
          >
            Reconsider
          </button>
        </div>
      )}
    </section>
  )
}
