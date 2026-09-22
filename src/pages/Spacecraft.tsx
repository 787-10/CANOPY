import { useMemo } from 'react'
import { TopBar } from '../components/TopBar'
import { BeliefBar } from '../components/spacecraft/BeliefBar'
import { RecoveryStatePanel } from '../components/spacecraft/RecoveryStatePanel'
import { SpacecraftScene } from '../components/spacecraft/SpacecraftScene'
import { SymptomSparkline } from '../components/spacecraft/SymptomSparkline'
import { useCanopySocket } from '../hooks/useCanopySocket'
import { spacecraftDisplayName, verdictLabel } from '../lib/commanderLanguage'
import { FLEET_PRIMARY, fleetClock, fleetStatus } from '../lib/fleet'
import { resolveRequestedSatellite } from '../lib/syntheticSatellites'
import {
  buildSymptomSeries,
  latestVerdictFor,
  pickSatelliteId,
  recordsForSatellite,
  recoveryState,
  subsystemStates,
} from '../lib/spacecraftHealth'
import { withCapture } from '../store/captureStore'
import { useEventStore } from '../store/eventStore'

type SpacecraftProps = {
  /** `?sat=` value: a `ctb://` id or a display name such as `SIM-01`. */
  requestedSatellite?: string | null
}

/** The spacecraft as a body: the 3D model with each subsystem's health on
 *  it, the verdict, and one chip per subsystem; under it the symptom curve,
 *  the cause belief and the recovery state. Every value is derived from the
 *  store by the pure functions in lib/spacecraftHealth. */
export function Spacecraft({ requestedSatellite = null }: SpacecraftProps) {
  // Keep the store live while this page is open (same socket the Brigade uses).
  useCanopySocket()
  const signals = useEventStore((s) => s.signals)
  const attributions = useEventStore((s) => s.attributions)
  const anomalies = useEventStore((s) => s.anomalies)
  const decisions = useEventStore((s) => s.decisions)

  // The spacecraft named in ?sat=, else the latest bus-health record's, else
  // the fleet's primary: the page shows a body before any report arrives.
  const satelliteId = useMemo(
    () => pickSatelliteId(signals, resolveRequestedSatellite(requestedSatellite)) ?? FLEET_PRIMARY.satelliteId,
    [signals, requestedSatellite],
  )
  const fleet = useMemo(() => fleetStatus(signals, anomalies), [signals, anomalies])
  const records = useMemo(() => recordsForSatellite(signals, satelliteId), [signals, satelliteId])
  const { attribution, decision } = useMemo(
    () => latestVerdictFor(attributions, decisions, satelliteId, anomalies),
    [attributions, decisions, satelliteId, anomalies],
  )
  const states = useMemo(
    () => subsystemStates(records, attribution, decision),
    [records, attribution, decision],
  )
  const series = useMemo(() => buildSymptomSeries(records), [records])
  const acceptedIds = useEventStore((s) => s.acceptedDecisionIds)
  const deferredIds = useEventStore((s) => s.deferredDecisionIds)
  const operatorStatus = decision
    ? acceptedIds.has(decision.id)
      ? 'accepted'
      : deferredIds.has(decision.id)
        ? 'denied'
        : null
    : null
  const recovery = useMemo(
    () => recoveryState(records, decision, operatorStatus),
    [records, decision, operatorStatus],
  )
  const latest = records[records.length - 1] ?? null
  const latestSymptom = [...records].reverse().find((record) => !record.isNominal) ?? latest
  const name = spacecraftDisplayName(satelliteId)
  const verdict = attribution?.verdict ?? null
  const verdictState = verdict ?? 'absent'

  return (
    <main className="spacecraft-shell" data-testid="spacecraft-page" data-satellite={satelliteId ?? undefined}>
      <TopBar
        title={`Spacecraft · ${name}`}
        current="spacecraft"
        right={
          <span
            className={`verdict-badge verdict-badge--${verdictState}`}
            data-testid="spacecraft-verdict"
            data-verdict={verdictState}
          >
            {verdictLabel(verdict)}
            {attribution ? ` · ${Math.round(attribution.confidence * 100)}%` : ''}
            {attribution?.provisional ? ' · provisional' : ''}
          </span>
        }
      />

      <div className="spacecraft-body">
        <nav className="fleet-switch" aria-label="Spacecraft" data-testid="fleet-switch">
          {fleet.map(({ member, reportCount, latest, state }) => (
            <a
              key={member.satelliteId}
              href={withCapture(`/spacecraft?sat=${encodeURIComponent(member.name)}`)}
              className={`fleet-switch__item${member.satelliteId === satelliteId ? ' is-current' : ''}`}
              aria-current={member.satelliteId === satelliteId ? 'page' : undefined}
              data-testid={`fleet-switch-${member.name}`}
              data-state={state}
              title={`${member.roleLabel}: ${member.note}`}
            >
              <strong>{member.name}</strong>
              <span>{member.roleLabel}</span>
              <small>
                {latest ? `${reportCount} report${reportCount === 1 ? '' : 's'} · ${fleetClock(latest.ts)}` : 'no reports yet'}
              </small>
            </a>
          ))}
        </nav>
        {records.length === 0 ? (
          <p className="spacecraft-quiet" data-testid="spacecraft-quiet">
            No bus-health record from {name} yet: the body shows what is known, which is nothing.
            Replay a scenario from the Brigade view or the{' '}
            <a href={withCapture('/demo?run=A')}>demo launcher</a>.
          </p>
        ) : null}
          <SpacecraftScene
            name={name}
            states={states}
            recovery={recovery}
            verdict={verdict}
            confidence={attribution?.confidence ?? null}
            provisional={Boolean(attribution?.provisional)}
            actor={attribution?.actor ?? null}
          />

          <section className="spacecraft-strip" aria-label={`${name} health`}>
            <section className="panel spacecraft-strip__panel">
              <div className="panel__header">
                <h2>Symptom</h2>
                <span data-testid="spacecraft-symptom">
                  {latestSymptom ? `${latestSymptom.subsystemLabel} · ${latestSymptom.symptomLabel}` : 'none'}
                  {latest ? (
                    <>
                      {' · '}
                      <a
                        href={withCapture(`/signal?id=${encodeURIComponent(latest.signalId)}`)}
                        data-testid="spacecraft-latest-report"
                      >
                        latest report →
                      </a>
                    </>
                  ) : null}
                </span>
              </div>
              <div className="spacecraft-strip__body">
                <SymptomSparkline series={series} symptomLabel={latestSymptom?.symptomLabel ?? 'no symptom'} />
              </div>
            </section>

            <section className="panel spacecraft-strip__panel">
              <div className="panel__header">
                <h2>Cause belief</h2>
                <span>{latestSymptom ? `record ${latestSymptom.ts.slice(11, 19)}Z` : 'no record'}</span>
              </div>
              <div className="spacecraft-strip__body">
                <BeliefBar
                  basis={latestSymptom?.physicsBasis ?? null}
                  physicsConsistency={latestSymptom?.physicsConsistency ?? null}
                />
              </div>
            </section>

            <section className="panel spacecraft-strip__panel">
              <div className="panel__header">
                <h2>Recovery</h2>
                <span>{recovery.phase === 'none' ? 'none' : recovery.phase}</span>
              </div>
              <div className="spacecraft-strip__body">
                <RecoveryStatePanel state={recovery} />
              </div>
            </section>
          </section>
        </div>
    </main>
  )
}
