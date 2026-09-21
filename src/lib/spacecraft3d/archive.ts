// The archive body: NASA 3D Resources public-domain geometry of the GPM Core
// Observatory as the visual stand-in for the synthetic SIM-01 (terms, hashes
// and the material reading in public/models/PROVENANCE.md). The file carries
// artist material names, not part names, so MEGALITH's seven subsystems are
// attached by material, splitting shared materials into welded spatial
// components assigned by position or shape. Anything unmatched is primary
// structure and is never tinted. On any failure the procedural body loads.
import * as THREE from 'three'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { Subsystem } from '../spacecraftHealth'
import { buildProceduralModel, type BuiltModel, type StructureMesh, type Tag, type TaggedMesh } from './model'

/** A welded, spatially connected piece of one mesh, in the normalised frame. */
export type Component = { centre: THREE.Vector3; size: THREE.Vector3; tris: number }

type MapRule = {
  by: 'material' | 'node'
  match: RegExp
  subsystem: Subsystem
  /** When set, the mesh is split into spatial components and each is
   *  assigned by this predicate (null = primary structure). Used where the
   *  archive shares one material across several assemblies. */
  split?: (component: Component) => Subsystem | null
}

export type ArchiveModelSpec = {
  file: string
  credit: string
  /** Longest dimension after normalisation, in the procedural model's units. */
  fit: number
  /** Rotation applied after normalisation so the solar arrays run along X. */
  rotation: [number, number, number]
  rules: MapRule[]
  cameraDistance: number
}

export const ARCHIVE_MODEL: ArchiveModelSpec = {
  file: '/models/gpm.glb',
  credit: 'Geometry: NASA 3D Resources (public domain)',
  fit: 6.4,
  rotation: [0, Math.PI / 2, 0],
  cameraDistance: 8.6,
  // Read off the archive body with each material lit in turn (normalised
  // frame: arrays along X, +Y zenith). Shared materials split by component.
  rules: [
    // The white dish at the top of the mast is the high-gain antenna; the
    // same material covers the instrument drum lower down.
    {
      by: 'material',
      match: /^Dish-White-sm$/,
      subsystem: 'comms',
      split: (c) => (c.centre.y > 1.5 ? 'comms' : c.centre.y > 0.9 ? 'payload' : null),
    },
    // The tall thin mast shares grey with the launch-adapter ring and fittings.
    {
      by: 'material',
      match: /^Grey-sm-notex$/,
      subsystem: 'comms',
      split: (c) => (c.size.y > 0.8 && Math.max(c.size.x, c.size.z) < 0.3 ? 'comms' : null),
    },
    // White rods: the array yokes run along X; the mast segments stand up.
    {
      by: 'material',
      match: /^White-sm$/,
      subsystem: 'power',
      split: (c) => (c.size.x > 0.5 ? 'power' : c.size.y > 0.4 ? 'comms' : null),
    },
    // Two identical black boxes on the forward deck: the star-tracker stand-in.
    {
      by: 'material',
      match: /^Mainbody-Black-sm$/,
      subsystem: 'adcs',
      split: (c) => (c.centre.z > 1.0 ? 'adcs' : null),
    },
    { by: 'material', match: /^Gold-fl-instruments-[345]$/, subsystem: 'adcs' },
    // Spinning platform, its tripod truss, fittings, and the boxes under the bus.
    { by: 'material', match: /^spinningdish-top$|^MainDishRails|^GreyLight|^Silver-sm-bottombox/, subsystem: 'payload' },
    // The aft module behind the adapter ring.
    { by: 'material', match: /^Mainbody-backsection/, subsystem: 'propulsion' },
    // Large flat reflective panels on the bus sides.
    { by: 'material', match: /^Reflector$/, subsystem: 'thermal' },
    // One distinct black box on the forward face: the avionics-bay stand-in.
    { by: 'material', match: /^Mainbody-Black-fl$/, subsystem: 'cdh' },
    { by: 'material', match: /^Solar|^SolarPanel/, subsystem: 'power' },
  ],
}

let draco: DRACOLoader | null = null

function gltfLoader(): GLTFLoader {
  if (!draco) {
    draco = new DRACOLoader()
    draco.setDecoderPath('/draco/')
  }
  const loader = new GLTFLoader()
  loader.setDRACOLoader(draco)
  return loader
}

function nodeChain(object: THREE.Object3D): string {
  const names: string[] = []
  let current: THREE.Object3D | null = object
  while (current) {
    if (current.name) names.push(current.name)
    current = current.parent
  }
  return names.join(' / ')
}

function classify(spec: ArchiveModelSpec, mesh: THREE.Mesh, materialName: string): MapRule | null {
  const chain = nodeChain(mesh)
  for (const rule of spec.rules) {
    if (rule.match.test(rule.by === 'material' ? materialName : chain)) return rule
  }
  return null
}

/** Split a mesh into spatially connected components: vertices are welded by
 *  quantised world position (archive exports are flat-shaded and share no
 *  indices), triangles are unioned through welded vertices, and each
 *  component becomes its own geometry. Returns [geometry, component] pairs. */
function splitComponents(mesh: THREE.Mesh, cell = 0.002): Array<[THREE.BufferGeometry, Component]> {
  const geometry = mesh.geometry
  const position = geometry.attributes.position as THREE.BufferAttribute
  const index = geometry.index
  const count = position.count
  const triCount = index ? index.count / 3 : count / 3
  const vertexAt = (t: number, k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k)
  mesh.updateWorldMatrix(true, false)
  const world = new Float64Array(count * 3)
  const v = new THREE.Vector3()
  for (let i = 0; i < count; i += 1) {
    v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld)
    world[i * 3] = v.x
    world[i * 3 + 1] = v.y
    world[i * 3 + 2] = v.z
  }
  const representative = new Int32Array(count)
  const seen = new Map<string, number>()
  for (let i = 0; i < count; i += 1) {
    const key = `${Math.round(world[i * 3] / cell)},${Math.round(world[i * 3 + 1] / cell)},${Math.round(world[i * 3 + 2] / cell)}`
    const existing = seen.get(key)
    if (existing === undefined) {
      seen.set(key, i)
      representative[i] = i
    } else representative[i] = existing
  }
  const parent = new Int32Array(count)
  for (let i = 0; i < count; i += 1) parent[i] = i
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]]!
      a = parent[a]!
    }
    return a
  }
  const union = (a: number, b: number) => {
    a = find(a)
    b = find(b)
    if (a !== b) parent[a] = b
  }
  for (let t = 0; t < triCount; t += 1) {
    const a = representative[vertexAt(t, 0)]!
    union(a, representative[vertexAt(t, 1)]!)
    union(a, representative[vertexAt(t, 2)]!)
  }
  const buckets = new Map<number, number[]>()
  for (let t = 0; t < triCount; t += 1) {
    const root = find(representative[vertexAt(t, 0)]!)
    const list = buckets.get(root)
    if (list) list.push(t)
    else buckets.set(root, [t])
  }
  const attributes = Object.entries(geometry.attributes) as Array<[string, THREE.BufferAttribute]>
  const out: Array<[THREE.BufferGeometry, Component]> = []
  for (const tris of buckets.values()) {
    const piece = new THREE.BufferGeometry()
    for (const [name, attribute] of attributes) {
      const itemSize = attribute.itemSize
      const array = new Float32Array(tris.length * 3 * itemSize)
      let write = 0
      for (const t of tris) {
        for (let k = 0; k < 3; k += 1) {
          const source = vertexAt(t, k)
          for (let c = 0; c < itemSize; c += 1) array[write++] = attribute.getComponent(source, c)
        }
      }
      piece.setAttribute(name, new THREE.BufferAttribute(array, itemSize))
    }
    const box = new THREE.Box3()
    const sum = new THREE.Vector3()
    for (const t of tris) {
      for (let k = 0; k < 3; k += 1) {
        const source = vertexAt(t, k)
        v.set(world[source * 3]!, world[source * 3 + 1]!, world[source * 3 + 2]!)
        box.expandByPoint(v)
        sum.add(v)
      }
    }
    out.push([piece, { centre: sum.divideScalar(tris.length * 3), size: box.getSize(new THREE.Vector3()), tris: tris.length }])
  }
  return out
}

const volumeOf = (box: THREE.Box3): number => {
  const size = box.getSize(new THREE.Vector3())
  return size.x * size.y * size.z
}

/** The archive body normalised to the procedural one: centred, fitted to
 *  `spec.fit`, rotated so the arrays run along X, every matched mesh tagged
 *  like a procedural part. */
export async function loadArchiveModel(spec: ArchiveModelSpec = ARCHIVE_MODEL): Promise<BuiltModel> {
  const gltf = await gltfLoader().loadAsync(spec.file)
  const scene = gltf.scene
  scene.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(scene)
  const size = bounds.getSize(new THREE.Vector3())
  const centre = bounds.getCenter(new THREE.Vector3())
  const scale = spec.fit / Math.max(size.x, size.y, size.z, 1e-6)

  const inner = new THREE.Group()
  inner.add(scene)
  scene.position.set(-centre.x, -centre.y, -centre.z)
  inner.scale.setScalar(scale)
  inner.rotation.set(spec.rotation[0], spec.rotation[1], spec.rotation[2])
  const root = new THREE.Group()
  root.add(inner)
  root.updateMatrixWorld(true)

  const meshes: TaggedMesh[] = []
  const structure: StructureMesh[] = []
  const groups = new Map<Subsystem, { host: TaggedMesh; hostVolume: number; box: THREE.Box3 }>()
  const origin = new THREE.Vector3()

  const keepAsStructure = (mesh: THREE.Mesh, material: THREE.MeshStandardMaterial) => {
    mesh.userData = { baseColor: material.color.getHex() }
    structure.push(mesh as StructureMesh)
  }

  const tagMesh = (mesh: THREE.Mesh, material: THREE.MeshStandardMaterial, subsystem: Subsystem) => {
    const tagged = mesh as unknown as TaggedMesh
    const worldBox = new THREE.Box3().setFromObject(tagged)
    if (worldBox.isEmpty()) return
    const parent = tagged.parent ?? root
    const dir = parent
      .worldToLocal(worldBox.getCenter(new THREE.Vector3()))
      .sub(parent.worldToLocal(origin.clone()))
    if (dir.lengthSq() > 0) dir.normalize()
    const tag: Tag = {
      partId: tagged.name || material.name,
      subsystem,
      rest: tagged.position.clone(),
      dir,
      baseColor: material.color.getHex(),
      baseEmissive: material.emissive.getHex(),
      explodeScale: 1 / scale,
    }
    tagged.userData = tag
    meshes.push(tagged)
    const volume = volumeOf(worldBox)
    const group = groups.get(subsystem)
    if (!group) groups.set(subsystem, { host: tagged, hostVolume: volume, box: worldBox.clone() })
    else {
      group.box.union(worldBox)
      if (volume > group.hostVolume) {
        group.host = tagged
        group.hostVolume = volume
      }
    }
  }

  const found: THREE.Mesh[] = []
  scene.traverse((object) => {
    if (object instanceof THREE.Mesh) found.push(object)
  })
  for (const object of found) {
    const source = Array.isArray(object.material) ? object.material[0] : object.material
    if (!(source instanceof THREE.MeshStandardMaterial)) continue
    const material = source.clone()
    material.name = source.name
    object.material = material
    const rule = classify(spec, object, material.name)
    if (!rule) {
      keepAsStructure(object, material)
      continue
    }
    if (!rule.split) {
      tagMesh(object, material, rule.subsystem)
      continue
    }
    // Shared material: split into welded components, each with its own mesh
    // and material clone, assigned by the rule's predicate.
    const parent = object.parent ?? scene
    const byTarget = new Map<Subsystem | null, THREE.BufferGeometry[]>()
    for (const [geometry, component] of splitComponents(object)) {
      const target = rule.split(component)
      const list = byTarget.get(target)
      if (list) list.push(geometry)
      else byTarget.set(target, [geometry])
    }
    for (const [target, geometries] of byTarget) {
      const merged = geometries.length === 1 ? geometries[0]! : mergeGeometries(geometries, false)
      if (geometries.length > 1) for (const g of geometries) g.dispose()
      if (!merged) continue
      const pieceMaterial = material.clone()
      pieceMaterial.name = material.name
      const piece = new THREE.Mesh(merged, pieceMaterial)
      piece.name = `${object.name || material.name}·${target ?? 'structure'}`
      piece.position.copy(object.position)
      piece.quaternion.copy(object.quaternion)
      piece.scale.copy(object.scale)
      parent.add(piece)
      if (target) tagMesh(piece, pieceMaterial, target)
      else keepAsStructure(piece, pieceMaterial)
    }
    parent.remove(object)
    object.geometry.dispose()
    material.dispose()
  }
  root.updateMatrixWorld(true)

  const anchors: Partial<Record<Subsystem, THREE.Object3D>> = {}
  for (const [subsystem, group] of groups) {
    const anchor = new THREE.Object3D()
    anchor.position.copy(group.host.worldToLocal(group.box.getCenter(new THREE.Vector3())))
    group.host.add(anchor)
    anchors[subsystem] = anchor
  }
  return { root, meshes, structure, anchors, cameraDistance: spec.cameraDistance, credit: spec.credit, source: 'archive' }
}

/** The body the page shows: the archive file, else the procedural fallback. */
export async function loadSpacecraftModel(): Promise<{ built: BuiltModel; fallback: boolean }> {
  try {
    return { built: await loadArchiveModel(), fallback: false }
  } catch (error) {
    console.warn('Spacecraft page: archive geometry unavailable; showing the procedural body', error)
    return { built: buildProceduralModel(), fallback: true }
  }
}
