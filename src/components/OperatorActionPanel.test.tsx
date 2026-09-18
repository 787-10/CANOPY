import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { OperatorActionPanel } from './OperatorActionPanel'
import { useEventStore } from '../store/eventStore'
import { makeDecision } from '../test/factories'
import { ACTIONS } from '../types/canopy'

beforeEach(() => {
  useEventStore.getState().reset()
})

describe('OperatorActionPanel — action labels', () => {
  it('renders nothing until a decision arrives', () => {
    const { container } = render(<OperatorActionPanel />)
    expect(container).toBeEmptyDOMElement()
  })

  it('titles a recovery recommendation in plain language', () => {
    useEventStore
      .getState()
      .ingestDecision(
        makeDecision('d-recovery', {
          action: 'recovery_recommendation',
          authority: 'local',
        }),
      )
    render(<OperatorActionPanel />)
    expect(
      screen.getByRole('heading', { name: 'Recovery recommendation' }),
    ).toBeInTheDocument()
  })

  it('never falls back to a title-cased slug for a vocabulary action', () => {
    for (const action of ACTIONS) {
      useEventStore.getState().reset()
      useEventStore.getState().ingestDecision(makeDecision(`d-${action}`, { action }))
      const { unmount } = render(<OperatorActionPanel />)
      const heading = screen.getByRole('heading', { level: 2 })
      expect(heading.textContent, action).not.toMatch(/_/)
      expect(heading.textContent, action).toMatch(/\S/)
      unmount()
    }
  })
})
