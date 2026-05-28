import {
  ArcType,
  CallbackPositionProperty,
  Cartesian2,
  Cartesian3,
  Color,
  ConstantProperty,
  LabelStyle,
  NearFarScalar,
  PolylineDashMaterialProperty,
  Viewer,
} from 'cesium'

export type N2YOSatelliteConfig = {
  family: N2YOSatelliteFamily
  id: number
  label: string
  cacheUrl: string
}

export type N2YOSatelliteFamily =
  | 'AEHF'
  | 'MUOS'
  | 'WGS'
  | 'SBIRS'
  | 'GSSAP'
  | 'GPS-3'
  | 'CHINA'
  | 'RUSSIA'

export const isN2YOGeostationaryFamily = (family: N2YOSatelliteFamily) =>
  family === 'AEHF' ||
  family === 'MUOS' ||
  family === 'WGS' ||
  family === 'SBIRS'

export const N2YO_SATELLITES: N2YOSatelliteConfig[] = [
  {
    family: 'AEHF',
    id: 36868,
    label: 'AEHF 1',
    cacheUrl: '/orbital/n2yo_36868_positions.json',
  },
  {
    family: 'AEHF',
    id: 38254,
    label: 'AEHF 2',
    cacheUrl: '/orbital/n2yo_38254_positions.json',
  },
  {
    family: 'AEHF',
    id: 39256,
    label: 'AEHF 3',
    cacheUrl: '/orbital/n2yo_39256_positions.json',
  },
  {
    family: 'AEHF',
    id: 43651,
    label: 'AEHF 4',
    cacheUrl: '/orbital/n2yo_43651_positions.json',
  },
  {
    family: 'AEHF',
    id: 44481,
    label: 'AEHF 5',
    cacheUrl: '/orbital/n2yo_44481_positions.json',
  },
  {
    family: 'AEHF',
    id: 45465,
    label: 'AEHF 6',
    cacheUrl: '/orbital/n2yo_45465_positions.json',
  },
  {
    family: 'MUOS',
    id: 38093,
    label: 'MUOS 1',
    cacheUrl: '/orbital/n2yo_38093_positions.json',
  },
  {
    family: 'MUOS',
    id: 39206,
    label: 'MUOS 2',
    cacheUrl: '/orbital/n2yo_39206_positions.json',
  },
  {
    family: 'MUOS',
    id: 40374,
    label: 'MUOS 3',
    cacheUrl: '/orbital/n2yo_40374_positions.json',
  },
  {
    family: 'MUOS',
    id: 40887,
    label: 'MUOS 4',
    cacheUrl: '/orbital/n2yo_40887_positions.json',
  },
  {
    family: 'MUOS',
    id: 41622,
    label: 'MUOS 5',
    cacheUrl: '/orbital/n2yo_41622_positions.json',
  },
  {
    family: 'WGS',
    id: 32258,
    label: 'WGS 1',
    cacheUrl: '/orbital/n2yo_32258_positions.json',
  },
  {
    family: 'WGS',
    id: 34713,
    label: 'WGS 2',
    cacheUrl: '/orbital/n2yo_34713_positions.json',
  },
  {
    family: 'WGS',
    id: 36108,
    label: 'WGS 3',
    cacheUrl: '/orbital/n2yo_36108_positions.json',
  },
  {
    family: 'WGS',
    id: 38070,
    label: 'WGS 4',
    cacheUrl: '/orbital/n2yo_38070_positions.json',
  },
  {
    family: 'WGS',
    id: 39168,
    label: 'WGS 5',
    cacheUrl: '/orbital/n2yo_39168_positions.json',
  },
  {
    family: 'WGS',
    id: 39222,
    label: 'WGS 6',
    cacheUrl: '/orbital/n2yo_39222_positions.json',
  },
  {
    family: 'WGS',
    id: 40746,
    label: 'WGS 7',
    cacheUrl: '/orbital/n2yo_40746_positions.json',
  },
  {
    family: 'SBIRS',
    id: 37481,
    label: 'SBIRS-GEO 1',
    cacheUrl: '/orbital/n2yo_37481_positions.json',
  },
  {
    family: 'SBIRS',
    id: 39120,
    label: 'SBIRS-GEO 2',
    cacheUrl: '/orbital/n2yo_39120_positions.json',
  },
  {
    family: 'SBIRS',
    id: 41937,
    label: 'SBIRS-GEO 3',
    cacheUrl: '/orbital/n2yo_41937_positions.json',
  },
  {
    family: 'SBIRS',
    id: 43162,
    label: 'SBIRS-GEO 4',
    cacheUrl: '/orbital/n2yo_43162_positions.json',
  },
  {
    family: 'SBIRS',
    id: 48618,
    label: 'SBIRS-GEO 5',
    cacheUrl: '/orbital/n2yo_48618_positions.json',
  },
  {
    family: 'SBIRS',
    id: 53355,
    label: 'SBIRS-GEO 6',
    cacheUrl: '/orbital/n2yo_53355_positions.json',
  },
  {
    family: 'GSSAP',
    id: 40099,
    label: 'GSSAP 1',
    cacheUrl: '/orbital/n2yo_40099_positions.json',
  },
  {
    family: 'GSSAP',
    id: 40100,
    label: 'GSSAP 2',
    cacheUrl: '/orbital/n2yo_40100_positions.json',
  },
  {
    family: 'GSSAP',
    id: 41744,
    label: 'GSSAP 3',
    cacheUrl: '/orbital/n2yo_41744_positions.json',
  },
  {
    family: 'GSSAP',
    id: 41745,
    label: 'GSSAP 4',
    cacheUrl: '/orbital/n2yo_41745_positions.json',
  },
  {
    family: 'GPS-3',
    id: 43873,
    label: 'GPS-3 1',
    cacheUrl: '/orbital/n2yo_43873_positions.json',
  },
  {
    family: 'GPS-3',
    id: 44506,
    label: 'GPS-3 2',
    cacheUrl: '/orbital/n2yo_44506_positions.json',
  },
  {
    family: 'GPS-3',
    id: 45854,
    label: 'GPS-3 3',
    cacheUrl: '/orbital/n2yo_45854_positions.json',
  },
  {
    family: 'GPS-3',
    id: 46826,
    label: 'GPS-3 4',
    cacheUrl: '/orbital/n2yo_46826_positions.json',
  },
  {
    family: 'GPS-3',
    id: 48859,
    label: 'GPS-3 5',
    cacheUrl: '/orbital/n2yo_48859_positions.json',
  },
  {
    family: 'GPS-3',
    id: 55268,
    label: 'GPS-3 6',
    cacheUrl: '/orbital/n2yo_55268_positions.json',
  },
  {
    family: 'GPS-3',
    id: 62339,
    label: 'GPS-3 7',
    cacheUrl: '/orbital/n2yo_62339_positions.json',
  },
  {
    family: 'GPS-3',
    id: 64202,
    label: 'GPS-3 8',
    cacheUrl: '/orbital/n2yo_64202_positions.json',
  },
  {
    family: 'GPS-3',
    id: 67588,
    label: 'GPS-3 9',
    cacheUrl: '/orbital/n2yo_67588_positions.json',
  },
  {
    family: 'CHINA',
    id: 29092,
    label: 'YAOGAN 1',
    cacheUrl: '/orbital/n2yo_29092_positions.json',
  },
  {
    family: 'CHINA',
    id: 45461,
    label: 'YAOGAN-30 S',
    cacheUrl: '/orbital/n2yo_45461_positions.json',
  },
  {
    family: 'CHINA',
    id: 57727,
    label: 'YAOGAN-39 01A',
    cacheUrl: '/orbital/n2yo_57727_positions.json',
  },
  {
    family: 'CHINA',
    id: 60948,
    label: 'YAOGAN-43 02D',
    cacheUrl: '/orbital/n2yo_60948_positions.json',
  },
  {
    family: 'CHINA',
    id: 31490,
    label: 'YAOGAN 2',
    cacheUrl: '/orbital/n2yo_31490_positions.json',
  },
  {
    family: 'CHINA',
    id: 39410,
    label: 'YAOGAN 19',
    cacheUrl: '/orbital/n2yo_39410_positions.json',
  },
  {
    family: 'CHINA',
    id: 43030,
    label: 'YAOGAN-30 F',
    cacheUrl: '/orbital/n2yo_43030_positions.json',
  },
  {
    family: 'RUSSIA',
    id: 32276,
    label: 'COSMOS 2432',
    cacheUrl: '/orbital/n2yo_32276_positions.json',
  },
  {
    family: 'RUSSIA',
    id: 33467,
    label: 'COSMOS 2449',
    cacheUrl: '/orbital/n2yo_33467_positions.json',
  },
  {
    family: 'RUSSIA',
    id: 29670,
    label: 'COSMOS 2425',
    cacheUrl: '/orbital/n2yo_29670_positions.json',
  },
  {
    family: 'RUSSIA',
    id: 33378,
    label: 'COSMOS 2442',
    cacheUrl: '/orbital/n2yo_33378_positions.json',
  },
  {
    family: 'RUSSIA',
    id: 33468,
    label: 'COSMOS 2448',
    cacheUrl: '/orbital/n2yo_33468_positions.json',
  },
  {
    family: 'RUSSIA',
    id: 32393,
    label: 'COSMOS 2434',
    cacheUrl: '/orbital/n2yo_32393_positions.json',
  },
  {
    family: 'RUSSIA',
    id: 29671,
    label: 'COSMOS 2426',
    cacheUrl: '/orbital/n2yo_29671_positions.json',
  },
  {
    family: 'RUSSIA',
    id: 33379,
    label: 'COSMOS 2443',
    cacheUrl: '/orbital/n2yo_33379_positions.json',
  },
  {
    family: 'RUSSIA',
    id: 32395,
    label: 'COSMOS 2436',
    cacheUrl: '/orbital/n2yo_32395_positions.json',
  },
]

const MAP_FONT =
  '12px "Aptos Display", Aptos, "IBM Plex Sans Condensed", "IBM Plex Sans", "SF Pro Text", ui-sans-serif, system-ui, sans-serif'
const MAP_PANEL = Color.fromCssColorString('#091112')
// Dedicated orbital palette. These colors deliberately avoid the Brigade COP
// scenario/alert palette so a WGS marker never reads as "regional" or "blue
// team"; it reads as a WGS-family satellite.
export const FAMILY_COLOR_HEX: Record<N2YOSatelliteFamily, string> = {
  AEHF: '#ff8bd1',
  MUOS: '#b99cff',
  WGS: '#f2edd7',
  SBIRS: '#ffb26b',
  GSSAP: '#b7a7a0',
  'GPS-3': '#e6d66f',
  CHINA: '#ef4444',
  RUSSIA: '#38bdf8',
}

export const FAMILY_SHORT_LABEL: Record<N2YOSatelliteFamily, string> = {
  AEHF: 'Protected comms',
  MUOS: 'Mobile UHF',
  WGS: 'Wideband comms',
  SBIRS: 'Missile warning',
  GSSAP: 'Space surveillance',
  'GPS-3': 'PNT timing',
  CHINA: 'Chinese ISR',
  RUSSIA: 'GLONASS / ISR',
}

const familyColor = (family: N2YOSatelliteFamily) =>
  Color.fromCssColorString(FAMILY_COLOR_HEX[family])
// Display-altitude scale. True orbital altitudes span ~400 km (ISS-class
// LEO) to ~36,000 km (GEO) — a 90× ratio that won't fit on one camera
// frame. We compress the range linearly into the values below so the
// scene reads correctly without losing the LEO-vs-MEO-vs-GEO separation.
// Earlier values (260 km / 920 km) put even GEO satellites visually
// flush against the limb, so the orbit ring looked surface-clamped.
const MIN_DISPLAY_ALTITUDE_M = 800000
const MAX_DISPLAY_ALTITUDE_M = 6000000
const ORBIT_SAMPLE_COUNT = 240
// Single motion knob: 1 = real-time orbital motion, 45 = 45 seconds of
// orbital motion per wall-clock second. GEO families remain fixed.
const ORBIT_MOTION_PLAYBACK_SPEED = 45
const EARTH_RADIUS_M = 6371000
const EARTH_GRAVITATIONAL_PARAMETER = 3.986004418e14
const RESET_CAMERA_LONGITUDE_DEG = 0
const RESET_CAMERA_LATITUDE_DEG = 0
const RESET_CAMERA_ALTITUDE_M = 22000000

type N2YOTrackPoint = {
  timestamp: number
  timestamp_utc: string
  lat: number
  lng: number
  alt_km: number
}

export type N2YODisplayPoint = {
  lat: number
  lng: number
  timestampUtc: string
}

export type N2YOPositionCache = {
  fetched_at: string
  satellite: {
    id: number
    name: string
  }
  track: N2YOTrackPoint[]
  orbit?: N2YOTrackPoint[]
  tle?: {
    line1: string
    line2: string
  }
}

export type N2YOLayerState = {
  cache: N2YOPositionCache
  displayAltitudeM: number
  entityIds: string[]
  point: N2YOTrackPoint
  satelliteFamily: N2YOSatelliteFamily
  satelliteId: number
  satelliteName: string
}

export const orbitEntityIdForSatellite = (satelliteId: number) =>
  `n2yo-${satelliteId}-orbit`

const parsedPositionCacheByUrl = new Map<string, N2YOPositionCache>()
const pendingPositionCacheByUrl = new Map<string, Promise<N2YOPositionCache>>()

const realSatelliteMarker = (colorHex: string, family: N2YOSatelliteFamily) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="58" viewBox="0 0 64 58">
      <filter id="g" x="-70%" y="-70%" width="240%" height="240%">
        <feDropShadow dx="0" dy="1" stdDeviation="2.0" flood-color="#000000" flood-opacity="0.82"/>
        <feDropShadow dx="0" dy="0" stdDeviation="3.4" flood-color="${colorHex}" flood-opacity="0.55"/>
      </filter>
      <!-- Stylised spacecraft side-profile: bus body (rectangle) flanked
           by two solar-panel arrays, with a high-gain antenna rising
           from the top. Cell dividers on the panels read as a satellite
           rather than a generic chevron. -->
      <g transform="translate(6 0)" stroke="${colorHex}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" filter="url(#g)" fill="none">
        <!-- left solar array -->
        <rect x="3" y="22" width="14" height="8" />
        <line x1="10" y1="22" x2="10" y2="30" />
        <!-- right solar array -->
        <rect x="35" y="22" width="14" height="8" />
        <line x1="42" y1="22" x2="42" y2="30" />
        <!-- bus / spacecraft body (filled so the wings read as separate) -->
        <rect x="20" y="19" width="12" height="14" fill="rgba(2,4,4,0.86)" />
        <line x1="20" y1="26" x2="32" y2="26" />
        <!-- antenna stem + dish -->
        <line x1="26" y1="19" x2="26" y2="11" />
        <circle cx="26" cy="9" r="2.2" fill="rgba(2,4,4,0.86)" />
      </g>
      <rect x="11" y="39" width="42" height="13" rx="1.5" fill="rgba(2,4,4,0.9)" stroke="${colorHex}" stroke-width="1.2"/>
      <text x="32" y="49" fill="${colorHex}" text-anchor="middle" font-family="Aptos, IBM Plex Sans, Arial, sans-serif" font-size="8.5" font-weight="800" letter-spacing="0.6">${family}</text>
    </svg>`,
  )}`

const latestTrackPoint = (cache: N2YOPositionCache) =>
  cache.track.reduce((latest, point) =>
    point.timestamp > latest.timestamp ? point : latest,
  )

export const latestN2YOAltitudeKm = (cache: N2YOPositionCache) =>
  latestTrackPoint(cache).alt_km

export function createN2YODisplayAltitudeScale(caches: N2YOPositionCache[]) {
  const altitudesKm = caches.map(latestN2YOAltitudeKm)
  const minAltitudeKm = Math.min(...altitudesKm)
  const maxAltitudeKm = Math.max(...altitudesKm)
  const altitudeRangeKm = Math.max(maxAltitudeKm - minAltitudeKm, 1)

  return (altitudeKm: number) => {
    const normalizedAltitude = (altitudeKm - minAltitudeKm) / altitudeRangeKm
    return (
      MIN_DISPLAY_ALTITUDE_M +
      normalizedAltitude * (MAX_DISPLAY_ALTITUDE_M - MIN_DISPLAY_ALTITUDE_M)
    )
  }
}

const formatUtcTime = (timestampUtc: string) =>
  new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(new Date(timestampUtc))

const toRadians = (degrees: number) => (degrees * Math.PI) / 180

const vectorFromPoint = (point: N2YOTrackPoint) => {
  const lat = toRadians(point.lat)
  const lon = toRadians(point.lng)
  const cosLat = Math.cos(lat)
  return {
    x: cosLat * Math.cos(lon),
    y: cosLat * Math.sin(lon),
    z: Math.sin(lat),
  }
}

const dot = (
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
) => a.x * b.x + a.y * b.y + a.z * b.z

const normalize = (v: { x: number; y: number; z: number }) => {
  const magnitude = Math.hypot(v.x, v.y, v.z) || 1
  return {
    x: v.x / magnitude,
    y: v.y / magnitude,
    z: v.z / magnitude,
  }
}

const latestPointOrbitBasis = (track: N2YOTrackPoint[]) => {
  const selectedPoint = latestTrackPoint({
    fetched_at: '',
    satellite: { id: 0, name: '' },
    track,
  })
  const selectedIndex = Math.max(
    track.findIndex((point) => point.timestamp === selectedPoint.timestamp),
    0,
  )
  const previousPoint = track[Math.max(selectedIndex - 1, 0)]
  const nextPoint = track[Math.min(selectedIndex + 1, track.length - 1)]
  const reference =
    nextPoint.timestamp !== selectedPoint.timestamp ? nextPoint : previousPoint
  const current = vectorFromPoint(selectedPoint)
  let tangent = {
    x: vectorFromPoint(reference).x - current.x,
    y: vectorFromPoint(reference).y - current.y,
    z: vectorFromPoint(reference).z - current.z,
  }
  const radialComponent = dot(tangent, current)
  tangent = normalize({
    x: tangent.x - radialComponent * current.x,
    y: tangent.y - radialComponent * current.y,
    z: tangent.z - radialComponent * current.z,
  })

  if (Math.hypot(tangent.x, tangent.y, tangent.z) < 0.000001) {
    tangent = normalize({ x: -current.y, y: current.x, z: 0 })
  }

  return { current, selectedPoint, tangent }
}

const cartesianFromOrbitBasis = (
  current: { x: number; y: number; z: number },
  tangent: { x: number; y: number; z: number },
  theta: number,
  displayAltitudeM: number,
) => {
  const sample = normalize({
    x: current.x * Math.cos(theta) + tangent.x * Math.sin(theta),
    y: current.y * Math.cos(theta) + tangent.y * Math.sin(theta),
    z: current.z * Math.cos(theta) + tangent.z * Math.sin(theta),
  })
  return Cartesian3.fromRadians(
    Math.atan2(sample.y, sample.x),
    Math.asin(sample.z),
    displayAltitudeM,
  )
}

const orbitalPeriodSeconds = (altitudeKm: number) => {
  const semiMajorAxisM = EARTH_RADIUS_M + altitudeKm * 1000
  return (
    2 *
    Math.PI *
    Math.sqrt(
      (semiMajorAxisM * semiMajorAxisM * semiMajorAxisM) /
        EARTH_GRAVITATIONAL_PARAMETER,
    )
  )
}

const createAnimatedOrbitPosition = (
  track: N2YOTrackPoint[],
  displayAltitudeM: number,
) => {
  return new CallbackPositionProperty(() => {
    const displayPoint = currentN2YODisplayPoint({ track })
    return Cartesian3.fromDegrees(
      displayPoint.lng,
      displayPoint.lat,
      displayAltitudeM,
    )
  }, false)
}

export function currentN2YODisplayPoint(
  layer: Pick<N2YOLayerState, 'cache' | 'satelliteFamily'> | Pick<N2YOPositionCache, 'track'>,
): N2YODisplayPoint {
  const track = 'cache' in layer ? layer.cache.track : layer.track
  const point = latestTrackPoint({
    fetched_at: '',
    satellite: { id: 0, name: '' },
    track,
  })

  if ('satelliteFamily' in layer && isN2YOGeostationaryFamily(layer.satelliteFamily)) {
    return {
      lat: point.lat,
      lng: point.lng,
      timestampUtc: point.timestamp_utc,
    }
  }

  const { current, selectedPoint, tangent } = latestPointOrbitBasis(track)
  const periodSeconds = orbitalPeriodSeconds(selectedPoint.alt_km)
  const elapsedSeconds =
    ((Date.now() - selectedPoint.timestamp * 1000) / 1000) *
    ORBIT_MOTION_PLAYBACK_SPEED
  const theta = ((elapsedSeconds % periodSeconds) / periodSeconds) * Math.PI * 2
  const sample = normalize({
    x: current.x * Math.cos(theta) + tangent.x * Math.sin(theta),
    y: current.y * Math.cos(theta) + tangent.y * Math.sin(theta),
    z: current.z * Math.cos(theta) + tangent.z * Math.sin(theta),
  })

  return {
    lat: Math.asin(sample.z) * (180 / Math.PI),
    lng: Math.atan2(sample.y, sample.x) * (180 / Math.PI),
    timestampUtc: new Date(
      selectedPoint.timestamp * 1000 + elapsedSeconds * 1000,
    ).toISOString(),
  }
}

const createSampledMotionOrbitPositions = (
  track: N2YOTrackPoint[],
  displayAltitudeM: number,
) => {
  const { current, tangent } = latestPointOrbitBasis(track)
  const positions: Cartesian3[] = []
  for (let index = 0; index <= ORBIT_SAMPLE_COUNT; index += 1) {
    const theta = (index / ORBIT_SAMPLE_COUNT) * Math.PI * 2
    positions.push(cartesianFromOrbitBasis(current, tangent, theta, displayAltitudeM))
  }
  return positions
}

export async function fetchN2YOPositionCache(
  config: N2YOSatelliteConfig,
): Promise<N2YOPositionCache> {
  const parsedCache = parsedPositionCacheByUrl.get(config.cacheUrl)
  if (parsedCache) {
    return parsedCache
  }

  const pendingCache = pendingPositionCacheByUrl.get(config.cacheUrl)
  if (pendingCache) {
    return pendingCache
  }

  const cachePromise = fetch(config.cacheUrl)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`failed to load N2YO cache: HTTP ${response.status}`)
      }

      const cache = (await response.json()) as N2YOPositionCache
      if (!Array.isArray(cache.track) || cache.track.length === 0) {
        throw new Error('N2YO cache did not contain track points')
      }

      parsedPositionCacheByUrl.set(config.cacheUrl, cache)
      return cache
    })
    .finally(() => {
      pendingPositionCacheByUrl.delete(config.cacheUrl)
    })

  pendingPositionCacheByUrl.set(config.cacheUrl, cachePromise)
  return cachePromise
}

export function clearN2YOSatelliteLayer(
  viewer: Viewer,
  layer: Pick<N2YOLayerState, 'entityIds'> | null,
) {
  layer?.entityIds.forEach((id) => viewer.entities.removeById(id))
}

export function addN2YOSatellite(
  viewer: Viewer,
  cache: N2YOPositionCache,
  config: N2YOSatelliteConfig,
  displayAltitudeM: number,
): N2YOLayerState {
  const point = latestTrackPoint(cache)
  const satelliteId = cache.satellite.id
  const satelliteName = config.label || cache.satellite.name || `NORAD ${satelliteId}`
  const isGeostationary = isN2YOGeostationaryFamily(config.family)
  const position = isGeostationary
    ? Cartesian3.fromDegrees(point.lng, point.lat, displayAltitudeM)
    : createAnimatedOrbitPosition(cache.track, displayAltitudeM)
  const footprintPosition = isGeostationary
    ? Cartesian3.fromDegrees(point.lng, point.lat, 0)
    : createAnimatedOrbitPosition(cache.track, 0)
  const entityIds = [
    `n2yo-${satelliteId}-satellite`,
    `n2yo-${satelliteId}-footprint`,
  ]
  const familyHex = FAMILY_COLOR_HEX[config.family]
  const familyColorObj = familyColor(config.family)

  clearN2YOSatelliteLayer(viewer, { entityIds })

  viewer.entities.add({
    id: entityIds[0],
    name: `REAL N2YO ${satelliteName}`,
    position,
    billboard: {
      color: Color.WHITE,
      disableDepthTestDistance: 0,
      height: 74,
      image: realSatelliteMarker(familyHex, config.family),
      scaleByDistance: new NearFarScalar(1500000, 1, 25000000, 0.62),
      width: 82,
    },
    label: {
      backgroundColor: MAP_PANEL.withAlpha(0.9),
      disableDepthTestDistance: 0,
      fillColor: Color.WHITE,
      font: MAP_FONT,
      pixelOffset: new Cartesian2(0, -42),
      scaleByDistance: new NearFarScalar(1500000, 1, 25000000, 0.58),
      show: false,
      showBackground: true,
      style: LabelStyle.FILL,
      text: `${config.family} · ${FAMILY_SHORT_LABEL[config.family]}\n${satelliteName}\nNORAD ${cache.satellite.id}\nTRUE ALT ${Math.round(point.alt_km).toLocaleString()} km\n${formatUtcTime(point.timestamp_utc)}`,
    },
    description: `${config.family} ${FAMILY_SHORT_LABEL[config.family]} satellite from N2YO cache. NORAD ${cache.satellite.id}. True altitude ${point.alt_km.toFixed(2)} km; displayed at ${(displayAltitudeM / 1000).toFixed(0)} km for scene readability.`,
  })

  viewer.entities.add({
    id: entityIds[1],
    name: `${satelliteName} sub-satellite point`,
    position: footprintPosition,
    ellipse: {
      semiMajorAxis: 160000,
      semiMinorAxis: 160000,
      material: familyColorObj.withAlpha(0.05),
      outline: true,
      outlineColor: familyColorObj.withAlpha(0.55),
    },
  })

  return {
    cache,
    displayAltitudeM,
    entityIds,
    point,
    satelliteFamily: config.family,
    satelliteId,
    satelliteName,
  }
}

export function clearN2YOSatelliteLayers(
  viewer: Viewer,
  layers: N2YOLayerState[],
) {
  layers.forEach((layer) => {
    hideN2YOOrbit(viewer, layer)
    clearN2YOSatelliteLayer(viewer, layer)
  })
}

export function selectN2YOSatellite(
  viewer: Viewer,
  layer: N2YOLayerState,
) {
  const entity = viewer.entities.getById(layer.entityIds[0])
  if (!entity) {
    return []
  }

  entity.label!.show = new ConstantProperty(true)

  showN2YOOrbit(viewer, layer)

  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(
      RESET_CAMERA_LONGITUDE_DEG,
      RESET_CAMERA_LATITUDE_DEG,
      RESET_CAMERA_ALTITUDE_M,
    ),
    duration: 0.6,
  })

  return isN2YOGeostationaryFamily(layer.satelliteFamily)
    ? []
    : [orbitEntityIdForSatellite(layer.satelliteId)]
}

export function deselectN2YOSatellite(viewer: Viewer, layer: N2YOLayerState) {
  const entity = viewer.entities.getById(layer.entityIds[0])
  if (entity?.label) {
    entity.label.show = new ConstantProperty(false)
  }
  hideN2YOOrbit(viewer, layer)
}

export function showN2YOOrbit(viewer: Viewer, layer: N2YOLayerState) {
  const orbitId = orbitEntityIdForSatellite(layer.satelliteId)
  viewer.entities.removeById(orbitId)

  if (isN2YOGeostationaryFamily(layer.satelliteFamily)) {
    return
  }

  const positions = createSampledMotionOrbitPositions(
    layer.cache.track,
    layer.displayAltitudeM,
  )
  if (positions.length <= 1) {
    return
  }

  viewer.entities.add({
    id: orbitId,
    name: `${layer.satelliteName} orbital path`,
    polyline: {
      // ArcType.NONE = straight 3D line segments between Cartesian3 points.
      // Default GEODESIC interpolates along the surface ellipsoid, which
      // collapses altitude-bearing points down to ground level even when
      // clampToGround is false.
      arcType: ArcType.NONE,
      clampToGround: false,
      material: new PolylineDashMaterialProperty({
        color: familyColor(layer.satelliteFamily).withAlpha(0.86),
        dashLength: 18,
      }),
      positions,
      width: 2,
    },
  })
}

export function hideN2YOOrbit(viewer: Viewer, layer: N2YOLayerState) {
  viewer.entities.removeById(orbitEntityIdForSatellite(layer.satelliteId))
}

// --- Maneuver-demo helpers --------------------------------------------------
// Used by the operator-action panel's "execute burn" visualization. The demo
// needs three things the rest of the layer keeps private: the live orbital
// basis (so we can rotate it for a plane change), a position lookup that
// accepts an arbitrary tangent (so the demo can paint the post-burn track
// without re-implementing the orbit math), and an orbit polyline sampler.
// These are intentionally narrow exports — anything more general would
// duplicate the existing select/show APIs.

export type N2YOVector3 = { x: number; y: number; z: number }

export type N2YOOrbitMotion = {
  current: N2YOVector3
  tangent: N2YOVector3
  selectedTimestampSec: number
  periodSeconds: number
  displayAltitudeM: number
  isGeo: boolean
}

export function getN2YOOrbitMotion(layer: N2YOLayerState): N2YOOrbitMotion {
  const basis = latestPointOrbitBasis(layer.cache.track)
  return {
    current: basis.current,
    tangent: basis.tangent,
    selectedTimestampSec: basis.selectedPoint.timestamp,
    periodSeconds: orbitalPeriodSeconds(basis.selectedPoint.alt_km),
    displayAltitudeM: layer.displayAltitudeM,
    isGeo: isN2YOGeostationaryFamily(layer.satelliteFamily),
  }
}

/** Rotate the orbit's tangent vector around the radial axis (the line from
 *  earth's center through the satellite's current position). This produces
 *  a new orbit that intersects the original at the basis point but tilts at
 *  the given angle — analogous to an impulsive plane-change burn applied at
 *  that point. */
export function rotateN2YOOrbitTangent(
  motion: N2YOOrbitMotion,
  angleRad: number,
): N2YOVector3 {
  const axis = motion.current
  const tangent = motion.tangent
  // axis × tangent gives the binormal (orbit-plane normal-ish unit vector
  // since axis ⊥ tangent by construction in latestPointOrbitBasis).
  const binormal = {
    x: axis.y * tangent.z - axis.z * tangent.y,
    y: axis.z * tangent.x - axis.x * tangent.z,
    z: axis.x * tangent.y - axis.y * tangent.x,
  }
  const c = Math.cos(angleRad)
  const s = Math.sin(angleRad)
  return normalize({
    x: tangent.x * c + binormal.x * s,
    y: tangent.y * c + binormal.y * s,
    z: tangent.z * c + binormal.z * s,
  })
}

/** Live orbital phase (theta) for a motion descriptor at the given wall-clock
 *  timestamp. Used by the maneuver demo to place a tailing adversary at a
 *  fixed angular offset behind the friendly. */
export function n2yoCurrentOrbitalTheta(
  motion: N2YOOrbitMotion,
  nowMs: number = Date.now(),
): number {
  if (motion.isGeo) {
    return 0
  }
  const elapsedSec =
    ((nowMs - motion.selectedTimestampSec * 1000) / 1000) *
    ORBIT_MOTION_PLAYBACK_SPEED
  return ((elapsedSec % motion.periodSeconds) / motion.periodSeconds) * Math.PI * 2
}

/** Compute the position on an orbit (with optional rotated tangent) at an
 *  explicit theta. Lets the demo place the trailing hostile at any phase
 *  offset from the friendly's live position. */
export function n2yoOrbitalPositionAtTheta(
  motion: N2YOOrbitMotion,
  tangent: N2YOVector3,
  theta: number,
): Cartesian3 {
  if (motion.isGeo) {
    return Cartesian3.fromRadians(
      Math.atan2(motion.current.y, motion.current.x),
      Math.asin(Math.max(-1, Math.min(1, motion.current.z))),
      motion.displayAltitudeM,
    )
  }
  return cartesianFromOrbitBasis(
    motion.current,
    tangent,
    theta,
    motion.displayAltitudeM,
  )
}

/** Compute the live position on an orbit, given a (possibly rotated) tangent.
 *  Mirrors the math in currentN2YODisplayPoint but expressed in Cartesian for
 *  the maneuver overlay's polylines and position properties. */
export function n2yoOrbitalPositionAt(
  motion: N2YOOrbitMotion,
  tangent: N2YOVector3,
  nowMs: number = Date.now(),
): Cartesian3 {
  return n2yoOrbitalPositionAtTheta(
    motion,
    tangent,
    n2yoCurrentOrbitalTheta(motion, nowMs),
  )
}

/** Sample one full orbit ring as Cartesian3 positions, using a (possibly
 *  rotated) tangent. Used to draw the post-burn orbital track. */
export function n2yoOrbitSamples(
  motion: N2YOOrbitMotion,
  tangent: N2YOVector3,
): Cartesian3[] {
  if (motion.isGeo) {
    return []
  }
  const positions: Cartesian3[] = []
  for (let index = 0; index <= ORBIT_SAMPLE_COUNT; index += 1) {
    const theta = (index / ORBIT_SAMPLE_COUNT) * Math.PI * 2
    positions.push(
      cartesianFromOrbitBasis(
        motion.current,
        tangent,
        theta,
        motion.displayAltitudeM,
      ),
    )
  }
  return positions
}

export function setN2YOSatelliteLayerVisible(
  viewer: Viewer,
  layer: N2YOLayerState,
  visible: boolean,
) {
  layer.entityIds.forEach((id) => {
    const entity = viewer.entities.getById(id)
    if (entity) {
      entity.show = visible
    }
  })

  if (!visible) {
    hideN2YOOrbit(viewer, layer)
  }
}

export function setN2YOOrbitsVisible(
  viewer: Viewer,
  layers: N2YOLayerState[],
  visible: boolean,
) {
  layers.forEach((layer) => {
    if (visible) {
      showN2YOOrbit(viewer, layer)
    } else {
      hideN2YOOrbit(viewer, layer)
    }
  })
}
