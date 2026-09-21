import { describe, expect, it } from 'vitest'
import { SUBSYSTEMS, type Subsystem, type SubsystemState } from '../spacecraftHealth'
import { applyHealth, buildProceduralModel, disposeModel, readHealthPalette, setExplode, type Tag } from './model'
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

  it('selection brightens the selected subsystem and dims the rest', () => {
    const built = buildProceduralModel()
    const palette = readHealthPalette()
    const comms = built.meshes.find((mesh) => (mesh.userData as Tag).partId === 'transponder')!
    const wing = built.meshes.find((mesh) => (mesh.userData as Tag).partId === 'wing_px')!
    applyHealth(built, nominal, 'comms', palette, 0)
    expect(comms.material.emissiveIntensity).toBeGreaterThan(0)
    expect(wing.material.color.getHex()).not.toBe((wing.userData as Tag).baseColor)
    disposeModel(built.root)
  })

  it('falls back to the skin colours when the CSS variables are absent', () => {
    const palette = readHealthPalette()
    expect(palette.faulted.getHex()).toBe(0x7b96ff)
    expect(palette['withheld-recovery'].getHex()).toBe(0xff7b6d)
    expect(palette.degraded.getHex()).toBe(0xc9a457)
  })
})
