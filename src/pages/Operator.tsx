import { useEventStore } from '../store/eventStore'
import { selectEpisodeAttribution } from '../lib/episode'
import { ActionLog } from '../components/ActionLog'
import { EmbeddingViz } from '../components/EmbeddingViz'
import { ReasoningPanel } from '../components/ReasoningPanel'
import { TopBar } from '../components/TopBar'
import { VerdictPanel } from '../components/VerdictPanel'
import { WithheldRecoveryChip } from '../components/WithheldRecoveryChip'
import { useCanopySocket } from '../hooks/useCanopySocket'
import {
  parseGateRationale,
  subsystemLabel,
  verdictLabel,
} from '../lib/commanderLanguage'

export function Operator() {
  // Open the same WebSocket Brigade uses so live engine output streams
  // into the global event store while the operator is on this page.
  // Without this hook the page is read-only on whatever sessionStorage
  // had cached, so the reasoning panel and queues only "update" when
  // the user toggles back to Brigade and a re-render fires.
  useCanopySocket()

  const signals = useEventStore((s) => s.signals)
  const anomalies = useEventStore((s) => s.anomalies)
  const attributions = useEventStore((s) => s.attributions)
  const attributionsById = useEventStore((s) => s.attributionsById)
  const decisions = useEventStore((s) => s.decisions)

  // Satellite cluster's final revision, not the newest attribution received.
  const latestAttribution = selectEpisodeAttribution(attributions, anomalies)
  // Newest decision taken on the latest attribution: a gate-republished
  // threat_warning sits ahead of the recovery it replaced.
  const verdictDecision = latestAttribution
    ? (decisions.find((d) => d.attribution_id === latestAttribution.id) ?? null)
    : null

  return (
    <main className="operator-shell">
      <TopBar title="Operator · Fusion console" current="operator" />
      <section className="operator-grid" aria-label="Operator fusion state">
        <div className="panel operator-panel--anomaly">
          <div className="panel__header">
            <h2>Anomaly Queue</h2>
            <span>{String(anomalies.length).padStart(2, '0')} open</span>
          </div>
          {anomalies.length === 0 ? (
            <p className="operator-shell__empty">No correlated patterns</p>
          ) : (
            <ul className="operator-list">
              {anomalies.map((a) => (
                <li key={a.id}>
                  <span className="operator-list__kind">{a.kind}</span>
                  <span className="operator-list__sev">
                    sev {a.severity.toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="panel operator-panel--decision">
          <div className="panel__header">
            <h2>Decision Rail</h2>
            <span>{String(decisions.length).padStart(2, '0')} pending</span>
          </div>
          {decisions.length === 0 ? (
            <p className="operator-shell__empty">No authority requests</p>
          ) : (
            <ul className="operator-list">
              {decisions.map((d) => {
                const gate = parseGateRationale(d.rationale)
                const verdict = attributionsById[d.attribution_id]?.verdict
                return (
                  <li key={d.id}>
                    <span className="operator-list__kind">
                      {d.action}
                      {gate.reasonCode ? (
                        <span className="operator-list__chip operator-list__chip--blocked">
                          blocked · {gate.reasonCode}
                        </span>
                      ) : null}
                      {d.withheld_recovery ? (
                        <WithheldRecoveryChip
                          withheld={d.withheld_recovery}
                          variant="operator-list"
                        />
                      ) : null}
                      {d.recovery ? (
                        <span className="operator-list__chip operator-list__chip--recovery">
                          {d.recovery.action_id} →{' '}
                          {subsystemLabel(d.recovery.target_subsystem)}
                          {d.recovery.requires_approval ? ' · approval' : ''}
                        </span>
                      ) : null}
                      {verdict ? (
                        <span
                          className={`operator-list__chip operator-list__chip--verdict operator-list__chip--${verdict}`}
                        >
                          {verdictLabel(verdict).toLowerCase()}
                        </span>
                      ) : null}
                    </span>
                    <span className="operator-list__sev">
                      {d.authority} · {d.target}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
          <div className="operator-shell__footer" aria-live="polite">
            {signals.length} signals streamed
          </div>
        </div>
        <VerdictPanel attribution={latestAttribution} decision={verdictDecision} />
        <ActionLog limit={20} />
        <EmbeddingViz />
        <ReasoningPanel />
      </section>
    </main>
  )
}
