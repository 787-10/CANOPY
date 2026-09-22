import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { GlobeControls, type GlobeControlsProps } from './GlobeControls'

const setup = (overrides: Partial<GlobeControlsProps> = {}) => {
  const props: GlobeControlsProps = {
    following: false,
    canFollow: true,
    followTarget: 'SIM-01',
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onResetView: vi.fn(),
    onToggleFollow: vi.fn(),
    ...overrides,
  }
  const view = render(<GlobeControls {...props} />)
  return { props, view }
}

describe('GlobeControls', () => {
  it('renders zoom in, zoom out, reset view and follow, each firing its callback once', () => {
    const { props } = setup()
    const toolbar = screen.getByRole('toolbar', { name: 'Globe controls' })
    expect(toolbar.querySelectorAll('button')).toHaveLength(4)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset view' }))
    fireEvent.click(screen.getByRole('button', { name: 'Follow' }))
    expect(props.onZoomIn).toHaveBeenCalledTimes(1)
    expect(props.onZoomOut).toHaveBeenCalledTimes(1)
    expect(props.onResetView).toHaveBeenCalledTimes(1)
    expect(props.onToggleFollow).toHaveBeenCalledTimes(1)
  })

  it('names the keys and the target in the tooltips', () => {
    setup()
    expect(screen.getByRole('button', { name: 'Zoom in' })).toHaveAttribute('title', 'Zoom in (+)')
    expect(screen.getByRole('button', { name: 'Zoom out' })).toHaveAttribute('title', 'Zoom out (−)')
    expect(screen.getByRole('button', { name: 'Reset view' }).title).toMatch(/home framing/)
    expect(screen.getByRole('button', { name: 'Follow' }).title).toMatch(/Follow SIM-01/)
  })

  it('reads Stop following while following, is pressed, names Esc, and flips back', () => {
    const { props, view } = setup({ following: true })
    const button = screen.getByRole('button', { name: 'Stop following' })
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(button.title).toBe('Stop following (Esc)')
    expect(screen.getByTestId('globe-controls')).toHaveAttribute('data-following', 'true')
    view.rerender(<GlobeControls {...props} following={false} />)
    expect(screen.getByRole('button', { name: 'Follow' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('globe-controls')).toHaveAttribute('data-following', 'false')
  })

  it('disables Follow when nothing can be followed, but never while following', () => {
    const { props, view } = setup({ canFollow: false, followTarget: null })
    const follow = screen.getByRole('button', { name: 'Follow' })
    expect(follow).toBeDisabled()
    expect(follow.title).toMatch(/Pin or select/)
    view.rerender(<GlobeControls {...props} following />)
    expect(screen.getByRole('button', { name: 'Stop following' })).toBeEnabled()
  })
})

describe('GlobeControls with the flight clock', () => {
  const flight = () => ({
    view: 'flight' as const,
    mode: 'free' as const,
    rate: 60,
    rateLocked: false,
    onToggleView: vi.fn(),
    onSetRate: vi.fn(),
    onTogglePause: vi.fn(),
  })

  it('renders a second toolbar with the view toggle, pause and the four rates, and leaves the camera cluster at four buttons', () => {
    const controls = flight()
    setup({ flight: controls })
    expect(screen.getByRole('toolbar', { name: 'Globe controls' }).querySelectorAll('button')).toHaveLength(4)
    const flightBar = screen.getByRole('toolbar', { name: 'Flight controls' })
    expect(flightBar.querySelectorAll('button')).toHaveLength(6)
    fireEvent.click(screen.getByTestId('flight-view'))
    fireEvent.click(screen.getByTestId('flight-pause'))
    fireEvent.click(screen.getByTestId('flight-rate-600'))
    expect(controls.onToggleView).toHaveBeenCalledTimes(1)
    expect(controls.onTogglePause).toHaveBeenCalledTimes(1)
    expect(controls.onSetRate).toHaveBeenCalledWith(600)
    expect(screen.getByTestId('flight-rate-60')).toHaveAttribute('aria-pressed', 'true')
  })

  it('locks the rate while a run is live and disables pause and rates in pass view', () => {
    setup({ flight: { ...flight(), rateLocked: true } })
    expect(screen.getByTestId('flight-rate-10')).toBeDisabled()
    expect(screen.getByTestId('flight-rate-10').title).toMatch(/the run's/)
    expect(screen.getByTestId('flight-pause')).toBeEnabled()
  })

  it('in pass view only the view toggle is live', () => {
    setup({ flight: { ...flight(), view: 'pass' } })
    expect(screen.getByTestId('flight-view')).toHaveTextContent('Pass view')
    expect(screen.getByTestId('flight-pause')).toBeDisabled()
    expect(screen.getByTestId('flight-rate-60')).toBeDisabled()
  })

  it('renders no flight toolbar without the prop', () => {
    setup()
    expect(screen.queryByRole('toolbar', { name: 'Flight controls' })).toBeNull()
  })
})

describe('GlobeControls while the clock holds', () => {
  it('lights no rate and offers Play, which calls onPlay', () => {
    const onPlay = vi.fn()
    const onTogglePause = vi.fn()
    setup({
      flight: {
        view: 'flight',
        mode: 'holding',
        rate: 1,
        rateLocked: false,
        onToggleView: vi.fn(),
        onSetRate: vi.fn(),
        onTogglePause,
        onPlay,
      },
    })
    expect(screen.getByTestId('flight-rate-1')).toHaveAttribute('aria-pressed', 'false')
    const play = screen.getByTestId('flight-pause')
    expect(play).toHaveTextContent('Play')
    fireEvent.click(play)
    expect(onPlay).toHaveBeenCalledTimes(1)
    expect(onTogglePause).not.toHaveBeenCalled()
  })
})
