import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import { forward as toMgrs } from 'mgrs'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { ScenarioDefinition } from '../data/scenarioLibrary'
import { commanderSignalSummary, signalKindLabel } from '../lib/commanderLanguage'
import { boundsForSignals, signalCoordinate } from '../lib/signalLocation'
import { groundStationsFromSignals } from '../lib/groundStations'
import { useCaptureStore } from '../store/captureStore'
import type { PlaybackStatus } from '../types/playback'
import type { Signal } from '../types/canopy'

type Basemap = 'imagery' | 'muted'
type AorMapProps = {
  correlatedSignalIds: string[]
  focusSignalId: string | null
  focusRequestId?: number
  offsets: number[]
  playback: PlaybackStatus | null
  scenario: ScenarioDefinition
  signals: Signal[]
}

const aorBounds = {
  west: -116.61,
  south: 34.98,
  east: -116.43,
  north: 35.08,
}
const initialAorViewBounds: [[number, number], [number, number]] = [
  [aorBounds.west - 0.18, aorBounds.south - 0.12],
  [aorBounds.east + 0.18, aorBounds.north + 0.12],
]
const INITIAL_AOR_ZOOM = 10.8

type AorBounds = typeof aorBounds
type SignalVisualCategory =
  | 'space'
  | 'ew'
  | 'gps'
  | 'cyber'
  | 'satcom'
  | 'drone'
  | 'terrain'
  | 'health'
  | 'weather'
  | 'intel'

type CoordinateSignal = { point: [number, number]; signal: Signal }
type PlaybackCoordinateSignal = CoordinateSignal & { offsetMs: number }

const categoryColors: Record<SignalVisualCategory, string> = {
  space: '#78c4ff',
  ew: '#e8b45a',
  gps: '#9fc6ff',
  cyber: '#b79cff',
  satcom: '#33f2f0',
  drone: '#a9c76a',
  terrain: '#b7a58a',
  health: '#f08cb0',
  weather: '#8fe3b5',
  intel: '#f5f7f0',
}

const categorySymbols: Record<SignalVisualCategory, string> = {
  space: '✦',
  ew: '⌁',
  gps: '⌖',
  cyber: '⌬',
  satcom: '⌐',
  drone: '△',
  terrain: '▰',
  health: '⌇',
  weather: '☼',
  intel: '◇',
}

const iconNameForCategory = (category: SignalVisualCategory) =>
  `mission-${category}`

const hexToRgba = (hex: string, alpha: number) => {
  const normalized = hex.replace('#', '')
  const red = Number.parseInt(normalized.slice(0, 2), 16)
  const green = Number.parseInt(normalized.slice(2, 4), 16)
  const blue = Number.parseInt(normalized.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

const createMissionIcon = (category: SignalVisualCategory, color: string) => {
  const canvas = document.createElement('canvas')
  const scale = window.devicePixelRatio || 1
  canvas.width = 36 * scale
  canvas.height = 36 * scale
  const context = canvas.getContext('2d')
  if (!context) {
    return {
      data: new Uint8Array(canvas.width * canvas.height * 4),
      height: canvas.height,
      width: canvas.width,
    }
  }

  context.scale(scale, scale)
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.lineWidth = 2
  context.strokeStyle = color
  context.fillStyle = hexToRgba(color, 0.36)
  context.shadowColor = 'rgba(0, 0, 0, 0.74)'
  context.shadowBlur = 4
  context.shadowOffsetY = 1

  const strokePath = (draw: () => void) => {
    context.beginPath()
    draw()
    context.stroke()
  }

  const drawPinFrame = () => {
    context.beginPath()
    context.moveTo(18, 4)
    context.bezierCurveTo(10, 4, 6, 10, 6, 16)
    context.bezierCurveTo(6, 24, 14, 27, 18, 32)
    context.bezierCurveTo(22, 27, 30, 24, 30, 16)
    context.bezierCurveTo(30, 10, 26, 4, 18, 4)
    context.closePath()
    context.fill()
    context.stroke()
  }

  context.save()
  drawPinFrame()
  context.shadowColor = 'transparent'
  context.strokeStyle = '#f5f7f0'
  context.fillStyle = 'rgba(245, 247, 240, 0.08)'
  context.lineWidth = 1.8

  if (category === 'space') {
    strokePath(() => {
      context.rect(15, 14, 6, 6)
      context.rect(8, 15, 5, 4)
      context.rect(23, 15, 5, 4)
      context.moveTo(18, 14)
      context.lineTo(18, 10)
      context.moveTo(18, 20)
      context.lineTo(18, 24)
    })
  } else if (category === 'drone') {
    strokePath(() => {
      context.moveTo(18, 5)
      context.lineTo(26, 24)
      context.lineTo(18, 20)
      context.lineTo(10, 24)
      context.closePath()
      context.moveTo(18, 10)
      context.lineTo(18, 20)
      context.moveTo(14, 19)
      context.lineTo(22, 19)
    })
  } else if (category === 'gps') {
    strokePath(() => {
      context.arc(18, 16, 6, 0, Math.PI * 2)
      context.moveTo(18, 7)
      context.lineTo(18, 11)
      context.moveTo(18, 21)
      context.lineTo(18, 25)
      context.moveTo(9, 16)
      context.lineTo(13, 16)
      context.moveTo(23, 16)
      context.lineTo(27, 16)
    })
  } else if (category === 'ew') {
    strokePath(() => {
      context.moveTo(10, 23)
      context.lineTo(25, 9)
      context.moveTo(12, 22)
      context.quadraticCurveTo(17, 15, 25, 14)
      context.moveTo(16, 24)
      context.quadraticCurveTo(20, 20, 26, 19)
    })
  } else if (category === 'cyber') {
    strokePath(() => {
      context.rect(13, 11, 10, 10)
      context.moveTo(18, 11)
      context.lineTo(18, 7)
      context.moveTo(18, 21)
      context.lineTo(18, 25)
      context.moveTo(13, 16)
      context.lineTo(9, 16)
      context.moveTo(23, 16)
      context.lineTo(27, 16)
      context.moveTo(15, 13)
      context.lineTo(21, 19)
    })
  } else if (category === 'satcom') {
    strokePath(() => {
      context.moveTo(10, 23)
      context.quadraticCurveTo(19, 21, 24, 9)
      context.moveTo(13, 25)
      context.quadraticCurveTo(20, 26, 26, 20)
      context.moveTo(24, 9)
      context.lineTo(28, 7)
      context.moveTo(24, 9)
      context.lineTo(23, 5)
    })
  } else if (category === 'terrain') {
    strokePath(() => {
      context.moveTo(8, 23)
      context.lineTo(14, 11)
      context.lineTo(18, 18)
      context.lineTo(22, 13)
      context.lineTo(28, 23)
      context.closePath()
    })
  } else if (category === 'health') {
    // Telemetry pulse trace: flat, spike, flat.
    strokePath(() => {
      context.moveTo(8, 17)
      context.lineTo(13, 17)
      context.lineTo(15, 11)
      context.lineTo(19, 23)
      context.lineTo(21, 17)
      context.lineTo(28, 17)
    })
  } else if (category === 'weather') {
    // Sun disc with four rays.
    strokePath(() => {
      context.arc(18, 16, 4.5, 0, Math.PI * 2)
      context.moveTo(18, 6)
      context.lineTo(18, 9)
      context.moveTo(18, 23)
      context.lineTo(18, 26)
      context.moveTo(8, 16)
      context.lineTo(11, 16)
      context.moveTo(25, 16)
      context.lineTo(28, 16)
    })
  } else {
    context.strokeStyle = '#f5f7f0'
    strokePath(() => {
      context.moveTo(18, 8)
      context.lineTo(26, 16)
      context.lineTo(18, 24)
      context.lineTo(10, 16)
      context.closePath()
      context.moveTo(14, 16)
      context.lineTo(22, 16)
      context.moveTo(18, 12)
      context.lineTo(18, 20)
    })
  }
  context.restore()

  return context.getImageData(0, 0, canvas.width, canvas.height)
}

const formatMgrs = ([lon, lat]: [number, number]) => {
  if (
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    lat < -80 ||
    lat > 84
  ) {
    const latLabel = `${Math.abs(lat).toFixed(2)}${lat >= 0 ? 'N' : 'S'}`
    const lonLabel = `${Math.abs(lon).toFixed(2)}${lon >= 0 ? 'E' : 'W'}`
    return `${latLabel} ${lonLabel}`
  }

  return toMgrs([lon, lat], 4).replace(
    /^(\d{1,2}[A-Z])([A-Z]{2})(\d{4})(\d{4})$/,
    '$1 $2 $3 $4',
  )
}

// Friendly / asset / threat contacts pinned in the AOR overlay. Used to
// build the `aor-contacts` MapLibre source layer below — the satellite
// view merge dropped this constant; restored here so the source layer
// has data to render.
const aorContacts: Array<{
  id: string
  label: string
  symbol: string
  type: 'friendly' | 'asset' | 'threat'
  coordinate: [number, number]
}> = [
  {
    id: 'relay-team-2',
    label: 'RELAY TEAM 2',
    symbol: 'RLY',
    type: 'friendly',
    coordinate: [-116.52, 35.02],
  },
  {
    id: 'blos-relay-west',
    label: 'BLOS RELAY WEST',
    symbol: 'BLOS',
    type: 'asset',
    coordinate: [-116.547, 35.039],
  },
  {
    id: 'rf-hit-11',
    label: 'RF HIT 11',
    symbol: 'EW',
    type: 'threat',
    coordinate: [-116.485, 35.012],
  },
]

const labelForSignal = (signal: Signal) =>
  commanderSignalSummary(signal).location

const mapLabelForSignal = (signal: Signal) => {
  switch (signal.payload.event_type) {
  case 'approach_masking_check':
    return 'Masked UAS lane'
  case 'overhead_ir_cue':
    return 'Overhead warning'
  case 'uas_control_link_detected':
    return 'UAS control signal'
  case 'track_handoff_success':
    return 'UAS track handoff'
  case 'gps_spoof':
  case 'pnt_spoofing':
    return 'GPS bias'
  case 'rf_interference':
  case 'ew_bearing_refined':
  case 'rf_bearing_crosscheck':
    return 'EW interference'
  case 'satcom_degradation':
  case 'satcom_link_margin_drop':
  case 'satcom_queue_pressure':
    return 'SATCOM degraded'
  case 'rpo_close_approach':
  case 'proximity_operations':
    return 'LEO close approach'
  case 'screening_overlay':
    return 'Space object watch'
  case 'overhead_collection_window':
  case 'collection_cue':
  case 'sda_catalog_match':
    return 'Collection risk'
  case 'orbital_setup':
    return 'Satellite pass'
  case 'custody_quality_change':
  case 'custody_update':
    return 'Space custody'
  case 'terrain_masking_risk':
  case 'line_of_sight_forecast':
    return 'Relay masking risk'
  default:
    return signalKindLabel(signal)
  }
}

const mapMetaForSignal = (signal: Signal) => {
  const location = labelForSignal(signal)
  const confidence = `${Math.round(signal.confidence * 100)}%`
  return location ? `${location} / ${confidence}` : confidence
}

const priorityForSignal = (signal: Signal) => {
  if (signal.confidence >= 0.86) {
    return 'high'
  }
  if (signal.confidence >= 0.74) {
    return 'watch'
  }
  return 'low'
}

const signalTimeMs = (signal: Signal | undefined) => {
  const time = Date.parse(signal?.ts ?? '')
  return Number.isFinite(time) ? time : null
}

const centerFromBounds = (bounds: AorBounds): [number, number] => [
  (bounds.west + bounds.east) / 2,
  (bounds.south + bounds.north) / 2,
]

const createAorPolygon = (bounds: AorBounds) =>
  ({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [bounds.west, bounds.south],
              [bounds.east, bounds.south],
              [bounds.east, bounds.north],
              [bounds.west, bounds.north],
              [bounds.west, bounds.south],
            ],
          ],
        },
      },
    ],
  }) as GeoJSON.FeatureCollection

const numberObservable = (signal: Signal, key: string) => {
  const value = signal.payload.observables?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const stringObservable = (signal: Signal, key: string) => {
  const value = signal.payload.observables?.[key]
  return typeof value === 'string' ? value : null
}

const movementVectorForSignal = (signal: Signal) => {
  const value = signal.payload.observables?.movement_vector
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const vector = value as Record<string, unknown>
  const bearing = vector.bearing_deg
  const speed = vector.speed_mps
  if (
    typeof bearing !== 'number' ||
    typeof speed !== 'number' ||
    !Number.isFinite(bearing) ||
    !Number.isFinite(speed)
  ) {
    return null
  }

  return { bearingDeg: bearing, speedMps: speed }
}

const visualCategoryForSignal = (signal: Signal): SignalVisualCategory => {
  const configured = stringObservable(signal, 'visual_category')
  if (
    configured === 'space' ||
    configured === 'ew' ||
    configured === 'gps' ||
    configured === 'cyber' ||
    configured === 'satcom' ||
    configured === 'drone' ||
    configured === 'terrain' ||
    configured === 'health' ||
    configured === 'weather' ||
    configured === 'intel'
  ) {
    return configured
  }

  if (signal.domain === 'orbit' || signal.domain === 'sda') {
    return 'space'
  }
  if (signal.domain === 'rf_ew') {
    return 'ew'
  }
  if (signal.domain === 'pnt') {
    return 'gps'
  }
  if (signal.domain === 'satcom') {
    return 'satcom'
  }
  if (signal.domain === 'cyber') {
    return 'cyber'
  }
  if (signal.domain === 'drone') {
    return 'drone'
  }
  if (signal.domain === 'terrain') {
    return 'terrain'
  }
  if (signal.domain === 'bus_health') {
    return 'health'
  }
  if (signal.domain === 'space_weather') {
    return 'weather'
  }
  return 'intel'
}

const visualColorForSignal = (signal: Signal) =>
  categoryColors[visualCategoryForSignal(signal)]

const visualSymbolForSignal = (signal: Signal) =>
  categorySymbols[visualCategoryForSignal(signal)]

const destinationPoint = (
  [lon, lat]: [number, number],
  bearingDegrees: number,
  meters: number,
): [number, number] => {
  const radius = 6378137
  const bearing = (bearingDegrees * Math.PI) / 180
  const distance = meters / radius
  const lat1 = (lat * Math.PI) / 180
  const lon1 = (lon * Math.PI) / 180
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(distance) +
      Math.cos(lat1) * Math.sin(distance) * Math.cos(bearing),
  )
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(distance) * Math.cos(lat1),
      Math.cos(distance) - Math.sin(lat1) * Math.sin(lat2),
    )

  return [
    Number(((lon2 * 180) / Math.PI).toFixed(5)),
    Number(((lat2 * 180) / Math.PI).toFixed(5)),
  ]
}

const createCirclePolygon = (
  center: [number, number],
  radiusMeters: number,
  steps = 40,
) => {
  const coordinates: [number, number][] = []
  for (let index = 0; index <= steps; index += 1) {
    coordinates.push(destinationPoint(center, (360 / steps) * index, radiusMeters))
  }
  return coordinates
}

const createBearingCone = (
  center: [number, number],
  bearingDegrees: number,
  radiusMeters: number,
) => {
  const spread = 22
  return [
    center,
    destinationPoint(center, bearingDegrees - spread, radiusMeters),
    destinationPoint(center, bearingDegrees, radiusMeters * 1.16),
    destinationPoint(center, bearingDegrees + spread, radiusMeters),
    center,
  ]
}

const createSignalZones = (entries: CoordinateSignal[]) =>
  ({
    type: 'FeatureCollection',
    features: entries.flatMap(({ point, signal }) => {
      const category = visualCategoryForSignal(signal)
      const radius = numberObservable(signal, 'radius_m')
      const bearing = numberObservable(signal, 'bearing_deg')
      const zoneShape = stringObservable(signal, 'zone_shape')
      const shouldDrawZone =
        Boolean(radius) &&
        (category === 'space' ||
          category === 'ew' ||
          category === 'gps' ||
          category === 'satcom' ||
          category === 'terrain' ||
          Boolean(zoneShape))

      if (!shouldDrawZone || !radius) {
        return []
      }

      const coordinates =
        category === 'ew' && bearing !== null
          ? createBearingCone(point, bearing, radius)
          : createCirclePolygon(point, radius)

      return [
        {
          type: 'Feature',
          properties: {
            color: visualColorForSignal(signal),
            category,
            priority: priorityForSignal(signal),
          },
          geometry: {
            type: 'Polygon',
            coordinates: [coordinates],
          },
        } as GeoJSON.Feature,
      ]
    }),
  }) as GeoJSON.FeatureCollection

const trackIdForSignal = (signal: Signal) =>
  stringObservable(signal, 'track_id') ??
  stringObservable(signal, 'route_id') ??
  (signal.domain === 'drone' ? signal.payload.asset : null)

const interpolatePoint = (
  from: [number, number],
  to: [number, number],
  progress: number,
): [number, number] => [
  from[0] + (to[0] - from[0]) * progress,
  from[1] + (to[1] - from[1]) * progress,
]

const bearingBetweenPoints = (from: [number, number], to: [number, number]) =>
  (Math.atan2(to[0] - from[0], to[1] - from[1]) * 180) / Math.PI

const featureForSignalHead = (
  signal: Signal,
  point: [number, number],
  focusSignalId: string | null,
  correlatedSignalIds: string[],
): GeoJSON.Feature => ({
  type: 'Feature',
  properties: {
    id: signal.id,
    label: mapLabelForSignal(signal),
    meta: mapMetaForSignal(signal),
    color: visualColorForSignal(signal),
    symbol: visualSymbolForSignal(signal),
    category: visualCategoryForSignal(signal),
    icon: iconNameForCategory(visualCategoryForSignal(signal)),
    priority: priorityForSignal(signal),
    focus: signal.id === focusSignalId,
    correlated: correlatedSignalIds.includes(signal.id),
  },
  geometry: {
    type: 'Point',
    coordinates: point,
  },
})

const createSignalTracks = (
  entries: PlaybackCoordinateSignal[],
  elapsedMs: number,
  focusSignalId: string | null,
  correlatedSignalIds: string[],
) => {
  const tracks = new Map<string, PlaybackCoordinateSignal[]>()

  entries.forEach((entry) => {
    const trackId = trackIdForSignal(entry.signal)
    if (!trackId) {
      return
    }

    tracks.set(trackId, [...(tracks.get(trackId) ?? []), entry])
  })

  const lineFeatures: GeoJSON.Feature[] = []
  const arrowFeatures: GeoJSON.Feature[] = []
  const headFeatures: GeoJSON.Feature[] = []
  const activeTrackIds = new Set<string>()

  tracks.forEach((trackEntries, trackId) => {
    const ordered = [...trackEntries].sort(
      (a, b) => a.offsetMs - b.offsetMs,
    )
    if (!ordered.length || elapsedMs < ordered[0].offsetMs) {
      return
    }

    const completed = ordered.filter((entry) => entry.offsetMs <= elapsedMs)
    const previousEntry = completed[completed.length - 1] ?? ordered[0]
    const nextEntry =
      ordered.find((entry) => entry.offsetMs > elapsedMs) ?? previousEntry
    const spanMs = Math.max(nextEntry.offsetMs - previousEntry.offsetMs, 1)
    const progress =
      nextEntry === previousEntry
        ? 1
        : Math.min(1, Math.max(0, (elapsedMs - previousEntry.offsetMs) / spanMs))
    let headPoint = interpolatePoint(
      previousEntry.point,
      nextEntry.point,
      progress,
    )
    let points = [...completed.map((entry) => entry.point)]
    const headSignal = previousEntry.signal
    let bearing =
      points.length > 0
        ? bearingBetweenPoints(points[points.length - 1], headPoint)
        : 0

    if (ordered.length === 1) {
      const vector = movementVectorForSignal(previousEntry.signal)
      if (!vector) {
        return
      }

      const travelSeconds = Math.min(240, Math.max(60, 2400 / vector.speedMps))
      const startOffsetMs = Math.max(
        0,
        previousEntry.offsetMs - travelSeconds * 1000,
      )
      const vectorProgress = Math.min(
        1,
        Math.max(
          0,
          (elapsedMs - startOffsetMs) /
            Math.max(previousEntry.offsetMs - startOffsetMs, 1),
        ),
      )
      const startPoint = destinationPoint(
        previousEntry.point,
        vector.bearingDeg + 180,
        vector.speedMps * travelSeconds,
      )
      headPoint = interpolatePoint(startPoint, previousEntry.point, vectorProgress)
      points = [startPoint, headPoint]
      bearing = vector.bearingDeg
    } else if (nextEntry !== previousEntry) {
      points = [...points, headPoint]
    }

    if (points.length < 2) {
      return
    }

    activeTrackIds.add(trackId)
    const color = visualColorForSignal(headSignal)

    lineFeatures.push({
      type: 'Feature',
      properties: { trackId, color },
      geometry: {
        type: 'LineString',
        coordinates: points,
      },
    })
    arrowFeatures.push({
      type: 'Feature',
      properties: {
        trackId,
        color,
        bearing,
      },
      geometry: {
        type: 'Point',
        coordinates: headPoint,
      },
    })
    headFeatures.push(
      featureForSignalHead(
        headSignal,
        headPoint,
        focusSignalId,
        correlatedSignalIds,
      ),
    )
  })

  return {
    activeTrackIds,
    heads: {
      type: 'FeatureCollection',
      features: headFeatures,
    } as GeoJSON.FeatureCollection,
    lines: {
      type: 'FeatureCollection',
      features: lineFeatures,
    } as GeoJSON.FeatureCollection,
    arrows: {
      type: 'FeatureCollection',
      features: arrowFeatures,
    } as GeoJSON.FeatureCollection,
  }
}

const createGrid = (bounds: AorBounds) => {
  const features: GeoJSON.Feature[] = []
  const step = 0.01

  for (
    let lon = Math.ceil(bounds.west / step) * step;
    lon <= bounds.east;
    lon += step
  ) {
    features.push({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: [
          [Number(lon.toFixed(5)), bounds.south],
          [Number(lon.toFixed(5)), bounds.north],
        ],
      },
    })
  }

  for (
    let lat = Math.ceil(bounds.south / step) * step;
    lat <= bounds.north;
    lat += step
  ) {
    features.push({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: [
          [bounds.west, Number(lat.toFixed(5))],
          [bounds.east, Number(lat.toFixed(5))],
        ],
      },
    })
  }

  return {
    type: 'FeatureCollection',
    features,
  } as GeoJSON.FeatureCollection
}

export function AorMap({
  correlatedSignalIds,
  focusSignalId,
  focusRequestId = 0,
  offsets,
  playback,
  scenario,
  signals,
}: AorMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const handledFocusRequestRef = useRef(0)
  const [isMapReady, setIsMapReady] = useState(false)
  const [basemap, setBasemap] = useState<Basemap>('imagery')
  const [zoomLevel, setZoomLevel] = useState(INITIAL_AOR_ZOOM)
  const capture = useCaptureStore((s) => s.enabled)
  const stationFeatures = useMemo(
    () =>
      ({
        type: 'FeatureCollection',
        features: groundStationsFromSignals(signals).map((station) => ({
          type: 'Feature',
          properties: {
            id: station.id,
            label: station.label.toUpperCase(),
            grid: formatMgrs([station.lng, station.lat]),
          },
          geometry: { type: 'Point', coordinates: [station.lng, station.lat] },
        })),
      }) as GeoJSON.FeatureCollection,
    [signals],
  )

  const coordinateSignals = useMemo(
    () =>
      signals
        .map((signal) => ({ point: signalCoordinate(signal), signal }))
        .filter(
          (entry): entry is CoordinateSignal => entry.point !== null,
        ),
    [signals],
  )
  const scenarioBounds = useMemo(
    () => boundsForSignals(scenario.signals, aorBounds),
    [scenario.signals],
  )
  const scenarioCoordinateSignals = useMemo(
    () =>
      scenario.signals
        .map((signal, index) => ({
          point: signalCoordinate(signal),
          signal,
          offsetMs: offsets[index] ?? 0,
        }))
        .filter(
          (entry): entry is PlaybackCoordinateSignal => entry.point !== null,
        ),
    [offsets, scenario.signals],
  )
  const elapsedMs = playback?.elapsedMs ?? Number.MAX_SAFE_INTEGER
  const signalTracks = useMemo(
    () =>
      createSignalTracks(
        scenarioCoordinateSignals,
        elapsedMs,
        focusSignalId,
        correlatedSignalIds,
      ),
    [correlatedSignalIds, elapsedMs, focusSignalId, scenarioCoordinateSignals],
  )
  const contactDisplayLimit = zoomLevel >= 12.2 ? 8 : zoomLevel >= 10.4 ? 4 : 2
  const visibleSignals = useMemo(
    () =>
      [...coordinateSignals]
        .filter(({ signal }) => {
          const trackId = trackIdForSignal(signal)
          return !trackId || !signalTracks.activeTrackIds.has(trackId)
        })
        .sort((a, b) => {
          const focusScore = (signal: Signal) =>
            signal.id === focusSignalId ? 1 : 0
          const correlatedScore = (signal: Signal) =>
            correlatedSignalIds.includes(signal.id) ? 1 : 0

          return (
            focusScore(b.signal) - focusScore(a.signal) ||
            correlatedScore(b.signal) - correlatedScore(a.signal) ||
            (signalTimeMs(b.signal) ?? 0) - (signalTimeMs(a.signal) ?? 0) ||
            b.signal.confidence - a.signal.confidence
          )
        })
        .slice(0, contactDisplayLimit),
    [
      contactDisplayLimit,
      coordinateSignals,
      correlatedSignalIds,
      focusSignalId,
      signalTracks.activeTrackIds,
    ],
  )
  const mapDensity =
    zoomLevel >= 12.2 ? 'detail' : zoomLevel >= 10.4 ? 'contact' : 'wide'

  const signalFeatures = useMemo(
    () =>
      ({
        type: 'FeatureCollection',
        features: [
          ...signalTracks.heads.features,
          ...visibleSignals.map(({ point, signal }) =>
            featureForSignalHead(signal, point, focusSignalId, correlatedSignalIds),
          ),
        ],
      }) as GeoJSON.FeatureCollection,
    [correlatedSignalIds, focusSignalId, signalTracks.heads, visibleSignals],
  )
  const signalZones = useMemo(
    () => createSignalZones(visibleSignals),
    [visibleSignals],
  )

  useEffect(() => {
    if (!containerRef.current) {
      return
    }

    const map = new maplibregl.Map({
      attributionControl: false,
      center: centerFromBounds(aorBounds),
      container: containerRef.current,
      maxZoom: 19,
      minZoom: 5,
      pitch: 0,
      style: {
        version: 8,
        sources: {
          esriWorldImagery: {
            type: 'raster',
            tiles: [
              'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            ],
            tileSize: 256,
            maxzoom: 19,
            attribution:
              'Sources: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
          },
        },
        layers: [
          {
            id: 'imagery',
            type: 'raster',
            source: 'esriWorldImagery',
            paint: {
              'raster-brightness-max': 0.64,
              'raster-brightness-min': 0.03,
              'raster-contrast': 0.2,
              'raster-fade-duration': 0,
              'raster-saturation': -0.22,
            },
          },
          {
            id: 'muted',
            type: 'raster',
            source: 'esriWorldImagery',
            layout: {
              visibility: 'none',
            },
            paint: {
              'raster-brightness-max': 0.46,
              'raster-brightness-min': 0.02,
              'raster-contrast': 0.26,
              'raster-fade-duration': 0,
              'raster-saturation': -0.92,
            },
          },
        ],
      },
      zoom: INITIAL_AOR_ZOOM,
    })

    mapRef.current = map
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')
    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      'bottom-left',
    )

    map.on('load', () => {
      setIsMapReady(true)
      map.fitBounds(initialAorViewBounds, {
        duration: 0,
        padding: { bottom: 72, left: 48, right: 48, top: 42 },
      })
      setZoomLevel(map.getZoom())
      Object.entries(categoryColors).forEach(([category, color]) => {
        const iconName = iconNameForCategory(category as SignalVisualCategory)
        if (!map.hasImage(iconName)) {
          map.addImage(
            iconName,
            createMissionIcon(category as SignalVisualCategory, color),
            { pixelRatio: window.devicePixelRatio || 1 },
          )
        }
      })
      map.addSource('aor-zone', {
        type: 'geojson',
        data: createAorPolygon(aorBounds),
      })
      map.addLayer({
        id: 'aor-zone-fill',
        type: 'fill',
        source: 'aor-zone',
        paint: {
          'fill-color': '#c9a457',
          'fill-opacity': 0.012,
        },
      })
      map.addLayer({
        id: 'aor-zone-line',
        type: 'line',
        source: 'aor-zone',
        paint: {
          'line-color': '#c9a457',
          'line-opacity': 0.34,
          'line-width': 0.9,
        },
      })

      map.addSource('mgrs-grid', {
        type: 'geojson',
        data: createGrid(aorBounds),
      })
      map.addLayer({
        id: 'mgrs-grid-line',
        type: 'line',
        source: 'mgrs-grid',
        paint: {
          'line-color': '#f5f7f0',
          'line-opacity': 0.07,
          'line-width': 0.7,
        },
      })

      map.addSource('aor-contacts', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: aorContacts.map((contact) => ({
            type: 'Feature',
            properties: {
              label: contact.label,
              grid: formatMgrs(contact.coordinate),
              symbol: contact.symbol,
              type: contact.type,
            },
            geometry: {
              type: 'Point',
              coordinates: contact.coordinate,
            },
          })),
        } as GeoJSON.FeatureCollection,
      })
      map.addLayer({
        id: 'aor-contact-frame',
        type: 'circle',
        source: 'aor-contacts',
        paint: {
          'circle-color': '#020404',
          'circle-opacity': 0.78,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 6, 13, 9],
          'circle-stroke-color': [
            'match',
            ['get', 'type'],
            'friendly',
            '#9fc6ff',
            'asset',
            '#f5f7f0',
            'threat',
            '#ff8d7e',
            '#b8fbf7',
          ],
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, 1.2, 13, 1.8],
        },
      })
      map.addLayer({
        id: 'aor-contact-symbol',
        type: 'symbol',
        source: 'aor-contacts',
        layout: {
          'text-field': [
            'match',
            ['get', 'type'],
            'friendly',
            '▴',
            'asset',
            '□',
            'threat',
            '⌁',
            '◇',
          ],
          'text-font': ['Open Sans Semibold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 5, 9, 13, 12],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          'text-color': [
            'match',
            ['get', 'type'],
            'friendly',
            '#9fc6ff',
            'asset',
            '#f5f7f0',
            'threat',
            '#ff8d7e',
            '#b8fbf7',
          ],
          'text-halo-color': '#020404',
          'text-halo-width': 1.1,
        },
      })
      map.addLayer({
        id: 'aor-contact-label',
        type: 'symbol',
        source: 'aor-contacts',
        layout: {
          'text-field': ['concat', ['get', 'label'], '\n', ['get', 'grid']],
          'text-font': ['Open Sans Semibold'],
          'text-offset': [0, -1.6],
          'text-size': 11,
        },
        paint: {
          'text-color': '#f5f7f0',
          'text-halo-color': '#091112',
          'text-halo-width': 1.5,
        },
      })

      map.addSource('aor-signals', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addSource('aor-signal-zones', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: 'aor-signal-zone-fill',
        type: 'fill',
        source: 'aor-signal-zones',
        paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': [
            'match',
            ['get', 'priority'],
            'high',
            0.13,
            'watch',
            0.09,
            0.055,
          ],
        },
      })
      map.addLayer({
        id: 'aor-signal-zone-line',
        type: 'line',
        source: 'aor-signal-zones',
        paint: {
          'line-color': ['get', 'color'],
          'line-opacity': 0.55,
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.8, 13, 1.6],
          'line-dasharray': [2.6, 1.8],
        },
      })
      map.addSource('aor-signal-tracks', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: 'aor-signal-track-line',
        type: 'line',
        source: 'aor-signal-tracks',
        paint: {
          'line-color': ['get', 'color'],
          'line-opacity': 0.72,
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1, 13, 2.4],
          'line-dasharray': [1.2, 0.8],
        },
      })
      map.addSource('aor-signal-arrows', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: 'aor-signal-track-arrow',
        type: 'symbol',
        source: 'aor-signal-arrows',
        layout: {
          'text-field': '›',
          'text-font': ['Open Sans Semibold'],
          'text-rotate': ['get', 'bearing'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 5, 8, 13, 11],
        },
        paint: {
          'text-color': ['get', 'color'],
          'text-halo-color': '#020404',
          'text-halo-width': 0.8,
        },
      })
      map.addLayer({
        id: 'aor-signal-pulse',
        type: 'circle',
        source: 'aor-signals',
        paint: {
          'circle-color': ['get', 'color'],
          'circle-opacity': ['case', ['get', 'focus'], 0.045, ['get', 'correlated'], 0, 0],
          'circle-radius': ['case', ['get', 'focus'], 13, ['get', 'correlated'], 0, 0],
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-opacity': ['case', ['get', 'focus'], 0.32, ['get', 'correlated'], 0, 0],
          'circle-stroke-width': 1,
        },
      })
      map.addLayer({
        id: 'aor-signal-icon',
        type: 'symbol',
        source: 'aor-signals',
        layout: {
          'icon-image': ['get', 'icon'],
          'icon-size': ['case', ['get', 'focus'], 0.62, ['get', 'correlated'], 0.56, 0.5],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      })
      map.addLayer({
        id: 'aor-signal-label',
        type: 'symbol',
        source: 'aor-signals',
        layout: {
          'text-field': [
            'case',
            ['get', 'focus'],
            ['concat', ['get', 'label'], '\n', ['get', 'meta']],
            ['get', 'correlated'],
            ['get', 'label'],
            ['get', 'label'],
          ],
          'text-font': ['Open Sans Semibold'],
          'text-offset': [1.05, 0],
          'text-size': ['case', ['get', 'focus'], 10.5, 9.5],
          'text-anchor': 'left',
        },
        paint: {
          'text-color': '#f5f7f0',
          'text-halo-color': '#091112',
          'text-halo-width': 1.1,
        },
      })

      // Ground stations named by the stream (Site A). A square frame so the
      // site reads as infrastructure, not a report.
      map.addSource('aor-stations', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: 'aor-station-frame',
        type: 'circle',
        source: 'aor-stations',
        paint: {
          'circle-color': '#020404',
          'circle-opacity': 0.85,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 7, 13, 11],
          'circle-stroke-color': '#f2edd7',
          'circle-stroke-width': 1.6,
        },
      })
      map.addLayer({
        id: 'aor-station-symbol',
        type: 'symbol',
        source: 'aor-stations',
        layout: {
          'text-field': '⏚',
          'text-font': ['Open Sans Semibold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 5, 9, 13, 13],
          'text-allow-overlap': true,
        },
        paint: { 'text-color': '#f2edd7' },
      })
      map.addLayer({
        id: 'aor-station-label',
        type: 'symbol',
        source: 'aor-stations',
        layout: {
          'text-field': ['concat', ['get', 'label'], '\nground station'],
          'text-font': ['Open Sans Semibold'],
          'text-offset': [1.2, 0],
          'text-size': 10,
          'text-anchor': 'left',
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': '#f5f7f0',
          'text-halo-color': '#091112',
          'text-halo-width': 1.2,
        },
      })
    })

    map.on('zoom', () => {
      setZoomLevel(map.getZoom())
    })

    return () => {
      map.remove()
      mapRef.current = null
      setIsMapReady(false)
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !isMapReady) {
      return
    }

    const source = map.getSource('aor-signals') as
      | maplibregl.GeoJSONSource
      | undefined
    const zoneSource = map.getSource('aor-signal-zones') as
      | maplibregl.GeoJSONSource
      | undefined
    const trackSource = map.getSource('aor-signal-tracks') as
      | maplibregl.GeoJSONSource
      | undefined
    const arrowSource = map.getSource('aor-signal-arrows') as
      | maplibregl.GeoJSONSource
      | undefined
    const stationSource = map.getSource('aor-stations') as
      | maplibregl.GeoJSONSource
      | undefined
    if (source) {
      source.setData(signalFeatures)
    }
    zoneSource?.setData(signalZones)
    trackSource?.setData(signalTracks.lines)
    arrowSource?.setData(signalTracks.arrows)
    stationSource?.setData(stationFeatures)
  }, [isMapReady, signalFeatures, signalTracks, signalZones, stationFeatures])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !isMapReady) {
      return
    }

    const zoneSource = map.getSource('aor-zone') as
      | maplibregl.GeoJSONSource
      | undefined
    const gridSource = map.getSource('mgrs-grid') as
      | maplibregl.GeoJSONSource
      | undefined

    zoneSource?.setData(createAorPolygon(scenarioBounds))
    gridSource?.setData(createGrid(scenarioBounds))
    const { width, height } = map.getContainer().getBoundingClientRect()
    const isWide = width >= 1080 && height >= 560
    map.fitBounds(
      [
        [scenarioBounds.west, scenarioBounds.south],
        [scenarioBounds.east, scenarioBounds.north],
      ],
      {
        animate: true,
        duration: 900,
        maxZoom: 12,
        padding: isWide
          ? { top: 96, right: 420, bottom: 260, left: 360 }
          : { top: 72, right: 48, bottom: 96, left: 48 },
      },
    )
  }, [isMapReady, scenario.id, scenarioBounds])

  useEffect(() => {
    const map = mapRef.current
    const focusSignal = signals.find((signal) => signal.id === focusSignalId)
    const focusPoint = focusSignal ? signalCoordinate(focusSignal) : null
    if (
      !map ||
      !isMapReady ||
      !focusPoint ||
      focusRequestId === 0 ||
      handledFocusRequestRef.current === focusRequestId
    ) {
      return
    }

    handledFocusRequestRef.current = focusRequestId
    map.flyTo({
      center: focusPoint,
      duration: 650,
      essential: true,
      zoom: Math.max(map.getZoom(), 11.5),
    })
  }, [focusRequestId, focusSignalId, isMapReady, signals])

  const switchBasemap = (nextBasemap: Basemap) => {
    const map = mapRef.current
    if (!map) {
      return
    }

    map.setLayoutProperty(
      'imagery',
      'visibility',
      nextBasemap === 'imagery' ? 'visible' : 'none',
    )
    map.setLayoutProperty(
      'muted',
      'visibility',
      nextBasemap === 'muted' ? 'visible' : 'none',
    )
    setBasemap(nextBasemap)
  }

  return (
    <div className={`aor-map aor-map--${mapDensity}`} aria-label="AOR tactical map">
      <div className="aor-map__canvas" ref={containerRef} />
      {capture ? null : (
      <div className="aor-map__basemaps" aria-label="AOR basemap" data-capture-hide>
        <button
          className={basemap === 'imagery' ? 'is-active' : ''}
          onClick={() => switchBasemap('imagery')}
          type="button"
        >
          Imagery
        </button>
        <button
          className={basemap === 'muted' ? 'is-active' : ''}
          onClick={() => switchBasemap('muted')}
          type="button"
        >
          Muted
        </button>
      </div>
      )}
    </div>
  )
}
