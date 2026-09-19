import { useEffect } from 'react'
import { useEventStore } from '../store/eventStore'
import type { KBEntry } from '../types/canopy'

const API_URL = import.meta.env.VITE_CANOPY_API_URL ?? 'http://localhost:8000'

/** Loads the gateway's knowledge base once so citation ids resolve to cards
 *  in the Verdict panel. The gateway serves the file it was started with
 *  (the demo-only one under CANOPY_KB_PATH); a failed fetch leaves the ids
 *  rendered as ids. */
export function useKnowledgeBase(fetchImpl: typeof fetch = fetch, apiUrl: string = API_URL) {
  const setKB = useEventStore((s) => s.setKB)
  useEffect(() => {
    let cancelled = false
    fetchImpl(`${apiUrl}/kb`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return (await response.json()) as { entries?: KBEntry[] }
      })
      .then((body) => {
        if (!cancelled && Array.isArray(body.entries)) setKB(body.entries)
      })
      .catch(() => {
        // gateway unreachable: citations stay as ids
      })
    return () => {
      cancelled = true
    }
  }, [fetchImpl, apiUrl, setKB])
}
