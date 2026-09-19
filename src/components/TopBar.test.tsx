import { beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { TopBar } from './TopBar'
import { useEventStore } from '../store/eventStore'
import { makeAttribution } from '../test/factories'

beforeEach(() => {
  useEventStore.getState().reset()
})

describe('TopBar marking chip', () => {
  it('shows U while no attribution carries a higher marking', () => {
    useEventStore.getState().ingestAttribution(makeAttribution('att-u'))
    render(<TopBar title="Console" current="brigade" />)
    expect(screen.getByTestId('marking')).toHaveTextContent(/^U$/)
  })

  it('shows CUI once a CUI attribution is in the store', () => {
    const store = useEventStore.getState()
    store.ingestAttribution(makeAttribution('att-u', { marking: 'U' }))
    store.ingestAttribution(makeAttribution('att-c', { marking: 'CUI' }))
    render(<TopBar title="Console" current="brigade" />)
    expect(screen.getByTestId('marking')).toHaveTextContent(/^CUI$/)
  })

  it('follows the store while attributions arrive', () => {
    render(<TopBar title="Console" current="brigade" />)
    expect(screen.getByTestId('marking')).toHaveTextContent(/^U$/)
    act(() => {
      useEventStore.getState().ingestAttribution(makeAttribution('att-a', { marking: 'CUI//SP-B' }))
    })
    expect(screen.getByTestId('marking')).toHaveTextContent(/^CUI\/\/SP-B$/)
    act(() => {
      useEventStore.getState().ingestAttribution(makeAttribution('att-b', { marking: 'CUI//SP-A' }))
    })
    expect(screen.getByTestId('marking')).toHaveTextContent(/^CUI\/\/SP-A\/SP-B$/)
  })

  it('is hidden in capture mode so the fixed layout does not shift', () => {
    render(<TopBar title="Console" current="brigade" />)
    const chip = screen.getByTestId('marking')
    expect(chip).toHaveAttribute('data-capture-hide')
    // Styled like the connection dot beside it.
    expect(chip).toHaveClass('connection-dot')
    expect(screen.getByTestId('connection')).not.toHaveAttribute('data-capture-hide')
  })
})
