import type { ScenarioDefinition } from '../data/scenarioLibrary'
import { MissionSummary } from './MissionSummary'
import { OperatorActionPanel } from './OperatorActionPanel'
import { commanderSignalSummary, domainLabel } from '../lib/commanderLanguage'
import type { PlaybackStatus } from '../types/playback'
import type { Attribution, Decision, Signal, UIEvent } from '../types/canopy'

type ScenarioRailProps = {
  activeScenarioId: string
  attribution: Attribution | null
  decision: Decision | null
  latestSignal: Signal | null
  onSelectScenario: (scenarioId: string) => void
  offsets: number[]
  playback: PlaybackStatus
  scenarios: ScenarioDefinition[]
  signalCount: number
  uiEvent?: UIEvent | null
  collapsed?: boolean
  /** Capture mode: hide the scenario library (dev replay buttons). */
  hideLibrary?: boolean
}

const familyLabel = (family: ScenarioDefinition['family']) => {
  if (family === 'iran') {
    return 'CENTCOM'
  }
  if (family === 'army') {
    return 'Army'
  }
  if (family.startsWith('demo')) {
    return 'MEGALITH demo'
  }
  return 'Regional'
}

export function ScenarioRail({
  activeScenarioId,
  attribution,
  decision,
  latestSignal,
  onSelectScenario,
  offsets,
  playback,
  scenarios,
  signalCount,
  uiEvent = null,
  collapsed = false,
  hideLibrary = false,
}: ScenarioRailProps) {
  const activeScenario =
    scenarios.find((scenario) => scenario.id === activeScenarioId) ??
    scenarios[0]
  const completedInjects = activeScenario
    ? Math.min(
        activeScenario.signals.length,
        Math.max(
          1,
          offsets.filter((offset) => offset <= playback.elapsedMs).length,
        ),
      )
    : 0
  const currentSignal =
    activeScenario?.signals[Math.max(0, completedInjects - 1)] ?? null
  const currentSummary = currentSignal
    ? commanderSignalSummary(currentSignal)
    : null
  const activeDomains =
    activeScenario?.domains.map(domainLabel).join(' / ') ?? 'No domains'

  return (
    <aside
      className={`scenario-rail${collapsed ? ' scenario-rail--collapsed' : ''}`}
      aria-label="Scenario library"
      aria-hidden={collapsed}
    >
      {activeScenario ? (
        <div className={`scenario-rail__current scenario-rail__current--${activeScenario.family}`}>
          <span>{familyLabel(activeScenario.family)} scenario</span>
          <strong>{activeScenario.shortName}</strong>
          <p>{currentSummary?.oneLine ?? activeScenario.objective}</p>
          <em>
            {completedInjects.toString().padStart(2, '0')} /{' '}
            {activeScenario.signals.length.toString().padStart(2, '0')} reports
            · {activeScenario.theater}
          </em>
          <small>{activeDomains}</small>
        </div>
      ) : null}

      {hideLibrary ? (
        <div className="scenario-list scenario-list--hidden" aria-hidden="true" />
      ) : (
      <nav className="scenario-list" aria-label="Available scenarios" data-capture-hide>
        {scenarios.map((scenario) => {
          const isActive = scenario.id === activeScenarioId

          return (
            <button
              aria-current={isActive ? 'true' : undefined}
              className={
                isActive
                  ? `scenario-list__item scenario-list__item--${scenario.family} scenario-list__item--active`
                  : `scenario-list__item scenario-list__item--${scenario.family}`
              }
              key={scenario.id}
              onClick={() => onSelectScenario(scenario.id)}
              type="button"
            >
              <span>{scenario.id}</span>
              <strong>{scenario.shortName}</strong>
              <em>{familyLabel(scenario.family)}</em>
            </button>
          )
        })}
      </nav>
      )}

      <OperatorActionPanel />

      {activeScenario ? (
        <MissionSummary
          attribution={attribution}
          compact
          decision={decision}
          latestSignal={latestSignal}
          scenario={activeScenario}
          signalCount={signalCount}
          uiEvent={uiEvent}
        />
      ) : null}
    </aside>
  )
}
