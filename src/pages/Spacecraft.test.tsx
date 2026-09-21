import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { Spacecraft } from './Spacecraft'
import { useEventStore } from '../store/eventStore'
import { useCaptureStore } from '../store/captureStore'
import { MockWebSocket } from '../test/mockWebSocket'
import {
  HOSTILE_BELIEF_BASIS,
  SIM01,
  makeAttribution,
  makeBusHealthSignal,
  makeDecision,
} from '../test/factories'

beforeEach(() => {
  MockWebSocket.instances = []
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket)
  useEventStore.getState().reset()
  useCaptureStore.getState().setEnabled(false)
  sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const seed = (...signals: ReturnType<typeof makeBusHealthSignal>[]) => {
  const store = useEventStore.getState()
  signals.forEach((signal) => store.ingestSignal(signal))
}

const nominal = makeBusHealthSignal('bh-nominal', {
  ts: '2026-09-17T14:20:00Z',
  payload: { event_type: 'nominal', summary: 'SIM-01 link margin nominal at 8 dB.' },
  observables: { symptom: 'link_margin_db_nominal', rate_of_change: 0, recommended_recovery: null },
})
const drop = makeBusHealthSignal('bh-drop', { ts: '2026-09-17T14:32:12Z' })

const nodeState = (subsystem: string) =>
  screen.getByTestId(`subsystem-${subsystem}`).getAttribute('data-health')

describe('Spacecraft page — states', () => {
  it('shows the empty state with no bus-health records', () => {
    render(<Spacecraft />)
    expect(screen.getByText('No bus-health records yet')).toBeInTheDocument()
    expect(screen.getByTestId('brand')).toHaveTextContent('MEGALITH')
  })

  it('nominal: every chip nominal, no onset, no recovery, no verdict', () => {
    seed(nominal)
    render(<Spacecraft />)
    expect(screen.getByTestId('spacecraft-page')).toHaveAttribute('data-satellite', SIM01)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Spacecraft · SIM-01')
    for (const subsystem of ['power', 'thermal', 'comms', 'adcs', 'propulsion', 'cdh', 'payload']) {
      expect(nodeState(subsystem)).toBe('nominal')
    }
    expect(screen.getByTestId('symptom-sparkline')).toHaveAttribute('data-method', 'rate-integrated')
    expect(screen.queryByTestId('sparkline-onset')).not.toBeInTheDocument()
    expect(screen.getByTestId('recovery-state')).toHaveAttribute('data-phase', 'none')
    expect(screen.getByTestId('spacecraft-verdict')).toHaveTextContent('No verdict yet')
    expect(screen.getByTestId('spacecraft-explode')).toHaveValue('0.55')
    expect(screen.getByTestId('spacecraft-latest-report')).toHaveAttribute(
      'href',
      '/signal?id=bh-nominal',
    )
  })

  it('degraded: symptom without a verdict marks comms degraded with onset and rate', () => {
    seed(nominal, drop)
    render(<Spacecraft />)
    expect(nodeState('comms')).toBe('degraded')
    expect(nodeState('power')).toBe('nominal')
    expect(screen.getByTestId('spacecraft-symptom')).toHaveTextContent('Comms · link margin db drop')
    expect(screen.getByTestId('sparkline-onset')).toHaveTextContent('onset 14:32:10Z')
    expect(screen.getByTestId('sparkline-rate')).toHaveTextContent('rate -0.42 dB/s')
    expect(screen.getByTestId('recovery-state')).toHaveAttribute('data-phase', 'recommended')
    expect(screen.getByTestId('recovery-headline')).toHaveTextContent('Switch redundant amplifier on Comms')
    const belief = screen.getByTestId('belief-bar')
    expect(within(belief).getByTestId('belief-internal')).toHaveTextContent('81%')
    expect(within(belief).getByTestId('belief-top')).toHaveTextContent('Amplifier degradation · 75%')
    expect(within(belief).getByTestId('belief-physics')).toHaveTextContent('0.83')
  })

  it('faulted: internal-fault verdict with a routed recovery', () => {
    seed(nominal, drop)
    const store = useEventStore.getState()
    store.ingestAttribution(
      makeAttribution('att-a', {
        actor: 'None',
        confidence: 0.86,
        verdict: 'internal_fault',
        satellite_id: SIM01,
        revision: 1,
      }),
    )
    store.ingestDecision(
      makeDecision('dec-a', {
        attribution_id: 'att-a',
        action: 'recovery_recommendation',
        authority: 'local',
        recovery: {
          action_id: 'switch_redundant_amplifier',
          target_subsystem: 'comms',
          requires_approval: true,
          rationale: 'Primary amplifier output trending down; redundant unit nominal.',
        },
      }),
    )
    render(<Spacecraft requestedSatellite="SIM-01" />)
    expect(nodeState('comms')).toBe('faulted')
    expect(screen.getByTestId('spacecraft-verdict')).toHaveTextContent('Internal fault · 86%')
    expect(screen.getByTestId('spacecraft-verdict')).toHaveAttribute('data-verdict', 'internal_fault')
    expect(screen.getByTestId('recovery-state')).toHaveAttribute('data-phase', 'routed')
    // The target subsystem's chip carries the recovery's headline.
    expect(within(screen.getByTestId('subsystem-comms')).getByText(/Routed as a decision: switch redundant amplifier on comms/)).toBeInTheDocument()
    expect(within(screen.getByTestId('subsystem-power')).queryByText(/Routed as a decision/)).not.toBeInTheDocument()
    expect(screen.getByTestId('spacecraft-latest-report')).toHaveAttribute('href', '/signal?id=bh-drop')
    // An internal fault has no adversary: the literal actor "None" is not shown.
    expect(screen.queryByTestId('spacecraft-actor')).not.toBeInTheDocument()
  })

  it('withheld-recovery: hostile verdict with the recovery withheld marks comms and shows the reason', () => {
    seed(
      nominal,
      makeBusHealthSignal('bh-step', {
        ts: '2026-09-17T14:33:00Z',
        observables: {
          rate_of_change: -8,
          physics_consistency: 0.17,
          physics_basis: HOSTILE_BELIEF_BASIS,
          shape: 'step',
          recommended_recovery: {
            action_id: 'reset_transponder_chain',
            target_subsystem: 'comms',
            requires_approval: true,
            rationale: 'Receiver lock lost.',
          },
        },
      }),
    )
    const store = useEventStore.getState()
    store.ingestAttribution(
      makeAttribution('att-b', {
        actor: 'Actor-1',
        confidence: 0.81,
        verdict: 'hostile_external',
        satellite_id: SIM01,
        provisional: true,
        revision: 0,
      }),
    )
    store.ingestDecision(
      makeDecision('dec-b', {
        attribution_id: 'att-b',
        action: 'passive_defense',
        authority: 'local',
        withheld_recovery: {
          action_id: 'reset_transponder_chain',
          target_subsystem: 'comms',
          reason_code: 'verdict/hostile_external',
        },
      }),
    )
    render(<Spacecraft />)
    expect(nodeState('comms')).toBe('withheld-recovery')
    expect(screen.getByTestId('spacecraft-verdict')).toHaveTextContent('Hostile external · 81% · provisional')
    expect(screen.getByTestId('recovery-state')).toHaveAttribute('data-phase', 'withheld')
    expect(screen.getByTestId('recovery-reason')).toHaveTextContent('Withheld: Verdict: hostile external')
    expect(screen.getByTestId('recovery-reason')).toHaveTextContent('verdict/hostile_external')
    expect(within(screen.getByTestId('subsystem-comms')).getByText(/Withheld: reset transponder chain on comms/)).toBeInTheDocument()
    expect(screen.getByTestId('spacecraft-actor')).toHaveTextContent('Actor-1')
    const belief = screen.getByTestId('belief-bar')
    expect(within(belief).getByTestId('belief-external')).toHaveTextContent('79%')
    expect(within(belief).getByTestId('belief-top')).toHaveTextContent('Uplink interference · 56%')
    expect(within(belief).getByTestId('belief-top')).toHaveClass('belief__cause--external')
    // Neutral copy: the page names no product other than MEGALITH.
    expect(document.body.textContent).not.toMatch(/CANOPY/)
    expect(document.body.textContent).toMatch(/MEGALITH/)
  })

  it('follows ?sat= for a spacecraft that has no records', () => {
    seed(drop)
    render(<Spacecraft requestedSatellite="ctb://megalith.demo/sim-02" />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Spacecraft · SIM-02')
    expect(screen.getByTestId('symptom-sparkline')).toHaveAttribute('data-method', 'empty')
  })
})
