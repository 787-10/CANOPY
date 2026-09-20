import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { OperatorActionPanel } from './OperatorActionPanel'
import { useEventStore } from '../store/eventStore'
import { makeDecision } from '../test/factories'
import { ACTIONS, type RecoveryBlock } from '../types/canopy'

beforeEach(() => {
  useEventStore.getState().reset()
})

const recoveryBlock: RecoveryBlock = {
  action_id: 'switch_redundant_amplifier',
  target_subsystem: 'comms',
  requires_approval: true,
  rationale: 'Primary amplifier output trending down; redundant unit nominal.',
  source: 'internal-diagnosis',
  satellite_id: 'ctb://centralblue.dev/leo-science-1',
}

const ingestRecovery = (overrides: Partial<RecoveryBlock> = {}) => {
  const decision = makeDecision('d-recovery', {
    action: 'recovery_recommendation',
    authority: 'local',
    target: 'LEO-SCIENCE-1',
    rationale: 'Internal fault on comms; recovery recommended.',
    recovery: { ...recoveryBlock, ...overrides },
  })
  useEventStore.getState().ingestDecision(decision)
  return decision
}

describe('OperatorActionPanel — action labels', () => {
  it('renders nothing until a decision arrives', () => {
    const { container } = render(<OperatorActionPanel />)
    expect(container).toBeEmptyDOMElement()
  })

  it('titles a recovery recommendation in plain language', () => {
    useEventStore
      .getState()
      .ingestDecision(
        makeDecision('d-recovery', {
          action: 'recovery_recommendation',
          authority: 'local',
        }),
      )
    render(<OperatorActionPanel />)
    expect(
      screen.getByRole('heading', { name: 'Recovery recommendation' }),
    ).toBeInTheDocument()
  })

  it('never falls back to a title-cased slug for a vocabulary action', () => {
    for (const action of ACTIONS) {
      useEventStore.getState().reset()
      useEventStore.getState().ingestDecision(makeDecision(`d-${action}`, { action }))
      const { unmount } = render(<OperatorActionPanel />)
      const heading = screen.getByRole('heading', { level: 2 })
      expect(heading.textContent, action).not.toMatch(/_/)
      expect(heading.textContent, action).toMatch(/\S/)
      unmount()
    }
  })
})

describe('OperatorActionPanel — recovery recommendations', () => {
  it('shows the action id, target subsystem, approval flag and rationale from decision.recovery', () => {
    ingestRecovery()
    render(<OperatorActionPanel />)
    expect(screen.getByText('Internal diagnosis recommendation')).toBeInTheDocument()
    const block = within(screen.getByTestId('recovery-block'))
    expect(block.getByText('switch_redundant_amplifier')).toBeInTheDocument()
    expect(block.getByText('Switch redundant amplifier')).toBeInTheDocument()
    expect(block.getByText('Comms')).toBeInTheDocument()
    expect(block.getByText('Yes')).toHaveClass('operator-action__flag--required')
    expect(block.getByText('internal diagnosis')).toBeInTheDocument()
    expect(
      block.getByText(
        'Primary amplifier output trending down; redundant unit nominal.',
      ),
    ).toBeInTheDocument()
    // The decide-stage rationale is still shown alongside the recovery one.
    expect(
      screen.getByText('Internal fault on comms; recovery recommended.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Recovery recommendation' })).toHaveAttribute(
      'data-decision-kind',
      'recovery',
    )
  })

  it('renders "No" when the recovery needs no approval', () => {
    ingestRecovery({ requires_approval: false })
    render(<OperatorActionPanel />)
    expect(within(screen.getByTestId('recovery-block')).getByText('No')).not.toHaveClass(
      'operator-action__flag--required',
    )
  })

  it('Accept on a recovery marks it accepted in the store and does not start the maneuver demo', () => {
    const decision = ingestRecovery()
    render(<OperatorActionPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    const state = useEventStore.getState()
    expect(state.acceptedDecisionIds.has(decision.id)).toBe(true)
    expect(state.deferredDecisionIds.has(decision.id)).toBe(false)
    expect(state.maneuverDemo).toBeNull()
    expect(screen.getByText('Accepted')).toBeInTheDocument()
  })

  it('Accept on a counterspace action records it and starts no animation', () => {
    const decision = makeDecision('d-escort', {
      action: 'active_defense_escort',
      request_packet: { pre_miss_km: 12, post_miss_km: 90 },
    })
    useEventStore.getState().ingestDecision(decision)
    render(<OperatorActionPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(useEventStore.getState().acceptedDecisionIds.has('d-escort')).toBe(true)
    expect(useEventStore.getState().maneuverDemo).toBeNull()
  })

  it('shows the decision it is given rather than the newest in the store', () => {
    const newest = makeDecision('d-newest', { action: 'threat_warning', authority: 'local' })
    const episode = makeDecision('d-episode', { action: 'passive_defense', authority: 'local' })
    useEventStore.getState().ingestDecision(episode)
    useEventStore.getState().ingestDecision(newest)
    render(<OperatorActionPanel decision={episode} />)
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Passive defense')
  })

  it('Deny on a recovery records the denial without touching the demo', () => {
    const decision = ingestRecovery()
    render(<OperatorActionPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(useEventStore.getState().deferredDecisionIds.has(decision.id)).toBe(true)
    expect(useEventStore.getState().maneuverDemo).toBeNull()
  })

  it('flags a recovery_recommendation that arrived without its recovery block', () => {
    useEventStore.getState().ingestDecision(
      makeDecision('d-hollow', {
        action: 'recovery_recommendation',
        authority: 'local',
        recovery: null,
      }),
    )
    render(<OperatorActionPanel />)
    expect(screen.queryByTestId('recovery-block')).not.toBeInTheDocument()
    expect(
      screen.getByText('Recovery block missing from this decision; nothing to execute.'),
    ).toBeInTheDocument()
  })
})

describe('OperatorActionPanel — gate-blocked decisions', () => {
  it('shows the reason code as a chip and strips the prefix from the rationale', () => {
    useEventStore.getState().ingestDecision(
      makeDecision('d-blocked', {
        action: 'threat_warning',
        authority: 'local',
        rationale:
          '[gate:threat/uplink_jamming_active] Recovery on comms withheld while uplink jamming is active.',
        recovery: null,
      }),
    )
    render(<OperatorActionPanel />)
    const chip = screen.getByTestId('gate-chip')
    expect(chip).toHaveTextContent('blocked threat/uplink_jamming_active')
    expect(chip).toHaveAttribute('title', 'Active jamming detected')
    expect(
      screen.getByText('Recovery on comms withheld while uplink jamming is active.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/\[gate:/)).not.toBeInTheDocument()
    expect(screen.getByText('Gate blocked')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Threat warning' })).toHaveClass(
      'operator-action--blocked',
    )
  })

  it('shows no chip for an ordinary rationale', () => {
    useEventStore
      .getState()
      .ingestDecision(makeDecision('d-plain', { rationale: 'gate: not a prefix' }))
    render(<OperatorActionPanel />)
    expect(screen.queryByTestId('gate-chip')).not.toBeInTheDocument()
    expect(screen.getByText('gate: not a prefix')).toBeInTheDocument()
  })
})

describe('OperatorActionPanel — bounded response (spec 1.4)', () => {
  const menu = [
    'passive_defense',
    'threat_warning',
    'sda_tasking',
    'active_defense_escort',
    'space_link_interdiction_request',
  ] as const

  it('shows the selectable set and the basis in muted text, hidden in capture mode', () => {
    useEventStore.getState().ingestDecision(
      makeDecision('d-bounded', {
        action: 'passive_defense',
        authority: 'local',
        target: 'SIM-01',
        selectable_set: [...menu],
        selection_basis: 'model-within-set',
      }),
    )
    render(<OperatorActionPanel />)
    const line = screen.getByTestId('selection-basis')
    expect(line).toHaveTextContent(
      'Selected from 5 options: Passive defense, Threat warning, SDA tasking, Active defense escort, Space-link interdiction request',
    )
    expect(line).toHaveTextContent('model choice within the approved set')
    expect(line).toHaveClass('operator-action__rationale')
    expect(line).toHaveAttribute('data-capture-hide')
  })

  it('labels a gate-withheld basis with the gate reason and a routed recovery by the rule', () => {
    useEventStore.getState().ingestDecision(
      makeDecision('d-gated', {
        action: 'threat_warning',
        authority: 'local',
        rationale: '[gate:threat/uplink_jamming_active] reset the radio',
        selectable_set: ['threat_warning'],
        selection_basis: 'gate-withheld:threat/uplink_jamming_active',
      }),
    )
    render(<OperatorActionPanel />)
    expect(screen.getByTestId('selection-basis')).toHaveTextContent(
      'Selected from 1 option: Threat warning · gate withheld: Active jamming detected',
    )
    useEventStore.getState().reset()
    useEventStore.getState().ingestDecision(
      makeDecision('d-routed', {
        action: 'recovery_recommendation',
        authority: 'local',
        selectable_set: ['recovery_recommendation'],
        selection_basis: 'recovery-routed',
      }),
    )
    render(<OperatorActionPanel />)
    expect(screen.getAllByTestId('selection-basis').at(-1)).toHaveTextContent(
      'Selected from 1 option: Recovery recommendation · recovery routed by the decision rule',
    )
  })

  it('renders no selection line for a decision recorded before spec 1.4', () => {
    useEventStore.getState().ingestDecision(makeDecision('d-old'))
    render(<OperatorActionPanel />)
    expect(screen.queryByTestId('selection-basis')).not.toBeInTheDocument()
  })
})

describe('OperatorActionPanel — compact (overview approve/deny box)', () => {
  it('keeps the action, the selection line without the option list and the buttons; drops the meta, recovery block and rationale', () => {
    const decision = ingestRecovery()
    useEventStore.getState().ingestDecision({
      ...decision,
      selectable_set: ['recovery_recommendation'],
      selection_basis: 'recovery-routed',
    })
    render(<OperatorActionPanel compact />)
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Recovery recommendation')
    expect(screen.getByText('Internal diagnosis recommendation')).toBeInTheDocument()
    expect(screen.getByTestId('selection-basis')).toHaveTextContent(
      'Selected from 1 option · recovery routed by the decision rule',
    )
    expect(screen.getByTestId('selection-basis')).not.toHaveTextContent('Recovery recommendation ·')
    expect(screen.queryByTestId('recovery-block')).not.toBeInTheDocument()
    expect(screen.queryByText('Authority')).not.toBeInTheDocument()
    expect(screen.queryByText('Internal fault on comms; recovery recommended.')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Recovery recommendation' })).toHaveClass('operator-action--compact')
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument()
  })

  it('Accept, Deny and Reconsider write the same store state as the full panel', () => {
    const decision = ingestRecovery()
    render(<OperatorActionPanel decision={decision} compact />)
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(useEventStore.getState().deferredDecisionIds.has(decision.id)).toBe(true)
    expect(screen.getByText('Denied')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reconsider' }))
    expect(useEventStore.getState().deferredDecisionIds.has(decision.id)).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(useEventStore.getState().acceptedDecisionIds.has(decision.id)).toBe(true)
    expect(useEventStore.getState().maneuverDemo).toBeNull()
    expect(screen.getByText('Accepted')).toBeInTheDocument()
  })

  it('still shows the withheld and gate chips in compact form', () => {
    useEventStore.getState().ingestDecision(
      makeDecision('d-withheld', {
        action: 'threat_warning',
        authority: 'local',
        rationale: '[gate:threat/uplink_jamming_active] Recovery withheld while jamming is active.',
        withheld_recovery: { action_id: 'reset_transponder_chain', target_subsystem: 'comms', reason_code: 'threat/uplink_jamming_active' },
      }),
    )
    render(<OperatorActionPanel compact />)
    expect(screen.getByTestId('gate-chip')).toHaveTextContent('blocked threat/uplink_jamming_active')
    expect(screen.getByTestId('withheld-chip')).toHaveTextContent(/Reset transponder chain on Comms/)
    expect(screen.queryByText('Recovery withheld while jamming is active.')).not.toBeInTheDocument()
  })
})
