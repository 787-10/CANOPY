import { useEffect, useState } from 'react'
import { fullscreenAvailable, toggleFullscreen } from '../lib/fullscreen'

/** The header's fullscreen control: the browser's own chrome goes, the
 *  console fills the screen, and page changes keep it since they stay in
 *  this document (lib/navigation.ts). Esc leaves, as the browser has it. */
export function FullscreenButton() {
  const [available, setAvailable] = useState(false)
  const [active, setActive] = useState(false)
  useEffect(() => {
    setAvailable(fullscreenAvailable())
    const sync = () => setActive(Boolean(document.fullscreenElement))
    sync()
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])
  if (!available) return null
  return (
    <button
      type="button"
      className="fullscreen-btn"
      onClick={() => void toggleFullscreen().catch(() => setActive(Boolean(document.fullscreenElement)))}
      aria-pressed={active}
      title={active ? 'Leave full screen (Esc)' : 'Full screen: the console fills the display; page keys keep it'}
      data-testid="fullscreen"
    >
      <span aria-hidden="true">{active ? '⤡' : '⛶'}</span>
      <span className="fullscreen-btn__label">{active ? 'Exit' : 'Full screen'}</span>
    </button>
  )
}
