import { useMemo } from 'react'
import { FullscreenButton } from './FullscreenButton'
import type { ReactNode } from 'react'
import { mostRestrictiveMarking } from '../lib/marking'
import { PAGES, type ConsolePage } from '../lib/pages'
import { useCaptureStore, withCapture } from '../store/captureStore'
import { useEventStore } from '../store/eventStore'

export type { ConsolePage }

/** Chip text when an attribution carries a marking the grammar rejects. */
export const MARKING_INVALID = 'marking invalid'

type TopBarProps = {
  /** Page title next to the MEGALITH mark. */
  title: string
  current: ConsolePage
  /** Extra right-side content rendered before the nav. */
  right?: ReactNode
}

/** The MEGALITH top bar: the mark, the page title, a connection dot, the
 *  marking chip (the most restrictive marking across the attributions
 *  received, docs/INTERFACE-SPEC.md §1.1; `U` until one says otherwise;
 *  hidden in capture mode so the fixed layout does not shift) and the
 *  page links. Capture mode (the fixed 1920x1080 layout for screenshots) is
 *  set by the demo launcher or `?capture=1` and left with `?capture=0`; the
 *  links carry the flag along. */
export function TopBar({ title, current, right }: TopBarProps) {
  const capture = useCaptureStore((s) => s.enabled)
  const connection = useEventStore((s) => s.connection)
  const attributions = useEventStore((s) => s.attributions)
  const marking = useMemo(() => {
    try {
      return mostRestrictiveMarking(attributions.map((a) => a.marking))
    } catch {
      // A malformed marking must not take every page down (the attributions
      // come back from sessionStorage on each load), and it must not read as
      // a milder level than it might be: the chip names the problem instead.
      return MARKING_INVALID
    }
  }, [attributions])

  return (
    <header className="app-header app-header--megalith" data-page={current}>
      <div className="app-header__brand-block">
        <p className="app-header__eyebrow" data-testid="brand">
          MEGALITH
        </p>
        <h1>{title}</h1>
      </div>
      <div className="app-header__right">
        {right}
        <span
          className={`connection-dot connection-dot--${connection}`}
          data-testid="connection"
          title="Engine connection"
        >
          {connection === 'live' ? 'engine live' : connection}
        </span>
        <span
          className="connection-dot connection-dot--marking"
          data-testid="marking"
          data-capture-hide
          title="Most restrictive marking across the attributions received"
        >
          {marking}
        </span>
        <FullscreenButton />
        <nav className="app-header__nav" aria-label="Console pages">
          {PAGES.map(({ page, label, href }, index) =>
            page === current ? (
              <span key={page} className="app-header__nav-current" aria-current="page" data-key={index + 1}>
                {label}
              </span>
            ) : (
              <a key={page} href={withCapture(href, capture)} data-key={index + 1} title={`Key ${index + 1}`}>
                {label}
              </a>
            ),
          )}
        </nav>
      </div>
    </header>
  )
}
