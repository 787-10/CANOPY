// The simulated demo spacecraft (MEGALITH demo plan §1) and their synthetic
// tracks. Cesium-free so pages and tests can resolve `SIM-01` without
// loading the globe; n2yoSatelliteLayer re-exports these for the layer.
export type SyntheticSatelliteFamily = 'SIM'

/** Which archive body draws the spacecraft (public/models/PROVENANCE.md):
 *  the fleet's bus for the SIM pair, a different spacecraft for the
 *  closely-spaced object so it reads as not one of ours (Jeewoo, 2026-09-22). */
export type SpacecraftBodyId = 'gpm' | 'trmm'

export type SyntheticSatelliteConfig = {
  family: SyntheticSatelliteFamily
  /** Synthetic globe-layer id (>= 900000), never a real NORAD id; matches
   *  `satellite.id` in the demo position files. */
  id: number
  label: string
  cacheUrl: string
  synthetic: true
  /** `ctb://` spacecraft id the track belongs to (docs/INTERFACE-SPEC.md §1). */
  satelliteId: string
  /** Drawn in flight (and in pass view only when the stream names it): the
   *  closely-spaced object must not appear pinned in the storyboard's frames. */
  flightOnly?: boolean
  /** The 3D body on the Spacecraft page and the focused flight mark; `gpm` when unset. */
  body?: SpacecraftBodyId
}

// Position files are produced by the demo-scenario lane in the exact shape
// of the N2YO caches; until a file exists the layer skips it.
export const SYNTHETIC_SATELLITES: SyntheticSatelliteConfig[] = [
  {
    family: 'SIM',
    id: 900001,
    label: 'SIM-01',
    cacheUrl: '/orbital/sim01_positions.json',
    synthetic: true,
    satelliteId: 'ctb://megalith.demo/sim-01',
  },
  {
    family: 'SIM',
    id: 900002,
    label: 'SIM-02',
    cacheUrl: '/orbital/sim02_positions.json',
    synthetic: true,
    satelliteId: 'ctb://megalith.demo/sim-02',
  },
  {
    // The closely-spaced object (docs/MEGALITH-Flight-Plan.md stage 5): a
    // second body in SIM-01's plane 3 s behind it, about 2.4° apart from
    // Site A at the pass.
    family: 'SIM',
    id: 900003,
    label: 'OBJ-1',
    cacheUrl: '/orbital/obj01_positions.json',
    synthetic: true,
    satelliteId: 'ctb://megalith.demo/obj-01',
    flightOnly: true,
    body: 'trmm',
  },
]

/** The synthetic entry for a `ctb://` spacecraft id, a display name
 *  (`SIM-01`) or the id's last path segment (`sim-01`), or null. */
export function syntheticSatelliteFor(
  idOrName: string | null | undefined,
): SyntheticSatelliteConfig | null {
  if (!idOrName) return null
  const needle = idOrName.trim().toLowerCase()
  return (
    SYNTHETIC_SATELLITES.find(
      (satellite) =>
        satellite.satelliteId.toLowerCase() === needle ||
        satellite.label.toLowerCase() === needle ||
        satellite.satelliteId.split('/').pop() === needle,
    ) ?? null
  )
}

/** Resolve `SIM-01` / `sim-01` to its `ctb://` id when it is a synthetic
 *  demo spacecraft; pass any full id through unchanged. */
export function resolveRequestedSatellite(requested: string | null | undefined): string | null {
  if (!requested) return null
  if (requested.startsWith('ctb://')) return requested
  return syntheticSatelliteFor(requested)?.satelliteId ?? requested
}
