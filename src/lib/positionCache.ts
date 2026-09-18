// Position-cache fetching for the satellite layer, kept free of Cesium so the
// missing-file guard can be unit-tested. The N2YO caches under
// public/orbital/ and the synthetic demo tracks share this shape.
export type N2YOTrackPoint = {
  timestamp: number
  timestamp_utc: string
  lat: number
  lng: number
  alt_km: number
}

/** Extra block the demo-scenario lane writes into a synthetic track file. */
export type SyntheticTrackInfo = {
  display_name?: string
  satellite_id?: string
  epoch_utc?: string
  note?: string
  orbit?: { altitude_km?: number; inclination_deg?: number; period_s?: number }
  pass?: {
    site?: string
    site_lat?: number
    site_lng?: number
    site_alt_m?: number
    closest_approach_utc?: string
    closest_approach_km?: number
    max_elevation_deg?: number
    track_window_utc?: [string, string]
  }
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
  } | null
  realism?: string
  synthetic?: SyntheticTrackInfo
}

/** The track point to pin a synthetic spacecraft at: the sample nearest its
 *  pass's closest approach, else the middle of the track. Real tracks use
 *  their latest point and animate from there; a synthetic demo track is
 *  shown at its pass so the spacecraft, the ground station and the RF marker
 *  share one frame whenever the console is opened. */
export function syntheticAnchorPoint(cache: N2YOPositionCache): N2YOTrackPoint {
  const track = cache.track
  const target = cache.synthetic?.pass?.closest_approach_utc
  const targetTs = target ? Date.parse(target) / 1000 : Number.NaN
  if (Number.isFinite(targetTs)) {
    return track.reduce((best, point) =>
      Math.abs(point.timestamp - targetTs) < Math.abs(best.timestamp - targetTs) ? point : best,
    )
  }
  return track[Math.floor(track.length / 2)]
}

/** The part of a layer entry the fetcher needs. */
export type PositionCacheSource = {
  cacheUrl: string
  synthetic?: boolean
}

const parsedPositionCacheByUrl = new Map<string, N2YOPositionCache>()
const pendingPositionCacheByUrl = new Map<string, Promise<N2YOPositionCache>>()

/** Test hook: forget every parsed and pending cache. */
export function clearPositionCacheMemory() {
  parsedPositionCacheByUrl.clear()
  pendingPositionCacheByUrl.clear()
}

export async function fetchN2YOPositionCache<C extends PositionCacheSource>(
  config: C,
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
        throw new Error(
          `${config.synthetic ? 'synthetic track not present' : 'failed to load N2YO cache'}: HTTP ${response.status}`,
        )
      }

      const cache = (await response.json()) as N2YOPositionCache
      if (!Array.isArray(cache.track) || cache.track.length === 0) {
        throw new Error('position cache did not contain track points')
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

export type N2YOLoadResult<C extends PositionCacheSource> = {
  loaded: Array<{ config: C; cache: N2YOPositionCache }>
  /** Entries whose file could not be fetched or parsed; synthetic ones are
   *  expected to be absent until the demo-scenario lane writes them. */
  missing: Array<{ config: C; error: string }>
}

/** Fetch every position cache, keeping the ones that load. A missing or
 *  malformed file never fails the whole layer. */
export async function loadN2YOPositionCaches<C extends PositionCacheSource>(
  configs: C[],
): Promise<N2YOLoadResult<C>> {
  const settled = await Promise.allSettled(
    configs.map((config) => fetchN2YOPositionCache(config)),
  )
  const result: N2YOLoadResult<C> = { loaded: [], missing: [] }
  settled.forEach((outcome, index) => {
    const config = configs[index]
    if (outcome.status === 'fulfilled') {
      result.loaded.push({ config, cache: outcome.value })
    } else {
      result.missing.push({
        config,
        error:
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason),
      })
    }
  })
  return result
}
