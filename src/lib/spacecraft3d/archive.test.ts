import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { adoptHosts, ARCHIVE_MODELS, isDegenerate, TRMM_MODEL, type Component } from './archive'

const component = (centre: [number, number, number], size: [number, number, number], tris: number, area: number): Component => ({
  centre: new THREE.Vector3(...centre),
  size: new THREE.Vector3(...size),
  min: new THREE.Vector3(centre[0] - size[0] / 2, centre[1] - size[1] / 2, centre[2] - size[2] / 2),
  max: new THREE.Vector3(centre[0] + size[0] / 2, centre[1] + size[1] / 2, centre[2] + size[2] / 2),
  tris,
  area,
  material: 'm',
})

describe('archive components', () => {
  it('drops fragments with no area or a few triangles of no size, keeps real sheets', () => {
    const bodyDiag = 7.3
    const totalArea = 500
    expect(isDegenerate(component([0, 0, 0], [0, 0.003, 0.15], 10, 0.00001), bodyDiag, totalArea)).toBe(true)
    expect(isDegenerate(component([0, 0, 0], [0.001, 0.002, 0.003], 3, 0.001), bodyDiag, totalArea)).toBe(true)
    // A solar panel back: two triangles, but a real sheet with area.
    expect(isDegenerate(component([2, 0, 0], [0, 0.79, 1.55], 2, 1.2), bodyDiag, totalArea)).toBe(false)
    expect(isDegenerate(component([0, 0, 0], [0.5, 0.5, 0.5], 400, 1.5), bodyDiag, totalArea)).toBe(false)
  })

  it('a thin plate on a box adopts the box\'s subsystem; the smallest containing host wins', () => {
    const bus = { component: component([0, 0, 0], [3, 2, 2], 4000, 30), target: null }
    const box = { component: component([1, -0.5, 0], [0.6, 0.4, 0.5], 600, 2), target: 'payload' as const }
    const plate = { component: component([1, -0.7, 0], [0.55, 0.004, 0.45], 150, 0.5), target: 'cdh' as const }
    const panel = { component: component([4, 0, 0], [0.01, 0.8, 1.5], 2, 1.2), target: 'power' as const }
    const pieces = [bus, box, plate, panel]
    const adopted = adoptHosts(pieces, 7.3)
    expect(adopted).toBe(1)
    expect(plate.target).toBe('payload')
    // Far from any body, the panel keeps its own subsystem.
    expect(panel.target).toBe('power')
    expect(box.target).toBe('payload')
  })
})

describe('the TRMM body (OBJ-1)', () => {
  const at = (material: string, centre: [number, number, number], size: [number, number, number], area = 0.1): Component => ({
    material,
    centre: new THREE.Vector3(...centre),
    size: new THREE.Vector3(...size),
    min: new THREE.Vector3(),
    max: new THREE.Vector3(),
    tris: 12,
    area,
  })
  it('is the body the object wears; the fleet bus stays on the SIM pair', () => {
    expect(ARCHIVE_MODELS.trmm.file).toBe('/models/trmm.glb')
    expect(ARCHIVE_MODELS.gpm.file).toBe('/models/gpm.glb')
    expect(TRMM_MODEL.credit).toBe(ARCHIVE_MODELS.gpm.credit)
  })
  it('assigns parts by their names, with a position check where one material serves two assemblies', () => {
    const assign = TRMM_MODEL.assign
    expect(assign(at('Panel 3.001', [-2.8, 0.5, 0], [0.9, 0.4, 1]))).toBe('power')
    expect(assign(at('Solar_Parts.001', [1.3, 0.4, 0], [0.1, 0.1, 0.1]))).toBe('power')
    // The array booms run out along the arrays; the dish arm stays by the bus.
    expect(assign(at('Sat/Solar_Arms.001', [1.8, 0.4, 0], [0.8, 0.02, 0.02]))).toBe('power')
    expect(assign(at('Sat/Solar_Arms.001', [0, 0.5, -0.2], [0.04, 0.4, 0.04]))).toBe('comms')
    expect(assign(at('Satellite_Dish.001', [0, 0.9, 0.1], [0.6, 0.5, 0.3]))).toBe('comms')
    expect(assign(at('Microwave_Imager.001', [0, 0.2, 0.9], [0.3, 0.3, 0.3]))).toBe('payload')
    expect(assign(at('CERES.001', [0, -1, -0.6], [0.2, 0.3, 0.2]))).toBe('payload')
    // The ring at the aft end is propulsion; blue elsewhere is structure.
    expect(assign(at('Blue_Surfaces.001', [0, 0.4, -1.0], [0.45, 0.45, 0.1]))).toBe('propulsion')
    expect(assign(at('Blue_Surfaces.001', [0.4, 0.2, 0.2], [0.2, 0.2, 0.2]))).toBeNull()
    // The two large flat sheets are radiators; a grey box is structure.
    expect(assign(at('Grey_Surfaces.001', [0, 0.4, -0.7], [1.1, 1.0, 0.01], 1.9))).toBe('thermal')
    expect(assign(at('Grey_Surfaces.001', [0.3, 0.1, -0.5], [0.5, 0.5, 0.3], 0.35))).toBeNull()
    expect(assign(at('Brown_Surface.001', [0.5, 0.2, 0.1], [0.14, 0.17, 0.07]))).toBe('cdh')
    expect(assign(at('Orange Surface.001', [0.3, 0.3, 0.1], [0.4, 0.4, 0.1]))).toBe('adcs')
    expect(assign(at('TRMM_Main Body.001', [0, 0, 0.4], [1, 1, 0.4]))).toBeNull()
  })
})
