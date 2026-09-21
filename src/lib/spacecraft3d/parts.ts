// The fallback body: a procedural reference spacecraft built from this part
// table when the archive geometry (archive.ts) cannot be loaded. Synthetic
// reference geometry for a ~1 m class bus; not a flight article. Units are
// metres. Axes: X along the solar-array axis, +Y zenith (nadir is -Y), +Z
// forward. Subsystem ids are MEGALITH's seven (docs/INTERFACE-SPEC.md §3).
import type { Subsystem } from '../spacecraftHealth'

export type Axis = 'x' | 'y' | 'z'
export type Vec3 = readonly [number, number, number]
export type Tone = 'structure' | 'foil' | 'solar' | 'white' | 'dark' | 'gold' | 'copper' | 'optic'

type PartBase = {
  id: string
  label: string
  /** `null` is primary structure: drawn, never tinted by health. */
  subsystem: Subsystem | null
  tone: Tone
  at: Vec3
}

export type Part =
  | (PartBase & { kind: 'box'; size: Vec3 })
  | (PartBase & { kind: 'cyl'; axis: Axis; radius: number; length: number })
  | (PartBase & { kind: 'sphere'; radius: number })
  | (PartBase & { kind: 'dish'; axis: Axis; radius: number; depth: number })

export const TONE_HEX: Record<Tone, number> = {
  structure: 0x8b959d,
  foil: 0xb9924a,
  solar: 0x1e3f73,
  white: 0xd9dfe1,
  dark: 0x2b333a,
  gold: 0xc4a25c,
  copper: 0x9c6b3d,
  optic: 0x13171c,
}


const box = (id: string, label: string, subsystem: Subsystem | null, tone: Tone, at: Vec3, size: Vec3): Part =>
  ({ kind: 'box', id, label, subsystem, tone, at, size })
const cyl = (
  id: string, label: string, subsystem: Subsystem | null, tone: Tone, at: Vec3,
  axis: Axis, radius: number, length: number,
): Part => ({ kind: 'cyl', id, label, subsystem, tone, at, axis, radius, length })
const sphere = (id: string, label: string, subsystem: Subsystem | null, tone: Tone, at: Vec3, radius: number): Part =>
  ({ kind: 'sphere', id, label, subsystem, tone, at, radius })
const dish = (
  id: string, label: string, subsystem: Subsystem | null, tone: Tone, at: Vec3,
  axis: Axis, radius: number, depth: number,
): Part => ({ kind: 'dish', id, label, subsystem, tone, at, axis, radius, depth })

export const SIM01_PARTS: readonly Part[] = [
  // primary structure
  box('bus_body', 'Bus structure', null, 'structure', [0, 0, 0], [1.0, 1.3, 1.0]),
  // power
  cyl('yoke_px', 'Array yoke +X', 'power', 'dark', [0.7, 0.1, 0], 'x', 0.05, 0.4),
  cyl('yoke_nx', 'Array yoke -X', 'power', 'dark', [-0.7, 0.1, 0], 'x', 0.05, 0.4),
  box('wing_px', 'Solar wing +X', 'power', 'solar', [1.8, 0.1, 0], [1.8, 0.9, 0.04]),
  box('wing_nx', 'Solar wing -X', 'power', 'solar', [-1.8, 0.1, 0], [1.8, 0.9, 0.04]),
  box('battery', 'Battery', 'power', 'gold', [0.62, -0.42, 0], [0.24, 0.32, 0.5]),
  // thermal
  box('radiator_nx', 'Radiator -X', 'thermal', 'white', [-0.53, -0.35, 0], [0.04, 0.55, 0.8]),
  box('radiator_aft', 'Radiator aft', 'thermal', 'white', [0, 0.4, -0.53], [0.6, 0.4, 0.04]),
  // comms
  cyl('dish_boom', 'Dish boom', 'comms', 'dark', [0, 0.15, 0.7], 'z', 0.04, 0.4),
  dish('dish', 'High-gain dish', 'comms', 'white', [0, 0.15, 0.95], 'z', 0.45, 0.14),
  sphere('dish_feed', 'Dish feed', 'comms', 'gold', [0, 0.15, 1.22], 0.05),
  box('transponder', 'Transponder chain · transmit amplifier', 'comms', 'gold', [0.28, -0.4, 0.57], [0.36, 0.22, 0.14]),
  cyl('omni_a', 'TT&C omni A', 'comms', 'dark', [-0.35, 0.875, 0.35], 'y', 0.012, 0.45),
  cyl('omni_b', 'TT&C omni B', 'comms', 'dark', [0.35, 0.875, 0.35], 'y', 0.012, 0.45),
  // adcs
  cyl('star_tracker_a', 'Star tracker A', 'adcs', 'dark', [-0.3, 0.8, -0.25], 'y', 0.07, 0.3),
  cyl('star_tracker_b', 'Star tracker B', 'adcs', 'dark', [0.3, 0.8, -0.25], 'y', 0.07, 0.3),
  cyl('rw_1', 'Reaction wheel 1', 'adcs', 'copper', [-0.55, 0.35, -0.18], 'x', 0.09, 0.06),
  cyl('rw_2', 'Reaction wheel 2', 'adcs', 'copper', [-0.55, 0.35, 0.18], 'x', 0.09, 0.06),
  cyl('rw_3', 'Reaction wheel 3', 'adcs', 'copper', [-0.55, 0.55, 0], 'x', 0.09, 0.06),
  // propulsion
  sphere('tank', 'Propellant tank', 'propulsion', 'gold', [0, -0.15, -0.55], 0.26),
  cyl('thr_1', 'Thruster 1', 'propulsion', 'dark', [-0.38, -0.52, -0.6], 'z', 0.06, 0.2),
  cyl('thr_2', 'Thruster 2', 'propulsion', 'dark', [0.38, -0.52, -0.6], 'z', 0.06, 0.2),
  cyl('thr_3', 'Thruster 3', 'propulsion', 'dark', [-0.38, 0.52, -0.6], 'z', 0.06, 0.2),
  cyl('thr_4', 'Thruster 4', 'propulsion', 'dark', [0.38, 0.52, -0.6], 'z', 0.06, 0.2),
  // payload
  cyl('telescope', 'Nadir telescope', 'payload', 'dark', [0.1, -0.95, 0.15], 'y', 0.2, 0.6),
  cyl('baffle', 'Telescope baffle', 'payload', 'optic', [0.1, -1.3, 0.15], 'y', 0.24, 0.1),
  box('payload_elec', 'Payload electronics', 'payload', 'dark', [-0.28, -0.74, 0.2], [0.3, 0.18, 0.3]),
  // cdh
  box('avionics_1', 'Avionics board 1', 'cdh', 'copper', [0, 0.69, 0.15], [0.42, 0.07, 0.32]),
  box('avionics_2', 'Avionics board 2', 'cdh', 'copper', [0, 0.78, 0.15], [0.42, 0.07, 0.32]),
  box('avionics_3', 'Avionics board 3', 'cdh', 'copper', [0, 0.87, 0.15], [0.42, 0.07, 0.32]),
]

/** The part a HUD leader or a callout points at, one per subsystem. */
export const ANCHOR_PART: Record<Subsystem, string> = {
  power: 'wing_px',
  thermal: 'radiator_nx',
  comms: 'transponder',
  adcs: 'star_tracker_b',
  propulsion: 'tank',
  cdh: 'avionics_2',
  payload: 'telescope',
}

/** What each subsystem's parts are, one line. */
export const ASSEMBLY: Record<Subsystem, string> = {
  power: 'Solar wings, yokes, battery',
  thermal: 'Radiator panels',
  comms: 'High-gain dish, TT&C omnis, transponder chain with the transmit amplifier',
  adcs: 'Star trackers, reaction-wheel module',
  propulsion: 'Propellant tank, four thrusters',
  cdh: 'Avionics stack',
  payload: 'Nadir telescope and electronics',
}
