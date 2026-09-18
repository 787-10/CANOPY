import { useEventStore, type ManeuverDemo } from '../store/eventStore'
import {
  gateReasonLabel,
  parseGateRationale,
  recoveryActionLabel,
  subsystemLabel,
} from '../lib/commanderLanguage'
import type { Action } from '../types/canopy'
import { WithheldRecoveryChip } from './WithheldRecoveryChip'

// Exhaustive over the Action vocabulary (types/canopy.ts) so adding an action
// without a label is a typecheck error, not a title-cased fallback.
const ACTION_LABELS: Record<Action, string> = {
  active_defense_escort: 'Active defense escort',
  active_defense_counterattack: 'Active defense counterattack',
  orbital_strike_request: 'Orbital strike request',
  terrestrial_strike_request: 'Terrestrial strike request',
  space_link_interdiction_request: 'Space-link interdiction',
  sda_tasking: 'SDA tasking',
  threat_warning: 'Threat warning',
  passive_defense: 'Passive defense',
  recovery_recommendation: 'Recovery recommendation',
}

// Map engine action → which Cesium animation runs on Accept. Evasion is
// the default since it's the broadest visualisation (shared-orbit threat
// + plane change) and reads correctly even for actions without a more
// specific story (threat_warning, passive_defense, sda_tasking). A
// recovery_recommendation never reaches this: it is an onboard action
// on the friendly bus, so Accept skips the orbital demo entirely.
const actionToDemoType = (action: string): ManeuverDemo['demoType'] => {
  if (
    action === 'orbital_strike_request' ||
    action === 'active_defense_counterattack'
  ) {
    return 'strike'
  }
  if (action === 'space_link_interdiction_request') {
    return 'interdiction'
  }
  return 'evasion'
}

const formatAction = (action: string) =>
  (ACTION_LABELS as Record<string, string | undefined>)[action] ??
  action
    .split(/[_\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')

/** Operator-facing review surface for the latest decide-stage output.
 *  Lives in the left rail under the scenario list. When the engine
 *  produces a Decision, the operator can ACCEPT (authorize the action)
 *  or DENY (refuse it). Status persists per-decision via Zustand. */
export function OperatorActionPanel() {
  const decision = useEventStore((s) => s.decisions[0] ?? null)
  const accepted = useEventStore((s) =>
    decision ? s.acceptedDecisionIds.has(decision.id) : false,
  )
  const deferred = useEventStore((s) =>
    decision ? s.deferredDecisionIds.has(decision.id) : false,
  )
  const acceptDecision = useEventStore((s) => s.acceptDecision)
  const deferDecision = useEventStore((s) => s.deferDecision)
  const clearDecisionStatus = useEventStore((s) => s.clearDecisionStatus)
  const startManeuverDemo = useEventStore((s) => s.startManeuverDemo)

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
      ? 'Engine recommendation · gate blocked'
      : withheld
        ? 'Engine recommendation · recovery withheld'
        : 'Engine recommendation'

  const accept = () => {
    acceptDecision(decision.id)
    if (isRecovery) {
      // A recovery is executed on the friendly bus (switch a redundant
      // unit, enter safe mode, ...). There is no orbital manoeuvre to
      // show, so the accept is recorded in the store and nothing else.
      return
    }
    const packet = (decision.request_packet ?? {}) as Record<string, unknown>
    const burn = (packet.recommended_burn ?? {}) as Record<string, unknown>
    const preMissKm = Number(packet.pre_miss_km ?? 0)
    const postMissKm = Number(packet.post_miss_km ?? preMissKm + 80)
    const dvMs = Number(burn.dv_m_s ?? 1.5)
    startManeuverDemo({
      decisionId: decision.id,
      startedAt: Date.now(),
      durationMs: 15000,
      preMissKm,
      postMissKm,
      dvMs,
      friendlyLabel: typeof burn.sat === 'string' ? burn.sat : undefined,
      hostileLabel: typeof burn.against === 'string' ? burn.against : undefined,
      demoType: actionToDemoType(decision.action),
    })
  }

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
        <h2 id="operator-action-title">{formatAction(decision.action)}</h2>
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
