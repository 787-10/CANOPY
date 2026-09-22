import { spacecraftDisplayName } from '../../lib/commanderLanguage'
import { FLEET, fleetClock, fleetStatus } from '../../lib/fleet'
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

/** The fleet, known before any report (lib/fleet.ts): one row per spacecraft
 *  with its role and what it has sent this run. The name opens the body on
 *  the Spacecraft page; the rest of the row follows the spacecraft on the
 *  globe, incident or not (OBJ-1 included). Then the episode's
 *  spacecraft, its latest bus symptom with its subsystem, and the
 *  physics-consistency score with its recent trend. */
export function SpacecraftSection({ satelliteId, open, onToggle }: SpacecraftSectionProps) {
  const anomalies = useEventStore((s) => s.anomalies)
  const signals = useEventStore((s) => s.signals)
  const followed = useEventStore((s) => s.followedSatelliteId)
  const followSatellite = useEventStore((s) => s.followSatellite)
  const facts = spacecraftFacts(anomalies, satelliteId)
  const name = facts.satelliteId ? spacecraftDisplayName(facts.satelliteId) : null
  const href = withCapture(name ? `/spacecraft?sat=${encodeURIComponent(name)}` : '/spacecraft')
  const fleet = fleetStatus(signals, anomalies)
  return (
    <Disclosure id="spacecraft" label="Spacecraft" count={name ?? String(FLEET.length)} open={open} onToggle={onToggle}>
      <ul className="fleet" data-testid="fleet">
        {fleet.map(({ member, reportCount, latest, state }) => {
          const isFollowed = followed === member.satelliteId
          return (
            <li
              key={member.satelliteId}
              className={`fleet__row${member.satelliteId === facts.satelliteId ? ' fleet__row--episode' : ''}${isFollowed ? ' fleet__row--followed' : ''}`}
              data-testid="fleet-row"
              data-satellite={member.satelliteId}
              data-state={state}
              aria-current={member.satelliteId === facts.satelliteId ? 'true' : undefined}
            >
              <a
                className="fleet__name"
                href={withCapture(`/spacecraft?sat=${encodeURIComponent(member.name)}`)}
                title={`${member.note}. Open the body.`}
                data-testid="fleet-name"
              >
                {member.name}
              </a>
              <button
                type="button"
                className="fleet__follow"
                aria-pressed={isFollowed}
                onClick={() => followSatellite(isFollowed ? null : member.satelliteId)}
                title={isFollowed ? `Stop following ${member.name}` : `Follow ${member.name} on the globe`}
                data-testid="fleet-follow"
              >
                <span className="fleet__role">{member.roleLabel}</span>
                <span className="fleet__status">
                  {latest ? `${reportCount} report${reportCount === 1 ? '' : 's'} · ${fleetClock(latest.ts)}` : 'no reports yet'}
                </span>
                <span className="fleet__follow-mark" aria-hidden="true">
                  {isFollowed ? '◉' : '◎'}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
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
