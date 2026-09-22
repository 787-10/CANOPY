import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, act, render, screen } from '@testing-library/react'
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

  it('does not take the page down on a malformed marking; the chip says so instead', () => {
    // The engine validates markings, but the attributions come back from
    // sessionStorage on every page load: one bad value must not white-screen
    // every page until the operator clears storage, and it must not read as
    // a milder level than it might be.
    useEventStore.getState().ingestAttribution(makeAttribution('att-bad', { marking: 'secret' }))
    render(<TopBar title="Console" current="brigade" />)
    const chip = screen.getByTestId('marking')
    expect(chip).toHaveTextContent(/invalid/i)
    expect(chip).not.toHaveTextContent(/^U$/)
    // The page around it still renders.
    expect(screen.getByTestId('connection')).toBeInTheDocument()
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

describe('TopBar navigation and fullscreen', () => {
  it('a plain click on a page link navigates in the document; the fullscreen control is present when the API exists', () => {
    window.history.replaceState(null, '', '/brigade')
    render(<TopBar title="Console" current="brigade" />)
    const link = screen.getByRole('link', { name: /Verdict/ })
    fireEvent.click(link)
    expect(window.location.pathname).toBe('/verdict')
    // jsdom has no fullscreen API: the control stays out of the way.
    expect(screen.queryByTestId('fullscreen')).toBeNull()
  })
})
