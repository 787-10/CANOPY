import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { adoptHosts, isDegenerate, type Component } from './archive'

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
