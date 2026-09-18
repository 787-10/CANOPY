import { beforeAll, describe, expect, it } from 'vitest'
import { render, within } from '@testing-library/react'
import { EventFeed } from './EventFeed'
import { makeSignal } from '../test/factories'

// jsdom has no Element.scrollTo; the raw tail scrolls to the newest entry
// on every render.
beforeAll(() => {
  if (typeof Element.prototype.scrollTo !== 'function') {
    Element.prototype.scrollTo = () => {}
  }
})

const busSignal = makeSignal('sig-bus', {
  domain: 'bus_health',
  source: 'internal-diagnosis',
  confidence: 0.81,
  location: { label: 'LEO-SCIENCE-1' },
  payload: {
    event_type: 'link_margin_drop',
    summary:
      'LEO-SCIENCE-1 downlink margin falling 0.42 dB/s since 14:32:10Z; consistent with amplifier degradation.',
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
    summary:
      'Geomagnetic storm in progress (G2): Kp 6.33, Dst -112 nT; valid 14:00Z to 20:00Z.',
    observables: {
      kp: 6.33,
      dst_nt: -112,
      f107: 158.4,
      severity: 0.4,
    },
  },
})

const orbitSignal = makeSignal('sig-orbit', { domain: 'orbit', confidence: 0.6 })

const rowFor = (container: HTMLElement, domain: string) => {
  const entry = container.querySelector<HTMLElement>(
    `.event-feed__raw-entry[data-domain="${domain}"]`,
  )
  if (!entry) throw new Error(`no raw entry for ${domain}`)
  return entry
}

describe('EventFeed — bus_health rows', () => {
  it('carries the domain colour hook and shows subsystem, symptom and physics consistency', () => {
    const { container } = render(<EventFeed signals={[busSignal]} />)
    const row = rowFor(container, 'bus_health')
    expect(row).toHaveAttribute('data-domain', 'bus_health')
    expect(within(row).getByText('Link margin drop')).toBeInTheDocument()
    const facts = within(row).getByTestId('raw-facts')
    expect(facts).toHaveTextContent('subsystem Comms')
    expect(facts).toHaveTextContent('symptom link margin db drop')
    expect(facts).toHaveTextContent('physics 0.83')
    expect(facts.querySelectorAll('.event-feed__raw-fact')).toHaveLength(3)
    // One-liner reads the observables, not the raw summary.
    expect(row).toHaveTextContent(
      'LEO-SCIENCE-1: link margin drop in comms at -0.42 dB/s; physics consistency 0.83.',
    )
  })

  it('says so when the observables are missing instead of hiding the row', () => {
    const bare = makeSignal('sig-bare', {
      domain: 'bus_health',
      payload: { event_type: 'unexpected_reset', summary: 'reset' },
    })
    const { container } = render(<EventFeed signals={[bare]} />)
    const facts = within(rowFor(container, 'bus_health')).getByTestId('raw-facts')
    expect(facts).toHaveTextContent('subsystem Unknown subsystem')
    expect(facts).toHaveTextContent('symptom not stated')
    expect(facts).toHaveTextContent('physics not scored')
  })
})

describe('EventFeed — space_weather rows', () => {
  it('shows the event type and Kp', () => {
    const { container } = render(<EventFeed signals={[weatherSignal]} />)
    const row = rowFor(container, 'space_weather')
    expect(row).toHaveAttribute('data-domain', 'space_weather')
    const facts = within(row).getByTestId('raw-facts')
    expect(facts).toHaveTextContent('event Geomagnetic storm')
    expect(facts).toHaveTextContent('Kp 6.3')
    expect(facts.querySelectorAll('.event-feed__raw-fact')).toHaveLength(2)
    expect(row).toHaveTextContent(
      'Geomagnetic storm with Kp 6.3, Dst -112 nT; weigh environmental cause.',
    )
  })
})

describe('EventFeed — other domains', () => {
  it('renders no facts strip for a domain outside the two spacecraft-environment vocabularies', () => {
    const { container } = render(
      <EventFeed signals={[busSignal, weatherSignal, orbitSignal]} />,
    )
    expect(container.querySelectorAll('.event-feed__raw-entry')).toHaveLength(3)
    expect(
      within(rowFor(container, 'orbit')).queryByTestId('raw-facts'),
    ).not.toBeInTheDocument()
    expect(container.querySelectorAll('[data-testid="raw-facts"]')).toHaveLength(2)
  })
})
