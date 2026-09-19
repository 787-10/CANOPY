import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { OperatorActionPanel } from './OperatorActionPanel'
import { useEventStore } from '../store/eventStore'
import { GATE_REASON_CODES, gateReasonLabel } from '../lib/commanderLanguage'
import { makeDecision } from '../test/factories'

beforeEach(() => {
  useEventStore.getState().reset()
})

describe('OperatorActionPanel — F8 withheld-recovery chip', () => {
  it.each(GATE_REASON_CODES)('shows the withheld chip with the label for %s', (reasonCode) => {
    useEventStore.getState().ingestDecision(
      makeDecision('d-withheld', {
        action: 'passive_defense',
        authority: 'local',
        target: 'SIM-01',
        rationale: 'Hostile uplink interference attributed to Actor-1; defensive posture.',
        withheld_recovery: {
          action_id: 'reset_transponder_chain',
          target_subsystem: 'comms',
          reason_code: reasonCode,
        },
      }),
    )
    render(<OperatorActionPanel />)
    const chip = screen.getByTestId('withheld-chip')
    expect(chip).toHaveTextContent(
      `Recovery withheld: Reset transponder chain on Comms: ${gateReasonLabel(reasonCode)}`,
    )
    expect(chip).toHaveClass('operator-action__chip--withheld')
    expect(chip).toHaveAttribute('title', reasonCode)
    const section = document.querySelector('.operator-action')
    expect(section).toHaveAttribute('data-withheld', reasonCode)
    expect(screen.getByText('Recovery withheld')).toBeInTheDocument()
  })

  it('renders no withheld chip for a decision without the block', () => {
    useEventStore.getState().ingestDecision(makeDecision('d-plain'))
    render(<OperatorActionPanel />)
    expect(screen.queryByTestId('withheld-chip')).not.toBeInTheDocument()
    expect(screen.getByText('Engine recommendation')).toBeInTheDocument()
  })
})
