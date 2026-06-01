import { describe, it, expect, beforeEach, vi } from 'vitest'

import { useEventStore } from './eventStore'
import {
  makeAnomaly,
  makeAttribution,
  makeDecision,
  makeEmbeddingSnapshot,
  makeKBEntry,
  makeManeuverDemo,
  makeRecommendationEvent,
  makeSignal,
  makeTrace,
  makeUIEvent,
} from '../test/factories'
import type {
  ConnectionStatus,
  OsintEmbeddingSnapshot,
  ReasoningTrace,
  Signal,
  ViewMode,
} from '../types/canopy'

const STORAGE_KEY = 'canopy-event-store'

// Convenience accessor that always reads the current store snapshot.
const store = () => useEventStore.getState()

beforeEach(() => {
  useEventStore.getState().reset()
  sessionStorage.clear()
})

describe('eventStore — ingestSignal', () => {
  it('prepends newest-first and indexes by id', () => {
    store().ingestSignal(makeSignal('a'))
    store().ingestSignal(makeSignal('b'))

    const { signals, signalsById } = store()
    expect(signals.map((s) => s.id)).toEqual(['b', 'a'])
    expect(signalsById['a']?.id).toBe('a')
    expect(signalsById['b']?.id).toBe('b')
    // Lookup map returns the same object instance that was ingested.
    expect(signalsById['b']).toBe(signals[0])
  })

  it('caps the ring buffer at 200 keeping the newest at index 0', () => {
    for (let i = 0; i < 205; i++) {
      store().ingestSignal(makeSignal(`s${i}`))
    }

    const { signals, signalsById } = store()
    expect(signals).toHaveLength(200)
    // Newest (last pushed) sits at the front.
    expect(signals[0]?.id).toBe('s204')
    // Oldest surviving is the 6th item we pushed (s0..s4 fell off).
    expect(signals[199]?.id).toBe('s5')
    expect(signals.find((s) => s.id === 's4')).toBeUndefined()
    // signalsById is not bounded — it accumulates every id seen.
    expect(Object.keys(signalsById)).toHaveLength(205)
    expect(signalsById['s0']?.id).toBe('s0')
  })
})

describe('eventStore — ingestAnomaly', () => {
  it('prepends newest-first', () => {
    store().ingestAnomaly(makeAnomaly('x'))
    store().ingestAnomaly(makeAnomaly('y'))
    expect(store().anomalies.map((a) => a.id)).toEqual(['y', 'x'])
  })

  it('respects the 200-item ring buffer', () => {
    for (let i = 0; i < 205; i++) store().ingestAnomaly(makeAnomaly(`a${i}`))
    const { anomalies } = store()
    expect(anomalies).toHaveLength(200)
    expect(anomalies[0]?.id).toBe('a204')
    expect(anomalies[199]?.id).toBe('a5')
  })
})

describe('eventStore — ingestAttribution', () => {
  it('prepends newest-first and populates attributionsById', () => {
    store().ingestAttribution(makeAttribution('p'))
    store().ingestAttribution(makeAttribution('q'))

    const { attributions, attributionsById } = store()
    expect(attributions.map((a) => a.id)).toEqual(['q', 'p'])
    expect(attributionsById['p']?.id).toBe('p')
    expect(attributionsById['q']).toBe(attributions[0])
  })

  it('respects the 200-item ring buffer', () => {
    for (let i = 0; i < 205; i++) store().ingestAttribution(makeAttribution(`at${i}`))
    expect(store().attributions).toHaveLength(200)
    expect(store().attributions[0]?.id).toBe('at204')
  })
})

describe('eventStore — ingestDecision', () => {
  it('prepends newest-first and populates decisionsById', () => {
    store().ingestDecision(makeDecision('d1'))
    store().ingestDecision(makeDecision('d2'))

    const { decisions, decisionsById } = store()
    expect(decisions.map((d) => d.id)).toEqual(['d2', 'd1'])
    expect(decisionsById['d1']?.id).toBe('d1')
    expect(decisionsById['d2']).toBe(decisions[0])
  })

  it('respects the 200-item ring buffer', () => {
    for (let i = 0; i < 205; i++) store().ingestDecision(makeDecision(`dec${i}`))
    expect(store().decisions).toHaveLength(200)
    expect(store().decisions[0]?.id).toBe('dec204')
  })
})

describe('eventStore — ingestUIEvent', () => {
  it('sets pendingApproval for a recommendation_created event with a recommendation', () => {
    const evt = makeRecommendationEvent('rec1')
    store().ingestUIEvent(evt)

    expect(store().uiEvents[0]?.id).toBe('rec1')
    expect(store().pendingApproval).toBe(evt)
  })

  it('does NOT set pendingApproval when the event id is already approved', () => {
    store().markApproved('rec1')
    const evt = makeRecommendationEvent('rec1')
    store().ingestUIEvent(evt)

    // The event still lands in the ring buffer...
    expect(store().uiEvents[0]?.id).toBe('rec1')
    // ...but the banner is suppressed because it was already approved.
    expect(store().pendingApproval).toBeNull()
  })

  it('does NOT set pendingApproval for a recommendation_created event lacking a recommendation', () => {
    const evt = makeUIEvent('rec-missing', {
      type: 'recommendation_created',
      recommendation: null,
    })
    store().ingestUIEvent(evt)

    expect(store().uiEvents[0]?.id).toBe('rec-missing')
    expect(store().pendingApproval).toBeNull()
  })

  it('never sets pendingApproval for a non-recommendation event', () => {
    store().ingestUIEvent(makeUIEvent('threat1', { type: 'threat_updated' }))
    expect(store().pendingApproval).toBeNull()

    store().ingestUIEvent(makeUIEvent('status1', { type: 'status_update' }))
    expect(store().pendingApproval).toBeNull()
  })

  it('prepends newest-first and respects the 200-item ring buffer', () => {
    for (let i = 0; i < 205; i++) {
      store().ingestUIEvent(makeUIEvent(`u${i}`))
    }
    const { uiEvents } = store()
    expect(uiEvents).toHaveLength(200)
    expect(uiEvents[0]?.id).toBe('u204')
    expect(uiEvents[199]?.id).toBe('u5')
  })

  it('leaves an existing pendingApproval in place when a non-recommendation event arrives', () => {
    const rec = makeRecommendationEvent('rec1')
    store().ingestUIEvent(rec)
    expect(store().pendingApproval).toBe(rec)

    store().ingestUIEvent(makeUIEvent('threat1', { type: 'threat_updated' }))
    // The banner persists — a plain threat update must not clobber it.
    expect(store().pendingApproval).toBe(rec)
  })
})

describe('eventStore — ingestTrace', () => {
  it('appends oldest-first (newest at the end)', () => {
    store().ingestTrace(makeTrace('t1'))
    store().ingestTrace(makeTrace('t2'))
    store().ingestTrace(makeTrace('t3'))

    expect(store().traces.map((t) => t.id)).toEqual(['t1', 't2', 't3'])
  })

  it('caps at 500, dropping from the front', () => {
    for (let i = 0; i < 505; i++) store().ingestTrace(makeTrace(`tr${i}`))

    const { traces } = store()
    expect(traces).toHaveLength(500)
    // Front (oldest) items tr0..tr4 were dropped; tr5 is now the oldest.
    expect(traces[0]?.id).toBe('tr5')
    // Newest is at the end.
    expect(traces[499]?.id).toBe('tr504')
    expect(traces.find((t) => t.id === 'tr4')).toBeUndefined()
  })
})

describe('eventStore — ingestEmbeddingSnapshot', () => {
  it('replaces the snapshot wholesale (second write wins)', () => {
    const first = makeEmbeddingSnapshot('snap1', { cluster_count: 1 })
    const second = makeEmbeddingSnapshot('snap2', { cluster_count: 9 })

    store().ingestEmbeddingSnapshot(first)
    expect(store().embeddingSnapshot).toBe(first)

    store().ingestEmbeddingSnapshot(second)
    expect(store().embeddingSnapshot).toBe(second)
    expect(store().embeddingSnapshot?.cluster_count).toBe(9)
  })
})

describe('eventStore — markApproved', () => {
  it('adds the id to approvedEventIds', () => {
    store().markApproved('e1')
    expect(store().approvedEventIds.has('e1')).toBe(true)
    expect(store().approvedEventIds.size).toBe(1)
  })

  it('clears pendingApproval when it matches the approved id', () => {
    const evt = makeRecommendationEvent('e1')
    store().ingestUIEvent(evt)
    expect(store().pendingApproval).toBe(evt)

    store().markApproved('e1')
    expect(store().pendingApproval).toBeNull()
    expect(store().approvedEventIds.has('e1')).toBe(true)
  })

  it('leaves a non-matching pendingApproval intact', () => {
    const evt = makeRecommendationEvent('e1')
    store().ingestUIEvent(evt)

    store().markApproved('other')
    expect(store().pendingApproval).toBe(evt)
    expect(store().approvedEventIds.has('other')).toBe(true)
    expect(store().approvedEventIds.has('e1')).toBe(false)
  })
})

describe('eventStore — acceptDecision / deferDecision are mutually exclusive', () => {
  it('accepting an id removes it from deferred', () => {
    store().deferDecision('d1')
    expect(store().deferredDecisionIds.has('d1')).toBe(true)

    store().acceptDecision('d1')
    expect(store().acceptedDecisionIds.has('d1')).toBe(true)
    expect(store().deferredDecisionIds.has('d1')).toBe(false)
  })

  it('deferring an id removes it from accepted', () => {
    store().acceptDecision('d1')
    expect(store().acceptedDecisionIds.has('d1')).toBe(true)

    store().deferDecision('d1')
    expect(store().deferredDecisionIds.has('d1')).toBe(true)
    expect(store().acceptedDecisionIds.has('d1')).toBe(false)
  })

  it('tracks distinct ids independently across both sets', () => {
    store().acceptDecision('accepted-1')
    store().deferDecision('deferred-1')

    expect(store().acceptedDecisionIds.has('accepted-1')).toBe(true)
    expect(store().acceptedDecisionIds.has('deferred-1')).toBe(false)
    expect(store().deferredDecisionIds.has('deferred-1')).toBe(true)
    expect(store().deferredDecisionIds.has('accepted-1')).toBe(false)
  })

  it('clearDecisionStatus removes the id from both sets', () => {
    store().acceptDecision('d1')
    store().clearDecisionStatus('d1')
    expect(store().acceptedDecisionIds.has('d1')).toBe(false)
    expect(store().deferredDecisionIds.has('d1')).toBe(false)

    store().deferDecision('d2')
    store().clearDecisionStatus('d2')
    expect(store().acceptedDecisionIds.has('d2')).toBe(false)
    expect(store().deferredDecisionIds.has('d2')).toBe(false)
  })

  it('clearDecisionStatus is a no-op for an unknown id', () => {
    store().acceptDecision('keep')
    store().clearDecisionStatus('never-added')
    expect(store().acceptedDecisionIds.has('keep')).toBe(true)
  })
})

describe('eventStore — maneuver demo + takeover slots', () => {
  it('startManeuverDemo / endManeuverDemo set and clear the slot', () => {
    const demo = makeManeuverDemo({ decisionId: 'dec-42', demoType: 'strike' })
    store().startManeuverDemo(demo)
    expect(store().maneuverDemo).toBe(demo)
    expect(store().maneuverDemo?.demoType).toBe('strike')

    store().endManeuverDemo()
    expect(store().maneuverDemo).toBeNull()
  })

  it('openTakeover / closeTakeover set and clear the slot', () => {
    const evt = makeUIEvent('takeover-1')
    store().openTakeover(evt)
    expect(store().takeoverEvent).toBe(evt)

    store().closeTakeover()
    expect(store().takeoverEvent).toBeNull()
  })
})

describe('eventStore — connection / view / selection / dismissal', () => {
  it('setConnection updates the connection status', () => {
    const statuses: ConnectionStatus[] = ['live', 'fixture', 'offline', 'connecting']
    for (const status of statuses) {
      store().setConnection(status)
      expect(store().connection).toBe(status)
    }
  })

  it('setView updates the view mode', () => {
    const views: ViewMode[] = ['operator', 'brigade']
    for (const view of views) {
      store().setView(view)
      expect(store().view).toBe(view)
    }
  })

  it('selectEvent sets and clears the selected id', () => {
    store().selectEvent('evt-1')
    expect(store().selectedEventId).toBe('evt-1')
    store().selectEvent(null)
    expect(store().selectedEventId).toBeNull()
  })

  it('dismissApproval clears pendingApproval', () => {
    const evt = makeRecommendationEvent('rec1')
    store().ingestUIEvent(evt)
    expect(store().pendingApproval).toBe(evt)

    store().dismissApproval()
    expect(store().pendingApproval).toBeNull()
    // Dismissing does not record the id as approved.
    expect(store().approvedEventIds.has('rec1')).toBe(false)
  })
})

describe('eventStore — setKB', () => {
  it('builds a record keyed by entry id', () => {
    store().setKB([makeKBEntry('kb1'), makeKBEntry('kb2', { actor: 'BLUE' })])

    const { kb } = store()
    expect(Object.keys(kb).sort()).toEqual(['kb1', 'kb2'])
    expect(kb['kb1']?.id).toBe('kb1')
    expect(kb['kb2']?.actor).toBe('BLUE')
  })

  it('replaces the whole record on a subsequent call', () => {
    store().setKB([makeKBEntry('kb1')])
    store().setKB([makeKBEntry('kb3')])

    const { kb } = store()
    expect(Object.keys(kb)).toEqual(['kb3'])
    expect(kb['kb1']).toBeUndefined()
  })

  it('handles an empty list', () => {
    store().setKB([])
    expect(store().kb).toEqual({})
  })
})

describe('eventStore — reset', () => {
  it('returns every field to its initial value with fresh empty Sets', () => {
    // Mutate a broad cross-section of the store first.
    store().ingestSignal(makeSignal('s'))
    store().ingestAnomaly(makeAnomaly('a'))
    store().ingestAttribution(makeAttribution('at'))
    store().ingestDecision(makeDecision('d'))
    store().ingestUIEvent(makeRecommendationEvent('rec'))
    store().ingestTrace(makeTrace('t'))
    store().ingestEmbeddingSnapshot(makeEmbeddingSnapshot('snap'))
    store().setConnection('live')
    store().setView('operator')
    store().selectEvent('s')
    store().markApproved('rec')
    store().acceptDecision('d')
    store().deferDecision('d2')
    store().startManeuverDemo(makeManeuverDemo())
    store().openTakeover(makeUIEvent('to'))
    store().setKB([makeKBEntry('kb')])

    store().reset()

    const s = store()
    expect(s.signals).toEqual([])
    expect(s.anomalies).toEqual([])
    expect(s.attributions).toEqual([])
    expect(s.decisions).toEqual([])
    expect(s.uiEvents).toEqual([])
    expect(s.traces).toEqual([])
    expect(s.embeddingSnapshot).toBeNull()
    expect(s.signalsById).toEqual({})
    expect(s.attributionsById).toEqual({})
    expect(s.decisionsById).toEqual({})
    expect(s.connection).toBe('connecting')
    expect(s.view).toBe('brigade')
    expect(s.selectedEventId).toBeNull()
    expect(s.pendingApproval).toBeNull()
    expect(s.maneuverDemo).toBeNull()
    expect(s.takeoverEvent).toBeNull()
    expect(s.kb).toEqual({})

    // Fresh, genuinely-empty Set instances.
    expect(s.approvedEventIds).toBeInstanceOf(Set)
    expect(s.approvedEventIds.size).toBe(0)
    expect(s.acceptedDecisionIds).toBeInstanceOf(Set)
    expect(s.acceptedDecisionIds.size).toBe(0)
    expect(s.deferredDecisionIds).toBeInstanceOf(Set)
    expect(s.deferredDecisionIds.size).toBe(0)
  })
})

describe('eventStore — persist partialize', () => {
  it('persists ring buffers under the canopy-event-store key but excludes live/Set fields', async () => {
    // Touch persisted (ring-buffer) state and live/Set state.
    store().ingestSignal(makeSignal('s1'))
    store().ingestTrace(makeTrace('t1'))
    store().ingestEmbeddingSnapshot(makeEmbeddingSnapshot('snap1'))
    store().setConnection('live')
    store().setView('operator')
    store().markApproved('approved-1')
    store().acceptDecision('acc-1')
    store().deferDecision('def-1')
    store().startManeuverDemo(makeManeuverDemo())
    store().openTakeover(makeUIEvent('to-1'))
    store().setKB([makeKBEntry('kb1')])

    // Persist writes may be flushed on a microtask — wait for the key.
    await vi.waitFor(() => {
      expect(sessionStorage.getItem(STORAGE_KEY)).not.toBeNull()
    })

    const raw = sessionStorage.getItem(STORAGE_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw as string) as {
      version: number
      state: Record<string, unknown>
    }
    const persisted = parsed.state

    // Included: ring buffers + lookup maps + embedding snapshot.
    const includedKeys = [
      'signals',
      'anomalies',
      'attributions',
      'decisions',
      'uiEvents',
      'traces',
      'embeddingSnapshot',
      'signalsById',
      'attributionsById',
      'decisionsById',
    ]
    for (const key of includedKeys) {
      expect(persisted).toHaveProperty(key)
    }
    expect((persisted.signals as Signal[])[0]?.id).toBe('s1')
    expect((persisted.traces as ReasoningTrace[])[0]?.id).toBe('t1')
    expect((persisted.embeddingSnapshot as OsintEmbeddingSnapshot)?.id).toBe('snap1')

    // Excluded: live UI/connection state and Set-backed fields.
    const excludedKeys = [
      'connection',
      'view',
      'selectedEventId',
      'approvedEventIds',
      'acceptedDecisionIds',
      'deferredDecisionIds',
      'pendingApproval',
      'maneuverDemo',
      'takeoverEvent',
      'kb',
    ]
    for (const key of excludedKeys) {
      expect(persisted).not.toHaveProperty(key)
    }

    // The persisted blob carries exactly the partialized keys — nothing else.
    expect(Object.keys(persisted).sort()).toEqual([...includedKeys].sort())
    expect(parsed.version).toBe(2)
  })
})
