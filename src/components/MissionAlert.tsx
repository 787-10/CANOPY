import { commanderSignalSummary, signalKindLabel } from '../lib/commanderLanguage'
import { signalEffectLabel, signalEffectState } from '../lib/signalEffects'
import type { Signal } from '../types/canopy'

type MissionAlertProps = {
  signal: Signal | null
}

/** The alert card over the globe: the latest report in one line, its
 *  location, kind and confidence. */
export function MissionAlert({ signal }: MissionAlertProps) {
  if (!signal) {
    return null
  }

  const summary = commanderSignalSummary(signal)
  const state = signalEffectState(signal)

  return (
    <aside className={`mission-alert mission-alert--${state}`} key={signal.id} aria-live="polite">
      <div>
        <span>{signalEffectLabel(signal)}</span>
        <strong>{summary.oneLine}</strong>
      </div>
      <p>{summary.location}</p>
      <footer className="mission-alert__telemetry">
        <i>{signalKindLabel(signal)}</i>
        <i>{Math.round(signal.confidence * 100)}% CONF</i>
      </footer>
    </aside>
  )
}
