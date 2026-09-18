import { useEffect, useMemo, useState } from 'react'
import {
  gateReasonLabel,
  noVerdictCopy,
  parseGateRationale,
  recoveryActionLabel,
  spacecraftDisplayName,
  subsystemLabel,
  verdictBasisCopy,
  verdictCopy,
  verdictHeadline,
} from '../lib/commanderLanguage'
import { attributionTimings, formatMs } from '../lib/timing'
import { useEventStore } from '../store/eventStore'
import type { Attribution, Decision, Verdict } from '../types/canopy'
import { KBCitationCard } from './KBCitationCard'
import { WithheldRecoveryChip } from './WithheldRecoveryChip'

type VerdictPanelProps = {
  /** Latest attribution, or null while the engine is still correlating. */
  attribution: Attribution | null
  /** The decision taken on that attribution, when one has been published. */
  decision?: Decision | null
  /** Compact layout for the Brigade decision stack. */
  compact?: boolean
}

// `absent` is the explicit fifth state: the attribution predates the verdict
// lane (legacy scenarios) or the field came through as null.
type VerdictState = Verdict | 'absent'

const verdictState = (attribution: Attribution | null): VerdictState =>
  attribution?.verdict ?? 'absent'

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

const formatAction = (action: string) =>
  action.replaceAll('_', ' ').replace(/^\w/, (c) => c.toUpperCase())

/** Why fault versus attack: the verdict badge, the physics-consistency
 *  meter, which lane set the call, and every string the engine cited. Folds
 *  the former DecisionDetail (decision, request packet, KB citations) and
 *  NarrationPanel (assessment narrative) into one analyst-facing surface. */
export function VerdictPanel({
  attribution,
  decision = null,
  compact = false,
}: VerdictPanelProps) {
  const state = verdictState(attribution)
  const copy = state === 'absent' ? noVerdictCopy : verdictCopy[state]
  const physics =
    typeof attribution?.physics_consistency === 'number'
      ? clamp01(attribution.physics_consistency)
      : null
  const basis = attribution?.verdict_basis ?? null
  const verdictEvidence = attribution?.verdict_evidence ?? []
  const evidence = attribution?.evidence ?? []
  const citations = attribution?.kb_citations ?? []
  const satelliteId = attribution?.satellite_id ?? null
  const gate = decision ? parseGateRationale(decision.rationale) : null
  const provisional = attribution?.provisional === true
  const revision = attribution?.revision ?? 0
  const withheld = decision?.withheld_recovery ?? null

  return (
    <section
      className={[
        'panel',
        'verdict-panel',
        `verdict-panel--${state}`,
        compact ? 'verdict-panel--compact' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-labelledby="verdict-panel-title"
      data-verdict={state}
      data-provisional={provisional ? 'true' : undefined}
      data-revision={attribution ? revision : undefined}
    >
      <div className="panel__header">
        <h2 id="verdict-panel-title">Verdict</h2>
        <span className="verdict-panel__subject">
          {satelliteId
            ? spacecraftDisplayName(satelliteId)
            : attribution
              ? 'attribution lock'
              : 'standing by'}
        </span>
      </div>

      <div className="verdict-panel__badge-row">
        <span
          className={`verdict-panel__badge verdict-panel__badge--${state}`}
          data-testid="verdict-badge"
        >
          {copy.label}
        </span>
        {attribution ? (
          <span className="verdict-panel__confidence">
            {Math.round(attribution.confidence * 100)}% confidence
          </span>
        ) : null}
        {provisional ? (
          <span
            className="verdict-panel__provisional"
            data-testid="provisional-badge"
            title="Rule-lane verdict published before the reasoning lane ran; the same id is revised in place."
          >
            Provisional
          </span>
        ) : null}
        {attribution ? (
          <span className="verdict-panel__revision" data-testid="verdict-revision">
            rev {revision}
            {provisional ? '' : ' · final'}
          </span>
        ) : null}
      </div>

      {attribution ? (
        <p className="verdict-panel__headline">{verdictHeadline(attribution)}</p>
      ) : null}
      <p className="verdict-panel__meaning">
        {attribution
          ? copy.meaning
          : 'MEGALITH is correlating multi-domain activity. No attribution package is ready.'}
      </p>

      {attribution ? <VerdictTiming attribution={attribution} /> : null}

      {attribution ? (
        <>
          <div className="verdict-panel__meter-row">
            <span className="verdict-panel__meter-label" id="verdict-physics-label">
              Physics consistency
            </span>
            {physics === null ? (
              <span
                className="verdict-panel__meter-value verdict-panel__meter-value--absent"
                data-testid="physics-consistency"
              >
                not scored
              </span>
            ) : (
              <>
                <div
                  className="verdict-panel__meter"
                  role="meter"
                  aria-labelledby="verdict-physics-label"
                  aria-valuemin={0}
                  aria-valuemax={1}
                  aria-valuenow={physics}
                  aria-valuetext={`${physics.toFixed(2)} of 1`}
                >
                  <span
                    className="verdict-panel__meter-fill"
                    style={{ width: `${Math.round(physics * 100)}%` }}
                  />
                </div>
                <span
                  className="verdict-panel__meter-value"
                  data-testid="physics-consistency"
                >
                  {physics.toFixed(2)}
                </span>
              </>
            )}
          </div>

          <dl className="verdict-panel__facts">
            <div>
              <dt>Basis</dt>
              <dd data-testid="verdict-basis">
                {basis ? verdictBasisCopy[basis].label : 'no lane recorded'}
              </dd>
              {basis ? <small>{verdictBasisCopy[basis].meaning}</small> : null}
            </div>
            <div>
              <dt>Actor</dt>
              <dd>{attribution.actor}</dd>
              {attribution.doctrine_match ? (
                <small>{attribution.doctrine_match}</small>
              ) : null}
            </div>
            <div>
              <dt>Satellite</dt>
              <dd data-testid="verdict-satellite">
                {satelliteId ?? 'not identified'}
              </dd>
            </div>
            {attribution.predicted_next ? (
              <div>
                <dt>Forecast</dt>
                <dd>{attribution.predicted_next}</dd>
              </div>
            ) : null}
          </dl>

          {state !== 'absent' ? (
            <section className="verdict-panel__section" aria-label="Verdict evidence">
              <h3>Verdict evidence</h3>
              {verdictEvidence.length ? (
                <ul
                  className="verdict-panel__list verdict-panel__list--verdict"
                  data-testid="verdict-evidence"
                >
                  {verdictEvidence.map((line, index) => (
                    <li key={`${index}-${line}`}>{line}</li>
                  ))}
                </ul>
              ) : (
                <p className="verdict-panel__empty">
                  {basis === 'reasoning'
                    ? 'No cited change; the reasoning lane kept the rule verdict.'
                    : 'No reasoning-lane citations; the rule verdict stands.'}
                </p>
              )}
            </section>
          ) : null}

          <section className="verdict-panel__section" aria-label="Evidence">
            <h3>Evidence</h3>
            {evidence.length ? (
              <ul className="verdict-panel__list" data-testid="evidence">
                {evidence.map((line, index) => (
                  <li key={`${index}-${line}`}>{line}</li>
                ))}
              </ul>
            ) : (
              <p className="verdict-panel__empty">No evidence strings attached.</p>
            )}
          </section>

          {citations.length ? (
            <section className="verdict-panel__section" aria-label="KB citations">
              <h3>KB citations</h3>
              <div className="verdict-panel__citations">
                {citations.map((id) => (
                  <KBCitationCard key={id} citationId={id} />
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : null}

      {decision ? (
        <section
          className={`verdict-panel__section verdict-panel__decision${
            gate?.reasonCode ? ' verdict-panel__decision--blocked' : ''
          }`}
          aria-label="Decision"
        >
          <h3>Decision</h3>
          <p className="verdict-panel__decision-head">
            <strong>{formatAction(decision.action)}</strong>
            <span>authority: {decision.authority}</span>
            {gate?.reasonCode ? (
              <span
                className="verdict-panel__chip verdict-panel__chip--blocked"
                data-testid="gate-chip"
                title={gate.reasonCode}
              >
                Blocked: {gateReasonLabel(gate.reasonCode)}
              </span>
            ) : null}
            {withheld ? (
              <WithheldRecoveryChip withheld={withheld} variant="verdict-panel" />
            ) : null}
          </p>
          <p className="verdict-panel__rationale">{gate?.text ?? decision.rationale}</p>
          {decision.target ? (
            <p className="verdict-panel__target">Target: {decision.target}</p>
          ) : null}
          {decision.recovery ? (
            <dl className="verdict-panel__facts verdict-panel__recovery" data-testid="recovery">
              <div>
                <dt>Recovery action</dt>
                <dd>{recoveryActionLabel(decision.recovery.action_id)}</dd>
                <small>{decision.recovery.action_id}</small>
              </div>
              <div>
                <dt>Target subsystem</dt>
                <dd>{subsystemLabel(decision.recovery.target_subsystem)}</dd>
              </div>
              <div>
                <dt>Approval</dt>
                <dd>
                  {decision.recovery.requires_approval
                    ? 'Operator approval required'
                    : 'No approval required'}
                </dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>internal diagnosis</dd>
              </div>
              <div className="verdict-panel__facts-wide">
                <dt>Recovery rationale</dt>
                <dd>{decision.recovery.rationale}</dd>
              </div>
            </dl>
          ) : null}
          {decision.request_packet ? (
            <details className="details-panel details-panel--nested">
              <summary>
                <span>Request packet</span>
                <span>{String(decision.request_packet.packet_id ?? decision.id)}</span>
              </summary>
              <pre className="verdict-panel__packet">
                {JSON.stringify(decision.request_packet, null, 2)}
              </pre>
            </details>
          ) : null}
        </section>
      ) : null}
    </section>
  )
}


/** F3: "provisional in N ms, final in M ms" from the attrib traces'
 *  `latency_ms` (docs/INTERFACE-SPEC.md §5.0), plus the arrival-to-display
 *  time measured on the client from the WebSocket receipt of this revision
 *  to the commit that painted it. Real numbers only: a value the traces do
 *  not carry reads "n/a" and one that was never received over the socket
 *  (fixtures, sessionStorage) reads "not measured". */
export function VerdictTiming({ attribution }: { attribution: Attribution }) {
  const traces = useEventStore((s) => s.traces)
  const arrivals = useEventStore((s) => s.attributionArrivals[attribution.id])
  const timings = useMemo(
    () => attributionTimings(traces, attribution.id),
    [traces, attribution.id],
  )
  const revision = attribution.revision ?? 0
  const arrivedAt = arrivals?.[revision]
  const [displayMs, setDisplayMs] = useState<number | null>(null)
  const revisionKey = `${attribution.id}:${revision}`

  useEffect(() => {
    // Runs after this revision was committed to the DOM: the display moment.
    if (arrivedAt === undefined) {
      setDisplayMs(null)
      return
    }
    setDisplayMs(Math.max(0, performance.now() - arrivedAt))
    // revisionKey changes whenever a new revision of this id renders.
  }, [revisionKey, arrivedAt])

  const provisionalLine =
    timings.provisionalMs === null
      ? attribution.provisional
        ? 'awaiting trace'
        : 'n/a'
      : formatMs(timings.provisionalMs)
  const finalLine =
    timings.finalMs === null
      ? attribution.provisional
        ? 'pending'
        : 'n/a'
      : formatMs(timings.finalMs)

  return (
    <dl className="verdict-panel__timing" data-testid="verdict-timing" aria-label="Verdict timing">
      <div>
        <dt>Provisional in</dt>
        <dd data-testid="timing-provisional">{provisionalLine}</dd>
      </div>
      <div>
        <dt>Final in</dt>
        <dd data-testid="timing-final">
          {finalLine}
          {timings.finalRevision !== null ? <small> rev {timings.finalRevision}</small> : null}
        </dd>
      </div>
      <div>
        <dt>Arrival to display</dt>
        <dd data-testid="timing-display">
          {displayMs === null ? 'not measured' : `+${displayMs.toFixed(1)} ms`}
        </dd>
      </div>
    </dl>
  )
}
