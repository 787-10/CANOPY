import { gateReasonLabel, recoveryActionLabel, subsystemLabel } from '../../lib/commanderLanguage'
import type { RecoveryPhase, RecoveryState } from '../../lib/spacecraftHealth'

const STEPS: Array<{ phase: RecoveryPhase; label: string }> = [
  { phase: 'recommended', label: 'Recommended' },
  { phase: 'routed', label: 'Routed as decision' },
  { phase: 'withheld', label: 'Withheld' },
  { phase: 'approved', label: 'Operator' },
]

const PHASE_COPY: Record<RecoveryPhase, string> = {
  none: 'The internal diagnosis has not recommended a recovery for this spacecraft.',
  recommended:
    'The internal diagnosis recommends this action. No decision has routed it yet.',
  routed:
    'The decide stage routed the recommendation as a recovery decision (local authority, operator approval as marked).',
  withheld:
    'The internal diagnosis recommended this action; the decide stage withheld it for the reason shown.',
  blocked: 'The threat-context gate blocked the routed recovery for the reason shown.',
  approved: 'The operator approved the routed recovery; it is cleared for the spacecraft bus.',
  denied: 'The operator denied the routed recovery; it is held for review.',
}

/** Recovery life-cycle: recommended by the internal diagnosis, routed as a
 *  decision, or withheld / blocked with the reason. */
export function RecoveryStatePanel({ state }: { state: RecoveryState }) {
  const decided = state.phase === 'approved' || state.phase === 'denied'
  const reached = (phase: RecoveryPhase) => {
    if (state.phase === 'none') return false
    if (phase === 'recommended') return true
    if (phase === 'routed') return state.phase === 'routed' || state.phase === 'blocked' || decided
    if (phase === 'withheld') return state.phase === 'withheld' || state.phase === 'blocked'
    if (phase === 'approved') return decided
    return false
  }
  const stepLabel = (step: { phase: RecoveryPhase; label: string }) => {
    if (step.phase === 'withheld' && state.phase === 'blocked') return 'Blocked by gate'
    if (step.phase === 'approved') return state.phase === 'denied' ? 'Denied' : decided ? 'Approved' : step.label
    return step.label
  }

  return (
    <section
      className={`recovery-state recovery-state--${state.phase}`}
      aria-label="Recovery state"
      data-testid="recovery-state"
      data-phase={state.phase}
    >
      <ol className="recovery-state__track">
        {STEPS.map((step) => (
          <li
            key={step.phase}
            className={`recovery-state__step${reached(step.phase) ? ' recovery-state__step--on' : ''}${
              state.phase === step.phase ||
              (step.phase === 'withheld' && state.phase === 'blocked') ||
              (step.phase === 'approved' && decided)
                ? ' recovery-state__step--current'
                : ''
            }`}
          >
            {stepLabel(step)}
          </li>
        ))}
      </ol>
      <p className="recovery-state__headline" data-testid="recovery-headline">
        {state.actionId ? (
          <>
            <strong>{recoveryActionLabel(state.actionId)}</strong>
            {state.targetSubsystem ? <span> on {subsystemLabel(state.targetSubsystem)}</span> : null}
          </>
        ) : (
          <strong>No recovery recommended</strong>
        )}
      </p>
      {state.reasonCode ? (
        <p className="recovery-state__reason" data-testid="recovery-reason" title={state.reasonCode}>
          {state.phase === 'blocked' ? 'Blocked' : 'Withheld'}: {gateReasonLabel(state.reasonCode)}
          <code>{state.reasonCode}</code>
        </p>
      ) : null}
      <p className="recovery-state__copy">{PHASE_COPY[state.phase]}</p>
      {state.requiresApproval !== null ? (
        <p className="recovery-state__meta">
          {state.requiresApproval ? 'Operator approval required' : 'No approval required'}
        </p>
      ) : null}
      {state.rationale ? <p className="recovery-state__rationale">{state.rationale}</p> : null}
    </section>
  )
}
