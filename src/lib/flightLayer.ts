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
  Cartesian2,
  Cartesian3,
  Color,
  ConstantProperty,
  JulianDate,
  LabelStyle,
  NearFarScalar,
  PolylineDashMaterialProperty,
  TrackingReferenceFrame,
  type Viewer,
} from 'cesium'
import {
  FAMILY_COLOR_HEX,
  n2yoMarkerImage,
  orbitEntityIdForSatellite,
  type N2YOLayerState,
} from './n2yoSatelliteLayer'
import { CircularOrbit, elementsFromSynthetic, type Subpoint } from './orbit/kepler'
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

/** Show or hide a pinned layer's own entities (spacecraft, sub-point, orbit). */
export function setLayerEntitiesShown(viewer: Viewer, layer: N2YOLayerState, shown: boolean): void {
  for (const id of [...layer.entityIds, orbitEntityIdForSatellite(layer.satelliteId)]) {
    const entity = viewer.entities.getById(id)
    if (entity) entity.show = shown
  }
}

export function addFlightBody(viewer: Viewer, body: FlightBody): void {
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
      height: 74,
      image: n2yoMarkerImage(FAMILY_COLOR_HEX.SIM, 'SIM'),
      scaleByDistance: new NearFarScalar(1500000, 1, 25000000, 0.62),
      width: 82,
    },
    label: {
      backgroundColor: PANEL.withAlpha(0.9),
      disableDepthTestDistance: 0,
      fillColor: Color.WHITE,
      font: MAP_FONT,
      pixelOffset: new Cartesian2(0, -42),
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
  updateFlightRing(viewer, body, JulianDate.toDate(viewer.clock.currentTime).getTime())
}

/** The orbit ring at one moment: the inertial circle in the Earth-fixed frame
 *  at that sidereal time. Refreshed on a coarse timer, not per frame. */
export function updateFlightRing(viewer: Viewer, body: FlightBody, unixMs: number): void {
  const positions = body.orbit
    .ring(unixMs, RING_POINTS)
    .map((point) => Cartesian3.fromDegrees(point.lng, point.lat, point.altKm * 1000))
  const existing = viewer.entities.getById(body.entityIds[1])
  if (existing?.polyline) {
    existing.polyline.positions = new ConstantProperty(positions)
    return
  }
  viewer.entities.add({
    id: body.entityIds[1],
    name: `${body.layer.satelliteName} orbit`,
    polyline: {
      arcType: ArcType.NONE,
      clampToGround: false,
      material: new PolylineDashMaterialProperty({ color: bodyColor().withAlpha(0.8), dashLength: 18 }),
      positions,
      width: 2,
    },
  })
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
