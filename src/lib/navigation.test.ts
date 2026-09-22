import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { currentLocation, isPlainLeftClick, navigate, useLocation } from './navigation'

describe('in-document navigation', () => {
  it('pushes history and tells the router, without reloading', () => {
    window.history.replaceState(null, '', '/brigade?capture=1')
    const { result } = renderHook(() => useLocation())
    expect(result.current).toEqual({ pathname: '/brigade', search: '?capture=1' })
    act(() => navigate('/verdict?capture=1'))
    expect(window.location.pathname).toBe('/verdict')
    expect(result.current).toEqual({ pathname: '/verdict', search: '?capture=1' })
    // The back button is heard too.
    act(() => {
      window.history.back()
    })
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(currentLocation().pathname).toBe(result.current.pathname)
  })

  it('takes over only a plain left click', () => {
    const base = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false }
    expect(isPlainLeftClick(base)).toBe(true)
    expect(isPlainLeftClick({ ...base, metaKey: true })).toBe(false)
    expect(isPlainLeftClick({ ...base, button: 1 })).toBe(false)
    expect(isPlainLeftClick({ ...base, defaultPrevented: true })).toBe(false)
  })
})
