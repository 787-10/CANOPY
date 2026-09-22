import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { currentLocation, installLinkInterception, isPlainLeftClick, navigate, useLocation } from './navigation'

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

describe('link interception', () => {
  it('routes a plain click on a same-origin link in the document and leaves the rest to the browser', () => {
    window.history.replaceState(null, '', '/brigade')
    const remove = installLinkInterception()
    const internal = document.createElement('a')
    internal.href = '/spacecraft?sat=SIM-02'
    const external = document.createElement('a')
    external.href = 'https://example.org/x'
    const blank = document.createElement('a')
    blank.href = '/runs'
    blank.target = '_blank'
    document.body.append(internal, external, blank)
    const click = (el: HTMLElement) => {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
      el.dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(click(internal)).toBe(true)
    expect(window.location.pathname + window.location.search).toBe('/spacecraft?sat=SIM-02')
    expect(click(external)).toBe(false)
    expect(click(blank)).toBe(false)
    remove()
    internal.remove()
    external.remove()
    blank.remove()
  })
})
