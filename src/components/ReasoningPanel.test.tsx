import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReasoningPanel } from './ReasoningPanel'
import { useEventStore } from '../store/eventStore'
import { makeTrace } from '../test/factories'

beforeEach(() => {
  useEventStore.getState().reset()
})

const lineFor = (traceId: string) =>
  document.querySelector<HTMLElement>(`[data-trace-id="${traceId}"]`)

describe('ReasoningPanel — gate-blocked decide traces', () => {
  it('renders a decide-stage warn starting with "gate blocked" in the blocked style with the reason chip', () => {
    useEventStore.getState().ingestTrace(
      makeTrace('t-gate', {
        stage: 'decide',
        level: 'warn',
        message:
          'gate blocked recovery_recommendation: threat/uplink_jamming_active',
      }),
    )
    render(<ReasoningPanel />)
    const line = lineFor('t-gate')
    expect(line).toHaveClass('reasoning-line--blocked')
    expect(line).toHaveClass('reasoning-line--warn')
    expect(line).toHaveAttribute('data-blocked', 'true')
    expect(
      screen.getByText('blocked · threat/uplink_jamming_active'),
    ).toBeInTheDocument()
  })

  it('prefers a reason_code payload field over parsing the message', () => {
    useEventStore.getState().ingestTrace(
      makeTrace('t-gate-payload', {
        stage: 'decide',
        level: 'warn',
        message: 'gate blocked safe_mode_entry',
        payload: { reason_code: 'threat/hostile_close_approach' },
      }),
    )
    render(<ReasoningPanel />)
    expect(
      screen.getByText('blocked · threat/hostile_close_approach'),
    ).toBeInTheDocument()
  })

  it('does not mark an ordinary decide warn, or a fusion line mentioning the gate, as blocked', () => {
    useEventStore.getState().ingestTrace(
      makeTrace('t-warn', {
        stage: 'decide',
        level: 'warn',
        message: 'authority repaired to local',
      }),
    )
    useEventStore.getState().ingestTrace(
      makeTrace('t-fusion', {
        stage: 'fusion',
        level: 'info',
        message: 'gate blocked nothing here',
      }),
    )
    render(<ReasoningPanel />)
    expect(lineFor('t-warn')).not.toHaveClass('reasoning-line--blocked')
    expect(lineFor('t-fusion')).not.toHaveClass('reasoning-line--blocked')
    expect(screen.queryByText(/^blocked ·/)).not.toBeInTheDocument()
  })
})

describe('ReasoningPanel — verdict and physics lines', () => {
  it('renders verdict and physics_consistency from an attrib trace payload inline', () => {
    useEventStore.getState().ingestTrace(
      makeTrace('t-attrib', {
        stage: 'attrib_reconcile',
        level: 'decision',
        message: 'rule verdict internal_fault held after reconcile',
        payload: { verdict: 'internal_fault', physics_consistency: 0.83 },
      }),
    )
    render(<ReasoningPanel />)
    const verdictChip = screen.getByText('verdict · internal fault')
    expect(verdictChip).toHaveClass('reasoning-line__chip--internal_fault')
    expect(verdictChip).toHaveAttribute('data-verdict', 'internal_fault')
    expect(screen.getByText('physics · 0.83')).toBeInTheDocument()
    expect(lineFor('t-attrib')).not.toHaveClass('reasoning-line--blocked')
  })

  it('renders each verdict with its own chip class', () => {
    for (const verdict of [
      'natural_external',
      'hostile_external',
      'unknown',
    ] as const) {
      useEventStore.getState().ingestTrace(
        makeTrace(`t-${verdict}`, {
          stage: 'attrib_primary',
          payload: { verdict },
        }),
      )
    }
    render(<ReasoningPanel />)
    expect(screen.getByText('verdict · natural external')).toHaveClass(
      'reasoning-line__chip--natural_external',
    )
    expect(screen.getByText('verdict · hostile external')).toHaveClass(
      'reasoning-line__chip--hostile_external',
    )
    expect(screen.getByText('verdict · unknown')).toHaveClass(
      'reasoning-line__chip--unknown',
    )
  })

  it('renders a physics score alone, and ignores payloads with neither', () => {
    useEventStore.getState().ingestTrace(
      makeTrace('t-pc', {
        stage: 'attrib_primary',
        payload: { physics_consistency: 0.5 },
      }),
    )
    useEventStore.getState().ingestTrace(
      makeTrace('t-plain', { stage: 'fusion', payload: { window_s: 600 } }),
    )
    useEventStore.getState().ingestTrace(
      makeTrace('t-bogus', {
        stage: 'attrib_primary',
        payload: { verdict: 'sabotage', physics_consistency: 'high' },
      }),
    )
    render(<ReasoningPanel />)
    expect(screen.getByText('physics · 0.50')).toBeInTheDocument()
    expect(lineFor('t-plain')?.querySelector('.reasoning-line__chips')).toBeNull()
    expect(lineFor('t-bogus')?.querySelector('.reasoning-line__chips')).toBeNull()
  })
})
