import { useEffect, useState } from 'react'
import { verdictCopy } from '../../lib/commanderLanguage'
import { deriveIncidents, relativeTime } from '../../lib/incidents'
import { MARKING_UNCLASSIFIED } from '../../lib/marking'
import { useEventStore } from '../../store/eventStore'
import { Disclosure } from './Disclosure'

type TheatersSectionProps = {
  open: boolean
  onToggle: () => void
}

const CLOCK_MS = 30_000

/** Which incident to focus on: one row per satellite cluster (and per
 *  unresolved cue). A row pins the episode; the detail pages follow the
 *  pin until "Follow latest" clears it. */
export function TheatersSection({ open, onToggle }: TheatersSectionProps) {
  const attributions = useEventStore((s) => s.attributions)
  const pinned = useEventStore((s) => s.pinnedSatelliteId)
  const pinEpisode = useEventStore((s) => s.pinEpisode)
  const incidents = deriveIncidents(attributions)
  const [now, setNow] = useState(() => Date.now())

  // Relative times drift; refresh them on a slow clock while the section is open.
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS)
    return () => clearInterval(timer)
  }, [open])

  return (
    <Disclosure id="theaters" label="Theaters" count={incidents.length} open={open} onToggle={onToggle}>
      {incidents.length ? (
        <ul className="theaters" data-testid="theater-rows">
          {incidents.map((incident) => {
            const { attribution } = incident
            const verdict = attribution.verdict ?? 'absent'
            const label = attribution.verdict ? verdictCopy[attribution.verdict].label : 'No verdict'
            const isPinned = incident.satelliteId !== null && incident.satelliteId === pinned
            const marking = attribution.marking ?? MARKING_UNCLASSIFIED
            return (
              <li key={incident.key}>
                <button
                  type="button"
                  className={`theater${isPinned ? ' theater--pinned' : ''}${incident.unresolved ? ' theater--unresolved' : ''}`}
                  aria-pressed={isPinned}
                  disabled={incident.unresolved}
                  onClick={() => pinEpisode(isPinned ? null : incident.satelliteId)}
                  data-testid="theater-row"
                  data-satellite={incident.satelliteId ?? undefined}
                  title={incident.unresolved ? 'Not keyed to one satellite; cannot be pinned' : isPinned ? 'Pinned; click to follow the latest' : 'Pin this incident'}
                >
                  <span className="theater__name">{incident.label}</span>
                  <span className={`theater__verdict theater__verdict--${verdict}`}>{label}</span>
                  <span className="theater__meta">
                    <b>{Math.round(attribution.confidence * 100)}%</b>
                    {' · rev '}
                    {attribution.revision ?? 0}
                    {' · '}
                    {relativeTime(attribution.ts, now)}
                  </span>
                  {marking !== MARKING_UNCLASSIFIED ? (
                    <span className="theater__marking" data-testid="theater-marking">{marking}</span>
                  ) : null}
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="side-column__empty">No incident yet</p>
      )}
      {pinned ? (
        <button type="button" className="side-column__quiet" onClick={() => pinEpisode(null)} data-testid="follow-latest" data-key="F" title="Key F">
          Follow latest
        </button>
      ) : null}
    </Disclosure>
  )
}
