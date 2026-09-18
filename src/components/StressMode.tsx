import { useEffect, useState } from 'react'
import { DOMAINS, type Domain } from '../types/canopy'

const API_URL =
  import.meta.env.VITE_CANOPY_API_URL ?? 'http://localhost:8000'

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

export function StressMode() {
  const [blocked, setBlocked] = useState<Set<Domain>>(new Set())
  const [pending, setPending] = useState<Set<Domain>>(new Set())
  const [status, setStatus] = useState<'idle' | 'applying' | 'error'>('idle')

  useEffect(() => {
    let cancelled = false
    void fetch(`${API_URL}/stress`)
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
  }, [])

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
      const response = await fetch(`${API_URL}/stress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocked_domains: [...pending] }),
      })
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
        <h2 id="stress-mode-title">Stress mode</h2>
        <span>{blocked.size} blocked</span>
      </div>
      <p className="stress-mode__hint">
        Block input domains to simulate degraded ISR. The engine will drop
        signals from blocked domains and lower attribution confidence on
        anomalies that depend on them.
      </p>
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
