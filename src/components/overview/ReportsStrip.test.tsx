import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { ReportsStrip } from './ReportsStrip'
import { useCaptureStore } from '../../store/captureStore'
import { makeAnomaly, makeBusHealthSignal, makeSignal, SIM01 } from '../../test/factories'

beforeEach(() => {
  useCaptureStore.getState().setEnabled(false)
})

describe('ReportsStrip', () => {
  it('lays the reports out oldest to newest with alerts after their source, and links each card to its signal', () => {
    const signals = [
      makeSignal('s3', { domain: 'space_weather', payload: { event_type: 'geomagnetic_storm', summary: 'storm', observables: { kp: 7 } } }),
      makeBusHealthSignal('s2'),
      makeSignal('s1', { domain: 'rf_ew', payload: { event_type: 'rf_interference', summary: 'rf' } }),
    ]
    const anomalies = [
      makeAnomaly('an-bus', { kind: 'bus_link_margin', source_signal: 's2', source_signal_ids: ['s2'], payload: { satellite_id: SIM01 } }),
      makeAnomaly('an-storm', { kind: 'space_weather_storm', source_signal: 's3', source_signal_ids: ['s3'] }),
    ]
    render(<ReportsStrip signals={signals} anomalies={anomalies} />)
    const track = screen.getByTestId('reports-track')
    const cards = within(track).getAllByRole('listitem')
    expect(cards.map((card) => card.getAttribute('data-kind'))).toEqual(['report', 'report', 'alert', 'report'])
    expect(cards[0]).toHaveTextContent('RF interference')
    expect(cards[2]).toHaveTextContent('Alert')
    expect(cards[2]).toHaveTextContent('Link margin drop')
    expect(cards[2]).toHaveTextContent('SIM-01')
    expect(cards[3]).toHaveTextContent('Space weather')
    expect(within(cards[2]).getByRole('link')).toHaveAttribute('href', '/signal?id=s2')
    expect(screen.getByTestId('reports-count')).toHaveTextContent('3')
    expect(screen.getByTestId('alerts-count')).toHaveTextContent('1 alert')
    expect(screen.getByRole('link', { name: /All signals/ })).toHaveAttribute('href', '/signals')
    expect(screen.getByTestId('reports-strip')).toHaveAttribute('data-newest', 'signal:s3')
  })

  it('shows the newest 24 of many, and no more', () => {
    const signals = Array.from({ length: 30 }, (_, index) => makeSignal(`s${29 - index}`))
    render(<ReportsStrip signals={signals} anomalies={[]} />)
    const cards = within(screen.getByTestId('reports-track')).getAllByRole('listitem')
    expect(cards).toHaveLength(24)
    expect(cards[0]).toHaveTextContent(`signal s6`.replace('signal s6', 'Satellite proximity'))
    expect(screen.getByTestId('reports-strip')).toHaveAttribute('data-newest', 'signal:s29')
  })

  it('animates only cards that arrive after the first paint', () => {
    const { rerender } = render(<ReportsStrip signals={[makeSignal('s1')]} anomalies={[]} />)
    const first = within(screen.getByTestId('reports-track')).getAllByRole('listitem')
    expect(first[0]).not.toHaveClass('report-card--enter')
    rerender(<ReportsStrip signals={[makeSignal('s2'), makeSignal('s1')]} anomalies={[]} />)
    const cards = within(screen.getByTestId('reports-track')).getAllByRole('listitem')
    expect(cards[0]).not.toHaveClass('report-card--enter')
    expect(cards[1]).toHaveClass('report-card--enter')
  })

  it('carries capture=1 on its links in capture mode and says so when empty', () => {
    useCaptureStore.getState().setEnabled(true)
    render(<ReportsStrip signals={[makeSignal('s1')]} anomalies={[]} />)
    expect(screen.getByRole('link', { name: /All signals/ })).toHaveAttribute('href', '/signals?capture=1')
    useCaptureStore.getState().setEnabled(false)
    render(<ReportsStrip signals={[]} anomalies={[]} />)
    expect(screen.getByText('Waiting for the first report.')).toBeInTheDocument()
  })
})
