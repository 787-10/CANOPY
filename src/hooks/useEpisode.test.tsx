import { beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useEpisode } from './useEpisode'
import { useEventStore } from '../store/eventStore'
import { makeAnomaly, makeAttribution, makeDecision, SIM01 } from '../test/factories'

const SIM02 = 'ctb://megalith.demo/sim-02'

beforeEach(() => {
  useEventStore.getState().reset()
  sessionStorage.clear()
})

describe('pinning an episode', () => {
  it('the store holds the pin, persists it with the buffers, and reset clears it', () => {
    const store = useEventStore.getState()
    expect(store.pinnedSatelliteId).toBeNull()
    store.pinEpisode(SIM02)
    expect(useEventStore.getState().pinnedSatelliteId).toBe(SIM02)
    const persisted = JSON.parse(sessionStorage.getItem('canopy-event-store') ?? '{}') as { state?: { pinnedSatelliteId?: string } }
    expect(persisted.state?.pinnedSatelliteId).toBe(SIM02)
    useEventStore.getState().pinEpisode(null)
    expect(useEventStore.getState().pinnedSatelliteId).toBeNull()
    useEventStore.getState().pinEpisode(SIM01)
    useEventStore.getState().reset()
    expect(useEventStore.getState().pinnedSatelliteId).toBeNull()
  })

  it('useEpisode follows the latest cluster until pinned, then the pinned satellite and its decision', () => {
    const store = useEventStore.getState()
    store.ingestAnomaly(makeAnomaly('an-1', { kind: 'bus_link_margin', ts: '2026-09-20T15:05:00Z', payload: { satellite_id: SIM01 } }))
    store.ingestAnomaly(makeAnomaly('an-2', { kind: 'bus_safe_mode', ts: '2026-09-20T15:07:00Z', payload: { satellite_id: SIM02 } }))
    store.ingestAttribution(makeAttribution('att-1', { satellite_id: SIM01, anomaly_ids: ['an-1'], verdict: 'hostile_external', revision: 1 }))
    store.ingestAttribution(makeAttribution('att-2', { satellite_id: SIM02, anomaly_ids: ['an-2'], verdict: 'natural_external', revision: 1 }))
    store.ingestDecision(makeDecision('dec-1', { attribution_id: 'att-1', action: 'threat_warning' }))
    store.ingestDecision(makeDecision('dec-2', { attribution_id: 'att-2', action: 'recovery_recommendation' }))

    const { result } = renderHook(() => useEpisode())
    // Latest scored bus anomaly is SIM-02's: the episode follows it.
    expect(result.current.attribution?.id).toBe('att-2')
    expect(result.current.decision?.id).toBe('dec-2')
    expect(result.current.pinnedSatelliteId).toBeNull()

    act(() => useEventStore.getState().pinEpisode(SIM01))
    expect(result.current.pinnedSatelliteId).toBe(SIM01)
    expect(result.current.attribution?.id).toBe('att-1')
    expect(result.current.decision?.id).toBe('dec-1')

    act(() => useEventStore.getState().pinEpisode(null))
    expect(result.current.attribution?.id).toBe('att-2')
  })

  it('a pin on a satellite with no attribution falls back to the unpinned selection', () => {
    const store = useEventStore.getState()
    store.ingestAttribution(makeAttribution('att-1', { satellite_id: SIM01, verdict: 'internal_fault' }))
    store.pinEpisode('ctb://megalith.demo/sim-99')
    const { result } = renderHook(() => useEpisode())
    expect(result.current.attribution?.id).toBe('att-1')
  })
})
