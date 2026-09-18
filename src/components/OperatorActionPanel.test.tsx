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

  it('Accept on a counterspace action still starts the maneuver demo (regression guard)', () => {
    const decision = makeDecision('d-escort', {
      action: 'active_defense_escort',
      request_packet: {
        pre_miss_km: 12,
        post_miss_km: 90,
        recommended_burn: { dv_m_s: 2.5, sat: 'SAT-BRAVO', against: 'OBJ-7' },
      },
    })
    useEventStore.getState().ingestDecision(decision)
    render(<OperatorActionPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    const demo = useEventStore.getState().maneuverDemo
    expect(demo?.decisionId).toBe('d-escort')
    expect(demo?.demoType).toBe('evasion')
    expect(demo?.preMissKm).toBe(12)
    expect(demo?.postMissKm).toBe(90)
    expect(demo?.dvMs).toBe(2.5)
    expect(demo?.friendlyLabel).toBe('SAT-BRAVO')
    expect(demo?.hostileLabel).toBe('OBJ-7')
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
    expect(screen.getByText('Engine recommendation · gate blocked')).toBeInTheDocument()
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
