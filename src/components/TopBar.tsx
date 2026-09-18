import type { ReactNode } from 'react'
import { useCaptureStore, withCapture } from '../store/captureStore'
import { useEventStore } from '../store/eventStore'

export type ConsolePage = 'brigade' | 'operator' | 'spacecraft' | 'run' | 'signal' | 'demo'

const PAGES: Array<{ page: ConsolePage; label: string; href: string }> = [
  { page: 'brigade', label: 'Brigade', href: '/brigade' },
  { page: 'operator', label: 'Operator', href: '/operator' },
  { page: 'spacecraft', label: 'Spacecraft', href: '/spacecraft' },
  { page: 'run', label: 'Run', href: '/run' },
]

type TopBarProps = {
  /** Page title next to the MEGALITH mark. */
  title: string
  current: ConsolePage
  /** Extra right-side content (status pills) rendered before the nav. */
  right?: ReactNode
  /** Show the subsystem strip (default true). */
  subsystems?: boolean
}

/** The MEGALITH top bar. The console is MEGALITH; CANOPY appears only as
 *  the external-awareness subsystem in the strip, next to the internal
 *  diagnosis module and the verdict lane. */
export function TopBar({ title, current, right, subsystems = true }: TopBarProps) {
  const capture = useCaptureStore((s) => s.enabled)
  const toggleCapture = useCaptureStore((s) => s.toggle)

  return (
    <header className="app-header app-header--megalith" data-page={current}>
      <div className="app-header__brand-block">
        <p className="app-header__eyebrow" data-testid="brand">
          MEGALITH
        </p>
        <h1>{title}</h1>
      </div>
      {subsystems ? <SubsystemStrip /> : null}
      <div className="app-header__right">
        {right}
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
        <button
          type="button"
          className={`capture-toggle${capture ? ' capture-toggle--on' : ''}`}
          onClick={toggleCapture}
          aria-pressed={capture}
          title={
            capture
              ? 'Capture mode on: dev controls hidden, 1920x1080 layout. Click to leave.'
              : 'Capture mode: hide dev controls and fix the 1920x1080 layout'
          }
          data-testid="capture-toggle"
        >
          {capture ? '● REC' : 'Capture'}
        </button>
      </div>
    </header>
  )
}

/** Subsystem status strip: which MEGALITH subsystem is feeding the picture. */
export function SubsystemStrip() {
  const connection = useEventStore((s) => s.connection)
  const hasBusHealth = useEventStore((s) =>
    s.signals.some((signal) => signal.domain === 'bus_health'),
  )
  const hasExternal = useEventStore((s) =>
    s.signals.some(
      (signal) => signal.domain !== 'bus_health' && signal.domain !== 'space_weather',
    ),
  )
  const latest = useEventStore((s) => s.attributions[0] ?? null)
  const lane = latest
    ? latest.provisional
      ? 'provisional'
      : latest.verdict_basis === 'reasoning'
        ? 'reasoning lane'
        : latest.verdict_basis === 'rule'
          ? 'rule lane'
          : 'attributed'
    : 'standing by'

  return (
    <ul className="subsystem-strip" aria-label="MEGALITH subsystems">
      <li
        className={`subsystem-strip__item${hasExternal ? ' subsystem-strip__item--active' : ''}`}
        data-testid="subsystem-external"
      >
        <span>External awareness</span>
        <strong>CANOPY</strong>
        <em>{connection === 'live' ? 'live' : connection}</em>
      </li>
      <li
        className={`subsystem-strip__item${hasBusHealth ? ' subsystem-strip__item--active' : ''}`}
        data-testid="subsystem-internal"
      >
        <span>Internal diagnosis</span>
        <strong>Bus health</strong>
        <em>{hasBusHealth ? 'reporting' : 'no records'}</em>
      </li>
      <li
        className={`subsystem-strip__item${latest ? ' subsystem-strip__item--active' : ''}`}
        data-testid="subsystem-verdict"
      >
        <span>Verdict</span>
        <strong>Fault vs attack</strong>
        <em>{lane}</em>
      </li>
    </ul>
  )
}
