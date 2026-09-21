// The Three.js spacecraft model shared by the archive body (archive.ts) and
// the procedural fallback (parts.ts): subsystem-tagged meshes, health tinting
// in the skin's colours, an exploded-view offset, and screen-space anchors
// for the page's leader lines. Technique after the internal diagnosis
// module's dashboard twin: tag primitives, apply state by traversal.
import * as THREE from 'three'
import type { Subsystem, SubsystemHealth, SubsystemState } from '../spacecraftHealth'
import { ANCHOR_PART, SIM01_PARTS, TONE_HEX, type Part, type Tone } from './parts'

export type HealthPalette = Record<SubsystemHealth | 'selected', THREE.Color>
export type AnchorScreen = { x: number; y: number; visible: boolean }

export type TaggedMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>

export type Tag = {
  partId: string
  subsystem: Subsystem
  rest: THREE.Vector3
  dir: THREE.Vector3
  baseColor: number
  baseEmissive: number
  /** Local units per normalised unit, so archive bodies explode as far as the procedural one. */
  explodeScale?: number
}

/** Primary structure: drawn and dimmed behind a selection, never tinted. */
export type StructureMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> & {
  userData: { baseColor: number }
}

export type BuiltModel = {
  root: THREE.Group
  /** Subsystem-tagged meshes; primary structure is excluded. */
  meshes: TaggedMesh[]
  /** Untagged meshes, kept so a selection can dim the whole body around it. */
  structure: StructureMesh[]
  anchors: Partial<Record<Subsystem, THREE.Object3D>>
  cameraDistance: number
  /** Acknowledgement line for archive geometry. */
  credit?: string
  source: 'archive' | 'procedural'
}

const UP = new THREE.Vector3(0, 1, 0)
const AXIS = { x: new THREE.Vector3(1, 0, 0), y: UP, z: new THREE.Vector3(0, 0, 1) }

const TONE_MATERIAL: Record<Tone, Partial<THREE.MeshStandardMaterialParameters>> = {
  structure: { roughness: 0.55, metalness: 0.45 },
  foil: { roughness: 0.75, metalness: 0.2 },
  solar: { roughness: 0.3, metalness: 0.55 },
  white: { roughness: 0.5, metalness: 0.1 },
  dark: { roughness: 0.6, metalness: 0.35 },
  gold: { roughness: 0.45, metalness: 0.6 },
  copper: { roughness: 0.5, metalness: 0.5 },
  optic: { roughness: 0.3, metalness: 0.2 },
}

function geometryFor(part: Part): THREE.BufferGeometry {
  switch (part.kind) {
    case 'box':
      return new THREE.BoxGeometry(part.size[0], part.size[1], part.size[2])
    case 'sphere':
      return new THREE.SphereGeometry(part.radius, 28, 18)
    case 'cyl':
      return new THREE.CylinderGeometry(part.radius, part.radius, part.length, 32)
    case 'dish': {
      const points: THREE.Vector2[] = []
      for (let i = 0; i <= 16; i += 1) {
        const r = (i / 16) * part.radius
        points.push(new THREE.Vector2(r, part.depth * (r / part.radius) ** 2))
      }
      return new THREE.LatheGeometry(points, 48)
    }
  }
}

function meshFor(part: Part): TaggedMesh {
  const material = new THREE.MeshStandardMaterial({
    color: TONE_HEX[part.tone],
    ...TONE_MATERIAL[part.tone],
    side: part.kind === 'dish' ? THREE.DoubleSide : THREE.FrontSide,
  })
  const mesh = new THREE.Mesh(geometryFor(part), material)
  mesh.position.set(part.at[0], part.at[1], part.at[2])
  if (part.kind === 'cyl' || part.kind === 'dish') {
    mesh.quaternion.setFromUnitVectors(UP, AXIS[part.axis])
  }
  return mesh
}

export function buildProceduralModel(): BuiltModel {
  const root = new THREE.Group()
  const meshes: TaggedMesh[] = []
  const structure: StructureMesh[] = []
  const anchors: Partial<Record<Subsystem, THREE.Object3D>> = {}
  for (const part of SIM01_PARTS) {
    const mesh = meshFor(part)
    if (part.subsystem === null) {
      mesh.userData = { baseColor: mesh.material.color.getHex() }
      structure.push(mesh as StructureMesh)
      if (part.kind === 'box') {
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(mesh.geometry),
          new THREE.LineBasicMaterial({ color: 0xdce3d5, transparent: true, opacity: 0.35 }),
        )
        mesh.add(edges)
      }
      root.add(mesh)
      continue
    }
    const rest = new THREE.Vector3(part.at[0], part.at[1], part.at[2])
    const tag: Tag = {
      partId: part.id,
      subsystem: part.subsystem,
      rest,
      dir: rest.clone().normalize(),
      baseColor: mesh.material.color.getHex(),
      baseEmissive: mesh.material.emissive.getHex(),
    }
    mesh.userData = tag
    root.add(mesh)
    meshes.push(mesh)
    if (ANCHOR_PART[part.subsystem] === part.id) anchors[part.subsystem] = mesh
  }
  return { root, meshes, structure, anchors, cameraDistance: 8.2, source: 'procedural' }
}

/** 0 = assembled, 1 = every subsystem part pushed out along its own radial. */
export function setExplode(built: BuiltModel, factor: number): void {
  for (const mesh of built.meshes) {
    const tag = mesh.userData as Tag
    mesh.position.copy(tag.rest).addScaledVector(tag.dir, factor * 0.9 * (tag.explodeScale ?? 1))
  }
}

/** Linear-light factor applied to everything outside a selection. Colours
 *  are linear in three.js, so 0.1 reads as roughly a third of the brightness
 *  on screen. The environment reflection is cut with it, or white dielectric
 *  panels would stay bright regardless of their colour. */
const DIMMED = 0.1
const DIMMED_ENV = 0.2

/** Apply health tints, then the selection: the chosen assembly glows in its
 *  health colour (the neutral selection colour when nominal) and pulses,
 *  while every other mesh, structure included, is dimmed so the highlight
 *  reads on white and grey materials as well as dark ones. */
export function applyHealth(
  built: BuiltModel,
  states: SubsystemState[],
  selected: Subsystem | null,
  palette: HealthPalette,
  /** 0..1, drives the withheld-recovery and selection pulses. */
  pulse: number,
): void {
  const byId = new Map(states.map((state) => [state.subsystem, state.health]))
  for (const mesh of built.meshes) {
    const tag = mesh.userData as Tag
    const material = mesh.material
    const health = byId.get(tag.subsystem) ?? 'nominal'
    material.color.setHex(tag.baseColor)
    material.emissive.setHex(tag.baseEmissive)
    material.emissiveIntensity = 0
    if (health !== 'nominal') {
      const tint = palette[health]
      const mix = health === 'degraded' ? 0.3 : health === 'faulted' ? 0.42 : 0.5
      material.color.lerp(tint, mix)
      material.emissive.copy(tint)
      material.emissiveIntensity =
        health === 'withheld-recovery' ? 0.18 + 0.3 * pulse : health === 'faulted' ? 0.32 : 0.22
    }
    material.envMapIntensity = 1
    if (!selected) continue
    if (tag.subsystem === selected) {
      const glow = health === 'nominal' ? palette.selected : palette[health]
      material.color.lerp(glow, 0.3)
      material.emissive.copy(glow)
      material.emissiveIntensity = 0.5 + 0.35 * pulse
    } else {
      material.color.multiplyScalar(DIMMED)
      material.emissiveIntensity = 0
      material.envMapIntensity = DIMMED_ENV
    }
  }
  for (const mesh of built.structure) {
    mesh.material.color.setHex(mesh.userData.baseColor)
    mesh.material.envMapIntensity = selected ? DIMMED_ENV : 1
    if (selected) mesh.material.color.multiplyScalar(DIMMED)
  }
}

/** Anchor positions in viewport pixels, for leaders drawn over the canvas. */
export function anchorScreenPositions(
  built: BuiltModel,
  camera: THREE.Camera,
  width: number,
  height: number,
): Partial<Record<Subsystem, AnchorScreen>> {
  const out: Partial<Record<Subsystem, AnchorScreen>> = {}
  const world = new THREE.Vector3()
  for (const [subsystem, object] of Object.entries(built.anchors) as Array<[Subsystem, THREE.Object3D]>) {
    object.getWorldPosition(world)
    world.project(camera)
    out[subsystem] = {
      x: ((world.x + 1) / 2) * width,
      y: ((1 - world.y) / 2) * height,
      visible: world.z < 1,
    }
  }
  return out
}

const FALLBACK: Record<SubsystemHealth | 'selected', string> = {
  nominal: '#77b884',
  degraded: '#c9a457',
  faulted: '#7b96ff',
  'withheld-recovery': '#ff7b6d',
  selected: '#f5f7f0',
}
const CSS_VAR: Record<SubsystemHealth | 'selected', string> = {
  nominal: '--green',
  degraded: '--amber',
  faulted: '--verdict-internal',
  'withheld-recovery': '--verdict-hostile',
  selected: '--text-primary',
}

/** The skin's health colours, read from the CSS variables the topology uses. */
export function readHealthPalette(): HealthPalette {
  const style = typeof window !== 'undefined' ? getComputedStyle(document.documentElement) : null
  const palette = {} as HealthPalette
  for (const key of Object.keys(FALLBACK) as Array<keyof typeof FALLBACK>) {
    const raw = style?.getPropertyValue(CSS_VAR[key]).trim() ?? ''
    const value = raw && !raw.startsWith('var(') ? raw : FALLBACK[key]
    const color = new THREE.Color()
    color.setStyle(value)
    if (color.getHex() === 0 && value !== FALLBACK[key]) color.setStyle(FALLBACK[key])
    palette[key] = color
  }
  return palette
}

export function disposeModel(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
      object.geometry.dispose()
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      for (const material of materials) (material as THREE.Material).dispose()
    }
  })
}
