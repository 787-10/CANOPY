import type { Attribution, Decision, UIEvent } from '../types/canopy'
import type { Signal } from '../types/canopy'
import type { ScenarioDefinition } from '../data/scenarioLibrary'
import {
  commanderEventSummary,
  commanderSignalSummary,
  verdictHeadline,
} from '../lib/commanderLanguage'

type MissionSummaryProps = {
  attribution: Attribution | null
  compact?: boolean
  decision: Decision | null
  scenario: ScenarioDefinition
  uiEvent?: UIEvent | null
  latestSignal?: Signal | null
  signalCount: number
}

export function MissionSummary({
  attribution,
  compact = false,
  decision,
  scenario,
  uiEvent = null,
  latestSignal = null,
  signalCount,
}: MissionSummaryProps) {
  const signalSummary = latestSignal ? commanderSignalSummary(latestSignal) : null
  const confidence = uiEvent
    ? `${Math.round(uiEvent.confidence * 100)}%`
    : attribution
      ? `${Math.round(attribution.confidence * 100)}%`
      : '--'
  const commanderBrief = commanderEventSummary(uiEvent)
  const state = uiEvent
    ? commanderBrief.state
    : attribution
      ? 'Amber'
      : commanderBrief.state
  const headline = uiEvent
    ? commanderBrief.headline
    : attribution
      ? verdictHeadline(attribution)
      : scenario.name
  const summary = uiEvent
    ? commanderBrief.body
    : signalSummary?.oneLine ?? attribution?.predicted_next ?? scenario.objective
  const action = uiEvent
    ? commanderBrief.action
    : signalSummary?.action ?? decision?.action ?? commanderBrief.action
  const stateClass = state.toLowerCase()
  const compactHeadline = signalSummary?.label ?? scenario.shortName
  const compactSummary =
    signalSummary?.oneLine ?? summary.replace(/^CANOPY\s+/i, '')
  const compactAction = signalSummary?.action ?? action
  const compactMeta = `${signalCount.toString().padStart(2, '0')} reports / ${confidence} conf / ${scenario.theater}`

  return (
    <section
      className={[
        'mission-summary',
        `mission-summary--${stateClass}`,
        compact ? 'mission-summary--compact' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label="Mission summary"
    >
      <div className="mission-summary__topline">
        <span>{compact ? 'Mission state' : 'Posture'}</span>
        {compact ? null : <strong>{state}</strong>}
      </div>
      <div className="mission-summary__main">
        <p className="mission-summary__kicker">
          {compact ? compactMeta : `${signalCount.toString().padStart(2, '0')} reports fused / ${confidence} confidence / ${scenario.theater}`}
        </p>
        <h2>{compact ? compactHeadline : headline}</h2>
        <p>{compact ? compactSummary : summary}</p>
      </div>
      <div className="mission-summary__action">
        <span>Commander action</span>
        <strong>{compact ? compactAction : action}</strong>
      </div>
    </section>
  )
}
