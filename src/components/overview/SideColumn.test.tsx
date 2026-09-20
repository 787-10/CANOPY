import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SideColumn } from './SideColumn'
import { OVERVIEW_LAYOUT_KEYS, useColumnExpanded } from '../../lib/overviewLayout'
import { CAPTURE_HIDES } from '../../store/captureStore'

/** The column as the page wires it: state from the layout hook. */
function Harness({ side, capture = false }: { side: 'left' | 'right'; capture?: boolean }) {
  const [expanded, toggle] = useColumnExpanded(side, capture)
  return (
    <SideColumn side={side} label={side === 'left' ? 'Situation' : 'Response'} expanded={expanded} onToggle={toggle} capture={capture}>
      <p>column content</p>
    </SideColumn>
  )
}

beforeEach(() => {
  localStorage.clear()
})

describe('SideColumn', () => {
  it('starts expanded, collapses into a rail on the toggle and remembers the choice', () => {
    render(<Harness side="left" />)
    const column = screen.getByTestId('side-column-left')
    const toggle = screen.getByRole('button', { name: 'Collapse Situation' })
    expect(column).toHaveClass('side-column--expanded')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveAttribute('aria-controls', 'overview-left-column')
    expect(screen.getByText('column content')).toBeVisible()

    fireEvent.click(toggle)
    expect(column).toHaveClass('side-column--collapsed')
    expect(column).toHaveAttribute('data-expanded', 'false')
    expect(screen.getByRole('button', { name: 'Expand Situation' })).toHaveAttribute('aria-expanded', 'false')
    expect(document.getElementById('overview-left-column')).toHaveAttribute('hidden')
    expect(column).toHaveTextContent('Situation')
    expect(localStorage.getItem(OVERVIEW_LAYOUT_KEYS.left)).toBe('collapsed')
  })

  it('keeps the toggle in its own track: a sibling of the content box, never a child over it', () => {
    render(
      <>
        <Harness side="left" />
        <Harness side="right" />
      </>,
    )
    for (const side of ['left', 'right'] as const) {
      const column = screen.getByTestId(`side-column-${side}`)
      const body = screen.getByTestId(`side-body-${side}`)
      const toggle = screen.getByTestId(`side-toggle-${side}`)
      expect(body.parentElement).toBe(column)
      expect(toggle.parentElement).toBe(column)
      expect(body.contains(toggle)).toBe(false)
      expect(toggle).toHaveAttribute('aria-controls', body.id)
      // Collapsed, the rail label and the handle are separate siblings too.
      fireEvent.click(toggle)
      const label = column.querySelector('.side-column__rail-label')
      expect(label?.parentElement).toBe(column)
      expect(label).not.toHaveAttribute('hidden')
      expect(label?.contains(toggle)).toBe(false)
    }
  })

  it('reads a stored collapsed state on mount, per side', () => {
    localStorage.setItem(OVERVIEW_LAYOUT_KEYS.right, 'collapsed')
    render(
      <>
        <Harness side="left" />
        <Harness side="right" />
      </>,
    )
    expect(screen.getByTestId('side-column-left')).toHaveClass('side-column--expanded')
    expect(screen.getByTestId('side-column-right')).toHaveClass('side-column--collapsed')
  })

  it('is reachable from the keyboard: the toggle is a real button that reacts to Enter', () => {
    render(<Harness side="right" />)
    const toggle = screen.getByTestId('side-toggle-right')
    toggle.focus()
    expect(document.activeElement).toBe(toggle)
    fireEvent.click(toggle)
    expect(screen.getByTestId('side-column-right')).toHaveClass('side-column--collapsed')
  })

  it('works when storage throws', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    try {
      render(<Harness side="left" />)
      expect(screen.getByTestId('side-column-left')).toHaveClass('side-column--expanded')
      fireEvent.click(screen.getByTestId('side-toggle-left'))
      expect(screen.getByTestId('side-column-left')).toHaveClass('side-column--collapsed')
    } finally {
      getItem.mockRestore()
      setItem.mockRestore()
    }
  })

  it('capture mode forces the column open over a stored collapse and hides the toggle', () => {
    localStorage.setItem(OVERVIEW_LAYOUT_KEYS.left, 'collapsed')
    render(<Harness side="left" capture />)
    expect(screen.getByTestId('side-column-left')).toHaveClass('side-column--expanded')
    const toggle = screen.getByTestId('side-toggle-left')
    expect(toggle).toHaveAttribute('data-capture-hide')
    expect(toggle).toBeDisabled()
    expect(CAPTURE_HIDES.some((entry) => entry.component === 'SideColumn')).toBe(true)
    // The stored choice survives capture mode.
    expect(localStorage.getItem(OVERVIEW_LAYOUT_KEYS.left)).toBe('collapsed')
  })
})
