// The operator's call on a decision: Accept, Deny or Reconsider. One
// function for the buttons and the hotkeys. It updates the console store at
// once (every page reads it) and, when the console is live on a gateway,
// posts the call to `POST /decisions/{id}/operator`, which records it and
// writes a decide-stage trace line so the call is part of the run and
// reaches every connected console.
import { actionLabel } from './actionLabels'
import { recoveryActionLabel, subsystemLabel } from './commanderLanguage'
import { fetchGateway } from './gateway'
import { targetLabel } from './targetLabel'
import { useEventStore } from '../store/eventStore'
import type { Decision } from '../types/canopy'

export type OperatorStatus = 'accepted' | 'denied' | 'reconsidered'

export async function recordOperatorDecision(
  decision: Decision,
  status: OperatorStatus,
  { fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const store = useEventStore.getState()
  if (status === 'accepted') store.acceptDecision(decision.id)
  else if (status === 'denied') store.deferDecision(decision.id)
  else store.clearDecisionStatus(decision.id)
  // No gateway, nothing to tell: fixtures and tests stay local.
  if (store.connection !== 'live') return
  try {
    await fetchGateway(
      `/decisions/${encodeURIComponent(decision.id)}/operator`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status,
          action: decision.action,
          authority: decision.authority,
          target: decision.target,
          attribution_id: decision.attribution_id,
          satellite_id: decision.recovery?.satellite_id ?? null,
        }),
      },
      { fetchImpl },
    )
  } catch {
    // The console keeps its own record; the gateway line is best effort.
  }
}

/** What the operator's call did, in words: `Approved: Switch redundant
 *  amplifier on Comms`, `Issued: Threat warning to Brigade C2`, `Held for
 *  review`. */
export function operatorOutcome(decision: Decision, status: 'accepted' | 'denied'): string {
  if (status === 'denied') return 'Held for review'
  if (decision.action === 'recovery_recommendation' && decision.recovery) {
    return `Approved: ${recoveryActionLabel(decision.recovery.action_id)} on ${subsystemLabel(decision.recovery.target_subsystem)}`
  }
  return `Issued: ${actionLabel(decision.action)} to ${targetLabel(decision.target)}`
}

/** `2026-09-20T15:14:02.123Z` -> `15:14:02Z`. */
export function operatorStamp(iso: string | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : `${d.toISOString().slice(11, 19)}Z`
}
