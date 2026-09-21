import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { EpisodeReports } from './EpisodeReports'
import { useEventStore } from '../store/eventStore'
import { SIM01, makeAnomaly, makeBusHealthSignal, makeSignal } from '../test/factories'

const SIM02 = 'ctb://megalith.demo/sim-02'

beforeEach(() => {
  useEventStore.getState().reset()
})

/** n bus reports on SIM-01, one minute apart, the newest last ingested. */
const seedReports = (n: number) => {
  const store = useEventStore.getState()
  for (let i = 0; i < n; i += 1) {
    const minute = String(i).padStart(2, '0')
    store.ingestSignal(makeBusHealthSignal(`bus-${i}`, { ts: `2026-09-20T15:${minute}:00Z` }))
  }
}

describe('EpisodeReports', () => {
  it('shows the first `limit` rows and folds the rest behind "+k more" with the count', () => {
    seedReports(7)
    render(<EpisodeReports satelliteId={SIM01} limit={4} />)
    const section = screen.getByTestId('episode-reports')
    expect(section).toHaveAttribute('data-shown', '4')
    expect(section).toHaveAttribute('data-folded', '3')
    expect(within(screen.getByTestId('episode-reports-list')).getAllByRole('listitem')).toHaveLength(4)
    const more = screen.getByTestId('episode-reports-more')
    expect(more.tagName).toBe('DETAILS')
    expect(more.querySelector('summary')).toHaveTextContent('+3 more')
    expect(within(screen.getByTestId('episode-reports-rest')).getAllByRole('listitem')).toHaveLength(3)
    // Newest first: the folded rows are the oldest.
    expect(screen.getByTestId('episode-reports-list')).toHaveTextContent('15:06:00Z')
    expect(screen.getByTestId('episode-reports-rest')).toHaveTextContent('15:00:00Z')
    // Every row still links to its signal card.
    expect(within(more).getAllByRole('link')).toHaveLength(3)
  })

  it('renders no fold when the rows fit the limit', () => {
    seedReports(3)
    render(<EpisodeReports satelliteId={SIM01} limit={4} />)
    expect(screen.getByTestId('episode-reports')).toHaveAttribute('data-folded', '0')
    expect(screen.queryByTestId('episode-reports-more')).not.toBeInTheDocument()
    expect(within(screen.getByTestId('episode-reports-list')).getAllByRole('listitem')).toHaveLength(3)
  })

  it('lists the episode spacecraft only, marks an alert on a signal, and says so while empty', () => {
    const store = useEventStore.getState()
    store.ingestSignal(makeBusHealthSignal('bus-a', { ts: '2026-09-20T15:01:00Z' }))
    store.ingestSignal(makeBusHealthSignal('bus-b', { ts: '2026-09-20T15:02:00Z', payload: { satellite_id: SIM02, asset: 'SIM-02' } }))
    store.ingestSignal(makeSignal('sw-1', { ts: '2026-09-20T15:03:00Z', domain: 'space_weather' }))
    store.ingestAnomaly(makeAnomaly('an-a', { kind: 'bus_link_margin', ts: '2026-09-20T15:01:00Z', source_signal: 'bus-a', source_signal_ids: ['bus-a'], payload: { satellite_id: SIM01 } }))
    const { rerender } = render(<EpisodeReports satelliteId={SIM01} />)
    const rows = within(screen.getByTestId('episode-reports-list')).getAllByRole('listitem')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveAttribute('data-kind', 'alert')
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Reports · SIM-01')
    rerender(<EpisodeReports satelliteId="ctb://megalith.demo/sim-09" />)
    expect(screen.getByText('No reports on this spacecraft yet.')).toBeInTheDocument()
  })
})
