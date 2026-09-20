import { spacecraftDisplayName } from '../../lib/commanderLanguage'
import { spacecraftFacts } from '../../lib/situation'
import { withCapture } from '../../store/captureStore'
import { useEventStore } from '../../store/eventStore'
import { Disclosure } from './Disclosure'
import { Sparkline } from './Sparkline'

type SpacecraftSectionProps = {
  /** The episode's satellite; null falls back to the latest bus symptom. */
  satelliteId: string | null
  open: boolean
  onToggle: () => void
}

/** The episode's spacecraft: its name in the section header, the latest
 *  bus symptom with its subsystem, and the physics-consistency score with
 *  its recent trend. */
export function SpacecraftSection({ satelliteId, open, onToggle }: SpacecraftSectionProps) {
  const anomalies = useEventStore((s) => s.anomalies)
  const facts = spacecraftFacts(anomalies, satelliteId)
  const name = facts.satelliteId ? spacecraftDisplayName(facts.satelliteId) : null
  const href = withCapture(name ? `/spacecraft?sat=${encodeURIComponent(name)}` : '/spacecraft')
  return (
    <Disclosure id="spacecraft" label="Spacecraft" count={name ?? '—'} open={open} onToggle={onToggle}>
      {facts.latest ? (
        <dl className="facts" data-testid="spacecraft-facts">
          <div>
            <dt>Symptom</dt>
            <dd>
              {facts.kindLabel} · {facts.subsystem}
            </dd>
          </div>
          <div>
            <dt>Physics consistency</dt>
            <dd className="facts__trend">
              <b data-testid="spacecraft-physics">
                {facts.physicsConsistency === null ? 'not scored' : facts.physicsConsistency.toFixed(2)}
              </b>
              <Sparkline values={facts.trend} label={`Physics consistency, last ${facts.trend.length} records`} />
            </dd>
          </div>
        </dl>
      ) : (
        <p className="side-column__empty">No bus symptom yet</p>
      )}
      <a className="side-column__link" href={href}>
        Spacecraft page →
      </a>
    </Disclosure>
  )
}
