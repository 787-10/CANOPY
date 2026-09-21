import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { VerdictPage } from './VerdictPage'
import { useEventStore } from '../store/eventStore'
import { MockWebSocket } from '../test/mockWebSocket'
import { SIM01, makeAnomaly, makeAttribution, makeBusHealthSignal, makeDecision } from '../test/factories'

beforeEach(() => {
  MockWebSocket.instances = []
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket)
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  useEventStore.getState().reset()
  sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const seed = () => {
  const store = useEventStore.getState()
  for (let i = 0; i < 8; i += 1) {
    store.ingestSignal(makeBusHealthSignal(`bus-${i}`, { ts: `2026-09-20T15:0${i}:00Z` }))
  }
  // The alert rides on bus-0's row: the list stays eight rows long.
  store.ingestAnomaly(makeAnomaly('anom-1', { kind: 'bus_link_margin', ts: '2026-09-20T15:00:00Z', source_signal: 'bus-0', source_signal_ids: ['bus-0'], payload: { satellite_id: SIM01 } }))
  store.ingestAttribution(
    makeAttribution('att-1', {
      anomaly_ids: ['anom-1'],
      actor: 'None',
      confidence: 0.8,
      verdict: 'internal_fault',
      verdict_basis: 'reasoning',
      verdict_evidence: ['cited 1', 'cited 2', 'cited 3', 'cited 4'],
      evidence: ['evidence 1', 'evidence 2', 'evidence 3', 'evidence 4', 'evidence 5', 'evidence 6'],
      satellite_id: SIM01,
      revision: 1,
    }),
  )
  store.ingestDecision(
    makeDecision('dec-1', {
      attribution_id: 'att-1',
      action: 'recovery_recommendation',
      authority: 'local',
      target: 'SIM-01',
      recovery: { action_id: 'switch_redundant_amplifier', target_subsystem: 'comms', requires_approval: true, rationale: 'Primary amplifier degrading.', source: 'internal-diagnosis', satellite_id: SIM01 },
    }),
  )
}

const setWindowHeight = (height: number) => {
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height })
  window.dispatchEvent(new Event('resize'))
}

// The page's budgets (src/pages/VerdictPage.tsx): lines in view before the
// fold at a window of at least 1000px (the 1080 capture) and below it.
const TALL = { cited: 3, evidence: 5, reports: 6 }
const SHORT = { cited: 2, evidence: 3, reports: 4 }

describe('VerdictPage — the content fits the window height', () => {
  it('folds the evidence, the cited lines and the reports to the window budget, and refolds on resize', () => {
    seed()
    setWindowHeight(900)
    render(<VerdictPage />)
    const page = document.querySelector('.verdict-page')
    expect(page).toHaveAttribute('data-fit', 'short')
    expect(screen.getByTestId('evidence').querySelectorAll('li')).toHaveLength(SHORT.evidence)
    expect(screen.getByTestId('evidence-more').querySelector('summary')).toHaveTextContent(`+${6 - SHORT.evidence} more`)
    expect(screen.getByTestId('verdict-evidence').querySelectorAll('li')).toHaveLength(SHORT.cited)
    expect(screen.getByTestId('verdict-evidence-more').querySelector('summary')).toHaveTextContent(`+${4 - SHORT.cited} more`)
    expect(screen.getByTestId('episode-reports')).toHaveAttribute('data-shown', String(SHORT.reports))
    expect(screen.getByTestId('episode-reports')).toHaveAttribute('data-folded', String(8 - SHORT.reports))
    // Nothing left the page: the folds carry every remaining line.
    expect(screen.getByTestId('evidence-rest')).toHaveTextContent('evidence 6')
    expect(screen.getByTestId('episode-reports-rest')).toHaveTextContent('15:00:00Z')
    // The film's test ids are still where the script looks for them.
    for (const id of ['verdict-badge', 'verdict-timing', 'physics-consistency', 'verdict-evidence', 'evidence']) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument()

    // The 1080 capture height: more lines in view, the folds shrink.
    act(() => setWindowHeight(1080))
    expect(page).toHaveAttribute('data-fit', 'tall')
    expect(screen.getByTestId('evidence').querySelectorAll('li')).toHaveLength(TALL.evidence)
    expect(screen.getByTestId('evidence-more').querySelector('summary')).toHaveTextContent(`+${6 - TALL.evidence} more`)
    expect(screen.getByTestId('verdict-evidence').querySelectorAll('li')).toHaveLength(TALL.cited)
    expect(screen.getByTestId('episode-reports')).toHaveAttribute('data-shown', String(TALL.reports))
    expect(screen.getByTestId('episode-reports')).toHaveAttribute('data-folded', String(8 - TALL.reports))

    // Exactly at the threshold the tall budget applies; one pixel under it, the short one.
    act(() => setWindowHeight(1000))
    expect(page).toHaveAttribute('data-fit', 'tall')
    act(() => setWindowHeight(999))
    expect(page).toHaveAttribute('data-fit', 'short')
  })
})
