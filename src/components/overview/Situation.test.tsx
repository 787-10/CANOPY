import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { SituationColumn } from './SituationColumn'
import { TheatersSection } from './TheatersSection'
import { useEventStore } from '../../store/eventStore'
import { makeAnomaly, makeAttribution, makeSignal, makeTrace, SIM01 } from '../../test/factories'

const SIM02 = 'ctb://megalith.demo/sim-02'

beforeEach(() => {
  useEventStore.getState().reset()
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('TheatersSection', () => {
  it('lists one row per incident with verdict, confidence, revision and marking, pins on click and clears with Follow latest', () => {
    const store = useEventStore.getState()
    store.ingestAttribution(makeAttribution('a1', { satellite_id: SIM01, verdict: 'hostile_external', confidence: 0.8, revision: 1, marking: 'CUI', ts: '2026-09-20T15:05:00Z' }))
    store.ingestAttribution(makeAttribution('a2', { satellite_id: SIM02, verdict: 'natural_external', confidence: 0.66, revision: 2, ts: '2026-09-20T15:07:00Z' }))
    store.ingestAttribution(makeAttribution('cue', { satellite_id: null, candidate_satellite_ids: [SIM01, SIM02], verdict: 'unknown', confidence: 0.4, ts: '2026-09-20T15:08:00Z' }))
    render(<TheatersSection open onToggle={() => {}} />)
    const rows = screen.getAllByTestId('theater-row')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('SIM-01 or SIM-02, unresolved')
    expect(rows[0]).toBeDisabled()
    expect(rows[1]).toHaveTextContent('SIM-02')
    expect(rows[1]).toHaveTextContent('Natural external')
    expect(rows[1]).toHaveTextContent('66%')
    expect(rows[1]).toHaveTextContent('rev 2')
    expect(rows[2]).toHaveTextContent('SIM-01')
    expect(within(rows[2]).getByTestId('theater-marking')).toHaveTextContent('CUI')
    expect(within(rows[1]).queryByTestId('theater-marking')).not.toBeInTheDocument()
    expect(screen.getByTestId('theaters')).toHaveTextContent('Theaters3')
    expect(screen.queryByTestId('follow-latest')).not.toBeInTheDocument()

    fireEvent.click(rows[2])
    expect(useEventStore.getState().pinnedSatelliteId).toBe(SIM01)
    expect(screen.getAllByTestId('theater-row')[2]).toHaveClass('theater--pinned')
    expect(screen.getAllByTestId('theater-row')[2]).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByTestId('follow-latest'))
    expect(useEventStore.getState().pinnedSatelliteId).toBeNull()
    expect(screen.queryByTestId('follow-latest')).not.toBeInTheDocument()
  })

  it('shows a single incident and an honest empty state', () => {
    const { unmount } = render(<TheatersSection open onToggle={() => {}} />)
    expect(screen.getByText('No incident yet')).toBeInTheDocument()
    unmount()
    useEventStore.getState().ingestAttribution(makeAttribution('a1', { satellite_id: SIM01, verdict: 'internal_fault' }))
    render(<TheatersSection open onToggle={() => {}} />)
    expect(screen.getAllByTestId('theater-row')).toHaveLength(1)
  })
})

describe('SituationColumn', () => {
  it('opens Theaters by default, the others on click, and fills Spacecraft and Environment from the store', () => {
    const store = useEventStore.getState()
    store.ingestAnomaly(makeAnomaly('b1', { kind: 'bus_link_margin', ts: '2026-09-20T15:05:00Z', payload: { satellite_id: SIM01, subsystem: 'comms', symptom: 'link_margin_db_drop', physics_consistency: 0.34 } }))
    store.ingestAnomaly(makeAnomaly('b2', { kind: 'bus_link_margin', ts: '2026-09-20T15:06:00Z', payload: { satellite_id: SIM01, subsystem: 'comms', symptom: 'link_margin_db_drop', physics_consistency: 0.1 } }))
    store.ingestSignal(makeSignal('sw', { domain: 'space_weather', payload: { event_type: 'geomagnetic_storm', summary: 'storm', observables: { kp: 7.3 } } }))
    store.ingestTrace(makeTrace('t-stress', { stage: 'stress', level: 'warn', message: 'input dropped: rf_ew blocked', payload: { domain: 'rf_ew' } }))
    render(<SituationColumn satelliteId={SIM01} />)

    const theaters = within(screen.getByTestId('theaters')).getByRole('button')
    const spacecraft = within(screen.getByTestId('spacecraft')).getByRole('button', { name: /Spacecraft/ })
    const environment = within(screen.getByTestId('environment')).getByRole('button', { name: /Environment/ })
    expect(theaters).toHaveAttribute('aria-expanded', 'true')
    expect(spacecraft).toHaveAttribute('aria-expanded', 'false')
    expect(environment).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(spacecraft)
    expect(spacecraft).toHaveAttribute('aria-expanded', 'true')
    const facts = screen.getByTestId('spacecraft-facts')
    expect(facts).toHaveTextContent('Link margin drop · Comms')
    expect(facts).not.toHaveTextContent('link margin db drop')
    expect(screen.getByTestId('spacecraft')).toHaveTextContent('SIM-01')
    expect(screen.getByTestId('spacecraft-physics')).toHaveTextContent('0.10')
    expect(screen.getAllByTestId('fleet-row')[0]).toHaveAttribute('data-state', 'symptomatic')
    expect(screen.getAllByTestId('fleet-row')[0]).toHaveAttribute('aria-current', 'true')
    expect(screen.getByTestId('sparkline')).toHaveAttribute('data-points', '2')
    expect(screen.getByRole('link', { name: /Spacecraft page/ })).toHaveAttribute('href', '/spacecraft?sat=SIM-01')

    fireEvent.click(environment)
    expect(screen.getByTestId('environment-weather')).toHaveTextContent('Geomagnetic storm · Kp 7.3')
    expect(screen.getByTestId('environment-denied')).toHaveTextContent('EW interference')
    expect(screen.getByRole('link', { name: /Signals and inputs/ })).toHaveAttribute('href', '/signals')

    // Toggling Theaters closed hides its body but keeps its state local.
    fireEvent.click(theaters)
    expect(theaters).toHaveAttribute('aria-expanded', 'false')
  })

  it('says "none denied" and "No bus symptom yet" with nothing to show', () => {
    render(<SituationColumn satelliteId={null} />)
    fireEvent.click(within(screen.getByTestId('spacecraft')).getByRole('button', { name: /Spacecraft/ }))
    fireEvent.click(within(screen.getByTestId('environment')).getByRole('button', { name: /Environment/ }))
    expect(screen.getByText('No bus symptom yet')).toBeInTheDocument()
    // The fleet is listed before any report, all quiet.
    const rows = screen.getAllByTestId('fleet-row')
    expect(rows.map((row) => row.getAttribute('data-state'))).toEqual(['quiet', 'quiet', 'quiet'])
    expect(rows[0]).toHaveTextContent('SIM-01')
    expect(rows[0]).toHaveTextContent('no reports yet')
    // Any fleet member can be followed on the globe, incident or not; the name opens the body.
    const follows = screen.getAllByTestId('fleet-follow')
    fireEvent.click(follows[2])
    expect(useEventStore.getState().followedSatelliteId).toBe('ctb://megalith.demo/obj-01')
    expect(follows[2]).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(follows[2])
    expect(useEventStore.getState().followedSatelliteId).toBeNull()
    expect(screen.getAllByTestId('fleet-name')[2]).toHaveAttribute('href', '/spacecraft?sat=OBJ-1')
    expect(screen.getByTestId('environment-denied')).toHaveTextContent('none denied')
    expect(screen.getByTestId('environment-weather')).toHaveTextContent('No space-weather report')
  })
})
