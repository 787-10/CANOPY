import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { StatusBanner } from './StatusBanner'
import { DecisionSummaryCard, VerdictSummaryCard } from './SummaryCards'
import { ResponseColumn } from './overview/ResponseColumn'
import { useEventStore } from '../store/eventStore'
import { SIM01, makeAttribution, makeBusHealthSignal, makeDecision, makeTrace } from '../test/factories'

beforeEach(() => {
  useEventStore.getState().reset()
})

const hostile = () =>
  makeAttribution('att-b', {
    actor: 'Actor-1',
    confidence: 0.8,
    verdict: 'hostile_external',
    satellite_id: SIM01,
    revision: 1,
    provisional: false,
  })

const ingestTimingTraces = () => {
  const store = useEventStore.getState()
  store.ingestTrace(makeTrace('t-p', { stage: 'attrib_primary', ref_id: 'att-b', payload: { latency_ms: 500, provisional: true, revision: 0 } }))
  store.ingestTrace(makeTrace('t-f', { stage: 'attrib_reconcile', ref_id: 'att-b', payload: { latency_ms: 46000, provisional: false, revision: 1 } }))
}

describe('StatusBanner', () => {
  it('says what is happening in one line: spacecraft, latest report, verdict, confidence, timing', () => {
    ingestTimingTraces()
    render(<StatusBanner report={makeBusHealthSignal('sig-1')} attribution={hostile()} />)
    const banner = screen.getByTestId('status-banner')
    expect(banner).toHaveTextContent('SIM-01')
    expect(screen.getByTestId('status-verdict')).toHaveTextContent('Hostile external')
    expect(banner).toHaveTextContent('80% · final')
    expect(banner).toHaveTextContent('Actor-1')
    expect(screen.getByTestId('status-timing')).toHaveTextContent('provisional in 500 ms · final in 46.0 s')
  })

  it('is honest while nothing has arrived', () => {
    render(<StatusBanner report={null} attribution={null} />)
    expect(screen.getByTestId('status-banner')).toHaveTextContent('No verdict yet')
    expect(screen.getByTestId('status-banner')).toHaveTextContent('No reports received yet')
  })
})

describe('summary cards', () => {
  it('the verdict card shows the badge, a confidence bar, the revision, the timing and the actor, and links to the verdict page', () => {
    ingestTimingTraces()
    render(<VerdictSummaryCard attribution={hostile()} />)
    const card = screen.getByTestId('verdict-summary')
    expect(card).toHaveTextContent('Hostile external')
    expect(card).toHaveTextContent('80% confidence')
    expect(card).toHaveTextContent('Actor-1')
    const bar = screen.getByTestId('summary-confidence-bar')
    expect(bar).toHaveAttribute('aria-valuenow', '80')
    expect(bar.querySelector('.summary-card__bar-fill')).toHaveStyle({ width: '80%' })
    expect(screen.getByTestId('summary-timing')).toHaveTextContent('rev 1 · final')
    expect(screen.getByTestId('summary-timing')).toHaveTextContent('provisional in 500 ms · final in 46.0 s')
    expect(screen.getByRole('link', { name: /Full verdict/ })).toHaveAttribute('href', '/verdict')
  })

  it('the verdict card reads "pending" for timings the traces do not carry yet', () => {
    render(<VerdictSummaryCard attribution={{ ...hostile(), provisional: true, revision: 0 }} />)
    expect(screen.getByTestId('summary-timing')).toHaveTextContent('rev 0 · provisional')
    expect(screen.getByTestId('summary-timing')).toHaveTextContent('provisional pending · final pending')
    expect(screen.getByTestId('verdict-summary')).toHaveAttribute('data-provisional', 'true')
  })

  it('the decision card shows the action, authority, the gate state, the withheld recovery, and Accept / Deny that record in the store', () => {
    const decision = makeDecision('dec-b', {
      attribution_id: 'att-b',
      action: 'threat_warning',
      authority: 'local',
      target: 'SIM-01',
      rationale: '[gate:threat/uplink_jamming_active] Recovery on comms withheld while uplink jamming is active.',
      withheld_recovery: { action_id: 'reset_transponder_chain', target_subsystem: 'comms', reason_code: 'threat/uplink_jamming_active' },
    })
    render(<DecisionSummaryCard decision={decision} />)
    const card = screen.getByTestId('decision-summary')
    expect(card).toHaveTextContent('Recovery withheld')
    expect(card).toHaveTextContent('Threat warning')
    expect(card).toHaveTextContent('local')
    expect(card).toHaveAttribute('data-gate', 'blocked')
    expect(screen.getByTestId('summary-gate')).toHaveTextContent('Gate blocked: Active jamming detected')
    expect(screen.getByTestId('summary-withheld')).toHaveTextContent(/Reset transponder chain on Comms/)
    expect(screen.getByRole('link', { name: /Reasoning/ })).toHaveAttribute('href', '/reasoning')
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(useEventStore.getState().acceptedDecisionIds.has('dec-b')).toBe(true)
    expect(card).toHaveTextContent('Accepted')
  })

  it('the decision card can leave the buttons to the action panel above it', () => {
    render(<DecisionSummaryCard decision={makeDecision('dec-q', { action: 'passive_defense', authority: 'local' })} actions={false} />)
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
    expect(screen.getByTestId('summary-gate')).toHaveTextContent('Gate clear')
  })
})

describe('DecisionSummaryCard — bounded response (spec 1.4)', () => {
  it('shows how many options the action was selected from (hidden in capture mode) and the basis in words on the gate line', () => {
    const decision = makeDecision('dec-sel', {
      action: 'passive_defense',
      authority: 'local',
      target: 'SIM-01',
      selectable_set: ['passive_defense', 'threat_warning', 'sda_tasking', 'active_defense_escort', 'space_link_interdiction_request'],
      selection_basis: 'model-within-set',
    })
    render(<DecisionSummaryCard decision={decision} />)
    const line = screen.getByTestId('summary-selection')
    expect(line).toHaveTextContent('Selected from 5 options')
    expect(line).not.toHaveTextContent('Passive defense,')
    expect(line).toHaveClass('summary-card__text--muted')
    expect(line).toHaveAttribute('data-capture-hide')
    expect(screen.getByTestId('summary-gate')).toHaveTextContent('Gate clear · model choice within the approved set')
    expect(screen.getByTestId('summary-gate')).not.toHaveAttribute('data-capture-hide')
  })

  it('does not repeat a gate-withheld basis on the gate line', () => {
    render(
      <DecisionSummaryCard
        decision={makeDecision('dec-gated', {
          action: 'threat_warning',
          authority: 'local',
          rationale: '[gate:threat/uplink_jamming_active] reset the radio',
          selectable_set: ['threat_warning'],
          selection_basis: 'gate-withheld:threat/uplink_jamming_active',
        })}
      />,
    )
    expect(screen.getByTestId('summary-gate')).toHaveTextContent('Gate blocked: Active jamming detected')
    expect(screen.getByTestId('summary-gate').textContent).not.toMatch(/·/)
  })

  it('renders no selection line when the decision carries neither field', () => {
    render(<DecisionSummaryCard decision={makeDecision('dec-old', { action: 'threat_warning', authority: 'local' })} />)
    expect(screen.queryByTestId('summary-selection')).not.toBeInTheDocument()
  })
})

describe('ResponseColumn', () => {
  it('stacks the compact action panel over the verdict and decision cards, with one Accept / Deny pair', () => {
    const decision = makeDecision('dec-b', { attribution_id: 'att-b', action: 'threat_warning', authority: 'local', target: 'SIM-01' })
    useEventStore.getState().ingestDecision(decision)
    render(<ResponseColumn attribution={hostile()} decision={decision} />)
    const column = screen.getByTestId('response-column')
    expect(column.firstElementChild).toHaveClass('operator-action--compact')
    expect(screen.getByTestId('verdict-summary')).toBeInTheDocument()
    expect(screen.getByTestId('decision-summary')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Accept' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Deny' })).toHaveLength(1)
  })

  it('says what is coming while no decision exists', () => {
    render(<ResponseColumn attribution={null} decision={null} />)
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
    expect(screen.getByTestId('verdict-summary')).toHaveTextContent('provisional verdict')
    expect(screen.getByTestId('decision-summary')).toHaveTextContent('The decision follows the verdict')
  })
})
