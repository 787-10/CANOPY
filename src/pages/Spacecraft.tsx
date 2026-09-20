import { useMemo } from 'react'
import { BusHealthCard } from '../components/BusHealthCard'
import { TopBar } from '../components/TopBar'
import { BeliefBar } from '../components/spacecraft/BeliefBar'
import { RecoveryStatePanel } from '../components/spacecraft/RecoveryStatePanel'
import { SubsystemTopology } from '../components/spacecraft/SubsystemTopology'
import { SymptomSparkline } from '../components/spacecraft/SymptomSparkline'
import { useCanopySocket } from '../hooks/useCanopySocket'
import { spacecraftDisplayName, verdictLabel } from '../lib/commanderLanguage'
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

export function Spacecraft({ requestedSatellite = null }: SpacecraftProps) {
  // Keep the store live while this page is open (same socket the Brigade uses).
  useCanopySocket()
  const signals = useEventStore((s) => s.signals)
  const attributions = useEventStore((s) => s.attributions)
  const decisions = useEventStore((s) => s.decisions)

  const satelliteId = useMemo(
    () => pickSatelliteId(signals, resolveRequestedSatellite(requestedSatellite)),
    [signals, requestedSatellite],
  )
  const records = useMemo(() => recordsForSatellite(signals, satelliteId), [signals, satelliteId])
  const { attribution, decision } = useMemo(
    () => latestVerdictFor(attributions, decisions, satelliteId),
    [attributions, decisions, satelliteId],
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
  const latestSignal = latest
    ? signals.find((signal) => signal.id === latest.signalId) ?? null
    : null
  const name = satelliteId ? spacecraftDisplayName(satelliteId) : 'No spacecraft'
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

      {!satelliteId ? (
        <section className="spacecraft-empty panel">
          <h2>No bus-health records yet</h2>
          <p>
            The page follows the spacecraft named in <code>?sat=</code>, else the latest bus-health
            record. Replay a scenario from the Brigade view or the demo launcher and return here.
          </p>
          <a href={withCapture('/demo?run=A')}>Open the demo launcher</a>
        </section>
      ) : (
        <section className="spacecraft-grid" aria-label={`${name} health`}>
          <section className="panel spacecraft-panel spacecraft-panel--topology">
            <div className="panel__header">
              <h2>Subsystem topology</h2>
              <span>{records.length} bus-health records</span>
            </div>
            <SubsystemTopology states={states} name={name} />
          </section>

          <section className="panel spacecraft-panel spacecraft-panel--symptom">
            <div className="panel__header">
              <h2>Symptom</h2>
              <span data-testid="spacecraft-symptom">
                {latestSymptom ? `${latestSymptom.subsystemLabel} · ${latestSymptom.symptomLabel}` : 'none'}
              </span>
            </div>
            <SymptomSparkline
              series={series}
              symptomLabel={latestSymptom?.symptomLabel ?? 'no symptom'}
            />
          </section>

          <section className="panel spacecraft-panel spacecraft-panel--belief">
            <div className="panel__header">
              <h2>Cause belief</h2>
              <span>{latestSymptom ? `record ${latestSymptom.ts.slice(11, 19)}Z` : 'no record'}</span>
            </div>
            <BeliefBar
              basis={latestSymptom?.physicsBasis ?? null}
              physicsConsistency={latestSymptom?.physicsConsistency ?? null}
            />
          </section>

          <section className="panel spacecraft-panel spacecraft-panel--recovery">
            <div className="panel__header">
              <h2>Recovery</h2>
              <span>{recovery.phase === 'none' ? 'none' : recovery.phase}</span>
            </div>
            <RecoveryStatePanel state={recovery} />
          </section>

          <section className="spacecraft-panel spacecraft-panel--latest">
            {latestSignal ? (
              <BusHealthCard
                signal={latestSignal}
                decision={decision}
                zoomHref={withCapture(`/signal?id=${encodeURIComponent(latestSignal.id)}`)}
              />
            ) : null}
          </section>
        </section>
      )}
    </main>
  )
}
