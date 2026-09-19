import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReasoningPage } from './ReasoningPage'
import { SignalsPage } from './SignalsPage'
import { VerdictPage } from './VerdictPage'
import { useEventStore } from '../store/eventStore'
import { MockWebSocket } from '../test/mockWebSocket'
import { SIM01, makeAnomaly, makeAttribution, makeBusHealthSignal, makeDecision, makeTrace } from '../test/factories'

beforeEach(() => {
  MockWebSocket.instances = []
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket)
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  useEventStore.getState().reset()
})

afterEach(() => {
  vi.unstubAllGlobals()
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
