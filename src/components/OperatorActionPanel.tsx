import { useEventStore, type ManeuverDemo } from '../store/eventStore'
import type { Action } from '../types/canopy'

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
// specific story (threat_warning, passive_defense, sda_tasking).
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

  return (
    <section
      className={`operator-action operator-action--${status}`}
      aria-labelledby="operator-action-title"
    >
      <header className="operator-action__head">
        <span className="operator-action__eyebrow">Engine recommendation</span>
        <h2 id="operator-action-title">{formatAction(decision.action)}</h2>
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

      <p className="operator-action__rationale">{decision.rationale}</p>

      {status === 'pending' ? (
        <div className="operator-action__buttons" role="group">
          <button
            type="button"
            className="operator-action__btn operator-action__btn--accept"
            onClick={() => {
              acceptDecision(decision.id)
              const packet = (decision.request_packet ?? {}) as Record<
                string,
                unknown
              >
              const burn = (packet.recommended_burn ?? {}) as Record<
                string,
                unknown
              >
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
                friendlyLabel:
                  typeof burn.sat === 'string' ? burn.sat : undefined,
                hostileLabel:
                  typeof burn.against === 'string' ? burn.against : undefined,
                demoType: actionToDemoType(decision.action),
              })
            }}
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
