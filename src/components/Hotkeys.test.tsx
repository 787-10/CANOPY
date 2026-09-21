import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { Hotkeys } from './Hotkeys'
import { useEventStore } from '../store/eventStore'
import { SIM01, makeAnomaly, makeAttribution, makeDecision } from '../test/factories'

beforeEach(() => {
  useEventStore.getState().reset()
})

const seed = () => {
  const store = useEventStore.getState()
  store.ingestAnomaly(makeAnomaly('an-1', { kind: 'bus_link_margin', payload: { satellite_id: SIM01 } }))
  store.ingestAttribution(makeAttribution('att-1', { anomaly_ids: ['an-1'], satellite_id: SIM01, verdict: 'hostile_external', confidence: 0.8, revision: 1 }))
  store.ingestDecision(makeDecision('dec-1', { attribution_id: 'att-1', action: 'threat_warning', authority: 'local', target: 'brigade-c2' }))
}

describe('Hotkeys', () => {
  it('A accepts, D denies and R reconsiders the episode decision, with a time stamp', () => {
    seed()
    render(<Hotkeys />)
    fireEvent.keyDown(window, { key: 'a' })
    expect(useEventStore.getState().acceptedDecisionIds.has('dec-1')).toBe(true)
    expect(useEventStore.getState().decisionStatusAt['dec-1']).toMatch(/^\d{4}-/)
    fireEvent.keyDown(window, { key: 'd' })
    expect(useEventStore.getState().deferredDecisionIds.has('dec-1')).toBe(true)
    expect(useEventStore.getState().acceptedDecisionIds.has('dec-1')).toBe(false)
    fireEvent.keyDown(window, { key: 'r' })
    expect(useEventStore.getState().deferredDecisionIds.has('dec-1')).toBe(false)
    expect(useEventStore.getState().decisionStatusAt['dec-1']).toBeUndefined()
  })

  it('F clears the pin, and keys are ignored while typing or with a modifier', () => {
    seed()
    useEventStore.getState().pinEpisode(SIM01)
    const { container } = render(<><Hotkeys /><input aria-label="field" /></>)
    fireEvent.keyDown(window, { key: 'a', metaKey: true })
    expect(useEventStore.getState().acceptedDecisionIds.size).toBe(0)
    fireEvent.keyDown(container.querySelector('input')!, { key: 'a' })
    expect(useEventStore.getState().acceptedDecisionIds.size).toBe(0)
    fireEvent.keyDown(window, { key: 'f' })
    expect(useEventStore.getState().pinnedSatelliteId).toBeNull()
  })

  it('A is ignored while a recovery decision is behind the verdict revision; D still denies (C21)', () => {
    const store = useEventStore.getState()
    store.ingestAnomaly(makeAnomaly('an-1', { kind: 'bus_link_margin', payload: { satellite_id: SIM01 } }))
    store.ingestAttribution(makeAttribution('att-1', { anomaly_ids: ['an-1'], satellite_id: SIM01, verdict: 'internal_fault', revision: 1, provisional: false }))
    store.ingestDecision(makeDecision('dec-1', { attribution_id: 'att-1', action: 'recovery_recommendation', authority: 'local', target: 'SIM-01', revision: 0 }))
    render(<Hotkeys />)
    fireEvent.keyDown(window, { key: 'a' })
    expect(useEventStore.getState().acceptedDecisionIds.has('dec-1')).toBe(false)
    fireEvent.keyDown(window, { key: 'd' })
    expect(useEventStore.getState().deferredDecisionIds.has('dec-1')).toBe(true)
  })
})
