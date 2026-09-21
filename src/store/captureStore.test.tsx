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
import { ReasoningPanel } from '../components/ReasoningPanel'
import { StressMode } from '../components/StressMode'
import { TopBar } from '../components/TopBar'
import { makeTrace } from '../test/factories'

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
    for (const name of ['BusHealthCard', 'RunSummary', 'GlobeControls']) {
      expect([...components].some((component) => component.includes(name)), name).toBe(true)
    }
    expect(CAPTURE_HIDES.every((entry) => entry.hides.length > 0)).toBe(true)
  })
})

describe('capture mode — developer chrome is gone in both modes', () => {
  it('ReasoningPanel has no reset button', () => {
    useEventStore.getState().ingestTrace(makeTrace('t1'))
    const { unmount } = render(<ReasoningPanel />)
    expect(screen.queryByRole('button', { name: 'reset' })).not.toBeInTheDocument()
    unmount()
    useCaptureStore.getState().setEnabled(true)
    render(<ReasoningPanel />)
    expect(screen.queryByRole('button', { name: 'reset' })).not.toBeInTheDocument()
  })

  it('StressMode keeps the controls (F9) without the hint paragraph', () => {
    render(<StressMode />)
    expect(screen.queryByText(/Block input domains to simulate degraded ISR/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument()
    expect(screen.getByLabelText('RF / EW')).toBeInTheDocument()
  })

  it('TopBar has no capture toggle and its links carry capture=1 while on', () => {
    useCaptureStore.getState().setEnabled(true)
    render(<TopBar title="Console" current="brigade" />)
    expect(screen.queryByTestId('capture-toggle')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Operator' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Spacecraft' })).toHaveAttribute(
      'href',
      '/spacecraft?capture=1',
    )
  })
})

describe('branding', () => {
  it('the top bar is MEGALITH with the page title, a connection dot and the page links; CANOPY is not named', () => {
    render(<TopBar title="Console" current="brigade" />)
    expect(screen.getByTestId('brand')).toHaveTextContent('MEGALITH')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Console')
    expect(screen.getByTestId('connection')).toBeInTheDocument()
    for (const label of ['Verdict', 'Reasoning', 'Signals', 'Spacecraft', 'Run']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument()
    }
    expect(document.body.textContent).not.toMatch(/CANOPY/)
  })
})
