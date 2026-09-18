import { withheldRecoveryLabel } from '../lib/commanderLanguage'
import type { WithheldRecovery } from '../types/canopy'

type WithheldRecoveryChipProps = {
  withheld: WithheldRecovery
  /** Class prefix of the host panel so the chip inherits its gate-chip look. */
  variant: 'verdict-panel' | 'operator-action' | 'operator-list' | 'bus-health-card'
}

/** "Recovery withheld: <action> on <subsystem>: <reason>" chip, styled like
 *  the gate chip of the host panel (docs/INTERFACE-SPEC.md §6, F8). */
export function WithheldRecoveryChip({ withheld, variant }: WithheldRecoveryChipProps) {
  return (
    <span
      className={`${variant}__chip ${variant}__chip--withheld`}
      data-testid="withheld-chip"
      data-reason-code={withheld.reason_code}
      title={withheld.reason_code}
    >
      {withheldRecoveryLabel(withheld)}
    </span>
  )
}
