import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { StatusBanner } from './StatusBanner'
import { DecisionSummaryCard, LatestReports, VerdictSummaryCard } from './SummaryCards'
import { useEventStore } from '../store/eventStore'
import { SIM01, makeAttribution, makeBusHealthSignal, makeDecision, makeSignal, makeTrace } from '../test/factories'

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

describe('StatusBanner', () => {
  it('says what is happening in one line: spacecraft, latest report, verdict, confidence, timing', () => {
    const store = useEventStore.getState()
    store.ingestTrace(makeTrace('t-p', { stage: 'attrib_primary', ref_id: 'att-b', payload: { latency_ms: 500, provisional: true, revision: 0 } }))
    store.ingestTrace(makeTrace('t-f', { stage: 'attrib_reconcile', ref_id: 'att-b', payload: { latency_ms: 46000, provisional: false, revision: 1 } }))
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
  it('the verdict card shows the badge, confidence, headline and actor, and links to the verdict page', () => {
    render(<VerdictSummaryCard attribution={hostile()} />)
    const card = screen.getByTestId('verdict-summary')
    expect(card).toHaveTextContent('Hostile external')
    expect(card).toHaveTextContent('80% confidence')
    expect(card).toHaveTextContent('Actor-1')
    expect(screen.getByRole('link', { name: /Full verdict/ })).toHaveAttribute('href', '/verdict')
  })

  it('the decision card shows the action, authority, the withheld recovery, and Accept / Deny that record in the store', () => {
    const decision = makeDecision('dec-b', {
      attribution_id: 'att-b',
      action: 'threat_warning',
      authority: 'local',
      target: 'SIM-01',
      withheld_recovery: { action_id: 'reset_transponder_chain', target_subsystem: 'comms', reason_code: 'threat/uplink_jamming_active' },
    })
    render(<DecisionSummaryCard decision={decision} />)
    const card = screen.getByTestId('decision-summary')
    expect(card).toHaveTextContent('Recovery withheld')
    expect(card).toHaveTextContent('Threat warning')
    expect(card).toHaveTextContent('local')
    expect(screen.getByTestId('summary-withheld')).toHaveTextContent(/Reset transponder chain on Comms/)
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(useEventStore.getState().acceptedDecisionIds.has('dec-b')).toBe(true)
    expect(card).toHaveTextContent('Accepted')
  })

  it('the reports card lists the newest few with time, kind and one line, and links to the signals page', () => {
    const signals = [makeBusHealthSignal('s-3'), makeSignal('s-2', { domain: 'space_weather', payload: { event_type: 'quiet', summary: 'quiet', observables: {} } }), makeSignal('s-1')]
    render(<LatestReports signals={signals} limit={2} />)
    const card = screen.getByTestId('latest-reports')
    expect(card.querySelectorAll('.reports__row')).toHaveLength(2)
    expect(card).toHaveTextContent('Link margin drop')
    expect(screen.getByRole('link', { name: /All 3 signals/ })).toHaveAttribute('href', '/signals')
  })
})

describe('DecisionSummaryCard — bounded response (spec 1.4)', () => {
  it('shows how many options the action was selected from and the basis, hidden in capture mode', () => {
    const decision = makeDecision('dec-sel', {
      action: 'passive_defense',
      authority: 'local',
      target: 'SIM-01',
      selectable_set: ['passive_defense', 'threat_warning', 'sda_tasking', 'active_defense_escort', 'space_link_interdiction_request'],
      selection_basis: 'model-within-set',
    })
    render(<DecisionSummaryCard decision={decision} />)
    const line = screen.getByTestId('summary-selection')
    expect(line).toHaveTextContent('Selected from 5 options · model choice within the approved set')
    expect(line).not.toHaveTextContent('Passive defense,')
    expect(line).toHaveClass('summary-card__text--muted')
    expect(line).toHaveAttribute('data-capture-hide')
  })

  it('renders no selection line when the decision carries neither field', () => {
    render(<DecisionSummaryCard decision={makeDecision('dec-old', { action: 'threat_warning', authority: 'local' })} />)
    expect(screen.queryByTestId('summary-selection')).not.toBeInTheDocument()
  })
})
