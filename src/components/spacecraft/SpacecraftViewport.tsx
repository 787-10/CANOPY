// The Three.js host for the Spacecraft page: one renderer and scene for the
// life of the page, the body loaded once (archive geometry, else the
// procedural fallback), health applied every frame in the skin's colours.
// Lazy-loaded by the scene so `three` never enters the console's main chunk.
import { useEffect, useRef, useState } from 'react'
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
} from '../../lib/spacecraft3d/model'

export type SpacecraftViewportProps = {
  states: SubsystemState[]
  selected: Subsystem | null
  onSelect?: (subsystem: Subsystem | null) => void
  /** 0 = assembled, 1 = fully exploded. */
  explode?: number
  autoRotate?: boolean
  /** Bump to reset the camera. */
  resetToken?: number
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

function frameCamera(stage: Stage, built: BuiltModel) {
  const distance = built.cameraDistance / Math.min(1, stage.camera.aspect || 1)
  stage.camera.position.copy(CAMERA_DIR).multiplyScalar(distance)
  stage.controls.minDistance = distance * 0.3
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

    // The body, once; frame the camera when it lands.
    let cancelled = false
    void loadSpacecraftModel().then(({ built, fallback }) => {
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
        if (current.autoRotate) built.root.rotation.y += 0.0025
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
  }, [])

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
