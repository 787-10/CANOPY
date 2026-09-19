import type { Action } from '../types/canopy'

// Exhaustive over the Action vocabulary (types/canopy.ts) so adding an action
// without a label is a typecheck error, not a title-cased fallback.
const ACTION_LABELS: Record<Action, string> = {
  active_defense_escort: 'Active defense escort',
  active_defense_counterattack: 'Active defense counterattack',
  orbital_strike_request: 'Orbital strike request',
  terrestrial_strike_request: 'Terrestrial strike request',
  space_link_interdiction_request: 'Space-link interdiction request',
  sda_tasking: 'SDA tasking',
  threat_warning: 'Threat warning',
  passive_defense: 'Passive defense',
  recovery_recommendation: 'Recovery recommendation',
}

/** Operator-facing label for a decide-stage action id. */
export const actionLabel = (action: string) =>
  (ACTION_LABELS as Record<string, string | undefined>)[action] ??
  action
    .split(/[_\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
