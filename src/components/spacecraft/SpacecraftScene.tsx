// The Spacecraft page's stage: the 3D body with an explode control, the
// verdict at top-left, one chip per subsystem pinned on the right, and leader
// lines that follow the parts as the model moves. Leaders are updated
// imperatively every frame; React state per frame would re-render the HUD
// sixty times a second for nothing.
import { Suspense, lazy, useCallback, useRef, useState } from 'react'
import { subsystemLabel, verdictLabel } from '../../lib/commanderLanguage'
import type { AnchorScreen } from '../../lib/spacecraft3d/model'
import { ASSEMBLY } from '../../lib/spacecraft3d/parts'
import {
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

export function SpacecraftScene({ name, states, recovery, verdict, confidence, provisional, actor }: SpacecraftSceneProps) {
  const [explode, setExplode] = useState(DEFAULT_EXPLODE)
  const [selected, setSelected] = useState<Subsystem | null>(
    () => states.find((state) => state.health !== 'nominal')?.subsystem ?? null,
  )
  const [autoRotate, setAutoRotate] = useState(false)
  const [resetToken, setResetToken] = useState(0)
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

  const verdictState = verdict ?? 'absent'

  return (
    <div className="spacecraft-scene" ref={stageRef} aria-label={`${name} model`}>
      <Suspense fallback={<div className="viewport3d__status">Loading model…</div>}>
        <SpacecraftViewport
          className="spacecraft-scene__viewport"
          states={states}
          selected={selected}
          onSelect={setSelected}
          explode={explode}
          autoRotate={autoRotate}
          resetToken={resetToken}
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

      <div className="spacecraft-scene__hud">
        <span className={`verdict-badge verdict-badge--${verdictState}`}>
          {verdictLabel(verdict)}
          {confidence !== null ? ` · ${Math.round(confidence * 100)}%` : ''}
          {provisional ? ' · provisional' : ''}
        </span>
        {actor && actor !== 'Unknown' && actor !== 'None' ? (
          <span className="spacecraft-scene__actor" data-testid="spacecraft-actor">
            {actor}
          </span>
        ) : null}
        <label className="spacecraft-scene__explode">
          Explode
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
        <button type="button" className="scene-btn" onClick={() => setResetToken((value) => value + 1)}>
          Reset view
        </button>
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
              onClick={() => setSelected(isSelected ? null : subsystem)}
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
