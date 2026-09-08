import { afterEach, describe, expect, it, vi } from 'vitest'
import { listScenarios, triggerReplay } from './useEngineSocket'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('triggerReplay', () => {
  it('posts an encoded scenario name and replay speed', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    await triggerReplay('western pacific/aor', 10)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/scenarios/western%20pacific%2Faor/replay?speed=10',
      { method: 'POST' },
    )
  })
})

describe('listScenarios', () => {
  it('returns scenarios from the API', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(['beat1', 'beat2']),
      }),
    )

    await expect(listScenarios()).resolves.toEqual(['beat1', 'beat2'])
  })

  it('returns an empty list for non-success responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))

    await expect(listScenarios()).resolves.toEqual([])
  })

  it('returns an empty list when the API is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))

    await expect(listScenarios()).resolves.toEqual([])
  })
})
