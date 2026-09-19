import { lazy, Suspense } from 'react'
import { signalEffectState } from '../lib/signalEffects'
import type { Signal } from '../types/canopy'

const CesiumGlobe = lazy(() =>
  import('./CesiumGlobe').then((module) => ({ default: module.CesiumGlobe })),
)

type MapStageProps = {
  correlatedSignalIds: string[]
  focusSignalId: string | null
  signals: Signal[]
  /** The newest substantive report; drives the stage's effect state. */
  report: Signal | null
}

/** The orbital view (demo plan F1): the globe over Site A with the synthetic
 *  spacecraft, the station and any RF marker. The status line above the
 *  globe carries the latest report; nothing is drawn over the map. */
export function MapStage({ correlatedSignalIds, focusSignalId, signals, report }: MapStageProps) {
  const latestSignal = report
  const effectState = signalEffectState(latestSignal)

  return (
    <section
      className={`map-stage map-stage--globe map-stage--${effectState}`}
      aria-label="Operational map"
    >
      <Suspense
        fallback={
          <div
            aria-label="Loading globe"
            className="cesium-globe cesium-globe--loading"
            role="status"
          />
        }
      >
        <CesiumGlobe
          correlatedSignalIds={correlatedSignalIds}
          displayMode="globe"
          focusSignalId={focusSignalId}
          signals={signals}
        />
      </Suspense>
    </section>
  )
}
