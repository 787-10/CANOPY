// Engine-owned ephemeris (spec §10, 1.4.4): the latest position sample the
// engine published for each synthetic spacecraft. The flight layer reads it
// to name its source ("engine" while samples are fresh, "console model"
// otherwise) and to check its own propagation against the engine's; the
// engine and the console run the same circular model from the same defining
// pass, so the two agree to metres, and a disagreement is a defect to show.
import { create } from 'zustand'
import type { Ephemeris } from '../types/canopy'

/** A sample older than this (wall ms) no longer counts as the engine speaking. */
export const EPHEMERIS_FRESH_MS = 5_000

type EphemerisState = {
  /** Latest sample per `satellite_id`, with the wall time it arrived. */
  latest: Record<string, { sample: Ephemeris; receivedAt: number }>
  ingest: (sample: Ephemeris, receivedAt?: number) => void
  reset: () => void
}

export const useEphemerisStore = create<EphemerisState>()((set) => ({
  latest: {},
  ingest: (sample, receivedAt = Date.now()) =>
    set((state) => ({ latest: { ...state.latest, [sample.satellite_id]: { sample, receivedAt } } })),
  reset: () => set({ latest: {} }),
}))

/** The engine's latest sample for a spacecraft when it is fresh, else null. */
export function freshEphemeris(
  latest: EphemerisState['latest'],
  satelliteId: string,
  now: number = Date.now(),
): Ephemeris | null {
  const entry = latest[satelliteId]
  if (!entry) return null
  return now - entry.receivedAt <= EPHEMERIS_FRESH_MS ? entry.sample : null
}

// Development aid, like the globe's `__megalithViewer`: a browser probe can read the engine's samples.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as { __megalithEphemeris?: typeof useEphemerisStore }).__megalithEphemeris = useEphemerisStore
}
