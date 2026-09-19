import { describe, expect, it } from 'vitest'
import { render, within } from '@testing-library/react'
import { SignalTable } from './SignalTable'
import { makeSignal } from '../test/factories'

const busSignal = makeSignal('sig-bus', {
  domain: 'bus_health',
  source: 'internal-diagnosis',
  confidence: 0.81,
  location: { label: 'LEO-SCIENCE-1' },
  payload: {
    event_type: 'link_margin_drop',
    summary: 'LEO-SCIENCE-1 downlink margin falling 0.42 dB/s since 14:32:10Z; consistent with amplifier degradation.',
    asset: 'LEO-SCIENCE-1',
    satellite_id: 'ctb://centralblue.dev/leo-science-1',
    observables: {
      subsystem: 'comms',
      symptom: 'link_margin_db_drop',
      rate_of_change: -0.42,
      rate_unit: 'dB/s',
      physics_consistency: 0.83,
      shape: 'ramp',
    },
  },
})

const weatherSignal = makeSignal('sig-wx', {
  domain: 'space_weather',
  source: 'noaa-swpc',
  confidence: 0.9,
  location: { label: 'geospace' },
  payload: {
    event_type: 'geomagnetic_storm',
    summary: 'Geomagnetic storm in progress (G2): Kp 6.33, Dst -112 nT; valid 14:00Z to 20:00Z.',
    observables: { kp: 6.33, dst_nt: -112, f107: 158.4, severity: 0.4 },
  },
})

const orbitSignal = makeSignal('sig-orbit', { domain: 'orbit', confidence: 0.6 })

const rowFor = (container: HTMLElement, domain: string) => {
  const row = container.querySelector<HTMLElement>(`tr[data-domain="${domain}"]`)
  if (!row) throw new Error(`no row for ${domain}`)
  return row
}

describe('SignalTable — bus_health rows', () => {
  it('shows the report kind, the one-liner and the subsystem, symptom and physics facts', () => {
    const { container } = render(<SignalTable signals={[busSignal]} />)
    const row = rowFor(container, 'bus_health')
    expect(within(row).getByRole('link', { name: 'Link margin drop' })).toHaveAttribute(
      'href',
      '/signal?id=sig-bus',
    )
    const facts = within(row).getByTestId('raw-facts')
    expect(facts).toHaveTextContent('subsystem Comms')
    expect(facts).toHaveTextContent('symptom link margin db drop')
    expect(facts).toHaveTextContent('physics 0.83')
    expect(row).toHaveTextContent(
      'LEO-SCIENCE-1: link margin drop in comms at -0.42 dB/s; physics consistency 0.83.',
    )
    expect(row).toHaveTextContent('81%')
  })

  it('says so when the observables are missing instead of hiding the row', () => {
    const bare = makeSignal('sig-bare', {
      domain: 'bus_health',
      payload: { event_type: 'unexpected_reset', summary: 'reset' },
    })
    const { container } = render(<SignalTable signals={[bare]} />)
    const facts = within(rowFor(container, 'bus_health')).getByTestId('raw-facts')
    expect(facts).toHaveTextContent('subsystem Unknown subsystem')
    expect(facts).toHaveTextContent('symptom not stated')
    expect(facts).toHaveTextContent('physics not scored')
  })
})

describe('SignalTable — space_weather and other rows', () => {
  it('shows the event type and Kp for space weather', () => {
    const { container } = render(<SignalTable signals={[weatherSignal]} />)
    const facts = within(rowFor(container, 'space_weather')).getByTestId('raw-facts')
    expect(facts).toHaveTextContent('event Geomagnetic storm')
    expect(facts).toHaveTextContent('Kp 6.3')
  })

  it('renders one row per signal, newest first, with no facts strip for other domains', () => {
    const { container } = render(<SignalTable signals={[busSignal, weatherSignal, orbitSignal]} />)
    const rows = container.querySelectorAll('tbody tr')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveAttribute('data-newest', 'true')
    expect(within(rowFor(container, 'orbit')).queryByTestId('raw-facts')).not.toBeInTheDocument()
  })

  it('renders an empty state without a table when there are no signals', () => {
    const { container, getByText } = render(<SignalTable signals={[]} />)
    expect(container.querySelector('table')).toBeNull()
    expect(getByText(/No signals received yet/)).toBeInTheDocument()
  })
})
