// The flight layer (docs/MEGALITH-Flight-Plan.md §2.4): while the globe is in
// flight view the pinned synthetic spacecraft are hidden and each one with a
// defining pass in its track file flies its circular orbit at true altitude,
// with a trail, an orbit ring rotated to the clock's sidereal time, and the
// station footprint at the mask. Positions are callbacks on the time Cesium
// passes, so tracking frames and paths sample them correctly; the viewer's
// clock mirrors the flight clock store. Pass view is untouched.
import {
  ArcType,
  CallbackPositionProperty,
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Color,
  ConstantProperty,
  JulianDate,
  LabelStyle,
  ModelGraphics,
  NearFarScalar,
  ShadowMode,
  TrackingReferenceFrame,
  VelocityOrientationProperty,
  type Entity,
  type PositionProperty,
  type Viewer,
} from 'cesium'
import { FAMILY_COLOR_HEX, orbitEntityIdForSatellite, type N2YOLayerState } from './n2yoSatelliteLayer'
import { CircularOrbit, EARTH_RADIUS_KM, elementsFromSynthetic, type Subpoint } from './orbit/kepler'
import { footprintRadiusKm, lookAngles, nextAos, type Site } from './orbit/lookAngles'

export const DEFAULT_MASK_DEG = 5
/** Seconds of trail behind the spacecraft (about a fifth of an orbit). */
export const TRAIL_S = 900
const RING_POINTS = 240
const MAP_FONT = '600 12px "JetBrains Mono", "SF Mono", Menlo, ui-monospace, monospace'
const PANEL = Color.fromCssColorString('#0b1112')

export type FlightBody = {
  layer: N2YOLayerState
  orbit: CircularOrbit
  /** The ground station the track file names, when it does. */
  site: Site | null
  maskDeg: number
  entityIds: string[]
}

export const flightSatelliteId = (satelliteId: number) => `flight-${satelliteId}-satellite`
export const flightRingId = (satelliteId: number) => `flight-${satelliteId}-ring`
export const flightFootprintId = (satelliteId: number) => `flight-${satelliteId}-footprint`

export const isFlightSatelliteEntityId = (id: string) => id.startsWith('flight-') && id.endsWith('-satellite')

/** The layer's satellite number from a flight entity id, else null. */
export function flightSatelliteNumber(id: string): number | null {
  const match = /^flight-(\d+)-(satellite|ring|footprint)$/.exec(id)
  return match ? Number(match[1]) : null
}

/** A flight body for a synthetic layer whose file carries the defining pass
 *  (1.4.3); null for a file that predates it, which stays pinned. */
export function flightBodyFor(layer: N2YOLayerState): FlightBody | null {
  const synthetic = layer.cache.synthetic
  const elements = elementsFromSynthetic(synthetic)
  if (!elements) return null
  const pass = synthetic?.pass
  const site: Site | null =
    typeof pass?.site_lat === 'number' && typeof pass?.site_lng === 'number'
      ? { lat: pass.site_lat, lng: pass.site_lng, altM: pass.site_alt_m ?? 0 }
      : null
  const maskDeg = typeof pass?.mask_deg === 'number' ? pass.mask_deg : DEFAULT_MASK_DEG
  return {
    layer,
    orbit: new CircularOrbit(elements),
    site,
    maskDeg,
    entityIds: [
      flightSatelliteId(layer.satelliteId),
      flightRingId(layer.satelliteId),
      flightFootprintId(layer.satelliteId),
    ],
  }
}

const bodyColor = () => Color.fromCssColorString(FAMILY_COLOR_HEX.SIM)

/** The mark: a soft glow with a bright core, drawn once to a canvas. In flight
 *  the spacecraft is a moving light, not a pictogram (the pinned pass view
 *  keeps its marker image). Null outside a DOM (tests). */
export function glowDotImage(colorHex: string, size = 64): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) return null
  const centre = size / 2
  const glow = context.createRadialGradient(centre, centre, 0, centre, centre, centre)
  const color = Color.fromCssColorString(colorHex)
  const rgb = `${Math.round(color.red * 255)}, ${Math.round(color.green * 255)}, ${Math.round(color.blue * 255)}`
  glow.addColorStop(0, `rgba(${rgb}, 0.95)`)
  glow.addColorStop(0.22, `rgba(${rgb}, 0.55)`)
  glow.addColorStop(0.55, `rgba(${rgb}, 0.12)`)
  glow.addColorStop(1, `rgba(${rgb}, 0)`)
  context.fillStyle = glow
  context.fillRect(0, 0, size, size)
  context.fillStyle = 'rgba(255, 255, 255, 0.98)'
  context.beginPath()
  context.arc(centre, centre, size * 0.07, 0, Math.PI * 2)
  context.fill()
  return canvas
}

/** The glow breathes: scale over wall time, one cycle every 1.6 s, ±14 %. */
export const PULSE_PERIOD_MS = 1600
export function pulseScale(wallMs: number, base = 1): number {
  return base * (1 + 0.14 * Math.sin((wallMs / PULSE_PERIOD_MS) * Math.PI * 2))
}

/** Show or hide a pinned layer's own entities (spacecraft, sub-point, orbit). */
export function setLayerEntitiesShown(viewer: Viewer, layer: N2YOLayerState, shown: boolean): void {
  for (const id of [...layer.entityIds, orbitEntityIdForSatellite(layer.satelliteId)]) {
    const entity = viewer.entities.getById(id)
    if (entity) entity.show = shown
  }
}

/** Where a body's name sits relative to its mark, by the body's index: two
 *  closely-spaced objects (SIM-01 and OBJ-1, 23 km apart) would otherwise
 *  print one label over the other. Above, below, right, left, then repeat. */
export const LABEL_OFFSETS: readonly (readonly [number, number])[] = [
  [0, -26],
  [0, 26],
  [46, 0],
  [-46, 0],
]

export function labelOffsetFor(index: number): Cartesian2 {
  const [x, y] = LABEL_OFFSETS[index % LABEL_OFFSETS.length]!
  return new Cartesian2(x, y)
}

export function addFlightBody(viewer: Viewer, body: FlightBody, index = 0): void {
  removeFlightBody(viewer, body)
  const scratch: Subpoint = { lat: 0, lng: 0, altKm: 0 }
  const position = new CallbackPositionProperty((time, result) => {
    const at = time ?? viewer.clock.currentTime
    const sub = body.orbit.subpointAt(JulianDate.toDate(at).getTime(), scratch)
    return Cartesian3.fromDegrees(sub.lng, sub.lat, sub.altKm * 1000, undefined, result)
  }, false)
  const color = bodyColor()
  const name = body.layer.satelliteName
  viewer.entities.add({
    id: body.entityIds[0],
    name: `SIMULATED ${name} (flight)`,
    position,
    trackingReferenceFrame: TrackingReferenceFrame.ENU,
    billboard: {
      color: Color.WHITE,
      disableDepthTestDistance: 0,
      height: 36,
      image: glowDotImage(FAMILY_COLOR_HEX.SIM) ?? undefined,
      scale: new CallbackProperty(() => pulseScale(performance.now()), false),
      scaleByDistance: new NearFarScalar(1500000, 1, 25000000, 0.7),
      width: 36,
    },
    label: {
      backgroundColor: PANEL.withAlpha(0.9),
      disableDepthTestDistance: 0,
      fillColor: Color.WHITE,
      font: MAP_FONT,
      pixelOffset: labelOffsetFor(index),
      scaleByDistance: new NearFarScalar(1500000, 1, 25000000, 0.58),
      show: true,
      showBackground: true,
      style: LabelStyle.FILL,
      text: name,
    },
    path: {
      leadTime: 0,
      trailTime: TRAIL_S,
      resolution: 15,
      width: 2,
      material: color.withAlpha(0.55),
    },
    description: `${name}: synthetic spacecraft flying its circular orbit at true altitude (display only; not an ephemeris).`,
  })
  if (body.site) {
    const radiusM = footprintRadiusKm(body.orbit.elements.altitudeKm, body.maskDeg) * 1000
    viewer.entities.add({
      id: body.entityIds[2],
      name: `${name} visibility footprint at ${body.maskDeg}°`,
      position: Cartesian3.fromDegrees(body.site.lng, body.site.lat, 0),
      ellipse: {
        semiMajorAxis: radiusM,
        semiMinorAxis: radiusM,
        height: 0,
        material: color.withAlpha(0.04),
        outline: true,
        outlineColor: color.withAlpha(0.45),
      },
    })
  }
  addFlightRing(viewer, body)
}

/** The orbit ring: the inertial circle in the Earth-fixed frame at the
 *  clock's sidereal time, evaluated every frame from the time Cesium passes
 *  (a coarse timer made it jump 0.25° a second at 60×: the "ticking"). A
 *  solid line, since a dash pattern re-laid each frame shimmers. */
export function addFlightRing(viewer: Viewer, body: FlightBody): void {
  if (viewer.entities.getById(body.entityIds[1])) return
  const scratch: Cartesian3[] = []
  const positions = new CallbackProperty((time) => {
    const at = time ?? viewer.clock.currentTime
    const ring = body.orbit.ring(JulianDate.toDate(at).getTime(), RING_POINTS)
    scratch.length = ring.length
    ring.forEach((point, index) => {
      scratch[index] = Cartesian3.fromDegrees(point.lng, point.lat, point.altKm * 1000, undefined, scratch[index])
    })
    return scratch
  }, false)
  viewer.entities.add({
    id: body.entityIds[1],
    name: `${body.layer.satelliteName} orbit`,
    polyline: {
      arcType: ArcType.NONE,
      clampToGround: false,
      material: bodyColor().withAlpha(0.42),
      positions,
      width: 1.5,
    },
  })
}

/** The ring follows the clock by itself; this only makes sure it exists. */
export function updateFlightRing(viewer: Viewer, body: FlightBody): void {
  addFlightRing(viewer, body)
}

export function removeFlightBody(viewer: Viewer, body: FlightBody): void {
  body.entityIds.forEach((id) => viewer.entities.removeById(id))
}

export type FlightReadout = {
  elevationDeg: number
  azimuthDeg: number
  rangeKm: number
  visible: boolean
  /** When visible: the coming loss of signal at the mask. */
  losMs: number | null
  /** When not visible: the next acquisition within a day. */
  nextAosMs: number | null
}

/** Look angles from the body's site at a scenario time, and the edge of the
 *  current pass or the next one. Null for a body whose file names no site. */
export function flightReadout(body: FlightBody, unixMs: number): FlightReadout | null {
  if (!body.site) return null
  const scratch: Subpoint = { lat: 0, lng: 0, altKm: 0 }
  const now = lookAngles(body.orbit.subpointAt(unixMs, scratch), body.site)
  const visible = now.elevationDeg >= body.maskDeg
  let losMs: number | null = null
  let nextAosMs: number | null = null
  if (visible) {
    for (let t = unixMs + 1000; t <= unixMs + 1200_000; t += 1000) {
      if (lookAngles(body.orbit.subpointAt(t, scratch), body.site).elevationDeg < body.maskDeg) {
        losMs = t
        break
      }
    }
  } else {
    nextAosMs = nextAos(body.orbit, body.site, unixMs, body.maskDeg)
  }
  return { elevationDeg: now.elevationDeg, azimuthDeg: now.azimuthDeg, rangeKm: now.rangeKm, visible, losMs, nextAosMs }
}

/** The body's sub-satellite point at a scenario time (for the satellite card). */
export function flightSubpoint(body: FlightBody, unixMs: number): Subpoint {
  return body.orbit.subpointAt(unixMs)
}

export type EngineCheck = {
  /** The engine's sample time (scenario). */
  sampleMs: number
  /** Great-circle distance between the engine's sub-point and the console's at that time, km. */
  separationKm: number
}

/** Engine samples of the console's own model disagree only through a defect;
 *  beyond this the readout says so. */
export const ENGINE_DISAGREEMENT_KM = 1.0

/** How far the console's propagation sits from an engine sample of the same
 *  body at the sample's time. */
export function engineCheck(body: FlightBody, sample: { ts: string; lat: number; lng: number }): EngineCheck | null {
  const sampleMs = Date.parse(sample.ts)
  if (!Number.isFinite(sampleMs)) return null
  const ours = body.orbit.subpointAt(sampleMs)
  const toRad = Math.PI / 180
  const dLat = (sample.lat - ours.lat) * toRad
  const dLng = (sample.lng - ours.lng) * toRad
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(ours.lat * toRad) * Math.cos(sample.lat * toRad) * Math.sin(dLng / 2) ** 2
  const separationKm = 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)))
  return { sampleMs, separationKm }
}

/** The spacecraft body the Spacecraft page shows (public/models/PROVENANCE.md),
 *  drawn on the flying mark while it is the focus (a double-click, Follow). */
export const FLIGHT_MODEL_URI = '/models/gpm.glb'
/** Metres per model unit. The archive file's bounding sphere is 271 units
 *  (measured through Cesium); the spacecraft is about 13 m long, so this puts
 *  the body at its real size. The camera frames the bounding sphere, so the
 *  picture is the same at any scale; the number is for the truth of it. */
export const FLIGHT_MODEL_SCALE = 0.025

/** Put the 3D body on a flight entity and hide its glow dot: the entity is
 *  about to be tracked, so the camera frames the model in the spacecraft's
 *  own frame (Cesium waits for the model's bounding sphere before it frames).
 *  The body flies nose-first: orientation from the velocity. */
/** Where the camera sits in the spacecraft's frame while focused (metres:
 *  behind, beside and above a 13 m body), and the zoom floor that lets it. */
export const FLIGHT_MODEL_VIEW_FROM = new Cartesian3(-30, 18, 13)
export const FLIGHT_MODEL_MIN_ZOOM_M = 6
/** While the body is drawn its name is lifted this far above it in the eye's
 *  frame (metres up on screen at the body's depth), clear of a 13 m body;
 *  with the mark alone the pixel offset is enough. */
export const FLIGHT_MODEL_LABEL_LIFT_M = 7

export function focusFlightModel(viewer: Viewer, body: FlightBody): Entity | null {
  const entity = viewer.entities.getById(body.entityIds[0])
  if (!entity?.position) return null
  entity.viewFrom = new ConstantProperty(FLIGHT_MODEL_VIEW_FROM)
  if (!entity.model) {
    entity.orientation = new VelocityOrientationProperty(entity.position as PositionProperty)
    entity.model = new ModelGraphics({
      uri: FLIGHT_MODEL_URI,
      scale: FLIGHT_MODEL_SCALE,
      minimumPixelSize: 0,
      shadows: ShadowMode.DISABLED,
    })
  }
  if (entity.billboard) entity.billboard.show = new ConstantProperty(false)
  if (entity.label) entity.label.eyeOffset = new ConstantProperty(new Cartesian3(0, FLIGHT_MODEL_LABEL_LIFT_M, 0))
  return entity
}

/** Back to the mark: the model goes, the glow dot returns. */
export function unfocusFlightModel(viewer: Viewer, body: FlightBody): void {
  const entity = viewer.entities.getById(body.entityIds[0])
  if (!entity) return
  entity.model = undefined
  entity.orientation = undefined
  entity.viewFrom = undefined
  if (entity.billboard) entity.billboard.show = new ConstantProperty(true)
  if (entity.label) entity.label.eyeOffset = new ConstantProperty(Cartesian3.ZERO)
}
