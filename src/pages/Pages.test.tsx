import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { Brigade } from './Brigade'
import { ReasoningPage } from './ReasoningPage'
import { SignalsPage } from './SignalsPage'
import { VerdictPage } from './VerdictPage'
import { OVERVIEW_LAYOUT_KEYS } from '../lib/overviewLayout'
import { useCaptureStore } from '../store/captureStore'
import { useEventStore } from '../store/eventStore'
import { MockWebSocket } from '../test/mockWebSocket'
import { SIM01, makeAnomaly, makeAttribution, makeBusHealthSignal, makeDecision, makeSignal, makeTrace } from '../test/factories'

// The globe needs WebGL; the overview test checks the grid around it.
vi.mock('../components/MapStage', () => ({
  MapStage: () => <section className="map-stage" data-testid="map-stage" aria-label="Operational map" />,
}))

const SIM02 = 'ctb://megalith.demo/sim-02'

beforeEach(() => {
  MockWebSocket.instances = []
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket)
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  useEventStore.getState().reset()
  useCaptureStore.getState().setEnabled(false)
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const seedRunC = () => {
  const store = useEventStore.getState()
  store.ingestSignal(makeSignal('sw-1', { domain: 'space_weather', payload: { event_type: 'geomagnetic_storm', summary: 'storm', observables: { kp: 7.3 } } }))
  store.ingestSignal(makeBusHealthSignal('bus-1'))
  store.ingestSignal(makeBusHealthSignal('bus-2', { payload: { satellite_id: SIM02, asset: 'SIM-02' } }))
  store.ingestAnomaly(makeAnomaly('an-1', { kind: 'bus_link_margin', ts: '2026-09-20T15:05:00Z', source_signal: 'bus-1', source_signal_ids: ['bus-1'], payload: { satellite_id: SIM01, subsystem: 'comms', physics_consistency: 0.1 } }))
  store.ingestAnomaly(makeAnomaly('an-2', { kind: 'bus_safe_mode', ts: '2026-09-20T15:07:00Z', source_signal: 'bus-2', source_signal_ids: ['bus-2'], payload: { satellite_id: SIM02, subsystem: 'power', physics_consistency: 0.7 } }))
  store.ingestAttribution(makeAttribution('att-1', { anomaly_ids: ['an-1'], actor: 'None', confidence: 0.8, verdict: 'natural_external', satellite_id: SIM01, revision: 1 }))
  store.ingestAttribution(makeAttribution('att-2', { anomaly_ids: ['an-2'], actor: 'None', confidence: 0.66, verdict: 'natural_external', satellite_id: SIM02, revision: 1 }))
  store.ingestDecision(makeDecision('dec-1', { attribution_id: 'att-1', action: 'recovery_recommendation', authority: 'local', target: 'SIM-01', recovery: { action_id: 'reduce_downlink_rate', target_subsystem: 'comms', requires_approval: false, rationale: 'Storm.', source: 'internal-diagnosis', satellite_id: SIM01 } }))
  store.ingestDecision(makeDecision('dec-2', { attribution_id: 'att-2', action: 'passive_defense', authority: 'local', target: 'SIM-02' }))
}

describe('the overview (Brigade)', () => {
  it('lays out the status line, the globe between the two columns and the reports strip; both columns collapse into rails', () => {
    seedRunC()
    render(<Brigade />)
    const overview = screen.getByTestId('overview')
    expect(screen.getByTestId('status-banner')).toBeInTheDocument()
    const children = [...overview.children]
    expect(children.map((child) => child.getAttribute('data-testid'))).toEqual([
      'side-column-left',
      'map-stage',
      'side-column-right',
      'reports-strip',
    ])
    expect(overview).toHaveAttribute('data-left', 'expanded')
    expect(overview).toHaveAttribute('data-right', 'expanded')
    expect(overview.style.getPropertyValue('--left-w')).toBe('320px')
    expect(overview.style.getPropertyValue('--right-w')).toBe('360px')

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Situation' }))
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Response' }))
    expect(overview).toHaveAttribute('data-left', 'collapsed')
    expect(overview.style.getPropertyValue('--left-w')).toBe('44px')
    expect(overview.style.getPropertyValue('--right-w')).toBe('44px')
    expect(localStorage.getItem(OVERVIEW_LAYOUT_KEYS.left)).toBe('collapsed')
    expect(localStorage.getItem(OVERVIEW_LAYOUT_KEYS.right)).toBe('collapsed')
  })

  it('shows two theater rows for two satellites, pins one, and the response column follows the pin', () => {
    seedRunC()
    render(<Brigade />)
    const rows = screen.getAllByTestId('theater-row')
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.getAttribute('data-satellite'))).toEqual(expect.arrayContaining([SIM01, SIM02]))
    // The episode follows the latest scored bus anomaly (SIM-02) until pinned.
    expect(screen.getByTestId('decision-summary')).toHaveTextContent('Passive defense')
    fireEvent.click(rows.find((row) => row.getAttribute('data-satellite') === SIM01)!)
    expect(useEventStore.getState().pinnedSatelliteId).toBe(SIM01)
    expect(screen.getByTestId('decision-summary')).toHaveTextContent('Recovery recommendation')
    expect(screen.getByRole('heading', { level: 2, name: 'Recovery recommendation' })).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('follow-latest'))
    expect(screen.getByTestId('decision-summary')).toHaveTextContent('Passive defense')
  })

  it('the reports strip carries every signal and the bus alerts, oldest left', () => {
    seedRunC()
    render(<Brigade />)
    const cards = within(screen.getByTestId('reports-track')).getAllByRole('listitem')
    expect(cards.map((card) => card.getAttribute('data-kind'))).toEqual(['report', 'report', 'alert', 'report', 'alert'])
    expect(cards[0]).toHaveTextContent('Geomagnetic storm')
    expect(cards[4]).toHaveTextContent('Alert')
    expect(cards[4]).toHaveTextContent('SIM-02')
    expect(screen.getByTestId('reports-count')).toHaveTextContent('3')
  })

  it('capture mode holds both columns open over a stored collapse and marks the toggles hidden', () => {
    localStorage.setItem(OVERVIEW_LAYOUT_KEYS.left, 'collapsed')
    localStorage.setItem(OVERVIEW_LAYOUT_KEYS.right, 'collapsed')
    useCaptureStore.getState().setEnabled(true)
    render(<Brigade />)
    const overview = screen.getByTestId('overview')
    expect(overview).toHaveAttribute('data-left', 'expanded')
    expect(overview).toHaveAttribute('data-right', 'expanded')
    for (const side of ['left', 'right']) {
      const toggle = screen.getByTestId(`side-toggle-${side}`)
      expect(toggle).toHaveAttribute('data-capture-hide')
      expect(toggle).toBeDisabled()
    }
    expect(screen.getByRole('link', { name: /Full verdict/ })).toHaveAttribute('href', '/verdict?capture=1')
  })
})

describe('detail pages', () => {
  it('the Verdict page shows the full verdict beside the decision taken on it', () => {
    const store = useEventStore.getState()
    store.ingestAnomaly(makeAnomaly('anom-1', { kind: 'bus_link_margin', payload: { satellite_id: SIM01 } }))
    store.ingestAttribution(makeAttribution('att-1', { anomaly_ids: ['anom-1'], actor: 'None', confidence: 0.8, verdict: 'internal_fault', satellite_id: SIM01, revision: 1 }))
    store.ingestDecision(makeDecision('dec-1', {
      attribution_id: 'att-1', action: 'recovery_recommendation', authority: 'local', target: 'SIM-01',
      recovery: { action_id: 'switch_redundant_amplifier', target_subsystem: 'comms', requires_approval: true, rationale: 'Primary amplifier degrading.', source: 'internal-diagnosis', satellite_id: SIM01 },
    }))
    render(<VerdictPage />)
    expect(screen.getByTestId('verdict-page')).toBeInTheDocument()
    expect(screen.getByTestId('verdict-badge')).toHaveTextContent('Internal fault')
    expect(screen.getByRole('heading', { level: 2, name: 'Recovery recommendation' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument()
  })

  it('the Verdict page follows a pinned satellite', () => {
    seedRunC()
    useEventStore.getState().pinEpisode(SIM01)
    render(<VerdictPage />)
    expect(screen.getByRole('heading', { level: 2, name: 'Recovery recommendation' })).toBeInTheDocument()
    expect(screen.getByTestId('verdict-badge')).toHaveTextContent('Natural external')
    expect(document.querySelector('.verdict-panel__subject')).toHaveTextContent('SIM-01')
  })

  it('the Reasoning page renders the trace full height', () => {
    useEventStore.getState().ingestTrace(makeTrace('t1', { stage: 'attrib_redteam', message: 'challenge: weak evidence' }))
    render(<ReasoningPage />)
    expect(screen.getByTestId('reasoning-page')).toHaveTextContent('challenge: weak evidence')
    expect(screen.getByRole('link', { name: 'Verdict page' })).toHaveAttribute('href', '/verdict')
  })

  it('the Signals page lists the signals in a table and carries the input-domain controls', () => {
    useEventStore.getState().ingestSignal(makeBusHealthSignal('sig-1'))
    render(<SignalsPage />)
    expect(screen.getByTestId('signals-table')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Link margin drop' })).toHaveAttribute('href', '/signal?id=sig-1')
    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument()
  })
})
