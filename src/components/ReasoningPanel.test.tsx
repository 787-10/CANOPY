import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { ReasoningPanel } from './ReasoningPanel'
import { useEventStore } from '../store/eventStore'
import { makeTrace } from '../test/factories'

beforeEach(() => {
  useEventStore.getState().reset()
})

const lineFor = (traceId: string) =>
  document.querySelector<HTMLElement>(`[data-trace-id="${traceId}"]`)

describe('ReasoningPanel — gate-blocked decide traces', () => {
  it('renders a decide-stage warn starting with "gate blocked" in the blocked style with the reason chip', () => {
    useEventStore.getState().ingestTrace(
      makeTrace('t-gate', {
        stage: 'decide',
        level: 'warn',
        message:
          'gate blocked recovery_recommendation: threat/uplink_jamming_active',
      }),
    )
    render(<ReasoningPanel />)
    const line = lineFor('t-gate')
    expect(line).toHaveClass('reasoning-line--blocked')
    expect(line).toHaveClass('reasoning-line--warn')
    expect(line).toHaveAttribute('data-blocked', 'true')
    expect(
      screen.getByText('blocked · threat/uplink_jamming_active'),
    ).toBeInTheDocument()
  })

  it('prefers a reason_code payload field over parsing the message', () => {
    useEventStore.getState().ingestTrace(
      makeTrace('t-gate-payload', {
        stage: 'decide',
        level: 'warn',
        message: 'gate blocked safe_mode_entry',
        payload: { reason_code: 'threat/hostile_close_approach' },
      }),
    )
    render(<ReasoningPanel />)
    expect(
      screen.getByText('blocked · threat/hostile_close_approach'),
    ).toBeInTheDocument()
  })

  it('does not mark an ordinary decide warn, or a fusion line mentioning the gate, as blocked', () => {
    useEventStore.getState().ingestTrace(
      makeTrace('t-warn', {
        stage: 'decide',
        level: 'warn',
        message: 'authority repaired to local',
      }),
    )
    useEventStore.getState().ingestTrace(
      makeTrace('t-fusion', {
        stage: 'fusion',
        level: 'info',
        message: 'gate blocked nothing here',
      }),
    )
    render(<ReasoningPanel />)
    expect(lineFor('t-warn')).not.toHaveClass('reasoning-line--blocked')
    expect(lineFor('t-fusion')).not.toHaveClass('reasoning-line--blocked')
    expect(screen.queryByText(/^blocked ·/)).not.toBeInTheDocument()
  })
})

describe('ReasoningPanel — verdict and physics lines', () => {
  it('renders verdict and physics_consistency from an attrib trace payload inline', () => {
    useEventStore.getState().ingestTrace(
      makeTrace('t-attrib', {
        stage: 'attrib_reconcile',
        level: 'decision',
        message: 'rule verdict internal_fault held after reconcile',
        payload: { verdict: 'internal_fault', physics_consistency: 0.83 },
      }),
    )
    render(<ReasoningPanel />)
    const verdictChip = screen.getByText('verdict · internal fault')
    expect(verdictChip).toHaveClass('reasoning-line__chip--internal_fault')
    expect(verdictChip).toHaveAttribute('data-verdict', 'internal_fault')
    expect(screen.getByText('physics · 0.83')).toBeInTheDocument()
    expect(lineFor('t-attrib')).not.toHaveClass('reasoning-line--blocked')
  })

  it('renders each verdict with its own chip class', () => {
    for (const verdict of [
      'natural_external',
      'hostile_external',
      'unknown',
    ] as const) {
      useEventStore.getState().ingestTrace(
        makeTrace(`t-${verdict}`, {
          stage: 'attrib_primary',
          payload: { verdict },
        }),
      )
    }
    render(<ReasoningPanel />)
    expect(screen.getByText('verdict · natural external')).toHaveClass(
      'reasoning-line__chip--natural_external',
    )
    expect(screen.getByText('verdict · hostile external')).toHaveClass(
      'reasoning-line__chip--hostile_external',
    )
    expect(screen.getByText('verdict · unknown')).toHaveClass(
      'reasoning-line__chip--unknown',
    )
  })

  it('renders a physics score alone, and ignores payloads with neither', () => {
    useEventStore.getState().ingestTrace(
      makeTrace('t-pc', {
        stage: 'attrib_primary',
        payload: { physics_consistency: 0.5 },
      }),
    )
    useEventStore.getState().ingestTrace(
      makeTrace('t-plain', { stage: 'fusion', payload: { window_s: 600 } }),
    )
    useEventStore.getState().ingestTrace(
      makeTrace('t-bogus', {
        stage: 'attrib_primary',
        payload: { verdict: 'sabotage', physics_consistency: 'high' },
      }),
    )
    render(<ReasoningPanel />)
    expect(screen.getByText('physics · 0.50')).toBeInTheDocument()
    expect(lineFor('t-plain')?.querySelector('.reasoning-line__chips')).toBeNull()
    expect(lineFor('t-bogus')?.querySelector('.reasoning-line__chips')).toBeNull()
  })
})

describe('ReasoningPanel — follows the newest line', () => {
  // jsdom lays nothing out: give every element a tall scrollable box and a
  // recording `scrollTo` so the pin and the follow logic can be observed.
  const geometry = { scrollHeight: 2000, clientHeight: 400 }
  const scrollTops = new WeakMap<Element, number>()
  const scrollTo = vi.fn(function (this: HTMLElement, options?: ScrollToOptions | number) {
    const top = typeof options === 'number' ? options : options?.top
    if (typeof top === 'number') scrollTops.set(this, top)
  })

  beforeEach(() => {
    scrollTo.mockClear()
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => geometry.scrollHeight,
    })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => geometry.clientHeight,
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get(this: Element) {
        return scrollTops.get(this) ?? 0
      },
      set(this: Element, value: number) {
        scrollTops.set(this, value)
      },
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      writable: true,
      value: scrollTo,
    })
  })

  afterEach(() => {
    for (const key of ['scrollHeight', 'clientHeight', 'scrollTop', 'scrollTo']) {
      Reflect.deleteProperty(HTMLElement.prototype, key)
    }
  })

  const seed = (count: number, prefix = 't') => {
    for (let i = 0; i < count; i += 1) {
      useEventStore.getState().ingestTrace(makeTrace(`${prefix}-${i}`))
    }
  }
  const stream = () => document.querySelector<HTMLElement>('.reasoning-panel__stream')!
  const latest = () => screen.queryByTestId('trace-latest')

  it('opens pinned to the newest line with no animation, and shows no affordance', () => {
    seed(40)
    render(<ReasoningPanel />)
    expect(scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: 'instant' })
    expect(scrollTo.mock.instances[0]).toBe(stream())
    expect(stream().scrollTop).toBe(2000)
    expect(latest()).toBeNull()
  })

  it('re-pins instantly when a line arrives while following', () => {
    seed(3)
    render(<ReasoningPanel />)
    scrollTo.mockClear()
    act(() => {
      useEventStore.getState().ingestTrace(makeTrace('t-new'))
    })
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: 'instant' })
    expect(latest()).toBeNull()
  })

  it('stops following when the operator scrolls up, counts the lines that arrive, and jumps back on "latest"', () => {
    seed(10)
    render(<ReasoningPanel />)
    stream().scrollTop = 1000
    fireEvent.scroll(stream())
    expect(latest()).toHaveTextContent('latest')
    expect(latest()).not.toHaveTextContent('new')

    scrollTo.mockClear()
    act(() => {
      useEventStore.getState().ingestTrace(makeTrace('t-a'))
      useEventStore.getState().ingestTrace(makeTrace('t-b'))
    })
    expect(scrollTo).not.toHaveBeenCalled()
    expect(stream().scrollTop).toBe(1000)
    expect(latest()).toHaveTextContent('2 new')

    fireEvent.click(latest()!)
    expect(scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: 'instant' })
    expect(latest()).toBeNull()
  })

  it('resumes following on its own when scrolled back to within a few pixels of the end', () => {
    seed(10)
    render(<ReasoningPanel />)
    stream().scrollTop = 800
    fireEvent.scroll(stream())
    expect(latest()).not.toBeNull()

    // 2000 - 400 - 1597 = 3 px short of the end: close enough.
    stream().scrollTop = 1597
    fireEvent.scroll(stream())
    expect(latest()).toBeNull()

    scrollTo.mockClear()
    act(() => {
      useEventStore.getState().ingestTrace(makeTrace('t-after'))
    })
    expect(scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: 'instant' })
  })

  it('keeps the film script hooks on every line', () => {
    useEventStore.getState().ingestTrace(
      makeTrace('t-hooks', { stage: 'attrib_redteam', message: 'challenge: weak evidence' }),
    )
    render(<ReasoningPanel compact />)
    const line = lineFor('t-hooks')!
    expect(line).toHaveAttribute('data-trace-id', 't-hooks')
    expect(line.querySelector('[data-testid="trace-stage"]')).not.toBeNull()
    expect(line.querySelector('[data-testid="trace-headline"]')).not.toBeNull()
    expect(document.querySelector('.reasoning-panel--compact')).not.toBeNull()
  })
})
