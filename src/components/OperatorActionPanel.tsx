import { useEventStore } from '../store/eventStore'
import {
  gateReasonLabel,
  parseGateRationale,
  recoveryActionLabel,
  subsystemLabel,
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
import type { Decision } from '../types/canopy'
import { WithheldRecoveryChip } from './WithheldRecoveryChip'

type OperatorActionPanelProps = {
  /** The decision to review. The console passes the episode's decision
   *  (the one taken on the satellite cluster's verdict); left out, the
   *  newest decision in the store is shown. */
  decision?: Decision | null
  /** Revision of the episode attribution shown beside the panel. A decision
   *  made for an earlier revision is flagged, and a recovery stays
   *  unacceptable until the decide stage catches up (C21). */
  attributionRevision?: number | null
  /** The overview's approve/deny box: the action, its gate or withheld chip,
   *  the "selected from N options" line and the buttons; the authority and
   *  target, the recovery block and the rationale are left to the cards
   *  under it. Same handlers, same store writes. */
  compact?: boolean
}

/** Operator-facing review surface for the decide-stage output: the action,
 *  its authority and target, the recovery block or the withheld recovery,
 *  and ACCEPT (authorize) / DENY (refuse). Status persists per decision in
 *  the store. Accepting records the decision and nothing else: a recovery
 *  runs on the friendly bus and a defensive response is routed to the
 *  authority named, neither is animated. */
export function OperatorActionPanel({
  decision: episodeDecision,
  attributionRevision = null,
  compact = false,
}: OperatorActionPanelProps = {}) {
  const newestDecision = useEventStore((s) => s.decisions[0] ?? null)
  const decision = episodeDecision === undefined ? newestDecision : episodeDecision
  const accepted = useEventStore((s) =>
    decision ? s.acceptedDecisionIds.has(decision.id) : false,
  )
  const deferred = useEventStore((s) =>
    decision ? s.deferredDecisionIds.has(decision.id) : false,
  )
  const statusAt = useEventStore((s) => (decision ? s.decisionStatusAt[decision.id] : undefined))
  const scenarioAt = useEventStore((s) => (decision ? s.decisionStatusScenarioAt[decision.id] : undefined))

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
  const selection = selectionSummary(decision)
  const stale = decisionIsStale(decision, attributionRevision)
  const acceptLocked = acceptIsLocked(decision, attributionRevision)
  const eyebrow = isRecovery
    ? 'Internal diagnosis recommendation'
    : isBlocked
      ? 'Gate blocked'
      : withheld
        ? 'Recovery withheld'
        : 'Engine recommendation'

  const accept = () => void recordOperatorDecision(decision, 'accepted')

  return (
    <section
      className={[
        'operator-action',
        `operator-action--${status}`,
        isRecovery ? 'operator-action--recovery' : '',
        isBlocked ? 'operator-action--blocked' : '',
        withheld ? 'operator-action--withheld' : '',
        compact ? 'operator-action--compact' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-labelledby="operator-action-title"
      data-decision-kind={isRecovery ? 'recovery' : isBlocked ? 'blocked' : 'action'}
      data-withheld={withheld ? withheld.reason_code : undefined}
      data-stale={stale ? 'true' : undefined}
    >
      <header className="operator-action__head">
        <span className="operator-action__eyebrow">{eyebrow}</span>
        <h2 id="operator-action-title">{actionLabel(decision.action)}</h2>
        {stale ? (
          <span
            className="operator-action__chip operator-action__chip--stale"
            data-testid="stale-chip"
            title={STALE_DECISION_TITLE}
          >
            {STALE_DECISION_FLAG}
          </span>
        ) : null}
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

      {compact ? null : (
        <dl className="operator-action__meta">
          <div>
            <dt>Authority</dt>
            <dd>{decision.authority}</dd>
          </div>
          <div>
            <dt>Target</dt>
            <dd title={decision.target}>{targetLabel(decision.target)}</dd>
          </div>
        </dl>
      )}

      {selection ? (
        // Spec 1.4 bounded response: the menu the action came from and why.
        // Muted Barlow text; hidden in capture mode so the pinned 1920x1080
        // layout does not shift.
        <p
          className="operator-action__rationale operator-action__selection"
          data-testid="selection-basis"
          data-capture-hide
        >
          {selectionSentence(selection, { options: !compact })}
          {selection.basis ? ` · ${selection.basis}` : ''}
        </p>
      ) : null}

      {compact ? null : recovery ? (
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

      {!compact && (!recovery || recovery.rationale !== gate.text) ? (
        <p className="operator-action__rationale">{gate.text}</p>
      ) : null}

      {status === 'pending' ? (
        <div className="operator-action__buttons" role="group">
          <button
            type="button"
            className="operator-action__btn operator-action__btn--accept"
            onClick={accept}
            data-key="A"
            disabled={acceptLocked}
            title={acceptLocked ? ACCEPT_LOCKED_TITLE : undefined}
          >
            Accept
          </button>
          <button
            type="button"
            className="operator-action__btn operator-action__btn--deny"
            onClick={() => void recordOperatorDecision(decision, 'denied')}
            data-key="D"
          >
            Deny
          </button>
        </div>
      ) : (
        <div className="operator-action__resolved">
          <span className="operator-action__resolved-tag">
            {status === 'accepted' ? 'Accepted' : 'Denied'}
          </span>
          <span className="operator-action__resolved-detail" data-testid="operator-outcome">
            {operatorStamps(statusAt, scenarioAt) ? `${operatorStamps(statusAt, scenarioAt)} · ` : ''}
            {operatorOutcome(decision, status)}
          </span>
          <button
            type="button"
            className="operator-action__btn operator-action__btn--undo"
            onClick={() => void recordOperatorDecision(decision, 'reconsidered')}
            data-key="R"
          >
            Reconsider
          </button>
        </div>
      )}
    </section>
  )
}
