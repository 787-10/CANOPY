import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  OVERVIEW_LAYOUT_KEYS,
  readColumnExpanded,
  useColumnExpanded,
  writeColumnExpanded,
} from './overviewLayout'

const memoryStorage = (seed: Record<string, string> = {}) => {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    map,
  }
}

const throwingStorage = {
  getItem: () => {
    throw new Error('SecurityError')
  },
  setItem: () => {
    throw new Error('QuotaExceededError')
  },
}

describe('overview column state', () => {
  it('defaults to expanded, reads "collapsed" back, and writes both keys', () => {
    const storage = memoryStorage()
    expect(readColumnExpanded('left', storage)).toBe(true)
    writeColumnExpanded('left', false, storage)
    writeColumnExpanded('right', true, storage)
    expect(storage.map.get(OVERVIEW_LAYOUT_KEYS.left)).toBe('collapsed')
    expect(storage.map.get(OVERVIEW_LAYOUT_KEYS.right)).toBe('expanded')
    expect(readColumnExpanded('left', storage)).toBe(false)
    expect(readColumnExpanded('right', storage)).toBe(true)
    expect(OVERVIEW_LAYOUT_KEYS).toEqual({ left: 'megalith-overview-left', right: 'megalith-overview-right' })
  })

  it('treats a throwing or missing storage as expanded and never throws on write', () => {
    expect(readColumnExpanded('left', throwingStorage)).toBe(true)
    expect(() => writeColumnExpanded('left', false, throwingStorage)).not.toThrow()
    expect(readColumnExpanded('right', null)).toBe(true)
    expect(() => writeColumnExpanded('right', false, null)).not.toThrow()
  })

  it('the hook toggles and persists to window.localStorage', () => {
    localStorage.clear()
    const { result } = renderHook(() => useColumnExpanded('left'))
    expect(result.current[0]).toBe(true)
    act(() => result.current[1]())
    expect(result.current[0]).toBe(false)
    expect(localStorage.getItem(OVERVIEW_LAYOUT_KEYS.left)).toBe('collapsed')
    act(() => result.current[1]())
    expect(result.current[0]).toBe(true)
    expect(localStorage.getItem(OVERVIEW_LAYOUT_KEYS.left)).toBe('expanded')
  })

  it('the hook starts from the stored value and stays expanded when forced (capture mode)', () => {
    localStorage.setItem(OVERVIEW_LAYOUT_KEYS.right, 'collapsed')
    const stored = renderHook(() => useColumnExpanded('right'))
    expect(stored.result.current[0]).toBe(false)
    const forced = renderHook(() => useColumnExpanded('right', true))
    expect(forced.result.current[0]).toBe(true)
    // Forcing does not overwrite the operator's stored choice.
    expect(localStorage.getItem(OVERVIEW_LAYOUT_KEYS.right)).toBe('collapsed')
    localStorage.clear()
  })

  it('the hook survives a storage that throws', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    try {
      const { result } = renderHook(() => useColumnExpanded('left'))
      expect(result.current[0]).toBe(true)
      act(() => result.current[1]())
      expect(result.current[0]).toBe(false)
    } finally {
      getItem.mockRestore()
      setItem.mockRestore()
    }
  })
})
