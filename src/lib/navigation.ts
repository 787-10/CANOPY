// In-document navigation between the console's pages. The header links and
// the page keys used to be full-page loads; a load drops browser fullscreen,
// so a demo on a fullscreen console lost it on every page change (Jeewoo,
// 2026-09-21). Navigation now pushes history and re-renders the route in
// place; a plain load of any URL still works, since the router reads the
// location on mount, and links stay real links (middle-click, copy).
import { useEffect, useState } from 'react'

export type Location = { pathname: string; search: string }

const NAVIGATE_EVENT = 'megalith:navigate'

export function currentLocation(): Location {
  if (typeof window === 'undefined') return { pathname: '/', search: '' }
  return { pathname: window.location.pathname, search: window.location.search }
}

/** Go to a same-origin URL without leaving the document. */
export function navigate(url: string): void {
  if (typeof window === 'undefined') return
  const target = new URL(url, window.location.href)
  if (target.origin !== window.location.origin) {
    window.location.assign(url)
    return
  }
  const same = target.pathname === window.location.pathname && target.search === window.location.search
  if (!same) window.history.pushState(null, '', `${target.pathname}${target.search}${target.hash}`)
  window.dispatchEvent(new Event(NAVIGATE_EVENT))
}

/** True for an unmodified left click on a link: the kind a router may take over. */
export function isPlainLeftClick(event: {
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  defaultPrevented: boolean
}): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.defaultPrevented
}

/** The document's location, updated on navigate() and on the back button. */
export function useLocation(): Location {
  const [location, setLocation] = useState<Location>(currentLocation)
  useEffect(() => {
    const update = () => setLocation(currentLocation())
    window.addEventListener('popstate', update)
    window.addEventListener(NAVIGATE_EVENT, update)
    return () => {
      window.removeEventListener('popstate', update)
      window.removeEventListener(NAVIGATE_EVENT, update)
    }
  }, [])
  return location
}
