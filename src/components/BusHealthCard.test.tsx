import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { BusHealthCard } from './BusHealthCard'
import { useCaptureStore } from '../store/captureStore'
import { makeBusHealthSignal, makeDecision, HOSTILE_BELIEF_BASIS, SIM01 } from '../test/factories'

beforeEach(() => {
  useCaptureStore.getState().setEnabled(false)
})

describe('BusHealthCard — F2 fields', () => {
  it('shows subsystem, symptom, onset, rate with unit, the physics meter, the basis and the display name', () => {
    render(<BusHealthCard signal={makeBusHealthSignal('sig-bh-1')} />)
    const card = screen.getByTestId('bus-health-card')
    expect(card).toHaveAttribute('data-event-type', 'link_margin_drop')
    expect(screen.getByTestId('bus-health-satellite')).toHaveTextContent('SIM-01')
    expect(screen.getByTestId('bus-health-event')).toHaveTextContent('Link margin drop')
    expect(screen.getByTestId('bus-health-subsystem')).toHaveTextContent('Comms')
    expect(screen.getByTestId('bus-health-symptom')).toHaveTextContent('link margin db drop')
    expect(screen.getByTestId('bus-health-onset')).toHaveTextContent('14:32:10Z (simulation clock)')
    expect(screen.getByTestId('bus-health-rate')).toHaveTextContent('-0.42 dB/s')

    const meter = screen.getByRole('meter')
    expect(meter).toHaveAttribute('aria-valuenow', '0.83')
    expect(screen.getByTestId('bus-health-physics')).toHaveTextContent('0.83')

    const basis = screen.getByTestId('bus-health-basis')
    expect(basis).toHaveAttribute('data-basis-kind', 'belief')
    expect(within(basis).getByTestId('basis-internal')).toHaveTextContent('81%')
    expect(within(basis).getByTestId('basis-external')).toHaveTextContent('8%')
    expect(within(basis).getByTestId('basis-unknown')).toHaveTextContent('10%')
    expect(within(basis).getByTestId('basis-top')).toHaveTextContent('Amplifier degradation')
    expect(within(basis).getByTestId('basis-top')).toHaveTextContent('75%')
    expect(basis).toHaveTextContent('shape ramp')
  })

  it('shows the recommended recovery and marks it routed when the decision carries it', () => {
    render(
      <BusHealthCard
        signal={makeBusHealthSignal('sig-bh-2')}
        decision={makeDecision('dec-1', {
          action: 'recovery_recommendation',
          authority: 'local',
          recovery: {
            action_id: 'switch_redundant_amplifier',
            target_subsystem: 'comms',
            requires_approval: true,
            rationale: 'x',
            source: 'internal-diagnosis',
            satellite_id: SIM01,
          },
        })}
      />,
    )
    const recovery = screen.getByTestId('bus-health-recovery')
    expect(recovery).toHaveTextContent('Switch redundant amplifier')
    expect(recovery).toHaveTextContent('Comms · operator approval required')
    expect(recovery).toHaveTextContent('routed as decision')
    expect(recovery).toHaveTextContent('Primary amplifier output trending down; redundant unit nominal.')
  })

  it('shows the withheld chip on the recovery when the decision withheld it', () => {
    render(
      <BusHealthCard
        signal={makeBusHealthSignal('sig-bh-3', {
          observables: {
            physics_basis: HOSTILE_BELIEF_BASIS,
            physics_consistency: 0.17,
            recommended_recovery: {
              action_id: 'reset_transponder_chain',
              target_subsystem: 'comms',
              requires_approval: true,
              rationale: 'Receiver lock lost.',
            },
          },
        })}
        decision={makeDecision('dec-2', {
          action: 'threat_warning',
          withheld_recovery: {
            action_id: 'reset_transponder_chain',
            target_subsystem: 'comms',
            reason_code: 'verdict/hostile_external',
          },
        })}
      />,
    )
    expect(screen.getByTestId('withheld-chip')).toHaveTextContent(
      'Recovery withheld: Reset transponder chain on Comms: Verdict: hostile external',
    )
    expect(screen.getByTestId('basis-top')).toHaveTextContent('Uplink interference')
    expect(screen.getByTestId('basis-top').querySelector('.bus-health-card__cause--external')).not.toBeNull()
  })

  it('says so when the record carries no window, no basis and no recovery', () => {
    render(
      <BusHealthCard
        signal={makeBusHealthSignal('sig-bh-4', {
          observables: {
            rate_of_change: null,
            rate_unit: null,
            physics_basis: undefined,
            physics_consistency: 0.5,
            recommended_recovery: null,
            shape: null,
          },
        })}
      />,
    )
    expect(screen.getByTestId('bus-health-rate')).toHaveTextContent('no window')
    expect(screen.getByTestId('bus-health-basis')).toHaveTextContent('No physics basis attached.')
    expect(screen.queryByTestId('bus-health-recovery')).not.toBeInTheDocument()
  })

  it('falls back to the asset name when there is no satellite id and reads a shape-only basis', () => {
    render(
      <BusHealthCard
        signal={makeBusHealthSignal('sig-bh-5', {
          payload: { satellite_id: null, asset: 'LEO-SCIENCE-1' },
          observables: {
            physics_basis: 'shape:shape=step;shape_support=0.25;fit_quality=1.00;row=link_margin_drop;rate=step_per_interval',
          },
        })}
      />,
    )
    expect(screen.getByTestId('bus-health-satellite')).toHaveTextContent('LEO-SCIENCE-1')
    const basis = screen.getByTestId('bus-health-basis')
    expect(basis).toHaveAttribute('data-basis-kind', 'shape')
    expect(basis).toHaveTextContent('Shape evidence only')
  })
})

describe('BusHealthCard — zoomed and capture mode', () => {
  it('zoomed adds the spacecraft id, the summary and the extra basis fields', () => {
    render(<BusHealthCard signal={makeBusHealthSignal('sig-bh-6')} zoomed />)
    const card = screen.getByTestId('bus-health-card')
    expect(card).toHaveClass('bus-health-card--zoomed')
    expect(card).toHaveTextContent(SIM01)
    expect(card).toHaveTextContent('belief weight 0.60')
    expect(card).toHaveTextContent('rate slope')
    expect(card).toHaveTextContent('consistent with amplifier degradation')
  })

  it('renders the zoom link when given and hides the provenance footer in capture mode', () => {
    const { unmount } = render(
      <BusHealthCard signal={makeBusHealthSignal('sig-bh-7')} zoomHref="/signal?id=sig-bh-7" />,
    )
    expect(screen.getByRole('link', { name: 'Zoom' })).toHaveAttribute('href', '/signal?id=sig-bh-7')
    expect(screen.getByText('sig-bh-7')).toBeInTheDocument()
    unmount()

    useCaptureStore.getState().setEnabled(true)
    render(<BusHealthCard signal={makeBusHealthSignal('sig-bh-8')} />)
    expect(screen.queryByText('sig-bh-8')).not.toBeInTheDocument()
    expect(screen.queryByText('megalith-bus-health-adapter')).not.toBeInTheDocument()
  })
})
