import { useEffect, useState } from 'react'
import { fetchGateway } from '../lib/gateway'
import { DOMAINS, type Domain } from '../types/canopy'

// Every blockable input domain, in vocabulary order (see types/canopy.ts).
const ALL_DOMAINS: readonly Domain[] = DOMAINS

const LABELS: Record<Domain, string> = {
  sda: 'SDA',
  orbit: 'Orbit',
  osint: 'OSINT',
  humint: 'HUMINT',
  rf_ew: 'RF / EW',
  cyber: 'Cyber',
  pnt: 'PNT / GNSS',
  satcom: 'SATCOM',
  drone: 'Drone',
  terrain: 'Terrain',
  bus_health: 'Bus health',
  space_weather: 'Space weather',
}

/** Reads and sets the gateway's blocked input domains (`GET`/`POST
 *  /stress`); `fetchImpl` is injectable for tests. */
export function StressMode({ fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {}) {
  const [blocked, setBlocked] = useState<Set<Domain>>(new Set())
  const [pending, setPending] = useState<Set<Domain>>(new Set())
  const [status, setStatus] = useState<'idle' | 'applying' | 'error'>('idle')

  useEffect(() => {
    let cancelled = false
    void fetchGateway('/stress', undefined, { fetchImpl })
      .then((r) => r.json())
      .then((data: { blocked_domains: Domain[] }) => {
        if (cancelled) return
        const next = new Set(data.blocked_domains)
        setBlocked(next)
        setPending(new Set(next))
      })
      .catch(() => {
        // Engine not running — leave defaults.
      })
    return () => {
      cancelled = true
    }
  }, [fetchImpl])

  function toggle(domain: Domain) {
    setPending((current) => {
      const next = new Set(current)
      if (next.has(domain)) next.delete(domain)
      else next.add(domain)
      return next
    })
  }

  async function apply() {
    setStatus('applying')
    try {
      const response = await fetchGateway(
        '/stress',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ blocked_domains: [...pending] }),
        },
        { fetchImpl },
      )
      if (!response.ok) throw new Error(`status=${response.status}`)
      const data = (await response.json()) as { blocked_domains: Domain[] }
      setBlocked(new Set(data.blocked_domains))
      setStatus('idle')
    } catch {
      setStatus('error')
    }
  }

  const dirty =
    pending.size !== blocked.size ||
    [...pending].some((d) => !blocked.has(d))

  return (
    <section className="stress-mode" aria-labelledby="stress-mode-title">
      <div className="panel__header">
        <h2 id="stress-mode-title">Stress mode · deny inputs</h2>
        <span>{blocked.size ? `${blocked.size} denied` : 'none denied'}</span>
      </div>
      <p className="stress-mode__hint">
        A tick denies that input: the engine drops it on the next replay, as if the source had gone
        dark. Untick and Apply to restore it.
      </p>
      {blocked.size ? (
        <p className="stress-mode__banner" role="status" data-testid="stress-banner">
          <strong>Denied {blocked.size === 1 ? 'input' : 'inputs'}:</strong>{' '}
          {[...blocked].map((domain) => LABELS[domain]).join(', ')}. The engine ignores{' '}
          {blocked.size === 1 ? 'it' : 'them'} on the next run; confidence on anomalies that needed{' '}
          {blocked.size === 1 ? 'it' : 'them'} is lowered and the trace records the dropped input.
        </p>
      ) : null}
      <div className="stress-mode__grid">
        {ALL_DOMAINS.map((domain) => {
          const isBlocked = pending.has(domain)
          return (
            <label
              key={domain}
              className={`stress-mode__cell${isBlocked ? ' stress-mode__cell--blocked' : ''}`}
            >
              <input
                type="checkbox"
                checked={isBlocked}
                onChange={() => toggle(domain)}
              />
              <span>{LABELS[domain]}</span>
            </label>
          )
        })}
      </div>
      <div className="stress-mode__actions">
        <button
          type="button"
          onClick={apply}
          disabled={!dirty || status === 'applying'}
        >
          {status === 'applying' ? 'Applying…' : 'Apply'}
        </button>
        {status === 'error' ? (
          <span className="stress-mode__error">Engine unreachable</span>
        ) : null}
      </div>
    </section>
  )
}
