import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { SUBSYSTEMS, type Subsystem, type SubsystemState } from '../spacecraftHealth'
import {
  EDGE_OPACITY,
  EDGE_OPACITY_DIMMED,
  addEdges,
  applyHealth,
  buildProceduralModel,
  disposeModel,
  edgesOf,
  readHealthPalette,
  setEdgesDimmed,
  setExplode,
  setIsolation,
  subsystemBounds,
  type Tag,
} from './model'
import { ANCHOR_PART, SIM01_PARTS } from './parts'

const state = (subsystem: Subsystem, health: SubsystemState['health']): SubsystemState => ({
  subsystem,
  health,
  latest: null,
  reason: 'test',
})

const nominal = SUBSYSTEMS.map((subsystem) => state(subsystem, 'nominal'))

describe('procedural spacecraft model', () => {
  it('every subsystem has at least one tagged part and an anchor', () => {
    const built = buildProceduralModel()
    for (const subsystem of SUBSYSTEMS) {
      expect(built.meshes.some((mesh) => (mesh.userData as Tag).subsystem === subsystem), subsystem).toBe(true)
      expect(built.anchors[subsystem], `${subsystem} anchor`).toBeDefined()
    }
    disposeModel(built.root)
  })

  it('anchor parts name real parts of the right subsystem', () => {
    for (const subsystem of SUBSYSTEMS) {
      const part = SIM01_PARTS.find((item) => item.id === ANCHOR_PART[subsystem])
      expect(part, subsystem).toBeDefined()
      expect(part?.subsystem).toBe(subsystem)
    }
  })

  it('primary structure is never tagged', () => {
    const built = buildProceduralModel()
    expect(built.meshes.some((mesh) => (mesh.userData as Tag).partId === 'bus_body')).toBe(false)
    disposeModel(built.root)
  })

  it('explode pushes a wing outward along its own radial and back', () => {
    const built = buildProceduralModel()
    const wing = built.meshes.find((mesh) => (mesh.userData as Tag).partId === 'wing_px')!
    const rest = wing.position.x
    setExplode(built, 1)
    expect(wing.position.x).toBeGreaterThan(rest)
    setExplode(built, 0)
    expect(wing.position.x).toBeCloseTo(rest, 6)
    disposeModel(built.root)
  })

  it('tints only the unhealthy subsystem and pulses a withheld recovery', () => {
    const built = buildProceduralModel()
    const palette = readHealthPalette()
    const comms = built.meshes.find((mesh) => (mesh.userData as Tag).partId === 'transponder')!
    const wing = built.meshes.find((mesh) => (mesh.userData as Tag).partId === 'wing_px')!
    const states = nominal.map((item) => (item.subsystem === 'comms' ? state('comms', 'withheld-recovery') : item))

    applyHealth(built, states, null, palette, 0)
    const dim = comms.material.emissiveIntensity
    expect(dim).toBeGreaterThan(0)
    applyHealth(built, states, null, palette, 1)
    expect(comms.material.emissiveIntensity).toBeGreaterThan(dim)
    expect(wing.material.emissiveIntensity).toBe(0)
    expect(wing.material.color.getHex()).toBe((wing.userData as Tag).baseColor)
    disposeModel(built.root)
  })

  it('selection spotlights the chosen subsystem and dims everything else, structure included', () => {
    const built = buildProceduralModel()
    const palette = readHealthPalette()
    const comms = built.meshes.find((mesh) => (mesh.userData as Tag).partId === 'transponder')!
    const wing = built.meshes.find((mesh) => (mesh.userData as Tag).partId === 'wing_px')!
    const bus = built.structure[0]!
    const brightness = (hex: number) => ((hex >> 16) & 255) + ((hex >> 8) & 255) + (hex & 255)

    applyHealth(built, nominal, 'comms', palette, 0.5)
    expect(comms.material.emissiveIntensity).toBeGreaterThan(0.5)
    expect(brightness(wing.material.color.getHex())).toBeLessThan(brightness((wing.userData as Tag).baseColor) * 0.5)
    expect(brightness(bus.material.color.getHex())).toBeLessThan(brightness(bus.userData.baseColor) * 0.5)

    // Clearing the selection restores every colour.
    applyHealth(built, nominal, null, palette, 0.5)
    expect(comms.material.emissiveIntensity).toBe(0)
    expect(wing.material.color.getHex()).toBe((wing.userData as Tag).baseColor)
    expect(bus.material.color.getHex()).toBe(bus.userData.baseColor)
    disposeModel(built.root)
  })

  it('a selected faulted subsystem glows in the fault colour, not the neutral one', () => {
    const built = buildProceduralModel()
    const palette = readHealthPalette()
    const comms = built.meshes.find((mesh) => (mesh.userData as Tag).partId === 'transponder')!
    const states = nominal.map((item) => (item.subsystem === 'comms' ? state('comms', 'faulted') : item))
    applyHealth(built, states, 'comms', palette, 0)
    expect(comms.material.emissive.getHex()).toBe(palette.faulted.getHex())
    disposeModel(built.root)
  })

  it('falls back to the skin colours when the CSS variables are absent', () => {
    const palette = readHealthPalette()
    expect(palette.faulted.getHex()).toBe(0x7b96ff)
    expect(palette['withheld-recovery'].getHex()).toBe(0xff7b6d)
    expect(palette.degraded.getHex()).toBe(0xc9a457)
  })
})

describe('drawn edges', () => {
  it('outlines a box with its twelve creases as a child that follows the part, and dims with it', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial())
    const lines = addEdges(mesh)
    expect(edgesOf(mesh)).toBe(lines)
    expect(lines.parent).toBe(mesh)
    expect(lines.geometry.getAttribute('position').count).toBe(24)
    expect(mesh.material.polygonOffset).toBe(true)
    const material = lines.material as THREE.LineBasicMaterial
    expect(material.opacity).toBe(EDGE_OPACITY)
    setEdgesDimmed(mesh, true)
    expect(material.opacity).toBe(EDGE_OPACITY_DIMMED)
    setEdgesDimmed(mesh, false)
    expect(material.opacity).toBe(EDGE_OPACITY)
    expect(edgesOf(new THREE.Mesh())).toBeNull()
    disposeModel(mesh)
  })
})

describe('focus on one subsystem', () => {
  it('shows the chosen subsystem alone and back, and bounds it for the orbit centre', () => {
    const built = buildProceduralModel()
    setIsolation(built, 'comms')
    for (const mesh of built.meshes) expect(mesh.visible).toBe((mesh.userData as Tag).subsystem === 'comms')
    for (const mesh of built.structure) expect(mesh.visible).toBe(false)
    setIsolation(built, null)
    expect(built.meshes.every((mesh) => mesh.visible) && built.structure.every((mesh) => mesh.visible)).toBe(true)
    const bounds = subsystemBounds(built, 'comms')
    expect(bounds).not.toBeNull()
    expect(bounds!.isEmpty()).toBe(false)
    disposeModel(built.root)
  })
})
