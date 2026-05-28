import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  ArcGisMapServerImageryProvider,
  ArcType,
  BoundingSphere,
  CallbackPositionProperty,
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Color,
  ConstantProperty,
  createWorldImageryAsync,
  CzmlDataSource,
  HeadingPitchRange,
  Ion,
  ImageryLayer,
  IonWorldImageryStyle,
  LabelStyle,
  NearFarScalar,
  PolylineDashMaterialProperty,
  Rectangle,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  TileMapServiceImageryProvider,
  Viewer,
} from 'cesium'
import { forward as toMgrs, toPoint as mgrsToPoint } from 'mgrs'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import {
  addN2YOSatellite,
  clearN2YOSatelliteLayers,
  currentN2YODisplayPoint,
  deselectN2YOSatellite,
  fetchN2YOPositionCache,
  FAMILY_COLOR_HEX,
  FAMILY_SHORT_LABEL,
  getN2YOOrbitMotion,
  isN2YOGeostationaryFamily,
  latestN2YOAltitudeKm,
  N2YO_SATELLITES,
  n2yoCurrentOrbitalTheta,
  n2yoOrbitalPositionAtTheta,
  n2yoOrbitSamples,
  rotateN2YOOrbitTangent,
  selectN2YOSatellite,
  setN2YOSatelliteLayerVisible,
  setN2YOOrbitsVisible,
  type N2YOLayerState,
  type N2YODisplayPoint,
  type N2YOSatelliteFamily,
} from '../lib/n2yoSatelliteLayer'
import { commanderSignalSummary } from '../lib/commanderLanguage'
import { useEventStore } from '../store/eventStore'
import type { Signal } from '../types/canopy'

const token = import.meta.env.VITE_CESIUM_ION_TOKEN?.trim()
const MAP_FONT =
  '12px "Aptos Display", Aptos, "IBM Plex Sans Condensed", "IBM Plex Sans", "SF Pro Text", ui-sans-serif, system-ui, sans-serif'
const MAP_RED = Color.fromCssColorString('#e05c4f')
const MAP_AMBER = Color.fromCssColorString('#c9a457')
const MAP_CYAN = Color.fromCssColorString('#33f2f0')
const MAP_PANEL = Color.fromCssColorString('#091112')
const RESET_CAMERA_DESTINATION = Cartesian3.fromDegrees(0, 0, 22_000_000)

const markerSvg = (
  kind:
    | 'satellite'
    | 'drone'
    | 'signal'
    | 'ew'
    | 'gps'
    | 'cyber'
    | 'satcom'
    | 'terrain'
    | 'intel',
  stroke: string,
  fill = 'rgba(2,4,4,0.72)',
) => {
  const inner =
    kind === 'satellite'
      ? '<path d="M13 13h10v10H13z"/><path d="M5 16h6M25 16h6M5 20h6M25 20h6M18 7v4M18 25v4"/><circle cx="18" cy="18" r="2.4" fill="currentColor" stroke="none"/>'
      : kind === 'drone'
        ? '<path d="M18 6l10 20-10-5-10 5z"/><path d="M18 11v10M13 20h10"/><circle cx="18" cy="18" r="2.2" fill="currentColor" stroke="none"/>'
        : kind === 'ew'
          ? '<path d="M8 26l20-16"/><path d="M13 26c0-5 4-10 10-12M18 28c1-4 4-7 8-9"/><circle cx="9" cy="27" r="2.4" fill="currentColor" stroke="none"/>'
          : kind === 'gps'
            ? '<path d="M18 6l5 10-5 14-5-14z"/><path d="M11 15h14M13 23h10"/><circle cx="18" cy="18" r="2.2" fill="currentColor" stroke="none"/>'
            : kind === 'cyber'
              ? '<path d="M10 11h16v14H10z"/><path d="M14 11V7M22 11V7M14 25v4M22 25v4M6 16h4M6 21h4M26 16h4M26 21h4"/>'
              : kind === 'satcom'
                ? '<path d="M9 25c5-1 10-5 14-14"/><path d="M13 26c2 2 7 0 12-5"/><path d="M23 11l5-4M23 11l-2-6"/><circle cx="12" cy="24" r="2.3" fill="currentColor" stroke="none"/>'
                : kind === 'terrain'
                  ? '<path d="M5 25l7-11 5 7 4-5 10 9z"/><path d="M12 14l2 5M21 16l2 6"/>'
                  : kind === 'intel'
                    ? '<path d="M9 8h18v20H9z"/><path d="M13 14h10M13 19h10M13 24h6"/>'
        : '<path d="M18 7l11 11-11 11L7 18z"/><path d="M18 12v12M12 18h12"/><circle cx="18" cy="18" r="2.2" fill="currentColor" stroke="none"/>'

  return `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 36 36">
      <filter id="g" x="-60%" y="-60%" width="220%" height="220%">
        <feDropShadow dx="0" dy="1" stdDeviation="1.2" flood-color="#000000" flood-opacity="0.72"/>
      </filter>
      <g color="${stroke}" fill="${fill}" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" filter="url(#g)">
        ${inner}
      </g>
    </svg>`,
  )}`
}

const markerColorHex = (color: Color) => color.toCssHexString()

const markerKindForSignal = (signal: Signal) => {
  const configured = signal.payload.observables?.visual_category
  if (
    configured === 'ew' ||
    configured === 'gps' ||
    configured === 'cyber' ||
    configured === 'satcom' ||
    configured === 'drone' ||
    configured === 'terrain' ||
    configured === 'intel'
  ) {
    return configured
  }
  if (signal.domain === 'sda' || signal.domain === 'orbit') {
    return 'satellite'
  }
  if (signal.domain === 'rf_ew') {
    return 'ew'
  }
  if (signal.domain === 'pnt') {
    return 'gps'
  }
  if (signal.domain === 'cyber') {
    return 'cyber'
  }
  if (signal.domain === 'satcom') {
    return 'satcom'
  }
  if (signal.domain === 'drone') {
    return 'drone'
  }
  if (signal.domain === 'terrain') {
    return 'terrain'
  }
  return 'intel'
}

type CesiumGlobeProps = {
  correlatedSignalIds?: string[]
  displayMode?: 'nav' | 'globe'
  focusSignalId?: string | null
  signals?: Signal[]
}

type MapPoint = {
  lon: number
  lat: number
  height: number
  label: string
}

type SatelliteFamilyFilter = 'all' | N2YOSatelliteFamily
type SatelliteFamilySelection = 'all' | N2YOSatelliteFamily[]

const SATELLITE_FAMILY_FILTERS: SatelliteFamilyFilter[] = [
  'all',
  'AEHF',
  'MUOS',
  'WGS',
  'SBIRS',
  'GSSAP',
  'GPS-3',
  'CHINA',
  'RUSSIA',
]
const ALL_N2YO_FAMILIES = SATELLITE_FAMILY_FILTERS.filter(
  (familyFilter): familyFilter is N2YOSatelliteFamily => familyFilter !== 'all',
)
const MANEUVER_DEMO_FAMILIES: N2YOSatelliteFamily[] = ['GSSAP', 'CHINA', 'RUSSIA']
const N2YO_ALTITUDE_SCALE = 0.1

const isFamilyVisible = (
  selection: SatelliteFamilySelection,
  family: N2YOSatelliteFamily,
) => selection === 'all' || selection.includes(family)

const isFamilyControlActive = (
  selection: SatelliteFamilySelection,
  familyFilter: SatelliteFamilyFilter,
) =>
  familyFilter === 'all'
    ? selection === 'all'
    : selection !== 'all' && selection.includes(familyFilter)

const localAorBounds = {
  west: -116.61,
  south: 34.98,
  east: -116.43,
  north: 35.08,
}
const LOCAL_AOR_CAMERA_DESTINATION = Rectangle.fromDegrees(
  localAorBounds.west - 0.28,
  localAorBounds.south - 0.18,
  localAorBounds.east + 0.28,
  localAorBounds.north + 0.18,
)
const LOCAL_AOR_CAMERA_ORIENTATION = {
  heading: 0,
  pitch: -1.5,
  roll: 0,
}

const localContacts = [
  {
    name: 'RELAY TEAM 2',
    lon: -116.52,
    lat: 35.02,
    height: 1210,
    color: MAP_AMBER,
  },
  {
    name: 'BLOS RELAY WEST',
    lon: -116.547,
    lat: 35.039,
    height: 1225,
    color: MAP_CYAN,
  },
  {
    name: 'RF HIT 11',
    lon: -116.485,
    lat: 35.012,
    height: 1230,
    color: MAP_RED,
  },
]

const formatMgrs = (lon: number, lat: number) =>
  toMgrs([lon, lat], 4).replace(
    /^(\d{1,2}[A-Z])([A-Z]{2})(\d{4})(\d{4})$/,
    '$1 $2 $3 $4',
  )

const colorForSignal = (signal: Signal) => {
  if (signal.confidence >= 0.86) {
    return MAP_RED
  }
  if (signal.confidence >= 0.74) {
    return MAP_AMBER
  }
  return MAP_CYAN
}

const signalLabel = (signal: Signal) =>
  commanderSignalSummary(signal).location

const signalPoint = (signal: Signal): MapPoint | null => {
  let lon = signal.location.lng
  let lat = signal.location.lat

  if (
    (typeof lon !== 'number' || typeof lat !== 'number') &&
    signal.location.mgrs
  ) {
    try {
      const [mgrsLon, mgrsLat] = mgrsToPoint(signal.location.mgrs)
      lon = mgrsLon
      lat = mgrsLat
    } catch {
      return null
    }
  }

  if (typeof lon !== 'number' || typeof lat !== 'number') {
    return null
  }

  const height =
    signal.location.alt_m ??
    (signal.location.alt_km !== undefined
      ? signal.location.alt_km * 1000
      : signal.domain === 'orbit' || signal.domain === 'sda'
        ? 400000
        : 25)

  return {
    lon,
    lat,
    height,
    label: signalLabel(signal),
  }
}

const signalPolygon = (signal: Signal) => {
  const match = signal.location.area_wkt?.match(/POLYGON\s*\(\((.+)\)\)/i)
  if (!match) {
    return null
  }

  const coords = match[1]
    .split(',')
    .flatMap((pair) => {
      const [lon, lat] = pair.trim().split(/\s+/).map(Number)
      return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : []
    })

  return coords.length >= 6 ? coords : null
}

const addMinutes = (date: Date, minutes: number) =>
  new Date(date.getTime() + minutes * 60000).toISOString()

const createVehicleCzml = () => {
  const start = new Date()
  const stop = addMinutes(start, 8)
  const epoch = start.toISOString()
  const interval = `${epoch}/${stop}`

  return [
    {
      id: 'document',
      name: 'CANOPY Vehicle Track',
      version: '1.0',
      clock: {
        interval,
        currentTime: epoch,
        multiplier: 4,
        range: 'LOOP_STOP',
        step: 'SYSTEM_CLOCK_MULTIPLIER',
      },
    },
    {
      id: 'Vehicle/Relay-Team-2',
      availability: interval,
      name: 'Relay-Team-2',
      position: {
        epoch,
        interpolationAlgorithm: 'LINEAR',
        cartographicDegrees: [
          0, -116.57, 35.0, 1200, 90, -116.55, 35.015, 1225, 180,
          -116.52, 35.02, 1210, 270, -116.49, 35.035, 1235, 380,
          -116.46, 35.05, 1240,
        ],
      },
      billboard: {
        height: 20,
        image: markerSvg('drone', '#c9a457'),
        scale: 1,
        width: 20,
      },
      label: {
        text: 'RELAY TEAM 2',
        font: MAP_FONT,
        fillColor: { rgba: [255, 255, 255, 255] },
        show: false,
        showBackground: true,
        backgroundColor: { rgba: [9, 17, 18, 220] },
        pixelOffset: { cartesian2: [0, -26] },
      },
    },
  ]
}

export function CesiumGlobe({
  correlatedSignalIds = [],
  displayMode = 'nav',
  focusSignalId = null,
  signals = [],
}: CesiumGlobeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const creditRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<Viewer | null>(null)
  const signalEntityIdsRef = useRef<Set<string>>(new Set())
  const n2yoLayersRef = useRef<N2YOLayerState[]>([])
  const loadedN2yoSatelliteIdsRef = useRef<Set<number>>(new Set())
  const selectedN2yoLayerRef = useRef<N2YOLayerState | null>(null)
  const [activeLayer, setActiveLayer] = useState('baseline')
  const [imageryMode, setImageryMode] = useState('Loading imagery')
  const [realSatelliteStatus, setRealSatelliteStatus] = useState('Satellites')
  const [satelliteFamilySelection, setSatelliteFamilySelection] =
    useState<SatelliteFamilySelection>([])
  const [selectedSatellite, setSelectedSatellite] = useState<N2YOLayerState | null>(null)
  const [selectedSatellitePoint, setSelectedSatellitePoint] =
    useState<N2YODisplayPoint | null>(null)
  const [showAllOrbits, setShowAllOrbits] = useState(false)
  const [n2yoLayerCount, setN2yoLayerCount] = useState(0)
  const [orbitCapableLayerCount, setOrbitCapableLayerCount] = useState(0)
  const showAllOrbitsRef = useRef(false)
  const satelliteFamilySelectionRef = useRef<SatelliteFamilySelection>([])
  const maneuverDemo = useEventStore((s) => s.maneuverDemo)
  const endManeuverDemo = useEventStore((s) => s.endManeuverDemo)
  const [maneuverProgress, setManeuverProgress] = useState(0)
  const [maneuverPair, setManeuverPair] = useState<{
    friendly: string
    hostile: string
  } | null>(null)

  useEffect(() => {
    showAllOrbitsRef.current = showAllOrbits
  }, [showAllOrbits])

  useEffect(() => {
    satelliteFamilySelectionRef.current = satelliteFamilySelection
  }, [satelliteFamilySelection])

  useEffect(() => {
    if (!selectedSatellite) {
      return
    }

    const updateSelectedSatellitePoint = () => {
      setSelectedSatellitePoint(currentN2YODisplayPoint(selectedSatellite))
    }

    updateSelectedSatellitePoint()
    const interval = window.setInterval(updateSelectedSatellitePoint, 500)
    return () => window.clearInterval(interval)
  }, [selectedSatellite])

  useEffect(() => {
    if (!containerRef.current || !creditRef.current) {
      return
    }

    if (token) {
      Ion.defaultAccessToken = token
    }

    let isDisposed = false
    const viewer = new Viewer(containerRef.current, {
      animation: false,
      baseLayer: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      navigationHelpButton: false,
      scene3DOnly: true,
      sceneModePicker: false,
      selectionIndicator: false,
      shouldAnimate: true,
      skyBox: false,
      timeline: false,
      useBrowserRecommendedResolution: false,
      creditContainer: creditRef.current,
    })
    viewerRef.current = viewer

    viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 2)
    viewer.scene.backgroundColor = Color.fromCssColorString('#07100f')
    viewer.scene.globe.baseColor = Color.fromCssColorString('#0c1514')
    viewer.scene.globe.enableLighting = false
    viewer.scene.globe.maximumScreenSpaceError = 1
    viewer.scene.globe.showGroundAtmosphere = true
    viewer.scene.screenSpaceCameraController.minimumZoomDistance = 250
    viewer.scene.screenSpaceCameraController.maximumZoomDistance = 42000000

    const flyToCenteredEarth = (duration = 0.45) => {
      viewer.camera.flyTo({
        destination: RESET_CAMERA_DESTINATION,
        duration,
      })
    }

    const clickHandler = new ScreenSpaceEventHandler(viewer.scene.canvas)
    clickHandler.setInputAction((event: ScreenSpaceEventHandler.PositionedEvent) => {
      const picked = viewer.scene.pick(event.position)
      const pickedId = typeof picked?.id?.id === 'string' ? picked.id.id : null
      if (!pickedId?.startsWith('n2yo-') || !pickedId.endsWith('-satellite')) {
        if (selectedN2yoLayerRef.current) {
          deselectN2YOSatellite(viewer, selectedN2yoLayerRef.current)
          setN2YOOrbitsVisible(viewer, n2yoLayersRef.current, false)
          showAllOrbitsRef.current = false
          setShowAllOrbits(false)
          selectedN2yoLayerRef.current = null
          setSelectedSatellite(null)
          flyToCenteredEarth()
          viewer.scene.requestRender()
        }
        return
      }

      const layer = n2yoLayersRef.current.find((candidate) =>
        candidate.entityIds.includes(pickedId),
      )
      if (!layer) {
        return
      }

      if (showAllOrbitsRef.current) {
        setN2YOOrbitsVisible(viewer, n2yoLayersRef.current, false)
        showAllOrbitsRef.current = false
        setShowAllOrbits(false)
      }

      if (selectedN2yoLayerRef.current) {
        deselectN2YOSatellite(viewer, selectedN2yoLayerRef.current)
      }
      selectedN2yoLayerRef.current = layer
      selectN2YOSatellite(viewer, layer)
      setSelectedSatellite(layer)
      viewer.scene.requestRender()
    }, ScreenSpaceEventType.LEFT_CLICK)

    const addLocalImagery = () => {
      void TileMapServiceImageryProvider.fromUrl(
        '/cesiumStatic/Assets/Textures/NaturalEarthII',
      ).then((provider) => {
        if (isDisposed || viewer.isDestroyed()) {
          return
        }

        const layer = new ImageryLayer(provider, {
          alpha: 0.95,
          brightness: 0.82,
          contrast: 1.18,
          gamma: 1.05,
          saturation: 0.12,
        })
        viewer.imageryLayers.add(layer)
        setImageryMode('Local fallback imagery')
        viewer.scene.requestRender()
      })
    }

    const addEsriImagery = () => {
      const esriLayer = ImageryLayer.fromProviderAsync(
        ArcGisMapServerImageryProvider.fromUrl(
          'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
          {
            enablePickFeatures: false,
          },
        ),
        {
          alpha: 0.95,
          brightness: 0.88,
          contrast: 1.04,
          gamma: 1,
          saturation: 0.02,
        },
      )

      esriLayer.errorEvent.addEventListener(() => {
        if (isDisposed || viewer.isDestroyed()) {
          return
        }

        viewer.imageryLayers.remove(esriLayer, true)
        addLocalImagery()
      })

      esriLayer.readyEvent.addEventListener(() => {
        if (!isDisposed) {
          setImageryMode('Esri world imagery')
        }
      })

      viewer.imageryLayers.add(esriLayer)
    }

    if (token) {
      Ion.defaultAccessToken = token
      const ionLayer = ImageryLayer.fromProviderAsync(
        createWorldImageryAsync({
          style: IonWorldImageryStyle.AERIAL,
        }),
        {
          alpha: 0.88,
          brightness: 0.72,
          contrast: 1.08,
          gamma: 1,
          saturation: 0.18,
        },
      )

      ionLayer.errorEvent.addEventListener(() => {
        if (isDisposed || viewer.isDestroyed()) {
          return
        }

        viewer.imageryLayers.remove(ionLayer, true)
        addEsriImagery()
      })

      ionLayer.readyEvent.addEventListener(() => {
        if (!isDisposed) {
          setImageryMode('Ion world imagery')
        }
      })

      viewer.imageryLayers.add(ionLayer)
    } else {
      addEsriImagery()
    }

    viewer.entities.add({
      name: 'North Axis AOR',
      rectangle: {
        coordinates: Rectangle.fromDegrees(47, 25, 77, 43),
        fill: true,
        height: 0,
        material: MAP_RED.withAlpha(0.08),
        outline: true,
        outlineColor: MAP_RED.withAlpha(0.65),
      },
    })

    viewer.entities.add({
      id: 'local-aor-boundary',
      name: 'Local AOR Boundary',
      rectangle: {
        coordinates: Rectangle.fromDegrees(
          localAorBounds.west,
          localAorBounds.south,
          localAorBounds.east,
          localAorBounds.north,
        ),
        fill: true,
        height: 0,
        material: MAP_RED.withAlpha(0.06),
        outline: true,
        outlineColor: MAP_RED.withAlpha(0.65),
      },
    })

    localContacts.forEach((contact) => {
      viewer.entities.add({
        id: `local-${contact.name.toLowerCase().replaceAll(' ', '-')}`,
        name: contact.name,
        position: Cartesian3.fromDegrees(contact.lon, contact.lat, contact.height),
        billboard: {
          color: Color.WHITE,
          height: 20,
          image: markerSvg('drone', markerColorHex(contact.color)),
          scaleByDistance: new NearFarScalar(50000, 0.82, 900000, 0.42),
          width: 20,
        },
        label: {
          backgroundColor: MAP_PANEL.withAlpha(0.82),
          fillColor: Color.WHITE,
          font: MAP_FONT,
          pixelOffset: new Cartesian2(0, -28),
          show: false,
          showBackground: true,
          style: LabelStyle.FILL,
          text: `${contact.name}\n${formatMgrs(contact.lon, contact.lat)}`,
        },
      })
    })

    viewer.camera.setView({
      destination: RESET_CAMERA_DESTINATION,
    })

    return () => {
      isDisposed = true
      clickHandler.destroy()
      viewerRef.current = null
      if (!viewer.isDestroyed()) {
        viewer.destroy()
      }
    }
  }, [])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || viewer.isDestroyed()) {
      return
    }

    signalEntityIdsRef.current.forEach((id) => {
      viewer.entities.removeById(id)
    })
    signalEntityIdsRef.current.clear()

    const correlatedIds = new Set(correlatedSignalIds)
    signals.forEach((signal) => {
      const entityId = `signal-${signal.id}`
      const color = colorForSignal(signal)
      const point = signalPoint(signal)
      const polygon = signalPolygon(signal)
      const isFocus = signal.id === focusSignalId
      const isCorrelated = correlatedIds.has(signal.id)
      const shouldLabel = isFocus && signals.length <= 8
      const markerKind = markerKindForSignal(signal)

      if (point) {
        viewer.entities.add({
          id: entityId,
          name: point.label,
          position: Cartesian3.fromDegrees(point.lon, point.lat, point.height),
          billboard: {
            color: Color.WHITE,
            height: isFocus ? 24 : isCorrelated ? 21 : 18,
            image: markerSvg(markerKind, markerColorHex(color)),
            scaleByDistance: new NearFarScalar(1500000, 0.84, 25000000, 0.36),
            width: isFocus ? 24 : isCorrelated ? 21 : 18,
          },
          label: {
            backgroundColor: MAP_PANEL.withAlpha(0.84),
            fillColor: Color.WHITE,
            font: MAP_FONT,
            pixelOffset: new Cartesian2(0, -28),
            scaleByDistance: new NearFarScalar(800000, 1, 22000000, 0.62),
            show: shouldLabel,
            showBackground: true,
            style: LabelStyle.FILL,
            text: 'FOCUS',
          },
          description: commanderSignalSummary(signal).oneLine,
        })
        signalEntityIdsRef.current.add(entityId)

        if (isFocus || isCorrelated) {
          const pulseId = `${entityId}-pulse`
          viewer.entities.add({
            id: pulseId,
            name: `${point.label} focus ring`,
            position: Cartesian3.fromDegrees(point.lon, point.lat, 0),
            ellipse: {
              semiMajorAxis: isFocus ? 14000 : 9500,
              semiMinorAxis: isFocus ? 14000 : 9500,
              material: color.withAlpha(isFocus ? 0.03 : 0.018),
              outline: true,
              outlineColor: color.withAlpha(isFocus ? 0.42 : 0.26),
            },
          })
          signalEntityIdsRef.current.add(pulseId)
        }
      } else if (polygon) {
        viewer.entities.add({
          id: entityId,
          name: signalLabel(signal),
          polygon: {
            hierarchy: Cartesian3.fromDegreesArray(polygon),
            material: color.withAlpha(0.08),
            outline: true,
            outlineColor: color.withAlpha(0.8),
          },
          description: commanderSignalSummary(signal).oneLine,
        })
        signalEntityIdsRef.current.add(entityId)
      }
    })

    viewer.scene.requestRender()
  }, [correlatedSignalIds, focusSignalId, signals])

  const resetDynamicSources = () => {
    const viewer = viewerRef.current
    if (!viewer || viewer.isDestroyed()) {
      return
    }

    viewer.dataSources.removeAll()
    if (selectedN2yoLayerRef.current) {
      deselectN2YOSatellite(viewer, selectedN2yoLayerRef.current)
    }
    clearN2YOSatelliteLayers(viewer, n2yoLayersRef.current)
    n2yoLayersRef.current = []
    loadedN2yoSatelliteIdsRef.current.clear()
    setN2yoLayerCount(0)
    setOrbitCapableLayerCount(0)
    selectedN2yoLayerRef.current = null
    setSelectedSatellite(null)
    satelliteFamilySelectionRef.current = []
    setSatelliteFamilySelection([])
    showAllOrbitsRef.current = false
    setShowAllOrbits(false)
    viewer.clock.shouldAnimate = true
    setActiveLayer('baseline')
    viewer.camera.flyTo({
      destination: RESET_CAMERA_DESTINATION,
      duration: 0.6,
    })
  }

  const loadVehicle = () => {
    const viewer = viewerRef.current
    if (!viewer || viewer.isDestroyed()) {
      return
    }

    viewer.dataSources.removeAll()
    if (selectedN2yoLayerRef.current) {
      deselectN2YOSatellite(viewer, selectedN2yoLayerRef.current)
    }
    clearN2YOSatelliteLayers(viewer, n2yoLayersRef.current)
    n2yoLayersRef.current = []
    loadedN2yoSatelliteIdsRef.current.clear()
    setN2yoLayerCount(0)
    setOrbitCapableLayerCount(0)
    selectedN2yoLayerRef.current = null
    setSelectedSatellite(null)
    satelliteFamilySelectionRef.current = []
    setSatelliteFamilySelection([])
    showAllOrbitsRef.current = false
    setShowAllOrbits(false)
    void viewer.dataSources.add(CzmlDataSource.load(createVehicleCzml())).then(() => {
      if (viewer.isDestroyed()) {
        return
      }

      viewer.clock.shouldAnimate = true
      setActiveLayer('local-aor')
      viewer.camera.flyTo({
        destination: LOCAL_AOR_CAMERA_DESTINATION,
        duration: 0.8,
        orientation: LOCAL_AOR_CAMERA_ORIENTATION,
      })
    })
  }

  const visibleN2yoLayers = useCallback(
    (familySelection = satelliteFamilySelectionRef.current) =>
      n2yoLayersRef.current.filter((layer) =>
        isFamilyVisible(familySelection, layer.satelliteFamily),
      ),
    [],
  )

  const visibleOrbitCapableLayers = useCallback(
    (familySelection = satelliteFamilySelectionRef.current) =>
      visibleN2yoLayers(familySelection).filter(
        (layer) => !isN2YOGeostationaryFamily(layer.satelliteFamily),
      ),
    [visibleN2yoLayers],
  )

  const syncN2YOLayerVisibility = useCallback(
    (viewer: Viewer, normalizedSelection: SatelliteFamilySelection) => {
      if (
        selectedN2yoLayerRef.current &&
        !isFamilyVisible(
          normalizedSelection,
          selectedN2yoLayerRef.current.satelliteFamily,
        )
      ) {
        deselectN2YOSatellite(viewer, selectedN2yoLayerRef.current)
        selectedN2yoLayerRef.current = null
        setSelectedSatellite(null)
      }

      setN2YOOrbitsVisible(viewer, n2yoLayersRef.current, false)
      n2yoLayersRef.current.forEach((layer) => {
        setN2YOSatelliteLayerVisible(
          viewer,
          layer,
          isFamilyVisible(normalizedSelection, layer.satelliteFamily),
        )
      })

      const orbitCapableLayers = visibleOrbitCapableLayers(normalizedSelection)
      setOrbitCapableLayerCount(orbitCapableLayers.length)

      if (selectedN2yoLayerRef.current) {
        selectN2YOSatellite(viewer, selectedN2yoLayerRef.current)
      } else if (showAllOrbitsRef.current && orbitCapableLayers.length > 0) {
        setN2YOOrbitsVisible(viewer, orbitCapableLayers, true)
      } else if (showAllOrbitsRef.current) {
        showAllOrbitsRef.current = false
        setShowAllOrbits(false)
      }

      setN2yoLayerCount(n2yoLayersRef.current.length)
      viewer.scene.requestRender()
    },
    [visibleOrbitCapableLayers],
  )

  const ensureN2YOSatellitesLoaded = useCallback(
    (
      normalizedSelection: SatelliteFamilySelection,
      options: { flyTo?: boolean } = {},
    ) => {
      const viewer = viewerRef.current
      if (!viewer || viewer.isDestroyed()) {
        return Promise.resolve()
      }

      viewer.dataSources.removeAll()
      const selectedFamilies =
        normalizedSelection === 'all' ? ALL_N2YO_FAMILIES : normalizedSelection
      const satellitesToLoad = N2YO_SATELLITES.filter(
        (satellite) =>
          selectedFamilies.includes(satellite.family) &&
          !loadedN2yoSatelliteIdsRef.current.has(satellite.id),
      )

      syncN2YOLayerVisibility(viewer, normalizedSelection)
      if (satellitesToLoad.length === 0) {
        return Promise.resolve()
      }

      setRealSatelliteStatus('Loading sats')
      return Promise.all(
        satellitesToLoad.map((satellite) =>
          fetchN2YOPositionCache(satellite).then((cache) => ({ cache, satellite })),
        ),
      )
        .then((payloads) => {
          if (viewer.isDestroyed()) {
            return
          }

          if (selectedN2yoLayerRef.current) {
            deselectN2YOSatellite(viewer, selectedN2yoLayerRef.current)
          }
          selectedN2yoLayerRef.current = null
          setSelectedSatellite(null)
          showAllOrbitsRef.current = false
          setShowAllOrbits(false)
          const newLayers = payloads.flatMap(({ cache, satellite }) => {
            if (loadedN2yoSatelliteIdsRef.current.has(satellite.id)) {
              return []
            }

            loadedN2yoSatelliteIdsRef.current.add(satellite.id)
            return [
              addN2YOSatellite(
                viewer,
                cache,
                satellite,
                latestN2YOAltitudeKm(cache) * 1000 * N2YO_ALTITUDE_SCALE,
              ),
            ]
          })
          n2yoLayersRef.current = [...n2yoLayersRef.current, ...newLayers]
          syncN2YOLayerVisibility(viewer, normalizedSelection)
          if (options.flyTo) {
            viewer.camera.flyTo({
              destination: RESET_CAMERA_DESTINATION,
              duration: 0.8,
            })
          }
          viewer.clock.shouldAnimate = true
          setActiveLayer('real-satellite')
          setRealSatelliteStatus('Satellites')
          viewer.scene.requestRender()
        })
        .catch(() => {
          setRealSatelliteStatus('Sats unavailable')
        })
    },
    [syncN2YOLayerVisibility],
  )

  const applySatelliteFamilyFilter = (familyFilter: SatelliteFamilyFilter) => {
    const viewer = viewerRef.current
    if (!viewer || viewer.isDestroyed()) {
      return
    }

    const nextSelection: SatelliteFamilySelection =
      familyFilter === 'all'
        ? 'all'
        : satelliteFamilySelectionRef.current === 'all'
          ? [familyFilter]
          : satelliteFamilySelectionRef.current.includes(familyFilter)
            ? satelliteFamilySelectionRef.current.filter(
                (family) => family !== familyFilter,
              )
            : [...satelliteFamilySelectionRef.current, familyFilter]

    satelliteFamilySelectionRef.current = nextSelection
    setSatelliteFamilySelection(nextSelection)
    void ensureN2YOSatellitesLoaded(nextSelection)
  }

  const loadRealSatellites = () => {
    const viewer = viewerRef.current
    if (!viewer || viewer.isDestroyed()) {
      return
    }

    viewer.dataSources.removeAll()
    if (selectedN2yoLayerRef.current) {
      deselectN2YOSatellite(viewer, selectedN2yoLayerRef.current)
    }
    selectedN2yoLayerRef.current = null
    setSelectedSatellite(null)
    setN2YOOrbitsVisible(viewer, n2yoLayersRef.current, false)
    showAllOrbitsRef.current = false
    setShowAllOrbits(false)
    viewer.clock.shouldAnimate = true
    setActiveLayer('real-satellite')
    syncN2YOLayerVisibility(viewer, satelliteFamilySelectionRef.current)
    viewer.camera.flyTo({
      destination: RESET_CAMERA_DESTINATION,
      duration: 0.8,
    })
  }

  const toggleAllOrbits = () => {
    const viewer = viewerRef.current
    if (!viewer || viewer.isDestroyed()) {
      return
    }
    if (activeLayer !== 'real-satellite' || n2yoLayersRef.current.length === 0) {
      showAllOrbitsRef.current = false
      setShowAllOrbits(false)
      return
    }

    setShowAllOrbits((current) => {
      const next = !current
      if (next && selectedN2yoLayerRef.current) {
        deselectN2YOSatellite(viewer, selectedN2yoLayerRef.current)
        selectedN2yoLayerRef.current = null
        setSelectedSatellite(null)
      }
      setN2YOOrbitsVisible(viewer, visibleOrbitCapableLayers(), next)
      showAllOrbitsRef.current = next
      viewer.scene.requestRender()
      return next
    })
  }

  useEffect(() => {
    if (displayMode === 'globe') {
      resetDynamicSources()
      return
    }

    loadVehicle()
  }, [displayMode])

  // Maneuver demo: when the operator accepts a decide-stage decision, run an
  // interactive Cesium animation showing the hostile and friendly orbital
  // tracks, the predicted close-approach point, and the friendly executing
  // an inclination-change burn that diverges its track from the threat.
  // Both satellites continue along their real orbits the entire time —
  // only the friendly's orbital plane changes, and only after the burn.
  useEffect(() => {
    if (!maneuverDemo) {
      return
    }

    const viewer = viewerRef.current
    if (!viewer || viewer.isDestroyed()) {
      return
    }

    const layers = n2yoLayersRef.current
    if (layers.length === 0) {
      // Need a friendly non-GEO and hostile satellite to drive the demo math.
      satelliteFamilySelectionRef.current = MANEUVER_DEMO_FAMILIES
      setSatelliteFamilySelection(MANEUVER_DEMO_FAMILIES)
      void ensureN2YOSatellitesLoaded(MANEUVER_DEMO_FAMILIES, { flyTo: true })
      return
    }

    const isUsFamily = (family: N2YOSatelliteFamily) =>
      family === 'GPS-3' ||
      family === 'GSSAP' ||
      family === 'AEHF' ||
      family === 'MUOS' ||
      family === 'WGS' ||
      family === 'SBIRS'

    if (
      !layers.some(
        (l) =>
          isUsFamily(l.satelliteFamily) &&
          !isN2YOGeostationaryFamily(l.satelliteFamily),
      ) ||
      !layers.some(
        (l) => l.satelliteFamily === 'CHINA' || l.satelliteFamily === 'RUSSIA',
      )
    ) {
      satelliteFamilySelectionRef.current = MANEUVER_DEMO_FAMILIES
      setSatelliteFamilySelection(MANEUVER_DEMO_FAMILIES)
      void ensureN2YOSatellitesLoaded(MANEUVER_DEMO_FAMILIES, { flyTo: true })
      return
    }

    // We need non-GEO satellites for both sides — only non-GEO sats have
    // moving orbital tracks, which is the whole point of the demo. The
    // engine's friendlyLabel/hostileLabel come from request_packet and may
    // not match a loaded layer, so we fall back to family-based selection.
    const friendly =
      layers.find(
        (l) =>
          isUsFamily(l.satelliteFamily) &&
          !isN2YOGeostationaryFamily(l.satelliteFamily),
      ) ?? layers.find((l) => isUsFamily(l.satelliteFamily))
    const hostile =
      layers.find((l) => l.satelliteFamily === 'CHINA') ??
      layers.find((l) => l.satelliteFamily === 'RUSSIA')

    if (!friendly || !hostile || friendly === hostile) {
      endManeuverDemo()
      return
    }

    const friendlyMotion = getN2YOOrbitMotion(friendly)
    const hostileMotion = getN2YOOrbitMotion(hostile)

    if (friendlyMotion.isGeo || hostileMotion.isGeo) {
      endManeuverDemo()
      return
    }

    const friendlyEntity = viewer.entities.getById(friendly.entityIds[0])
    const hostileEntity = viewer.entities.getById(hostile.entityIds[0])
    const friendlyFootprint = viewer.entities.getById(friendly.entityIds[1])
    const hostileFootprint = viewer.entities.getById(hostile.entityIds[1])
    if (!friendlyEntity || !hostileEntity) {
      endManeuverDemo()
      return
    }

    // Surface real satellite names to the overlay.
    setManeuverPair({
      friendly: friendly.satelliteName,
      hostile: hostile.satelliteName,
    })

    const demoType = maneuverDemo.demoType ?? 'evasion'

    // ----- Strike branch: kinetic kill vehicle ---------------------------
    // For orbital_strike_request / active_defense_counterattack actions.
    // Both satellites continue along their natural orbits — no position
    // override. A KV entity launches from the friendly's live position
    // along a Bezier arc that intercepts the hostile, then dims the
    // hostile's billboard to communicate "neutralized".
    if (demoType === 'strike') {
      const friendlyDisplay = currentN2YODisplayPoint(friendly)
      const launchPos = Cartesian3.fromDegrees(
        friendlyDisplay.lng,
        friendlyDisplay.lat,
        friendly.displayAltitudeM,
      )

      let vehicleFraction = 0
      let hostileDim = 0

      const hostileBillboard = hostileEntity.billboard
      const originalHostileBillboardColor = hostileBillboard?.color

      // Quadratic Bezier interpolation between launchPos and the hostile's
      // live position, with a control point pulled outward (away from
      // Earth's center) so the trajectory arcs over rather than cutting
      // straight through space. Reads as a kill vehicle climbing then
      // descending onto its target.
      const computeVehiclePos = () => {
        if (vehicleFraction <= 0) return launchPos
        const display = currentN2YODisplayPoint(hostile)
        const targetPos = Cartesian3.fromDegrees(
          display.lng,
          display.lat,
          hostile.displayAltitudeM,
        )
        if (vehicleFraction >= 1) return targetPos
        const mid = Cartesian3.midpoint(launchPos, targetPos, new Cartesian3())
        const outward = Cartesian3.normalize(mid, new Cartesian3())
        const arcHeight = Cartesian3.distance(launchPos, targetPos) * 0.22
        const control = Cartesian3.add(
          mid,
          Cartesian3.multiplyByScalar(outward, arcHeight, new Cartesian3()),
          new Cartesian3(),
        )
        const t = vehicleFraction
        const inv = 1 - t
        return new Cartesian3(
          inv * inv * launchPos.x + 2 * inv * t * control.x + t * t * targetPos.x,
          inv * inv * launchPos.y + 2 * inv * t * control.y + t * t * targetPos.y,
          inv * inv * launchPos.z + 2 * inv * t * control.z + t * t * targetPos.z,
        )
      }

      const vehiclePosition = new CallbackPositionProperty(
        () => computeVehiclePos(),
        false,
      )

      const vehicleId = `maneuver-vehicle-${maneuverDemo.decisionId}`
      const vehicleTrailId = `maneuver-vehicle-trail-${maneuverDemo.decisionId}`

      viewer.entities.add({
        id: vehicleId,
        position: vehiclePosition,
        point: {
          color: Color.WHITE,
          pixelSize: 11,
          outlineColor: Color.fromCssColorString('#ef4444'),
          outlineWidth: 3,
        },
        label: {
          backgroundColor: MAP_PANEL.withAlpha(0.85),
          fillColor: Color.WHITE,
          font: MAP_FONT,
          pixelOffset: new Cartesian2(14, -2),
          show: true,
          showBackground: true,
          style: LabelStyle.FILL,
          text: 'KV',
        },
      })

      viewer.entities.add({
        id: vehicleTrailId,
        polyline: {
          arcType: ArcType.NONE,
          clampToGround: false,
          material: new PolylineDashMaterialProperty({
            color: Color.fromCssColorString('#ef4444'),
            dashLength: 14,
          }),
          positions: new CallbackProperty(
            () => [launchPos, computeVehiclePos()],
            false,
          ),
          width: 3,
        },
      })

      // Dim the hostile's billboard once impact has occurred.
      if (hostileBillboard) {
        hostileBillboard.color = new CallbackProperty(
          () => Color.WHITE.withAlpha(1 - hostileDim * 0.78),
          false,
        )
      }

      // Camera framing — same approach as evasion (bounding sphere centered
      // at the engagement midpoint), wide enough to keep the arc in frame.
      const friendlyD = currentN2YODisplayPoint(friendly)
      const hostileD = currentN2YODisplayPoint(hostile)
      const strikeMidLat = (friendlyD.lat + hostileD.lat) / 2
      const strikeMidLng = (friendlyD.lng + hostileD.lng) / 2
      const strikeRadiusM = Math.max(
        friendly.displayAltitudeM,
        hostile.displayAltitudeM,
      )
      viewer.camera.flyToBoundingSphere(
        new BoundingSphere(
          Cartesian3.fromDegrees(strikeMidLng, strikeMidLat, 0),
          strikeRadiusM,
        ),
        {
          duration: 1.4,
          offset: new HeadingPitchRange(
            0,
            -(Math.PI / 180) * 48,
            strikeRadiusM * 5,
          ),
        },
      )

      let strikeRaf = 0
      let strikeCancelled = false
      const strikeStart = performance.now()
      const strikeDuration = maneuverDemo.durationMs

      const smoothStrike = (x: number) =>
        x * x * x * (x * (x * 6 - 15) + 10)

      const strikeTick = () => {
        if (strikeCancelled) return
        const elapsed = performance.now() - strikeStart
        const t = Math.min(elapsed / strikeDuration, 1)
        // Phase windows:
        //   0.00 - 0.08: camera fly-in
        //   0.08 - 0.20: pre-launch hold
        //   0.20 - 0.72: vehicle arcs from friendly to hostile
        //   0.72 - 0.92: target dims
        //   0.92 - 1.00 (and beyond): persistent post-strike hold
        const vT = Math.min(Math.max((t - 0.2) / 0.52, 0), 1)
        vehicleFraction = smoothStrike(vT)
        const dimT = Math.min(Math.max((t - 0.72) / 0.2, 0), 1)
        hostileDim = smoothStrike(dimT)
        setManeuverProgress(t)
        viewer.scene.requestRender()
        if (t < 1) strikeRaf = requestAnimationFrame(strikeTick)
        // Same persistence pattern as evasion: don't auto-end. The
        // dimmed hostile + KV at impact stay on screen until a new
        // demo replaces this one.
      }
      strikeRaf = requestAnimationFrame(strikeTick)

      return () => {
        strikeCancelled = true
        if (strikeRaf) cancelAnimationFrame(strikeRaf)
        if (!viewer.isDestroyed()) {
          if (hostileBillboard) {
            hostileBillboard.color =
              originalHostileBillboardColor ?? new ConstantProperty(Color.WHITE)
          }
          viewer.entities.removeById(vehicleId)
          viewer.entities.removeById(vehicleTrailId)
          viewer.scene.requestRender()
        }
        setManeuverPair(null)
      }
    }

    // ----- Interdiction branch: jamming beam -----------------------------
    // For space_link_interdiction_request. A friendly satellite emits a
    // jamming beam to the hostile, which pulses then visibly degrades.
    if (demoType === 'interdiction') {
      let beamFraction = 0
      let hostileDim = 0
      const hostileBillboard = hostileEntity.billboard
      const originalHostileBillboardColor = hostileBillboard?.color

      const beamId = `maneuver-beam-${maneuverDemo.decisionId}`
      const groundLinkId = `maneuver-ground-link-${maneuverDemo.decisionId}`

      // The hostile's "comms link" — a faded red beam from the hostile
      // down to a notional ground station directly below it (sub-satellite
      // point at altitude 0). Visualizes what the friendly is trying to
      // sever.
      const groundLinkPositions = new CallbackProperty(() => {
        const display = currentN2YODisplayPoint(hostile)
        const top = Cartesian3.fromDegrees(
          display.lng,
          display.lat,
          hostile.displayAltitudeM,
        )
        const bottom = Cartesian3.fromDegrees(display.lng, display.lat, 0)
        return [top, bottom]
      }, false)

      viewer.entities.add({
        id: groundLinkId,
        polyline: {
          arcType: ArcType.NONE,
          clampToGround: false,
          material: new PolylineDashMaterialProperty({
            color: Color.fromCssColorString('#ef4444').withAlpha(0.55),
            dashLength: 14,
          }),
          positions: groundLinkPositions,
          width: 2,
        },
      })

      // Friendly→hostile jamming beam — grows across the beam phase.
      viewer.entities.add({
        id: beamId,
        polyline: {
          arcType: ArcType.NONE,
          clampToGround: false,
          material: new PolylineDashMaterialProperty({
            color: Color.fromCssColorString('#facc15'),
            dashLength: 8,
          }),
          positions: new CallbackProperty(() => {
            const fd = currentN2YODisplayPoint(friendly)
            const hd = currentN2YODisplayPoint(hostile)
            const fp = Cartesian3.fromDegrees(
              fd.lng,
              fd.lat,
              friendly.displayAltitudeM,
            )
            const hp = Cartesian3.fromDegrees(
              hd.lng,
              hd.lat,
              hostile.displayAltitudeM,
            )
            // Truncate the beam by (1 - beamFraction) until it reaches
            // the hostile, so it visually "extends" toward the target.
            if (beamFraction <= 0) return []
            const tip = new Cartesian3(
              fp.x + (hp.x - fp.x) * beamFraction,
              fp.y + (hp.y - fp.y) * beamFraction,
              fp.z + (hp.z - fp.z) * beamFraction,
            )
            return [fp, tip]
          }, false),
          width: 4,
        },
      })

      if (hostileBillboard) {
        hostileBillboard.color = new CallbackProperty(
          () => Color.WHITE.withAlpha(1 - hostileDim * 0.55),
          false,
        )
      }

      const friendlyD = currentN2YODisplayPoint(friendly)
      const hostileD = currentN2YODisplayPoint(hostile)
      const interMidLat = (friendlyD.lat + hostileD.lat) / 2
      const interMidLng = (friendlyD.lng + hostileD.lng) / 2
      const interRadiusM = Math.max(
        friendly.displayAltitudeM,
        hostile.displayAltitudeM,
      )
      viewer.camera.flyToBoundingSphere(
        new BoundingSphere(
          Cartesian3.fromDegrees(interMidLng, interMidLat, 0),
          interRadiusM,
        ),
        {
          duration: 1.4,
          offset: new HeadingPitchRange(
            0,
            -(Math.PI / 180) * 48,
            interRadiusM * 5,
          ),
        },
      )

      let interRaf = 0
      let interCancelled = false
      const interStart = performance.now()
      const interDuration = maneuverDemo.durationMs
      const smoothInter = (x: number) =>
        x * x * x * (x * (x * 6 - 15) + 10)

      const interTick = () => {
        if (interCancelled) return
        const elapsed = performance.now() - interStart
        const t = Math.min(elapsed / interDuration, 1)
        //   0.00 - 0.08: camera fly-in
        //   0.08 - 0.25: hostile link visible (red beam to ground)
        //   0.25 - 0.65: friendly emits jamming beam (yellow), grows
        //                from friendly toward hostile
        //   0.65 - 0.85: hostile dims (link severed)
        //   0.85 - 1.00: persistent hold
        const bT = Math.min(Math.max((t - 0.25) / 0.4, 0), 1)
        beamFraction = smoothInter(bT)
        const dimT = Math.min(Math.max((t - 0.65) / 0.2, 0), 1)
        hostileDim = smoothInter(dimT)
        setManeuverProgress(t)
        viewer.scene.requestRender()
        if (t < 1) interRaf = requestAnimationFrame(interTick)
      }
      interRaf = requestAnimationFrame(interTick)

      return () => {
        interCancelled = true
        if (interRaf) cancelAnimationFrame(interRaf)
        if (!viewer.isDestroyed()) {
          if (hostileBillboard) {
            hostileBillboard.color =
              originalHostileBillboardColor ?? new ConstantProperty(Color.WHITE)
          }
          viewer.entities.removeById(beamId)
          viewer.entities.removeById(groundLinkId)
          viewer.scene.requestRender()
        }
        setManeuverPair(null)
      }
    }

    // Snapshot originals so we can restore natural orbital motion on
    // cleanup. We override BOTH satellites' positions: the hostile is
    // pulled onto a tailing co-orbital track behind the friendly so the
    // engagement reads as "adversary shadowing", and the friendly will
    // execute the plane change off that shared ring.
    const originalFriendlyPos = friendlyEntity.position
    const originalHostilePos = hostileEntity.position
    const friendlyLabel = friendlyEntity.label
    const hostileLabel = hostileEntity.label
    const originalFriendlyLabelShow = friendlyLabel?.show
    const originalHostileLabelShow = hostileLabel?.show
    const originalFriendlyFootprintShow = friendlyFootprint?.show ?? true
    const originalHostileFootprintShow = hostileFootprint?.show ?? true

    // Subtle plane-change: ~10° of inclination delta, applied as a
    // tangent rotation around the friendly's radial axis. The new orbit
    // intersects the original at the basis point and tilts away from
    // the shared ring elsewhere — visually communicates an evasive
    // cross-track Δv without the over-the-top 22° we had before.
    const inclinationDeltaRad = (Math.PI / 180) * 10
    const burnedTangent = rotateN2YOOrbitTangent(
      friendlyMotion,
      inclinationDeltaRad,
    )
    const naturalTangent = friendlyMotion.tangent

    // Hostile trails the friendly by a fixed angular offset on the same
    // orbit ring. ~0.22 rad ≈ 12.6° in orbital phase — close enough to
    // read as "tailing" but with enough gap to see both satellites
    // distinctly. Negative offset places the hostile *behind* the
    // friendly (earlier in the orbital phase).
    const tailingThetaOffsetRad = -0.22

    // Highlight both satellite labels for the engagement.
    if (friendlyLabel) {
      friendlyLabel.show = new ConstantProperty(true)
    }
    if (hostileLabel) {
      hostileLabel.show = new ConstantProperty(true)
    }
    // Suppress sub-satellite footprints during the demo — they trace the
    // original ground tracks even after the friendly has burned, which
    // muddies the orbital-divergence read.
    if (friendlyFootprint) {
      friendlyFootprint.show = false
    }
    if (hostileFootprint) {
      hostileFootprint.show = false
    }

    // burnFraction is the closure variable both satellite positions and
    // the miss-distance line read from. 0 = pre-burn (co-orbital);
    // 1 = full plane change applied.
    let burnFraction = 0

    const lerpedTangent = () => {
      if (burnFraction <= 0) return naturalTangent
      if (burnFraction >= 1) return burnedTangent
      const tx =
        naturalTangent.x * (1 - burnFraction) + burnedTangent.x * burnFraction
      const ty =
        naturalTangent.y * (1 - burnFraction) + burnedTangent.y * burnFraction
      const tz =
        naturalTangent.z * (1 - burnFraction) + burnedTangent.z * burnFraction
      const m = Math.hypot(tx, ty, tz) || 1
      return { x: tx / m, y: ty / m, z: tz / m }
    }

    // Friendly: live theta on its natural orbit, but the tangent rotates
    // from natural to burned through the burn window. Result is a
    // satellite that follows the shared ring pre-burn, then peels onto
    // the tilted orbit.
    const friendlyPosition = new CallbackPositionProperty(() => {
      const theta = n2yoCurrentOrbitalTheta(friendlyMotion)
      return n2yoOrbitalPositionAtTheta(friendlyMotion, lerpedTangent(), theta)
    }, false)
    friendlyEntity.position = friendlyPosition

    // Hostile: tailing position on the friendly's *natural* orbit. Stays
    // on the original ring even as the friendly burns away, which is the
    // visual story — the threat keeps coming, the friendly evades.
    const hostilePosition = new CallbackPositionProperty(() => {
      const theta =
        n2yoCurrentOrbitalTheta(friendlyMotion) + tailingThetaOffsetRad
      return n2yoOrbitalPositionAtTheta(friendlyMotion, naturalTangent, theta)
    }, false)
    hostileEntity.position = hostilePosition

    const sharedOrbitId = `maneuver-orbit-shared-${maneuverDemo.decisionId}`
    const friendlyBurnedOrbitId = `maneuver-orbit-friendly-burned-${maneuverDemo.decisionId}`
    const missLineId = `maneuver-miss-line-${maneuverDemo.decisionId}`

    const sharedOrbitSamples = n2yoOrbitSamples(friendlyMotion, naturalTangent)
    const friendlyBurnedSamples = n2yoOrbitSamples(
      friendlyMotion,
      burnedTangent,
    )

    // Shared orbit ring — pre-burn, both satellites are on it. Colored
    // red because it's the threat path: as long as the friendly stays
    // on this ring the hostile will close in.
    viewer.entities.add({
      id: sharedOrbitId,
      polyline: {
        arcType: ArcType.NONE,
        clampToGround: false,
        material: new PolylineDashMaterialProperty({
          color: Color.fromCssColorString('#ef4444').withAlpha(0.85),
          dashLength: 16,
        }),
        positions: sharedOrbitSamples,
        width: 4,
      },
    })

    // Post-burn orbit — appears as the friendly tilts onto it.
    viewer.entities.add({
      id: friendlyBurnedOrbitId,
      polyline: {
        arcType: ArcType.NONE,
        clampToGround: false,
        material: new PolylineDashMaterialProperty({
          color: Color.fromCssColorString('#22c55e'),
          dashLength: 18,
        }),
        positions: new CallbackProperty(
          () => (burnFraction > 0.02 ? friendlyBurnedSamples : []),
          false,
        ),
        width: 4,
      },
    })

    // Live miss-distance line connecting the two satellites. Pre-burn
    // it's a short red leash; post-burn it stretches as the friendly
    // peels off onto the tilted orbit, communicating the growing miss.
    viewer.entities.add({
      id: missLineId,
      polyline: {
        arcType: ArcType.NONE,
        clampToGround: false,
        material: new PolylineDashMaterialProperty({
          color: Color.fromCssColorString('#facc15').withAlpha(0.85),
          dashLength: 8,
        }),
        positions: new CallbackProperty(() => {
          const friendlyTheta = n2yoCurrentOrbitalTheta(friendlyMotion)
          const friendlyPos = n2yoOrbitalPositionAtTheta(
            friendlyMotion,
            lerpedTangent(),
            friendlyTheta,
          )
          const hostilePos = n2yoOrbitalPositionAtTheta(
            friendlyMotion,
            naturalTangent,
            friendlyTheta + tailingThetaOffsetRad,
          )
          return [friendlyPos, hostilePos]
        }, false),
        width: 2,
      },
    })

    // Camera framing: aim at a bounding sphere centered on the engagement
    // midpoint at Earth's surface. flyToBoundingSphere points the camera
    // AT the sphere center regardless of where the camera ends up, so the
    // engagement (and Earth underneath it) is always centered. The
    // HeadingPitchRange offset gives a 3/4 perspective — pitch −55° tilts
    // enough to read the post-burn plane change without flattening it,
    // and the range (~3.2× the orbital radius) keeps both orbit rings
    // and Earth's disk well within the FOV.
    const friendlyDisplay = currentN2YODisplayPoint(friendly)
    const hostileDisplay = currentN2YODisplayPoint(hostile)
    const midLat = (friendlyDisplay.lat + hostileDisplay.lat) / 2
    const midLng = (friendlyDisplay.lng + hostileDisplay.lng) / 2
    const orbitRadiusM = Math.max(
      friendlyMotion.displayAltitudeM,
      hostileMotion.displayAltitudeM,
    )
    viewer.camera.flyToBoundingSphere(
      new BoundingSphere(
        Cartesian3.fromDegrees(midLng, midLat, 0),
        orbitRadiusM,
      ),
      {
        duration: 1.4,
        offset: new HeadingPitchRange(
          0,
          -(Math.PI / 180) * 48,
          // Range pulled back to orbitRadius × 5 so a meaningful arc of
          // each orbit ring stays in frame across the long hold phase
          // — at 45× orbital playback the satellites traverse ~1/5 of
          // an orbit during the 22 s demo, and a tighter range would
          // let them sail off the edge of the camera view.
          orbitRadiusM * 5,
        ),
      },
    )

    let raf = 0
    let cancelled = false
    const startTime = performance.now()
    const totalDuration = maneuverDemo.durationMs

    // Smootherstep (Ken Perlin's quintic) — has zero first AND second
    // derivatives at both endpoints. Means the burn starts and ends
    // with no acceleration discontinuity, so the orbit-plane drift
    // reads as continuous low-thrust steering rather than a snap.
    const smootherstep = (x: number) =>
      x * x * x * (x * (x * 6 - 15) + 10)

    const tick = () => {
      if (cancelled) return
      const elapsed = performance.now() - startTime
      const t = Math.min(elapsed / totalDuration, 1)
      // Phase windows (fractions of total — totalDuration ≈ 15s):
      //   0.00 - 0.08 (~1.2s): camera fly-in
      //   0.08 - 0.22 (~2.1s): pre-burn cruise; both satellites visible
      //                       on the shared red ring, hostile tailing
      //   0.22 - 0.78 (~8.4s): burn fires; tangent rotates SLOWLY onto
      //                       the green post-burn orbit. Wide window
      //                       so the inclination drift is gradual and
      //                       readable, not a jump.
      //   0.78 - 1.00 (~3.3s): post-burn hold; scene then persists
      //                       indefinitely once t hits 1.
      const burnT = Math.min(Math.max((t - 0.22) / 0.56, 0), 1)
      burnFraction = smootherstep(burnT)
      setManeuverProgress(t)
      viewer.scene.requestRender()
      if (t < 1) {
        raf = requestAnimationFrame(tick)
      }
      // When t reaches 1 we deliberately do NOT call endManeuverDemo.
      // Letting the effect tear down would snap the hostile back to
      // its real orbit (somewhere on the other side of Earth) and
      // wipe the post-burn orbit ring. Instead, the scene persists:
      // burnFraction stays at 1, the friendly stays on the green
      // burned orbit, the hostile stays tailing on the red ring,
      // and Cesium keeps re-querying the CallbackPositionProperty
      // each frame so both satellites continue along their orbits.
      // Cleanup only runs when a new demo replaces this one or the
      // viewer unmounts.
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelled = true
      if (raf) cancelAnimationFrame(raf)
      if (!viewer.isDestroyed()) {
        if (originalFriendlyPos) {
          friendlyEntity.position = originalFriendlyPos
        }
        if (originalHostilePos) {
          hostileEntity.position = originalHostilePos
        }
        if (friendlyLabel) {
          friendlyLabel.show =
            originalFriendlyLabelShow ?? new ConstantProperty(false)
        }
        if (hostileLabel) {
          hostileLabel.show =
            originalHostileLabelShow ?? new ConstantProperty(false)
        }
        if (friendlyFootprint) {
          friendlyFootprint.show = originalFriendlyFootprintShow
        }
        if (hostileFootprint) {
          hostileFootprint.show = originalHostileFootprintShow
        }
        viewer.entities.removeById(sharedOrbitId)
        viewer.entities.removeById(friendlyBurnedOrbitId)
        viewer.entities.removeById(missLineId)
        viewer.scene.requestRender()
      }
      setManeuverPair(null)
    }
  }, [maneuverDemo, endManeuverDemo, n2yoLayerCount, ensureN2YOSatellitesLoaded])

  return (
    <>
      <div className="cesium-globe" ref={containerRef} />
      <div className="cesium-scenario-controls" aria-label="Map layers">
        <button
          className={activeLayer === 'local-aor' ? 'is-active' : ''}
          onClick={loadVehicle}
          type="button"
        >
          Local AOR
        </button>
        <button
          className={activeLayer === 'real-satellite' ? 'is-active' : ''}
          onClick={loadRealSatellites}
          type="button"
        >
          {realSatelliteStatus}
        </button>
        <button onClick={resetDynamicSources} type="button">
          Reset
        </button>
      </div>
      {activeLayer === 'real-satellite' ? (
        <>
          <div className="satellite-family-controls" aria-label="Satellite families">
            {SATELLITE_FAMILY_FILTERS.map((familyFilter) => (
              <button
                className={
                  isFamilyControlActive(satelliteFamilySelection, familyFilter)
                    ? 'is-active'
                    : ''
                }
                disabled={realSatelliteStatus === 'Loading sats'}
                key={familyFilter}
                onClick={() => applySatelliteFamilyFilter(familyFilter)}
                style={
                  familyFilter === 'all'
                    ? undefined
                    : ({
                        '--satellite-family-color':
                          FAMILY_COLOR_HEX[familyFilter],
                      } as CSSProperties)
                }
                type="button"
                title={
                  familyFilter === 'all'
                    ? 'Show every satellite family'
                    : `${familyFilter}: ${FAMILY_SHORT_LABEL[familyFilter]}`
                }
              >
                <span aria-hidden="true" className="satellite-family-controls__swatch" />
                <span className="satellite-family-controls__label">
                  {familyFilter === 'all' ? 'All' : familyFilter}
                </span>
                {familyFilter !== 'all' ? (
                  <span className="satellite-family-controls__sub">
                    {FAMILY_SHORT_LABEL[familyFilter]}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          <button
            aria-pressed={showAllOrbits}
            className={showAllOrbits ? 'orbit-toggle orbit-toggle--active' : 'orbit-toggle'}
            disabled={orbitCapableLayerCount === 0}
            onClick={toggleAllOrbits}
            type="button"
          >
            <span className="orbit-toggle__box" aria-hidden="true" />
            <span>Orbits</span>
          </button>
        </>
      ) : null}
      {selectedSatellite ? (
        <aside className="satellite-detail" aria-label="Selected satellite">
          <span>Selected Satellite</span>
          <strong>{selectedSatellite.satelliteName}</strong>
          <dl>
            <div>
              <dt>Family</dt>
              <dd>
                {selectedSatellite.satelliteFamily} ·{' '}
                {FAMILY_SHORT_LABEL[selectedSatellite.satelliteFamily]}
              </dd>
            </div>
            <div>
              <dt>NORAD</dt>
              <dd>{selectedSatellite.satelliteId}</dd>
            </div>
            <div>
              <dt>True Alt</dt>
              <dd>{Math.round(selectedSatellite.point.alt_km).toLocaleString()} km</dd>
            </div>
            <div>
              <dt>Lat / Lon</dt>
              <dd>
                {(selectedSatellitePoint?.lat ?? selectedSatellite.point.lat).toFixed(2)} /{' '}
                {(selectedSatellitePoint?.lng ?? selectedSatellite.point.lng).toFixed(2)}
              </dd>
            </div>
            <div>
              <dt>Fix</dt>
              <dd>
                {new Date(
                  selectedSatellitePoint?.timestampUtc ??
                    selectedSatellite.point.timestamp_utc,
                ).toLocaleTimeString([], {
                  hour12: false,
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
              </dd>
            </div>
          </dl>
        </aside>
      ) : null}
      {maneuverDemo ? (
        <aside className="maneuver-overlay" aria-label="Maneuver execution status">
          <span className="maneuver-overlay__eyebrow">
            {maneuverDemo.demoType === 'strike'
              ? 'Kinetic strike inbound'
              : maneuverDemo.demoType === 'interdiction'
                ? 'Link interdiction active'
                : 'Plane-change burn executing'}
          </span>
          <strong className="maneuver-overlay__title">
            {maneuverPair?.friendly ?? maneuverDemo.friendlyLabel ?? 'Friendly'}{' '}
            {maneuverDemo.demoType === 'strike'
              ? '↣ neutralize'
              : maneuverDemo.demoType === 'interdiction'
                ? '↯ jam'
                : '↦ evade'}{' '}
            {maneuverPair?.hostile ?? maneuverDemo.hostileLabel ?? 'hostile'}
          </strong>
          <dl className="maneuver-overlay__metrics">
            {maneuverDemo.demoType === 'evasion' ||
            maneuverDemo.demoType === undefined ? (
              <>
                <div>
                  <dt>Pre-burn miss</dt>
                  <dd className="maneuver-overlay__value maneuver-overlay__value--threat">
                    {maneuverDemo.preMissKm.toFixed(1)} km
                  </dd>
                </div>
                <div>
                  <dt>Post-burn miss</dt>
                  <dd className="maneuver-overlay__value maneuver-overlay__value--safe">
                    {maneuverDemo.postMissKm.toFixed(1)} km
                  </dd>
                </div>
                <div>
                  <dt>Δv applied</dt>
                  <dd className="maneuver-overlay__value">
                    {maneuverDemo.dvMs.toFixed(2)} m/s
                  </dd>
                </div>
              </>
            ) : maneuverDemo.demoType === 'strike' ? (
              <>
                <div>
                  <dt>Closing range</dt>
                  <dd className="maneuver-overlay__value maneuver-overlay__value--threat">
                    {maneuverDemo.preMissKm.toFixed(1)} km
                  </dd>
                </div>
                <div>
                  <dt>KV Δv</dt>
                  <dd className="maneuver-overlay__value">
                    {(maneuverDemo.dvMs * 220).toFixed(0)} m/s
                  </dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd className="maneuver-overlay__value maneuver-overlay__value--safe">
                    {maneuverProgress > 0.85 ? 'Neutralized' : 'Inbound'}
                  </dd>
                </div>
              </>
            ) : (
              <>
                <div>
                  <dt>Target band</dt>
                  <dd className="maneuver-overlay__value maneuver-overlay__value--threat">
                    Ka downlink
                  </dd>
                </div>
                <div>
                  <dt>Beam EIRP</dt>
                  <dd className="maneuver-overlay__value">
                    {(maneuverDemo.dvMs * 28).toFixed(0)} dBW
                  </dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd className="maneuver-overlay__value maneuver-overlay__value--safe">
                    {maneuverProgress > 0.78 ? 'Link severed' : 'Closing'}
                  </dd>
                </div>
              </>
            )}
          </dl>
          <div
            className="maneuver-overlay__progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(maneuverProgress * 100)}
          >
            <span style={{ width: `${Math.round(maneuverProgress * 100)}%` }} />
          </div>
        </aside>
      ) : null}
      <div className="map-stage__mode">{imageryMode}</div>
      <div className="cesium-credits" ref={creditRef} />
    </>
  )
}
