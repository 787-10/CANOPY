import { useEffect } from 'react'
import { PAGES } from '../lib/pages'
import { useEpisode } from '../hooks/useEpisode'
import { acceptIsLocked, recordOperatorDecision } from '../lib/operatorDecisions'
import { useCaptureStore, withCapture } from '../store/captureStore'
import { useEventStore } from '../store/eventStore'

/** Keys for the console, as a terminal monitor has them: 1 to 6 open the
 *  pages in header order, A accepts and D denies the episode's decision, R
 *  reconsiders it, F follows the latest incident again. Ignored while typing
 *  in a field and with a modifier held. Renders nothing. */
export function Hotkeys() {
  const { attribution, decision } = useEpisode()
  const accepted = useEventStore((s) => (decision ? s.acceptedDecisionIds.has(decision.id) : false))
  const denied = useEventStore((s) => (decision ? s.deferredDecisionIds.has(decision.id) : false))
  const capture = useCaptureStore((s) => s.enabled)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return
      const target = event.target as HTMLElement | null
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return
      const key = event.key.toLowerCase()
      if (/^[1-9]$/.test(key)) {
        const page = PAGES[Number(key) - 1]
        if (page) window.location.assign(withCapture(page.href, capture))
        return
      }
      if (key === 'f') {
        useEventStore.getState().pinEpisode(null)
        return
      }
      if (!decision) return
      if (key === 'a' && !accepted && !acceptIsLocked(decision, attribution?.revision)) void recordOperatorDecision(decision, 'accepted')
      else if (key === 'd' && !denied) void recordOperatorDecision(decision, 'denied')
      else if (key === 'r' && (accepted || denied)) void recordOperatorDecision(decision, 'reconsidered')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [attribution, decision, accepted, denied, capture])

  return null
}
