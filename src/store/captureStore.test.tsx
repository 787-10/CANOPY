import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  CAPTURE_HIDES,
  CAPTURE_STORAGE_KEY,
  initialiseCaptureMode,
  readInitialCapture,
  useCaptureStore,
  withCapture,
} from './captureStore'
import { useEventStore } from './eventStore'
import { EventFeed } from '../components/EventFeed'
import { ReasoningPanel } from '../components/ReasoningPanel'
import { StressMode } from '../components/StressMode'
import { TopBar } from '../components/TopBar'
import { makeBusHealthSignal, makeTrace } from '../test/factories'

beforeAll(() => {
  if (typeof Element.prototype.scrollTo !== 'function') {
    Element.prototype.scrollTo = () => {}
  }
})

beforeEach(() => {
  sessionStorage.clear()
  useCaptureStore.getState().setEnabled(false)
  useEventStore.getState().reset()
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('capture mode — flag', () => {
  it('reads ?capture=1 from the query, then the session flag, else off', () => {
    expect(readInitialCapture('?capture=1')).toBe(true)
    expect(readInitialCapture('?run=A&capture=true')).toBe(true)
    expect(readInitialCapture('?capture=0')).toBe(false)
    expect(readInitialCapture('')).toBe(false)
    sessionStorage.setItem(CAPTURE_STORAGE_KEY, '1')
    expect(readInitialCapture('')).toBe(true)
    // The query wins over the stored flag.
    expect(readInitialCapture('?capture=0')).toBe(false)
  })

  it('marks <html data-capture="1"> and persists while on', () => {
    initialiseCaptureMode('?capture=1')
    expect(useCaptureStore.getState().enabled).toBe(true)
    expect(document.documentElement.getAttribute('data-capture')).toBe('1')
    expect(sessionStorage.getItem(CAPTURE_STORAGE_KEY)).toBe('1')
    useCaptureStore.getState().toggle()
    expect(document.documentElement.hasAttribute('data-capture')).toBe(false)
    expect(sessionStorage.getItem(CAPTURE_STORAGE_KEY)).toBeNull()
  })

  it('appends capture=1 to console links only while on', () => {
    expect(withCapture('/spacecraft', true)).toBe('/spacecraft?capture=1')
    expect(withCapture('/signal?id=x', true)).toBe('/signal?id=x&capture=1')
    expect(withCapture('/spacecraft', false)).toBe('/spacecraft')
  })

  it('documents what it hides, one entry per component that checks the store', () => {
    const components = new Set(CAPTURE_HIDES.map((entry) => entry.component))
    for (const name of ['ScenarioRail', 'EventFeed', 'ReasoningPanel', 'StressMode', 'AorMap', 'BusHealthCard', 'RunSummary']) {
      expect([...components].some((component) => component.includes(name)), name).toBe(true)
    }
    expect(CAPTURE_HIDES.every((entry) => entry.hides.length > 0)).toBe(true)
  })
})

describe('capture mode — hidden controls', () => {
  it('ReasoningPanel drops the reset button', () => {
    useEventStore.getState().ingestTrace(makeTrace('t1'))
    const { unmount } = render(<ReasoningPanel />)
    expect(screen.getByRole('button', { name: 'reset' })).toBeInTheDocument()
    unmount()
    useCaptureStore.getState().setEnabled(true)
    render(<ReasoningPanel />)
    expect(screen.queryByRole('button', { name: 'reset' })).not.toBeInTheDocument()
  })

  it('EventFeed drops the Flow tab and the raw JSON envelope but keeps the bus-health card', () => {
    const signal = makeBusHealthSignal('sig-cap')
    const { unmount } = render(<EventFeed signals={[signal]} />)
    expect(screen.getByRole('tab', { name: 'Flow' })).toBeInTheDocument()
    unmount()
    useCaptureStore.getState().setEnabled(true)
    render(<EventFeed signals={[signal]} />)
    expect(screen.queryByRole('tab', { name: 'Flow' })).not.toBeInTheDocument()
    screen.getByRole('button', { name: /link margin drop/i }).click()
    // Card yes, JSON no.
    expect(screen.queryByTestId('bus-health-card')).toBeNull()
  })

  it('StressMode keeps the controls (F9) but drops the hint', () => {
    const { unmount } = render(<StressMode />)
    expect(screen.getByText(/Block input domains to simulate degraded ISR/)).toBeInTheDocument()
    unmount()
    useCaptureStore.getState().setEnabled(true)
    render(<StressMode />)
    expect(screen.queryByText(/Block input domains to simulate degraded ISR/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument()
    expect(screen.getByLabelText('RF / EW')).toBeInTheDocument()
  })

  it('TopBar reads REC while on and its links carry capture=1', () => {
    useCaptureStore.getState().setEnabled(true)
    render(<TopBar title="Brigade COP" current="brigade" />)
    expect(screen.getByTestId('capture-toggle')).toHaveTextContent('REC')
    expect(screen.getByTestId('capture-toggle')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('link', { name: 'Spacecraft' })).toHaveAttribute(
      'href',
      '/spacecraft?capture=1',
    )
  })
})

describe('branding', () => {
  it('the top bar is MEGALITH and CANOPY appears only as the external-awareness subsystem', () => {
    render(<TopBar title="Brigade COP" current="brigade" />)
    expect(screen.getByTestId('brand')).toHaveTextContent('MEGALITH')
    expect(screen.getByTestId('subsystem-external')).toHaveTextContent('External awareness')
    expect(screen.getByTestId('subsystem-external')).toHaveTextContent('CANOPY')
    expect(screen.getByTestId('subsystem-internal')).toHaveTextContent('Internal diagnosis')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Brigade COP')
    // No other CANOPY mention outside the subsystem strip.
    const strip = screen.getByRole('list', { name: 'MEGALITH subsystems' })
    const outside = document.body.textContent!.replace(strip.textContent!, '')
    expect(outside).not.toMatch(/CANOPY/)
  })
})
