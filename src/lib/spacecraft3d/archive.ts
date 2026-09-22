// The archive body: NASA 3D Resources public-domain geometry of the GPM Core
// Observatory as the visual stand-in for the synthetic SIM-01 (terms, hashes
// and the material reading in public/models/PROVENANCE.md). The file carries
// artist material names, not part names, so MEGALITH's seven subsystems are
// attached by material, splitting shared materials into welded spatial
// components assigned by position or shape. Anything unmatched is primary
// structure and is never tinted. On any failure the procedural body loads.
import * as THREE from 'three'
import type { SpacecraftBodyId } from '../syntheticSatellites'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { Subsystem } from '../spacecraftHealth'
import { addEdges, buildProceduralModel, type BuiltModel, type StructureMesh, type Tag, type TaggedMesh } from './model'

/** A welded, spatially connected piece of one mesh, in the normalised frame
 *  (arrays along X, +Y zenith, the bus along Z with the aft module at +Z). */
export type Component = {
  centre: THREE.Vector3
  size: THREE.Vector3
  /** World-space bounds. */
  min: THREE.Vector3
  max: THREE.Vector3
  tris: number
  /** Surface area in world units squared. */
  area: number
  material: string
}

export type ArchiveModelSpec = {
  file: string
  credit: string
  /** Longest dimension after normalisation, in the procedural model's units. */
  fit: number
  /** Rotation applied after normalisation so the solar arrays run along X. */
  rotation: [number, number, number]
  cameraDistance: number
  /** Which subsystem a component belongs to; null is primary structure. */
  assign: (component: Component) => Subsystem | null
  /** X of the bus centre after normalisation: power parts either side are
   *  different wings, merged and exploded apart from each other. */
  wingSplitX: number
}

type Range = readonly [number, number]
const within = (value: number, [low, high]: Range) => value >= low && value <= high
const inBox = (c: Component, x: Range, y: Range, z: Range) =>
  within(c.centre.x, x) && within(c.centre.y, y) && within(c.centre.z, z)
const longest = (c: Component) => Math.max(c.size.x, c.size.y, c.size.z)

/** The GPM Core Observatory body. Assignment is by region, read off the
 *  geometry with each material lit in turn and from a dump of the largest
 *  welded components (public/models/PROVENANCE.md), so a highlight lights a
 *  body rather than the faces that happen to share a material. Materials
 *  decide only the two subsystems that really are surfaces: solar cells and
 *  radiator panels. Order matters; the first match wins. */
export const ARCHIVE_MODEL: ArchiveModelSpec = {
  file: '/models/gpm.glb',
  credit: 'Geometry: NASA 3D Resources (public domain)',
  fit: 6.4,
  rotation: [0, Math.PI / 2, 0],
  cameraDistance: 8.6,
  wingSplitX: -0.85,
  assign: (c) => {
    // Radiator panels: the reflective flat panels on the bus sides. The same
    // material under the bus is the skin of the radar boxes, not a radiator.
    if (c.material === 'Reflector' && c.centre.y > -0.6) return 'thermal'
    // Everything beyond the bus in X is a wing, its yoke or its hinges.
    if (c.centre.x > -0.15 || c.centre.x < -1.55) return 'power'
    // The high-gain antenna: the dish and upper mast above the bus, and the
    // thin mast column down to the deck.
    if (inBox(c, [-1.05, -0.5], [0.75, 2.2], [-0.62, 0.05])) return 'comms'
    if (inBox(c, [-0.92, -0.68], [0.3, 0.75], [-0.32, -0.04]) && Math.min(c.size.x, c.size.z) < 0.3) return 'comms'
    // The instrument: the spinning platform, its dish, drum and tripod on the
    // forward end above the deck, and the radar boxes hung under the bus.
    if (inBox(c, [-1.3, -0.45], [0.26, 1.5], [-1.4, -0.55])) return 'payload'
    if (c.centre.y < -0.62 && within(c.centre.x, [-1.6, -0.15])) return 'payload'
    // Small sensors on the aft deck: two identical boxes, a boom and fittings.
    if (inBox(c, [-1.45, -0.45], [0.36, 0.95], [0.4, 1.36]) && longest(c) < 0.35) return 'adcs'
    // The aft module behind the adapter ring, all of its skins.
    if (inBox(c, [-1.5, -0.3], [-0.65, 0.8], [0.42, 1.4])) return 'propulsion'
    // The avionics stand-in: the forward compartment under the instrument,
    // and the mid-body equipment bay with its four boxes.
    if (inBox(c, [-1.45, -0.3], [-0.62, 0.26], [-1.4, -0.55])) return 'cdh'
    if (inBox(c, [-1.45, -0.3], [-0.4, 0.2], [-0.02, 0.37])) return 'cdh'
    return null
  },
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

/** Split a mesh into spatially connected components: vertices are welded by
 *  quantised world position (archive exports are flat-shaded and share no
 *  indices), triangles are unioned through welded vertices, and each
 *  component becomes its own geometry. Returns [geometry, component] pairs. */
function splitComponents(mesh: THREE.Mesh, material: string, cell = 0.002): Array<[THREE.BufferGeometry, Component]> {
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
    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    const c = new THREE.Vector3()
    let area = 0
    for (const t of tris) {
      for (let k = 0; k < 3; k += 1) {
        const source = vertexAt(t, k)
        v.set(world[source * 3]!, world[source * 3 + 1]!, world[source * 3 + 2]!)
        box.expandByPoint(v)
        sum.add(v)
      }
      const i0 = vertexAt(t, 0)
      const i1 = vertexAt(t, 1)
      const i2 = vertexAt(t, 2)
      a.set(world[i0 * 3]!, world[i0 * 3 + 1]!, world[i0 * 3 + 2]!)
      b.set(world[i1 * 3]!, world[i1 * 3 + 1]!, world[i1 * 3 + 2]!)
      c.set(world[i2 * 3]!, world[i2 * 3 + 1]!, world[i2 * 3 + 2]!)
      area += b.sub(a).cross(c.sub(a)).length() / 2
    }
    out.push([
      piece,
      {
        centre: sum.divideScalar(tris.length * 3),
        size: box.getSize(new THREE.Vector3()),
        min: box.min.clone(),
        max: box.max.clone(),
        tris: tris.length,
        area,
        material,
      },
    ])
  }
  return out
}

/** A component too small to be a part: no area to speak of, or a handful of
 *  triangles of no size. Exports leave these behind (seam faces, stray
 *  quads); drawn, they hovered as slivers once the body exploded. */
export function isDegenerate(component: Component, bodyDiag: number, totalArea: number): boolean {
  const diag = component.size.length()
  if (component.area <= totalArea * 5e-6) return true
  return component.tris <= 4 && diag < bodyDiag * 0.01
}

/** A thin plate (a box face, a decal, a strip) that lies on a much larger
 *  component takes that component's subsystem, so it stays on its body. */
export function adoptHosts(
  pieces: Array<{ component: Component; target: Subsystem | null }>,
  bodyDiag: number,
): number {
  const volume = (c: Component) => Math.max(c.size.x, 1e-9) * Math.max(c.size.y, 1e-9) * Math.max(c.size.z, 1e-9)
  const largest = Math.max(...pieces.map((piece) => volume(piece.component)), 1e-9)
  const tolerance = bodyDiag * 0.004
  const hosts = pieces.filter((piece) => volume(piece.component) >= largest * 0.002)
  let adopted = 0
  for (const piece of pieces) {
    const c = piece.component
    const thin = Math.min(c.size.x, c.size.y, c.size.z) / Math.max(c.size.x, c.size.y, c.size.z, 1e-9)
    if (thin > 0.03 || volume(c) > largest * 0.02) continue
    let best: { component: Component; target: Subsystem | null } | null = null
    let bestVolume = 0
    for (const host of hosts) {
      if (host === piece) continue
      const h = host.component
      const hv = volume(h)
      if (hv < volume(c) * 8) continue
      const inside =
        c.centre.x >= h.min.x - tolerance && c.centre.x <= h.max.x + tolerance &&
        c.centre.y >= h.min.y - tolerance && c.centre.y <= h.max.y + tolerance &&
        c.centre.z >= h.min.z - tolerance && c.centre.z <= h.max.z + tolerance
      if (!inside) continue
      // The smallest host that contains it: the box the plate lies on, not the bus.
      if (best === null || hv < bestVolume) {
        best = host
        bestVolume = hv
      }
    }
    if (best && best.target !== piece.target) {
      piece.target = best.target
      adopted += 1
    }
  }
  return adopted
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
    // The offset is applied in the mesh's parent frame, so one world unit of
    // explode is 1 / (the parent's world scale) there. The archive's nodes
    // carry their own scales under the fitted group (0.0002 in all for this
    // file), so dividing by the fit scale alone moved parts by a hundredth of
    // a unit: the slider did nothing visible.
    const parentScale = parent.getWorldScale(new THREE.Vector3()).x
    const tag: Tag = {
      partId: tagged.name || material.name,
      subsystem,
      rest: tagged.position.clone(),
      dir,
      baseColor: material.color.getHex(),
      baseEmissive: material.emissive.getHex(),
      explodeScale: parentScale > 0 ? 1 / parentScale : 1 / scale,
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
  // Every mesh is split into welded components and each component is
  // assigned on its own, so one archive material can serve several bodies
  // and one body can gather several materials. Components are gathered from
  // every mesh first, because two passes look across meshes:
  //  - degenerate fragments (no area, or a few triangles of no size) are
  //    dropped: they rendered as hovering slivers;
  //  - a thin plate lying on a body (a box face, a decal) adopts that body's
  //    subsystem, so it does not fly off on its own when exploding.
  type Piece = { object: THREE.Mesh; material: THREE.MeshStandardMaterial; geometry: THREE.BufferGeometry; component: Component; target: Subsystem | null }
  const pieces: Piece[] = []
  for (const object of found) {
    const source = Array.isArray(object.material) ? object.material[0] : object.material
    if (!(source instanceof THREE.MeshStandardMaterial)) continue
    const material = source.clone()
    material.name = source.name
    object.material = material
    for (const [geometry, component] of splitComponents(object, material.name)) {
      pieces.push({ object, material, geometry, component, target: spec.assign(component) })
    }
  }
  const bodyDiag = Math.hypot(size.x, size.y, size.z) * scale
  const totalArea = pieces.reduce((sum, piece) => sum + piece.component.area, 0)
  const kept: Piece[] = []
  for (const piece of pieces) {
    if (isDegenerate(piece.component, bodyDiag, totalArea)) piece.geometry.dispose()
    else kept.push(piece)
  }
  adoptHosts(kept, bodyDiag)
  const byObject = new Map<THREE.Mesh, Piece[]>()
  for (const piece of kept) {
    const list = byObject.get(piece.object)
    if (list) list.push(piece)
    else byObject.set(piece.object, [piece])
  }
  for (const [object, list] of byObject) {
    const material = list[0]!.material
    const parent = object.parent ?? scene
    // One merged mesh per target, except power, which is merged per wing so
    // that a material spanning both arrays (the cell fronts) does not tie the
    // wings together when they explode.
    const byBucket = new Map<string, { target: Subsystem | null; geometries: THREE.BufferGeometry[] }>()
    for (const piece of list) {
      const wing = piece.target === 'power' ? (piece.component.centre.x >= spec.wingSplitX ? ':east' : ':west') : ''
      const key = `${piece.target ?? 'structure'}${wing}`
      const bucket = byBucket.get(key)
      if (bucket) bucket.geometries.push(piece.geometry)
      else byBucket.set(key, { target: piece.target, geometries: [piece.geometry] })
    }
    for (const { target, geometries } of byBucket.values()) {
      const merged = geometries.length === 1 ? geometries[0]! : mergeGeometries(geometries, false)
      if (geometries.length > 1) for (const g of geometries) g.dispose()
      if (!merged) continue
      const pieceMaterial = material.clone()
      pieceMaterial.name = material.name
      // The archive models thin parts as single sheets (dish surfaces, panels,
      // blankets): drawn one-sided they vanish from behind, which looked like
      // 2D parts visible from one angle only. Both faces are drawn.
      pieceMaterial.side = THREE.DoubleSide
      const piece = new THREE.Mesh(merged, pieceMaterial)
      piece.name = `${material.name}·${target ?? 'structure'}`
      piece.position.copy(object.position)
      piece.quaternion.copy(object.quaternion)
      piece.scale.copy(object.scale)
      parent.add(piece)
      addEdges(piece)
      if (target) tagMesh(piece, pieceMaterial, target)
      else keepAsStructure(piece, pieceMaterial)
    }
    parent.remove(object)
    object.geometry.dispose()
    material.dispose()
  }
  for (const object of found) {
    // A mesh whose every component was dropped still leaves the scene.
    if (object.parent && !byObject.has(object)) {
      object.parent.remove(object)
      object.geometry.dispose()
    }
  }
  root.updateMatrixWorld(true)

  const anchors: Partial<Record<Subsystem, THREE.Object3D>> = {}
  const rigidDirection = (members: TaggedMesh[]) => {
    // One direction for a set of parts, so they explode as a body: each
    // part's own radial made the fronts, backs and fittings of one wing drift
    // apart into hovering sheets and specks.
    const box = new THREE.Box3()
    for (const mesh of members) box.expandByObject(mesh)
    const centre = box.getCenter(new THREE.Vector3())
    for (const mesh of members) {
      const parent = mesh.parent ?? root
      const dir = parent.worldToLocal(centre.clone()).sub(parent.worldToLocal(origin.clone()))
      if (dir.lengthSq() > 0) dir.normalize()
      ;(mesh.userData as Tag).dir.copy(dir)
    }
  }
  for (const [subsystem, group] of groups) {
    const members = meshes.filter((mesh) => (mesh.userData as Tag).subsystem === subsystem)
    if (subsystem === 'power') {
      // The two wings leave in opposite directions, each as one body.
      const centreX = (mesh: TaggedMesh) => new THREE.Box3().expandByObject(mesh).getCenter(new THREE.Vector3()).x
      const east = members.filter((mesh) => centreX(mesh) >= spec.wingSplitX)
      const west = members.filter((mesh) => centreX(mesh) < spec.wingSplitX)
      if (east.length) rigidDirection(east)
      if (west.length) rigidDirection(west)
    } else {
      rigidDirection(members)
    }
    const anchor = new THREE.Object3D()
    anchor.position.copy(group.host.worldToLocal(group.box.getCenter(new THREE.Vector3())))
    group.host.add(anchor)
    anchors[subsystem] = anchor
  }
  return { root, meshes, structure, anchors, cameraDistance: spec.cameraDistance, credit: spec.credit, source: 'archive' }
}

/** The TRMM observatory body, the closely-spaced object's (OBJ-1): a
 *  different spacecraft from the fleet's, so it reads as not one of ours.
 *  The file's parts are named (twenty meshes, one material each), so
 *  assignment is by material with a position check where one material
 *  serves two assemblies. Frame after rotation: arrays along X, the dish
 *  at +Y, the bus along Z with the microwave imager at +Z and the
 *  propulsion ring at -Z (public/models/PROVENANCE.md). */
export const TRMM_MODEL: ArchiveModelSpec = {
  file: '/models/trmm.glb',
  credit: 'Geometry: NASA 3D Resources (public domain)',
  fit: 6.4,
  rotation: [Math.PI / 2, 0, Math.PI / 2],
  cameraDistance: 8.6,
  wingSplitX: 0,
  assign: (c) => {
    const m = c.material
    if (/^Panel \d|^Solar_Parts|^Solar_Small_Parts/.test(m)) return 'power'
    // One material for the array booms and the dish arm: the booms run out
    // along the arrays, the arm stays by the bus.
    if (m.startsWith('Sat/Solar_Arms')) return Math.abs(c.centre.x) > 1.0 ? 'power' : 'comms'
    if (m.startsWith('Satellite_Dish') || m.startsWith('Satellite_Arm_Parts')) return 'comms'
    if (/^(VIRS|CERES|Microwave_)/.test(m)) return 'payload'
    // The ring and drum at the aft end of the bus.
    if (m.startsWith('Blue_Surfaces')) return c.centre.z < -0.75 ? 'propulsion' : null
    // The two large flat sheets on the bus are its radiator panels.
    if (m.startsWith('Grey_Surfaces')) return c.size.z < 0.05 && c.area > 1 ? 'thermal' : null
    // Equipment boxes on the bus panels: the avionics stand-in.
    if (m.startsWith('Brown_Surface')) return 'cdh'
    // The wheel-shaped assembly on the bus side: the reaction-wheel stand-in.
    if (m.startsWith('Orange Surface')) return 'adcs'
    return null
  },
}

export const ARCHIVE_MODELS: Record<SpacecraftBodyId, ArchiveModelSpec> = { gpm: ARCHIVE_MODEL, trmm: TRMM_MODEL }

/** The body the page shows: the spacecraft's archive file, else the procedural fallback. */
export async function loadSpacecraftModel(body: SpacecraftBodyId = 'gpm'): Promise<{ built: BuiltModel; fallback: boolean }> {
  try {
    return { built: await loadArchiveModel(ARCHIVE_MODELS[body]), fallback: false }
  } catch (error) {
    console.warn('Spacecraft page: archive geometry unavailable; showing the procedural body', error)
    return { built: buildProceduralModel(), fallback: true }
  }
}
