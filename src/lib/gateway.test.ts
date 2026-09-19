import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_API_URL,
  DEV_BRIDGE_URL,
  apiToken,
  apiUrl,
  authHeaders,
  fetchGateway,
  wsUrl,
  wsUrlWithToken,
  type GatewayEnv,
} from './gateway'

const OPEN: GatewayEnv = {}
const TOKEN = 'deploy-secret'
const LOCKED: GatewayEnv = { VITE_CANOPY_API_TOKEN: TOKEN }
const ok = () => ({ ok: true, status: 200, json: () => Promise.resolve({}) }) as unknown as Response

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('gateway addresses', () => {
  it('apiUrl is VITE_CANOPY_API_URL, else the local gateway', () => {
    expect(apiUrl(OPEN)).toBe('http://localhost:8000')
    expect(DEFAULT_API_URL).toBe('http://localhost:8000')
    expect(apiUrl({ VITE_CANOPY_API_URL: 'http://gw:8080/api' })).toBe('http://gw:8080/api')
  })

  it('wsUrl is VITE_CANOPY_WS_URL trimmed, else the dev bridge in development, else no socket', () => {
    expect(wsUrl({ VITE_CANOPY_WS_URL: ' ws://gw:8080/ws ' })).toBe('ws://gw:8080/ws')
    expect(wsUrl({ VITE_CANOPY_WS_URL: '   ', DEV: true })).toBe(DEV_BRIDGE_URL)
    expect(wsUrl({ DEV: true })).toBe('ws://127.0.0.1:8000/ws')
    expect(wsUrl({ DEV: false })).toBeNull()
    expect(wsUrl(OPEN)).toBeNull()
  })
})

describe('gateway token', () => {
  it('no token: no header, and the socket URL is returned untouched', () => {
    expect(apiToken(OPEN)).toBeNull()
    expect(apiToken({ VITE_CANOPY_API_TOKEN: '   ' })).toBeNull()
    expect(authHeaders(OPEN)).toEqual({})
    expect(wsUrlWithToken('ws://gw/ws', OPEN)).toBe('ws://gw/ws')
    expect(wsUrlWithToken('ws://gw/ws?x=1', OPEN)).toBe('ws://gw/ws?x=1')
    expect(wsUrlWithToken(null, OPEN)).toBeNull()
    expect(wsUrlWithToken(undefined, { DEV: true })).toBe(DEV_BRIDGE_URL)
  })

  it('token: a bearer header for REST and ?token= (or &token=) on the socket URL', () => {
    expect(apiToken({ VITE_CANOPY_API_TOKEN: ` ${TOKEN} ` })).toBe(TOKEN)
    expect(authHeaders(LOCKED)).toEqual({ Authorization: `Bearer ${TOKEN}` })
    expect(wsUrlWithToken('ws://gw/ws', LOCKED)).toBe(`ws://gw/ws?token=${TOKEN}`)
    expect(wsUrlWithToken('ws://gw/ws?x=1', LOCKED)).toBe(`ws://gw/ws?x=1&token=${TOKEN}`)
    expect(wsUrlWithToken(undefined, { ...LOCKED, VITE_CANOPY_WS_URL: 'ws://gw/ws' })).toBe(
      `ws://gw/ws?token=${TOKEN}`,
    )
    // No socket configured: still no socket, token or not.
    expect(wsUrlWithToken(undefined, LOCKED)).toBeNull()
    expect(wsUrlWithToken(null, LOCKED)).toBeNull()
  })

  it('escapes the token for the query string and leaves the header verbatim', () => {
    const env: GatewayEnv = { VITE_CANOPY_API_TOKEN: 'a b+c/d=e&f#g' }
    const url = wsUrlWithToken('ws://gw/ws', env)
    expect(url).toBe('ws://gw/ws?token=a%20b%2Bc%2Fd%3De%26f%23g')
    // Round trip through a standards parser: the gateway reads back the original.
    expect(new URL(url).searchParams.get('token')).toBe('a b+c/d=e&f#g')
    expect(authHeaders(env)).toEqual({ Authorization: 'Bearer a b+c/d=e&f#g' })
  })

  it('reads import.meta.env when no env is passed', () => {
    expect(authHeaders()).toEqual({})
    expect(wsUrlWithToken('ws://gw/ws')).toBe('ws://gw/ws')
    vi.stubEnv('VITE_CANOPY_API_TOKEN', TOKEN)
    expect(apiToken()).toBe(TOKEN)
    expect(authHeaders()).toEqual({ Authorization: `Bearer ${TOKEN}` })
    expect(wsUrlWithToken('ws://gw/ws')).toBe(`ws://gw/ws?token=${TOKEN}`)
  })
})

describe('fetchGateway', () => {
  it('open gateway: the call is exactly what the call site sent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok())
    await fetchGateway('/kb', undefined, { fetchImpl, env: OPEN })
    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:8000/kb')
    expect(fetchImpl.mock.calls[0]).toHaveLength(1)

    const init: RequestInit = { method: 'POST' }
    await fetchGateway('/reset', init, { fetchImpl, baseUrl: 'http://gw:8000', env: OPEN })
    expect(fetchImpl).toHaveBeenLastCalledWith('http://gw:8000/reset', init)
    // The same object, not a copy: nothing is added for an open gateway.
    expect(fetchImpl.mock.calls[1][1]).toBe(init)
  })

  it('token: adds the bearer header and keeps the caller headers and options', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok())
    await fetchGateway('/stress', undefined, { fetchImpl, env: LOCKED })
    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:8000/stress', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })

    const body = JSON.stringify({ blocked_domains: ['rf_ew'] })
    await fetchGateway(
      '/stress',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
      { fetchImpl, baseUrl: 'http://gw:8000', env: LOCKED },
    )
    expect(fetchImpl).toHaveBeenLastCalledWith('http://gw:8000/stress', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    })
  })

  it('token: merges a Headers instance and header pairs, and wins over a caller Authorization', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok())
    await fetchGateway('/a', { headers: new Headers({ Accept: 'application/json' }) }, { fetchImpl, env: LOCKED })
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({
      accept: 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    })
    await fetchGateway('/b', { headers: [['Accept', 'text/plain']] }, { fetchImpl, env: LOCKED })
    expect(fetchImpl.mock.calls[1][1].headers).toEqual({
      Accept: 'text/plain',
      Authorization: `Bearer ${TOKEN}`,
    })
    await fetchGateway('/c', { headers: { Authorization: 'Bearer stale' } }, { fetchImpl, env: LOCKED })
    expect(fetchImpl.mock.calls[2][1].headers).toEqual({ Authorization: `Bearer ${TOKEN}` })
  })

  it('uses import.meta.env by default', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok())
    vi.stubEnv('VITE_CANOPY_API_TOKEN', TOKEN)
    await fetchGateway('/health', undefined, { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith(`${DEFAULT_API_URL}/health`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
  })
})
