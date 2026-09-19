import type { ReactNode } from 'react'
import { useCaptureStore, withCapture } from '../store/captureStore'
import { useEventStore } from '../store/eventStore'

export type ConsolePage =
  | 'brigade'
  | 'verdict'
  | 'reasoning'
  | 'signals'
  | 'spacecraft'
  | 'run'
  | 'signal'
  | 'demo'

const PAGES: Array<{ page: ConsolePage; label: string; href: string }> = [
  { page: 'brigade', label: 'Console', href: '/brigade' },
  { page: 'verdict', label: 'Verdict', href: '/verdict' },
  { page: 'reasoning', label: 'Reasoning', href: '/reasoning' },
  { page: 'signals', label: 'Signals', href: '/signals' },
  { page: 'spacecraft', label: 'Spacecraft', href: '/spacecraft' },
  { page: 'run', label: 'Run', href: '/runs' },
]

type TopBarProps = {
  /** Page title next to the MEGALITH mark. */
  title: string
  current: ConsolePage
  /** Extra right-side content rendered before the nav. */
  right?: ReactNode
}

/** The MEGALITH top bar: the mark, the page title, a connection dot and the
 *  page links. Capture mode (the fixed 1920x1080 layout for screenshots) is
 *  set by the demo launcher or `?capture=1` and left with `?capture=0`; the
 *  links carry the flag along. */
export function TopBar({ title, current, right }: TopBarProps) {
  const capture = useCaptureStore((s) => s.enabled)
  const connection = useEventStore((s) => s.connection)

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
        <nav className="app-header__nav" aria-label="Console pages">
          {PAGES.map(({ page, label, href }) =>
            page === current ? (
              <span key={page} className="app-header__nav-current" aria-current="page">
                {label}
              </span>
            ) : (
              <a key={page} href={withCapture(href, capture)}>
                {label}
              </a>
            ),
          )}
        </nav>
      </div>
    </header>
  )
}
