import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useKnowledgeBase } from './useKnowledgeBase'
import { useEventStore } from '../store/eventStore'
import { makeKBEntry } from '../test/factories'

beforeEach(() => {
  useEventStore.getState().reset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useKnowledgeBase', () => {
  it('loads /kb once into the store so citation ids resolve to cards', async () => {
    const entry = makeKBEntry('kb-megalith-demo-actor1-doctrine-001', { title: 'Actor-1 doctrine' })
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ entries: [entry] }),
    } as unknown as Response)
    renderHook(() => useKnowledgeBase(fetchImpl as unknown as typeof fetch, 'http://gw:8000'))
    await waitFor(() =>
      expect(useEventStore.getState().kb['kb-megalith-demo-actor1-doctrine-001']?.title).toBe(
        'Actor-1 doctrine',
      ),
    )
    expect(fetchImpl).toHaveBeenCalledWith('http://gw:8000/kb')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('leaves the store untouched when the gateway is unreachable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'))
    renderHook(() => useKnowledgeBase(fetchImpl as unknown as typeof fetch, 'http://gw:8000'))
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled())
    expect(useEventStore.getState().kb).toEqual({})
  })
})
