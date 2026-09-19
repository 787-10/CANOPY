import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { VerdictPanel } from './VerdictPanel'
import { useEventStore } from '../store/eventStore'
import { GATE_REASON_CODES, gateReasonLabel } from '../lib/commanderLanguage'
import { makeAttribution, makeTrace, SIM01 } from '../test/factories'

beforeEach(() => {
  useEventStore.getState().reset()
  sessionStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

const provisional = (id = 'att-p') =>
  makeAttribution(id, {
    actor: 'None',
    confidence: 0.7,
    verdict: 'internal_fault',
    verdict_basis: 'rule',
    physics_consistency: 0.83,
    satellite_id: SIM01,
    provisional: true,
    revision: 0,
  })

const final = (id = 'att-p') =>
  makeAttribution(id, {
    actor: 'None',
    confidence: 0.86,
    verdict: 'internal_fault',
    verdict_basis: 'reasoning',
    verdict_evidence: ['ramp shape, rising amplifier temperature'],
    physics_consistency: 0.83,
    satellite_id: SIM01,
    provisional: false,
    revision: 1,
  })

describe('VerdictPanel — F3 provisional badge, revision and timing', () => {
  it('shows PROVISIONAL and rev 0 while the attribution is provisional', () => {
    render(<VerdictPanel attribution={provisional()} />)
    expect(screen.getByTestId('provisional-badge')).toHaveTextContent(/provisional/i)
    expect(screen.getByTestId('verdict-revision')).toHaveTextContent('rev 0')
    expect(screen.getByLabelText('Verdict').closest('section') ?? document.body).toBeTruthy()
    const panel = document.querySelector('.verdict-panel')
    expect(panel).toHaveAttribute('data-provisional', 'true')
    expect(panel).toHaveAttribute('data-revision', '0')
  })

  it('drops the badge and reads rev 1 · final once the reasoning lane republishes the id', () => {
    render(<VerdictPanel attribution={final()} />)
    expect(screen.queryByTestId('provisional-badge')).not.toBeInTheDocument()
    expect(screen.getByTestId('verdict-revision')).toHaveTextContent('rev 1 · final')
    expect(document.querySelector('.verdict-panel')).not.toHaveAttribute('data-provisional')
  })

  it('reads "provisional in N ms" and "final in M ms" from the attrib traces of this id', () => {
    const store = useEventStore.getState()
    store.ingestTrace(
      makeTrace('t-prov', {
        stage: 'attrib_primary',
        level: 'decision',
        ref_id: 'att-p',
        message: 'provisional verdict=internal_fault confidence=0.70 basis=rule (fast lane, no LLM)',
        payload: { latency_ms: 42.6, stage_ms: 3.1, provisional: true, revision: 0 },
      }),
    )
    store.ingestTrace(
      makeTrace('t-other', {
        stage: 'attrib_reconcile',
        ref_id: 'att-other',
        payload: { latency_ms: 999, revision: 1 },
      }),
    )
    store.ingestTrace(
      makeTrace('t-final', {
        stage: 'attrib_reconcile',
        ref_id: 'att-p',
        message: 'final actor=None confidence=0.86 verdict=internal_fault basis=reasoning pc=0.83',
        payload: { latency_ms: 5120.4, stage_ms: 4900, provisional: false, revision: 1 },
      }),
    )
    render(<VerdictPanel attribution={final()} />)
    expect(screen.getByTestId('timing-provisional')).toHaveTextContent('43 ms')
    expect(screen.getByTestId('timing-final')).toHaveTextContent('5,120 ms')
    expect(screen.getByTestId('timing-final')).toHaveTextContent('rev 1')
  })

  it('reports pending / n/a instead of inventing numbers when no trace carries them', () => {
    render(<VerdictPanel attribution={provisional()} />)
    expect(screen.getByTestId('timing-provisional')).toHaveTextContent('awaiting trace')
    expect(screen.getByTestId('timing-final')).toHaveTextContent('pending')
    expect(screen.getByTestId('timing-display')).toHaveTextContent('not measured')
  })

  it('measures arrival-to-display on the client from the WebSocket receipt stamp of this revision', () => {
    const now = vi.spyOn(performance, 'now')
    // Receipt stamped at t=1000 ms; the panel commits at t=1012.5 ms.
    useEventStore.getState().noteAttributionArrival('att-p', 1, 1000)
    now.mockReturnValue(1012.5)
    render(<VerdictPanel attribution={final()} />)
    expect(screen.getByTestId('timing-display')).toHaveTextContent('+12.5 ms')
  })

  it('does not reuse the provisional receipt for the final revision', () => {
    const now = vi.spyOn(performance, 'now')
    useEventStore.getState().noteAttributionArrival('att-p', 0, 1000)
    now.mockReturnValue(2000)
    render(<VerdictPanel attribution={final()} />)
    expect(screen.getByTestId('timing-display')).toHaveTextContent('not measured')
  })
})

describe('gate reason labels', () => {
  it('labels the two verdict reason codes exactly as the spec words them', () => {
    expect(gateReasonLabel('verdict/hostile_external')).toBe('Verdict: hostile external')
    expect(gateReasonLabel('verdict/unknown')).toBe('Verdict: unknown')
    expect(GATE_REASON_CODES).toHaveLength(6)
  })
})
