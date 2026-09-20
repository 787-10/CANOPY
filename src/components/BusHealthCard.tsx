import { useMemo } from 'react'
import {
  busHealthRecord,
  formatOnset,
  type BusHealthRecord,
} from '../lib/busHealth'
import {
  gateReasonLabel,
  recoveryActionLabel,
  subsystemLabel,
} from '../lib/commanderLanguage'
import { causeLabel, rateMethodLabel } from '../lib/physicsBasis'
import { useCaptureStore } from '../store/captureStore'
import type { Decision, Signal } from '../types/canopy'
import { WithheldRecoveryChip } from './WithheldRecoveryChip'

type BusHealthCardProps = {
  /** A `bus_health` signal (docs/INTERFACE-SPEC.md §3). */
  signal: Signal
  /** Fills the frame: larger type, every field, for capture S2. */
  zoomed?: boolean
  /** Inline in the feed under an expanded row. */
  compact?: boolean
  /** The decision taken on this spacecraft, to show whether the recommended
   *  recovery was routed or withheld. */
  decision?: Decision | null
  /** Where the zoom control navigates; omitted hides the control. */
  zoomHref?: string
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
const pct = (value: number | null) =>
  value === null ? '--' : `${Math.round(clamp01(value) * 100)}%`

/** F2: the internal-diagnosis signal card. Subsystem, symptom, onset, rate
 *  of change, the physics-consistency meter, the parsed basis (masses and
 *  top cause) and the recommended recovery. */
export function BusHealthCard({
  signal,
  zoomed = false,
  compact = false,
  decision = null,
  zoomHref,
}: BusHealthCardProps) {
  const capture = useCaptureStore((s) => s.enabled)
  const record = useMemo(() => busHealthRecord(signal), [signal])

  return (
    <article
      className={[
        'bus-health-card',
        zoomed ? 'bus-health-card--zoomed' : '',
        compact ? 'bus-health-card--compact' : '',
        record.isNominal ? 'bus-health-card--nominal' : 'bus-health-card--symptom',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label={`Bus-health signal for ${record.displayName}`}
      data-testid="bus-health-card"
      data-event-type={record.eventType}
    >
      <header className="bus-health-card__head">
        <div>
          <span className="bus-health-card__eyebrow">
            Bus-health signal · internal diagnosis
          </span>
          <h2 className="bus-health-card__title">
            <span data-testid="bus-health-satellite">{record.displayName}</span>
            <span className="bus-health-card__event" data-testid="bus-health-event">
              {record.eventLabel}
            </span>
          </h2>
        </div>
        <div className="bus-health-card__head-right">
          <span className="bus-health-card__confidence">
            {Math.round(record.confidence * 100)}% confidence
          </span>
          {zoomHref && !zoomed ? (
            <a className="bus-health-card__zoom" href={zoomHref}>
              Zoom
            </a>
          ) : null}
        </div>
      </header>

      <dl className="bus-health-card__facts">
        <div>
          <dt>Subsystem</dt>
          <dd data-testid="bus-health-subsystem">{record.subsystemLabel}</dd>
        </div>
        <div>
          <dt>Symptom</dt>
          <dd data-testid="bus-health-symptom">{record.symptomLabel}</dd>
        </div>
        <div>
          <dt>Onset</dt>
          <dd data-testid="bus-health-onset">
            {formatOnset(record.onsetTs, record.onsetClockDomain)}
          </dd>
          {record.simTimeS !== null ? <small>sim t+{record.simTimeS.toFixed(0)} s</small> : null}
        </div>
        <div>
          <dt>Rate of change</dt>
          <dd data-testid="bus-health-rate">{record.rateLabel ?? 'no window'}</dd>
          {record.shape ? <small>shape: {record.shape}</small> : null}
        </div>
      </dl>

      <PhysicsMeter record={record} />
      <BasisBlock record={record} zoomed={zoomed} />

      <RecoveryBlock record={record} decision={decision} />

      {zoomed && record.summary ? (
        <details className="bus-health-card__more">
          <summary>Record summary</summary>
          <p className="bus-health-card__summary">{record.summary}</p>
        </details>
      ) : null}

      {!capture ? (
        <footer className="bus-health-card__footer" data-capture-hide>
          <span>{signal.id}</span>
          <span>{signal.provenance.collector ?? signal.source}</span>
          {signal.provenance.method ? <span>{signal.provenance.method}</span> : null}
        </footer>
      ) : null}
    </article>
  )
}

function PhysicsMeter({ record }: { record: BusHealthRecord }) {
  const physics = record.physicsConsistency
  return (
    <div className="bus-health-card__meter-row">
      <span className="bus-health-card__meter-label" id={`bhc-physics-${record.signalId}`}>
        Physics consistency
      </span>
      {physics === null ? (
        <span
          className="bus-health-card__meter-value bus-health-card__meter-value--absent"
          data-testid="bus-health-physics"
        >
          not scored
        </span>
      ) : (
        <>
          <div
            className="bus-health-card__meter"
            role="meter"
            aria-labelledby={`bhc-physics-${record.signalId}`}
            aria-valuemin={0}
            aria-valuemax={1}
            aria-valuenow={clamp01(physics)}
            aria-valuetext={`${clamp01(physics).toFixed(2)} of 1`}
          >
            <span
              className="bus-health-card__meter-fill"
              style={{ width: `${Math.round(clamp01(physics) * 100)}%` }}
            />
          </div>
          <span className="bus-health-card__meter-value" data-testid="bus-health-physics">
            {clamp01(physics).toFixed(2)}
          </span>
        </>
      )}
    </div>
  )
}

function BasisBlock({ record, zoomed }: { record: BusHealthRecord; zoomed: boolean }) {
  const basis = record.physicsBasis
  if (!basis) {
    return (
      <p className="bus-health-card__basis-empty" data-testid="bus-health-basis">
        No physics basis attached.
      </p>
    )
  }
  return (
    <section
      className="bus-health-card__basis"
      aria-label="Physics basis"
      data-testid="bus-health-basis"
      data-basis-kind={basis.kind}
    >
      {basis.kind === 'belief' ? (
        <>
          <dl
            className="bus-health-card__legend"
            aria-label={`internal ${pct(basis.internal)}, external ${pct(basis.external)}, unknown ${pct(basis.unknown)}`}
          >
            <div className="bus-health-card__legend--internal">
              <dt>Internal</dt>
              <dd data-testid="basis-internal">{pct(basis.internal)}</dd>
            </div>
            <div className="bus-health-card__legend--external">
              <dt>External</dt>
              <dd data-testid="basis-external">{pct(basis.external)}</dd>
            </div>
            <div className="bus-health-card__legend--unknown">
              <dt>Unknown</dt>
              <dd data-testid="basis-unknown">{pct(basis.unknown)}</dd>
            </div>
          </dl>
        </>
      ) : (
        <p className="bus-health-card__basis-note">
          Shape evidence only; no belief was available for this record.
        </p>
      )}
      {basis.top ? (
        <p className="bus-health-card__top" data-testid="basis-top">
          <span className={`bus-health-card__cause bus-health-card__cause--${basis.top.side}`}>
            {causeLabel(basis.top.id)}
          </span>
          <span className="bus-health-card__top-mass">{pct(basis.top.mass)}</span>
          <span className="bus-health-card__top-label">top cause</span>
        </p>
      ) : null}
      {zoomed ? (
        // The scorer's details, folded: they are the record behind the score,
        // not the read.
        <details className="bus-health-card__more">
          <summary>Scorer details</summary>
        <dl className="bus-health-card__facts bus-health-card__facts--basis" data-testid="basis-facts">
          <div>
            <dt>shape</dt> <dd>{basis.shape ?? 'n/a'}</dd>
            {basis.shapeSupport !== null || basis.fitQuality !== null ? (
              <small>
                {basis.shapeSupport !== null ? `support ${basis.shapeSupport.toFixed(2)}` : ''}
                {basis.shapeSupport !== null && basis.fitQuality !== null ? ' · ' : ''}
                {basis.fitQuality !== null ? `fit ${basis.fitQuality.toFixed(2)}` : ''}
              </small>
            ) : null}
          </div>
          {basis.wBelief !== null ? (
            <div>
              <dt>belief weight</dt> <dd>{basis.wBelief.toFixed(2)}</dd>
            </div>
          ) : null}
          {basis.rate ? (
            <div>
              <dt>rate</dt> <dd>{rateMethodLabel(basis.rate)}</dd>
            </div>
          ) : null}
          {basis.row ? (
            <div>
              <dt>catalog row</dt> <dd>{basis.row.replaceAll('_', ' ')}</dd>
            </div>
          ) : null}
        </dl>
        </details>
      ) : (
        <p className="bus-health-card__shape-row">
          {basis.shape ? <span>shape {basis.shape}</span> : null}
          {basis.shapeSupport !== null ? <span>support {basis.shapeSupport.toFixed(2)}</span> : null}
          {basis.fitQuality !== null ? <span>fit {basis.fitQuality.toFixed(2)}</span> : null}
        </p>
      )}
    </section>
  )
}

function RecoveryBlock({
  record,
  decision,
}: {
  record: BusHealthRecord
  decision: Decision | null
}) {
  const recovery = record.recommendedRecovery
  if (!recovery) return null
  const withheld = decision?.withheld_recovery ?? null
  const routed =
    decision?.action === 'recovery_recommendation' &&
    decision.recovery?.action_id === recovery.action_id
  const gateMatch = decision?.rationale.match(/^\[gate:([^\]]+)\]/)
  const gateReason = gateMatch ? gateMatch[1] : null

  return (
    <section
      className="bus-health-card__recovery"
      aria-label="Recommended recovery"
      data-testid="bus-health-recovery"
    >
      <div className="bus-health-card__recovery-head">
        <span>Recommended recovery</span>
        {routed ? (
          <span className="bus-health-card__chip bus-health-card__chip--routed">routed as decision</span>
        ) : null}
        {gateReason ? (
          <span className="bus-health-card__chip bus-health-card__chip--blocked" title={gateReason}>
            blocked: {gateReasonLabel(gateReason)}
          </span>
        ) : null}
        {withheld ? <WithheldRecoveryChip withheld={withheld} variant="bus-health-card" /> : null}
      </div>
      <strong>{recoveryActionLabel(recovery.action_id)}</strong>
      <span className="bus-health-card__recovery-meta">
        {subsystemLabel(recovery.target_subsystem)} ·{' '}
        {recovery.requires_approval ? 'operator approval required' : 'no approval required'}
      </span>
      {recovery.rationale ? <p>{recovery.rationale}</p> : null}
    </section>
  )
}
