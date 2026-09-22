// The Spacecraft page's stage: the 3D body in the middle, the view controls
// in a left column (explode, rotate, reset, focus on subsystem), one chip
// per subsystem pinned on the right, and leader lines that follow the parts
// as the model moves. The verdict is the top bar's; it is not repeated here. Leaders are updated
// imperatively every frame; React state per frame would re-render the HUD
// sixty times a second for nothing.
import { Suspense, lazy, useCallback, useRef, useState } from 'react'
import { subsystemLabel } from '../../lib/commanderLanguage'
import type { AnchorScreen } from '../../lib/spacecraft3d/model'
import { ASSEMBLY } from '../../lib/spacecraft3d/parts'
import { isQuietHealth,
  HEALTH_LABEL,
  SUBSYSTEMS,
  type RecoveryState,
  type Subsystem,
  type SubsystemState,
} from '../../lib/spacecraftHealth'
import type { Verdict } from '../../types/canopy'

const SpacecraftViewport = lazy(() => import('./SpacecraftViewport'))

export type SpacecraftSceneProps = {
  name: string
  states: SubsystemState[]
  recovery: RecoveryState
  verdict: Verdict | null
  confidence: number | null
  provisional: boolean
  actor: string | null
}

const DEFAULT_EXPLODE = 0.55

export function SpacecraftScene({ name, states, recovery, actor }: SpacecraftSceneProps) {
  const [explode, setExplode] = useState(DEFAULT_EXPLODE)
  const [selected, setSelected] = useState<Subsystem | null>(
    () => states.find((state) => !isQuietHealth(state.health))?.subsystem ?? null,
  )
  const [autoRotate, setAutoRotate] = useState(false)
  const [resetToken, setResetToken] = useState(0)
  // "Focus on subsystem": the chosen subsystem alone on the stage.
  const [isolate, setIsolate] = useState(false)
  // The orbit centre: a subsystem the operator chose by clicking (a chip or
  // the part), never the page's default selection, so the page opens on the
  // whole body and closes in only when asked.
  const [focused, setFocused] = useState<Subsystem | null>(null)
  const choose = (subsystem: Subsystem | null) => {
    setSelected(subsystem)
    setFocused(subsystem)
    if (subsystem === null) setIsolate(false)
  }
  const stageRef = useRef<HTMLDivElement>(null)
  const chipRefs = useRef<Partial<Record<Subsystem, HTMLButtonElement | null>>>({})
  const lineRefs = useRef<Partial<Record<Subsystem, SVGLineElement | null>>>({})
  const byId = new Map(states.map((state) => [state.subsystem, state]))

  const onAnchors = useCallback((anchors: Partial<Record<Subsystem, AnchorScreen>>) => {
    const stage = stageRef.current
    if (!stage) return
    const stageRect = stage.getBoundingClientRect()
    for (const subsystem of SUBSYSTEMS) {
      const line = lineRefs.current[subsystem]
      const chip = chipRefs.current[subsystem]
      const anchor = anchors[subsystem]
      if (!line || !chip || !anchor) continue
      const rect = chip.getBoundingClientRect()
      line.setAttribute('x1', anchor.x.toFixed(1))
      line.setAttribute('y1', anchor.y.toFixed(1))
      line.setAttribute('x2', (rect.left - stageRect.left).toFixed(1))
      line.setAttribute('y2', (rect.top + rect.height / 2 - stageRect.top).toFixed(1))
      line.style.opacity = anchor.visible ? '' : '0'
    }
  }, [])

  return (
    <div className="spacecraft-scene" ref={stageRef} aria-label={`${name} model`}>
      <Suspense fallback={<div className="viewport3d__status">Loading model…</div>}>
        <SpacecraftViewport
          className="spacecraft-scene__viewport"
          states={states}
          selected={selected}
          onSelect={choose}
          explode={explode}
          autoRotate={autoRotate}
          resetToken={resetToken}
          focus={focused}
          isolate={isolate}
          onAnchors={onAnchors}
        />
      </Suspense>
      <svg className="spacecraft-scene__leaders" aria-hidden="true">
        {SUBSYSTEMS.map((subsystem) => {
          const health = byId.get(subsystem)?.health ?? 'nominal'
          return (
            <line
              key={subsystem}
              ref={(element) => {
                lineRefs.current[subsystem] = element
              }}
              className={`leader leader--${health}${selected === subsystem ? ' is-selected' : ''}`}
            />
          )
        })}
      </svg>

      <div className="spacecraft-scene__controls" role="group" aria-label="View controls">
        <label className="spacecraft-scene__explode">
          <span>Explode</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={explode}
            onChange={(event) => setExplode(Number(event.target.value))}
            aria-label="Explode factor"
            data-testid="spacecraft-explode"
          />
        </label>
        <button type="button" className="scene-btn" aria-pressed={autoRotate} onClick={() => setAutoRotate((value) => !value)}>
          {autoRotate ? 'Pause' : 'Rotate'}
        </button>
        <button
          type="button"
          className="scene-btn"
          onClick={() => {
            choose(null)
            setResetToken((value) => value + 1)
          }}
        >
          Reset view
        </button>
        <button
          type="button"
          className="scene-btn scene-btn--focus"
          aria-pressed={isolate && selected !== null}
          disabled={selected === null}
          onClick={() => {
            // Isolating a subsystem also makes it the orbit centre.
            if (!isolate && selected) setFocused(selected)
            setIsolate((value) => !value)
          }}
          title={selected ? 'Show the selected subsystem alone' : 'Select a subsystem to focus on it'}
          data-testid="spacecraft-isolate"
        >
          Focus on subsystem
        </button>
        {actor && actor !== 'Unknown' && actor !== 'None' ? (
          <span className="spacecraft-scene__actor" data-testid="spacecraft-actor">
            {actor}
          </span>
        ) : null}
      </div>

      <div className="spacecraft-scene__chips" role="list" aria-label="Subsystems">
        {SUBSYSTEMS.map((subsystem) => {
          const state = byId.get(subsystem)
          const health = state?.health ?? 'nominal'
          const isTarget = recovery.targetSubsystem === subsystem && recovery.phase !== 'none'
          const isSelected = selected === subsystem
          return (
            <button
              key={subsystem}
              type="button"
              role="listitem"
              ref={(element) => {
                chipRefs.current[subsystem] = element
              }}
              className={`subsystem-chip subsystem-chip--${health}${isSelected ? ' is-selected' : ''}`}
              aria-pressed={isSelected}
              data-testid={`subsystem-${subsystem}`}
              data-subsystem={subsystem}
              data-health={health}
              onClick={() => choose(isSelected ? null : subsystem)}
            >
              <span className="subsystem-chip__head">
                <i className={`health-dot health-dot--${health}`} aria-hidden="true" />
                {subsystemLabel(subsystem)}
                <em className={`health--${health}`}>{HEALTH_LABEL[health]}</em>
              </span>
              <span className="subsystem-chip__note">{health === 'nominal' ? ASSEMBLY[subsystem] : state?.reason}</span>
              {isTarget ? (
                <span className={`subsystem-chip__recovery subsystem-chip__recovery--${recovery.phase}`}>{recovery.headline}</span>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}
