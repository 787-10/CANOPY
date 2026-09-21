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
import { useClockStore } from '../store/clockStore'
import { useEventStore } from '../store/eventStore'
import type { Decision } from '../types/canopy'

export type OperatorStatus = 'accepted' | 'denied' | 'reconsidered'

export async function recordOperatorDecision(
  decision: Decision,
  status: OperatorStatus,
  { fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const store = useEventStore.getState()
  // Two stamps on every call (docs/MEGALITH-Flight-Plan.md §2.7): the wall
  // clock, and the scenario clock when a run's clock is known.
  const scenarioAt = scenarioStamp()
  if (status === 'accepted') store.acceptDecision(decision.id, scenarioAt)
  else if (status === 'denied') store.deferDecision(decision.id, scenarioAt)
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
          scenario_ts: scenarioAt,
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

/** The scenario clock's time now as ISO, or null while no run's clock is known. */
export function scenarioStamp(): string | null {
  const clock = useClockStore.getState()
  if (clock.mode === 'free') return null
  const ms = clock.timeAt()
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** `2026-09-20T15:14:02.123Z` -> `15:14:02Z`. */
export function operatorStamp(iso: string | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : `${d.toISOString().slice(11, 19)}Z`
}

/** Both stamps of a call, each naming its clock: `15:04:22Z scenario ·
 *  11:31:04Z wall`; only the wall stamp (unlabelled, as before) when the call
 *  was made with no run's clock known. */
export function operatorStamps(wallIso: string | undefined, scenarioIso: string | undefined): string | null {
  const wall = operatorStamp(wallIso)
  const scenario = operatorStamp(scenarioIso)
  if (!wall) return scenario ? `${scenario} scenario` : null
  return scenario ? `${scenario} scenario · ${wall} wall` : wall
}

// A decision behind the verdict revision (C21). The decide stage makes a
// decision per attribution revision under one id; between the final verdict
// arriving and the decide stage republishing, the decision on screen was made
// for the provisional verdict.

/** Shown beside the action title while the decision is behind the verdict. */
export const STALE_DECISION_FLAG = 'based on provisional verdict · updating'
export const STALE_DECISION_TITLE =
  'The verdict was revised after this decision was made; the decide stage is recomputing it on the final verdict.'
/** Title on a locked Accept: recoveries wait for the decision to catch up. */
export const ACCEPT_LOCKED_TITLE = 'Accept opens when the decision catches up with the final verdict'

/** True when the attribution on display is a later revision than the one
 *  the decision was made for. Unknown revisions on either side are never
 *  stale: the console flags only what the engine has stated. */
export function decisionIsStale(
  decision: Decision | null | undefined,
  attributionRevision: number | null | undefined,
): boolean {
  if (!decision || typeof decision.revision !== 'number' || typeof attributionRevision !== 'number') {
    return false
  }
  return attributionRevision > decision.revision
}

/** A recovery cannot be accepted while its decision is behind the verdict;
 *  threat warnings and other defensive responses stay acceptable. */
export function acceptIsLocked(
  decision: Decision | null | undefined,
  attributionRevision: number | null | undefined,
): boolean {
  return decision?.action === 'recovery_recommendation' && decisionIsStale(decision, attributionRevision)
}
