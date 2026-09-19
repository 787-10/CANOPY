// How the console reaches the gateway: REST base, WebSocket URL and the
// deploy-time bearer token (docs/C2-API.md section 1; docs/DEMO-RUNBOOK.md,
// "Secure profile"). Every REST call site goes through fetchGateway() and the
// socket hook through wsUrlWithToken(), so building the console with
// VITE_CANOPY_API_TOKEN is the whole client side of the secure profile.
//
// With no token set every function returns exactly what the call sites
// computed for themselves before this module existed: the open, local demo
// is unchanged byte for byte.
//
// The token is a shared secret baked into the bundle by Vite: anyone who can
// load the console can read it. It keeps strangers off an exposed gateway; it
// is not per-user identity, rotation or transport security (PKI/CAC is
// Phase 1). Browsers cannot set headers on a WebSocket handshake, so the
// socket carries the token in its query string, which the gateway accepts.

/** The part of import.meta.env this module reads; tests pass it explicitly. */
export type GatewayEnv = {
  readonly VITE_CANOPY_API_URL?: string
  readonly VITE_CANOPY_WS_URL?: string
  readonly VITE_CANOPY_API_TOKEN?: string
  readonly DEV?: boolean
}

export const DEFAULT_API_URL = 'http://localhost:8000'
/** The gateway's /ws (canopy/api/__init__.py): the dev console's default. */
export const DEV_BRIDGE_URL = 'ws://127.0.0.1:8000/ws'

/** REST base: VITE_CANOPY_API_URL, else the local gateway. */
export function apiUrl(env: GatewayEnv = import.meta.env): string {
  return env.VITE_CANOPY_API_URL ?? DEFAULT_API_URL
}

/** WebSocket URL: VITE_CANOPY_WS_URL, else the dev bridge in development,
 *  else null (a production build without a configured gateway opens no
 *  socket and reports offline). */
export function wsUrl(env: GatewayEnv = import.meta.env): string | null {
  const configured = env.VITE_CANOPY_WS_URL?.trim()
  return configured || (env.DEV ? DEV_BRIDGE_URL : null)
}

/** The deploy-time token, or null when unset or blank (the gateway treats a
 *  blank CANOPY_API_TOKEN the same way). */
export function apiToken(env: GatewayEnv = import.meta.env): string | null {
  return env.VITE_CANOPY_API_TOKEN?.trim() || null
}

/** `{ Authorization: "Bearer <token>" }` when a token is set, else `{}`. */
export function authHeaders(env: GatewayEnv = import.meta.env): Record<string, string> {
  const token = apiToken(env)
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** `url` with `token=<token>` appended (`?` or `&` as the URL needs) when a
 *  token is set; `url` untouched otherwise. Without `url`, wsUrl(env). */
export function wsUrlWithToken(url: string, env?: GatewayEnv): string
export function wsUrlWithToken(url?: string | null, env?: GatewayEnv): string | null
export function wsUrlWithToken(
  url?: string | null,
  env: GatewayEnv = import.meta.env,
): string | null {
  const base = url === undefined ? wsUrl(env) : url
  const token = apiToken(env)
  if (base === null || token === null) return base
  return `${base}${base.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
}

export type FetchGatewayOptions = {
  /** Injected by tests; the global fetch otherwise. */
  fetchImpl?: typeof fetch
  /** REST base; apiUrl(env) otherwise. */
  baseUrl?: string
  env?: GatewayEnv
}

/** fetch(`${base}${path}`, init) with the bearer header merged in when a
 *  token is set. Without a token the call is exactly the caller's: the same
 *  URL and the same `init` object, or none, so an open gateway sees no
 *  change. */
export function fetchGateway(
  path: string,
  init?: RequestInit,
  { fetchImpl = fetch, baseUrl, env = import.meta.env }: FetchGatewayOptions = {},
): Promise<Response> {
  const url = `${baseUrl ?? apiUrl(env)}${path}`
  const auth = authHeaders(env)
  if (!auth.Authorization) {
    return init === undefined ? fetchImpl(url) : fetchImpl(url, init)
  }
  return fetchImpl(url, { ...init, headers: mergeHeaders(init?.headers, auth) })
}

/** A plain record of `existing` (record, Headers or pairs) with `extra` on
 *  top: the deploy token wins over a caller's own Authorization header. */
function mergeHeaders(
  existing: HeadersInit | undefined,
  extra: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {}
  if (typeof Headers !== 'undefined' && existing instanceof Headers) {
    existing.forEach((value, name) => {
      merged[name] = value
    })
  } else if (Array.isArray(existing)) {
    for (const [name, value] of existing) merged[name] = value
  } else if (existing) {
    Object.assign(merged, existing)
  }
  return { ...merged, ...extra }
}
