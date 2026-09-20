import { useEffect, useMemo, useState } from 'react'
import { fetchGateway } from '../lib/gateway'
import { useEventStore } from '../store/eventStore'
import { DOMAINS, type Domain } from '../types/canopy'

const isDomain = (value: unknown): value is Domain =>
  typeof value === 'string' && (DOMAINS as readonly string[]).includes(value)

/** The input domains stress mode denies: the gateway's `GET /stress` answer
 *  at mount, plus every domain a `stress` trace reports dropped in this run
 *  (the gateway is the source of truth; the traces catch a change made from
 *  the Signals page while this page was open). Empty when the gateway is
 *  unreachable and no trace says otherwise. */
export function useStressDomains(fetchImpl: typeof fetch = fetch): Domain[] {
  const [fromGateway, setFromGateway] = useState<Domain[]>([])
  const traces = useEventStore((s) => s.traces)

  useEffect(() => {
    let cancelled = false
    fetchGateway('/stress', undefined, { fetchImpl })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((body: { blocked_domains?: unknown }) => {
        if (cancelled) return
        const blocked = Array.isArray(body.blocked_domains) ? body.blocked_domains : []
        setFromGateway(blocked.filter(isDomain))
      })
      .catch(() => {
        // gateway unreachable: only the traces can say what was dropped
      })
    return () => {
      cancelled = true
    }
  }, [fetchImpl])

  return useMemo(() => {
    const denied = new Set<Domain>(fromGateway)
    for (const trace of traces) {
      if (trace.stage === 'stress' && isDomain(trace.payload?.domain)) denied.add(trace.payload.domain)
    }
    return DOMAINS.filter((domain) => denied.has(domain))
  }, [fromGateway, traces])
}
