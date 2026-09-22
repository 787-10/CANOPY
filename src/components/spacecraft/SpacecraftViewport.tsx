// The Three.js host for the Spacecraft page: one renderer and scene for the
// life of the page, the body loaded once (archive geometry, else the
// procedural fallback), health applied every frame in the skin's colours.
// Lazy-loaded by the scene so `three` never enters the console's main chunk.
import { useEffect, useRef, useState } from 'react'
import type { SpacecraftBodyId } from '../../lib/syntheticSatellites'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import type { Subsystem, SubsystemState } from '../../lib/spacecraftHealth'
import { loadSpacecraftModel } from '../../lib/spacecraft3d/archive'
import {
  anchorScreenPositions,
  applyHealth,
  disposeModel,
  readHealthPalette,
  setExplode,
  type AnchorScreen,
  type BuiltModel,
  setIsolation,
  subsystemBounds,
} from '../../lib/spacecraft3d/model'

export type SpacecraftViewportProps = {
  /** The archive body to draw; the fleet's bus when unset. */
  body?: SpacecraftBodyId
  states: SubsystemState[]
  selected: Subsystem | null
  onSelect?: (subsystem: Subsystem | null) => void
  /** 0 = assembled, 1 = fully exploded. */
  explode?: number
  autoRotate?: boolean
  /** Bump to reset the camera. */
  resetToken?: number
  /** The subsystem the camera orbits and frames; null orbits the whole body. */
  focus?: Subsystem | null
  /** Show the focused subsystem alone. */
  isolate?: boolean
  /** Called every frame with the anchors' positions in viewport pixels. */
  onAnchors?: (
    anchors: Partial<Record<Subsystem, AnchorScreen>>,
    size: { width: number; height: number },
  ) => void
  className?: string
}

const CAMERA_DIR = new THREE.Vector3(0.62, 0.38, 0.7).normalize()

type Stage = {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
}

const hasWebGL = () =>
  typeof window !== 'undefined' &&
  (typeof WebGL2RenderingContext !== 'undefined' || typeof WebGLRenderingContext !== 'undefined')

/** The body fills more of the stage than the first cut did (Jeewoo: "much larger"). */
const FRAME_TIGHTEN = 0.74
/** Radians per frame while Rotate is on: half the original rate (Jeewoo: "a bit fast"). */
export const AUTO_ROTATE_RAD_PER_FRAME = 0.00125
/** A focused subsystem is framed at this many times its bounding radius. */
const FOCUS_DISTANCE_PER_RADIUS = 2.8

function frameDistance(stage: Stage, built: BuiltModel): number {
  return (built.cameraDistance * FRAME_TIGHTEN) / Math.min(1, stage.camera.aspect || 1)
}

function frameCamera(stage: Stage, built: BuiltModel) {
  const distance = frameDistance(stage, built)
  stage.camera.position.copy(CAMERA_DIR).multiplyScalar(distance)
  stage.controls.minDistance = distance * 0.12
  stage.controls.maxDistance = distance * 2.4
  stage.controls.target.set(0, 0, 0)
  stage.controls.update()
}

export default function SpacecraftViewport(props: SpacecraftViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const latest = useRef(props)
  const stageRef = useRef<Stage | null>(null)
  const builtRef = useRef<BuiltModel | null>(null)
  const explodeRef = useRef(props.explode ?? 0)
  // The camera's goal while a subsystem is the focus (world target and the
  // distance to settle at), consumed by the loop; null orbits the body.
  const focusRef = useRef<{ subsystem: Subsystem | null; distanceGoal: number | null; isolate: boolean }>({
    subsystem: null,
    distanceGoal: null,
    isolate: false,
  })
  const [status, setStatus] = useState<'loading' | 'ready' | 'fallback' | 'unavailable'>(
    hasWebGL() ? 'loading' : 'unavailable',
  )
  const [credit, setCredit] = useState<string | null>(null)

  useEffect(() => {
    latest.current = props
  })

  // The stage: renderer, environment, camera, controls, lights, picking, loop.
  useEffect(() => {
    const host = hostRef.current
    if (!host || !hasWebGL()) return
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    } catch {
      setStatus('unavailable')
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x000000, 0)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.0
    renderer.domElement.className = 'viewport3d__canvas'
    renderer.domElement.setAttribute('role', 'img')
    renderer.domElement.setAttribute('aria-label', 'Spacecraft model')
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const pmrem = new THREE.PMREMGenerator(renderer)
    const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    pmrem.dispose()
    scene.environment = environment
    scene.environmentIntensity = 0.55

    const camera = new THREE.PerspectiveCamera(34, 1, 0.05, 200)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.06
    const stage: Stage = { renderer, scene, camera, controls }
    stageRef.current = stage

    scene.add(new THREE.HemisphereLight(0xbcd4e6, 0x1a2024, 1.1))
    const key = new THREE.DirectionalLight(0xffffff, 2.6)
    key.position.set(6, 8, 7)
    scene.add(key)
    const rim = new THREE.DirectionalLight(0x7b96ff, 2.0)
    rim.position.set(-7, 2, -6)
    scene.add(rim)
    const fill = new THREE.DirectionalLight(0xffe2b0, 0.6)
    fill.position.set(0, -6, 3)
    scene.add(fill)

    const palette = readHealthPalette()
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    let down: { x: number; y: number } | null = null
    const onDown = (event: PointerEvent) => {
      down = { x: event.clientX, y: event.clientY }
    }
    const onUp = (event: PointerEvent) => {
      if (!down) return
      const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y)
      down = null
      const built = builtRef.current
      if (moved > 4 || !built) return
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      )
      raycaster.setFromCamera(pointer, camera)
      const hit = raycaster.intersectObjects(built.meshes, false)[0]
      const subsystem = (hit?.object.userData as { subsystem?: Subsystem } | undefined)?.subsystem ?? null
      latest.current.onSelect?.(subsystem)
    }
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointerup', onUp)

    let width = 1
    let height = 1
    const resize = () => {
      width = Math.max(1, host.clientWidth)
      height = Math.max(1, host.clientHeight)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null
    observer?.observe(host)
    resize()

    // The body; frame the camera when it lands. A different body (the fleet
    // switcher) rebuilds the stage: this effect depends on it.
    let cancelled = false
    void loadSpacecraftModel(props.body ?? 'gpm').then(({ built, fallback }) => {
      if (cancelled) {
        disposeModel(built.root)
        return
      }
      scene.add(built.root)
      builtRef.current = built
      setExplode(built, explodeRef.current)
      frameCamera(stage, built)
      setCredit(built.credit ?? null)
      setStatus(fallback ? 'fallback' : 'ready')
      // Dev-only handle for the mapping scripts that read the body's geometry.
      if (import.meta.env.DEV) (window as unknown as { __spacecraftBuilt?: BuiltModel }).__spacecraftBuilt = built
    })

    let frame = 0
    const render = () => {
      frame = window.requestAnimationFrame(render)
      const current = latest.current
      const built = builtRef.current
      if (built) {
        const target = current.explode ?? 0
        if (Math.abs(target - explodeRef.current) > 0.001) {
          explodeRef.current += (target - explodeRef.current) * 0.12
          setExplode(built, explodeRef.current)
        }
        const pulse = (Math.sin(performance.now() / 250) + 1) / 2
        applyHealth(built, current.states, current.selected, palette, pulse)
        if (current.autoRotate) built.root.rotation.y += AUTO_ROTATE_RAD_PER_FRAME

        // Focus: the orbit centre follows the chosen subsystem as the body
        // turns and explodes; the camera closes to frame it once per change
        // and is then the operator's again. Deselecting returns to the body.
        const focus = focusRef.current
        const wanted = current.focus ?? null
        const isolate = Boolean(current.isolate && wanted)
        if (wanted !== focus.subsystem || isolate !== focus.isolate) {
          focus.subsystem = wanted
          focus.isolate = isolate
          setIsolation(built, isolate ? wanted : null)
          if (wanted) {
            const bounds = subsystemBounds(built, wanted)
            focus.distanceGoal = bounds
              ? Math.max(controls.minDistance, bounds.getBoundingSphere(new THREE.Sphere()).radius * FOCUS_DISTANCE_PER_RADIUS)
              : null
          } else {
            focus.distanceGoal = frameDistance(stage, built)
          }
        }
        const goal = focus.subsystem ? subsystemBounds(built, focus.subsystem)?.getCenter(new THREE.Vector3()) ?? null : new THREE.Vector3()
        if (goal) {
          const offset = new THREE.Vector3().subVectors(camera.position, controls.target)
          controls.target.lerp(goal, 0.12)
          camera.position.copy(controls.target).add(offset)
        }
        if (focus.distanceGoal !== null) {
          const offset = new THREE.Vector3().subVectors(camera.position, controls.target)
          const distance = offset.length()
          const next = distance + (focus.distanceGoal - distance) * 0.12
          camera.position.copy(controls.target).add(offset.multiplyScalar(next / Math.max(distance, 1e-6)))
          if (Math.abs(next - focus.distanceGoal) < 0.01) focus.distanceGoal = null
        }
      }
      controls.update()
      renderer.render(scene, camera)
      if (built) current.onAnchors?.(anchorScreenPositions(built, camera, width, height), { width, height })
    }
    render()

    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerup', onUp)
      controls.dispose()
      if (builtRef.current) {
        scene.remove(builtRef.current.root)
        disposeModel(builtRef.current.root)
        builtRef.current = null
      }
      environment.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
      stageRef.current = null
    }
    // The stage is built once per body; everything else reaches it through refs.
  }, [props.body])

  useEffect(() => {
    const stage = stageRef.current
    const built = builtRef.current
    if (!stage || !built) return
    frameCamera(stage, built)
    built.root.rotation.set(0, 0, 0)
  }, [props.resetToken])

  return (
    <div
      className={`viewport3d${props.className ? ` ${props.className}` : ''}`}
      ref={hostRef}
      data-testid="spacecraft-viewport"
      data-status={status}
    >
      {status === 'unavailable' ? (
        <div className="viewport3d__status" role="status">
          3D rendering unavailable
        </div>
      ) : null}
      {status === 'loading' ? (
        <div className="viewport3d__status" role="status">
          Loading model…
        </div>
      ) : null}
      {status === 'fallback' ? (
        <div className="viewport3d__status viewport3d__status--corner" role="status">
          Archive geometry unavailable · reference body shown
        </div>
      ) : null}
      {credit && status === 'ready' ? <div className="viewport3d__credit">{credit}</div> : null}
    </div>
  )
}
