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
