import { commanderSignalSummary, plainEventName, signalKindLabel, spacecraftEnvironmentFacts } from '../lib/commanderLanguage'
import { withCapture } from '../store/captureStore'
import type { Signal } from '../types/canopy'

const formatTime = (ts: string) => {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  return `${d.toISOString().slice(11, 19)}Z`
}

/** Every signal the engine received, newest first, one row each: when, what
 *  kind, from whom, what it says, and the spacecraft or environment facts
 *  (subsystem, symptom, physics consistency; event type, Kp). A row opens the
 *  signal's card. */
export function SignalTable({ signals }: { signals: Signal[] }) {
  if (!signals.length) {
    return <p className="signals-empty">No signals received yet. Start a run from the launcher.</p>
  }
  return (
    <table className="signals-table" data-testid="signals-table">
      <thead>
        <tr>
          <th scope="col">Time</th>
          <th scope="col">Report</th>
          <th scope="col">Source</th>
          <th scope="col">What it says</th>
          <th scope="col" className="num">Confidence</th>
        </tr>
      </thead>
      <tbody>
        {signals.map((signal, index) => {
          const summary = commanderSignalSummary(signal)
          const facts = spacecraftEnvironmentFacts(signal)
          return (
            <tr key={signal.id} data-domain={signal.domain} data-newest={index === 0 ? 'true' : undefined} className="signals-table__row">
              <td className="signals-table__time">{formatTime(signal.ts)}</td>
              <td className="signals-table__kind">
                <a href={withCapture(`/signal?id=${encodeURIComponent(signal.id)}`)} title={plainEventName(signal)}>{signalKindLabel(signal)}</a>
              </td>
              <td className="signals-table__source">{summary.sourceLabel}</td>
              <td className="signals-table__summary">
                {summary.oneLine}
                {facts.length ? (
                  <span className="signals-table__facts" data-testid="raw-facts">
                    {facts.map((fact) => (
                      <span className={`signals-table__fact signals-table__fact--${fact.key}`} key={fact.key}>
                        <em>{fact.label}</em> {fact.value}
                      </span>
                    ))}
                  </span>
                ) : null}
              </td>
              <td className="num">{Math.round(signal.confidence * 100)}%</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
