import { AgentMuxError, type TrustedDevice } from '@agentmux/core'
import { DeviceAuthority } from './device-authority.js'
import { requirePrivateHostAddress, type PrivateTlsIdentity } from './private-tls.js'

const DEVICE_COOKIE = '__Host-agentmux-device'
const PAIR_COOKIE = '__Host-agentmux-pair'
const DEVICE_PATH = '/_agentmux/device'
const MAX_BODY_BYTES = 4096

/** This opaque identity is supplied by transport admission, never caller JSON. */
export type PrivateAccessAuthorization = {
  readonly principal: Readonly<{ kind: 'device'; id: string }>
  readonly signal: AbortSignal
  dispose(): void
}
function denied(): AgentMuxError {
  return new AgentMuxError('This device or request is not authorized for this Host.', 'CONTROL_PERMISSION_DENIED')
}
function invalid(): AgentMuxError {
  return new AgentMuxError('The device request is incomplete or invalid.', 'INVALID_CONTROL_REQUEST')
}
function cookie(request: Request, name: string): string | undefined {
  const source = request.headers.get('cookie')
  if (!source) return undefined
  if (source.length > 8192) throw denied()
  const values = source.split(';').map(value => value.trim()).filter(value => value.startsWith(`${name}=`))
  if (values.length > 1) throw denied()
  return values[0]?.slice(name.length + 1)
}
function cookieHeader(name: string, value: string, seconds: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${seconds}`
}
async function body(request: Request, keys: readonly string[]): Promise<Record<string, string>> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json' || !request.body) throw invalid()
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_BODY_BYTES) throw invalid()
      chunks.push(next.value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw invalid() }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || !keys.every(key => Object.hasOwn(value, key) && typeof (value as Record<string, unknown>)[key] === 'string')) throw invalid()
  return value as Record<string, string>
}
function json(status: number, value: unknown, cookies: string[] = []): Response {
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  for (const value of cookies) headers.append('Set-Cookie', value)
  return new Response(JSON.stringify(value), { status, headers })
}

/** Admission hooks for the one public HTTPS transport. Owns no listener, RPC or Runtime. */
export class PrivateAccess {
  readonly origin: string
  private readonly host: string
  constructor(private readonly authority: DeviceAuthority, readonly tls: PrivateTlsIdentity) {
    requirePrivateHostAddress(tls.host)
    const origin = new URL(tls.origin)
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash
      || origin.pathname !== '/' || !Number.isInteger(tls.port) || tls.port < 1 || tls.port > 65535
      || origin.hostname.replace(/^\[|\]$/gu, '') !== tls.host || Number(origin.port || 443) !== tls.port) throw invalid()
    this.origin = origin.origin; this.host = origin.host.toLowerCase()
  }
  private native(request: Request): boolean {
    const transport = request.headers.get('x-agentmux-transport')
    if (transport === null) return false
    if (transport !== 'native' || request.headers.has('origin') || request.headers.has('cookie')
      || [...request.headers.keys()].some(key => key.startsWith('sec-fetch-'))) throw denied()
    return true
  }
  private requireOrigin(request: Request): boolean {
    // The public HTTPS server supplies this absolute Request; no client JSON is trusted here.
    const url = new URL(request.url)
    if (url.origin !== this.origin || url.username || url.password || url.search || url.hash
      || request.headers.get('host')?.toLowerCase() !== this.host) throw denied()
    const native = this.native(request)
    if (native) return true
    if (request.headers.has('authorization')) throw denied()
    const origin = request.headers.get('origin')
    if (origin !== null && origin !== this.origin) throw denied()
    if (request.method !== 'GET' && origin !== this.origin) throw denied()
    const site = request.headers.get('sec-fetch-site')
    if (site !== null && site !== 'same-origin' && site !== 'none') throw denied()
    return false
  }
  private device(request: Request, native: boolean): TrustedDevice {
    const header = native ? request.headers.get('authorization') : null
    const value = native ? (header?.startsWith('AgentMuxDevice ') ? header.slice('AgentMuxDevice '.length) : undefined)
      : cookie(request, DEVICE_COOKIE)
    if (!value || value.length > 1024) throw denied()
    const [hostId, credential, ...extra] = value.split('.')
    if (!hostId || !credential || extra.length) throw denied()
    return this.authority.authenticate(hostId, credential)
  }
  /** The common server binds this approved principal and signal to its request/consumer. */
  authorize(request: Request): PrivateAccessAuthorization | null {
    try {
      const device = this.device(request, this.requireOrigin(request)), observation = this.authority.observe(device)
      return { principal: Object.freeze({ kind: 'device', id: `${this.authority.hostId}:${device.deviceId}` }),
        signal: observation.signal, dispose: observation.dispose }
    } catch (error) {
      if (error instanceof AgentMuxError && error.code === 'CONTROL_PERMISSION_DENIED') return null
      // Capacity or observation failure is not proof that an approved device lost authorization.
      throw error
    }
  }
  /** No remote approve/revoke endpoint. The Mac user operates the original local Authority. */
  async route(request: Request): Promise<Response | null> {
    const path = new URL(request.url).pathname
    if (path !== DEVICE_PATH && path !== `${DEVICE_PATH}/status` && path !== `${DEVICE_PATH}/claim`) return null
    try {
      const native = this.requireOrigin(request)
      if (path === DEVICE_PATH && request.method === 'GET') return json(200, { hostId: this.authority.hostId })
      if (path === `${DEVICE_PATH}/status` && request.method === 'GET') {
        return json(200, { hostId: this.authority.hostId, device: this.device(request, native) })
      }
      if (path === DEVICE_PATH && request.method === 'POST') {
        const input = await body(request, ['hostId', 'invitation', 'name'])
        const pending = this.authority.begin(input.hostId!, input.invitation!, input.name!)
        const state = { state: 'waiting', hostId: pending.hostId, deviceId: pending.deviceId,
          confirmationCode: pending.confirmationCode, expiresAt: pending.expiresAt }
        // Native owns pending claim and credential below the JS bridge. Browser gets neither.
        if (native) return json(201, { ...state, claim: pending.claim })
        const privateClaim = Buffer.from(JSON.stringify({ hostId: pending.hostId, deviceId: pending.deviceId,
          claim: pending.claim })).toString('base64url')
        return json(201, state, [cookieHeader(PAIR_COOKIE, privateClaim,
          Math.max(1, Math.ceil((pending.expiresAt - Date.now()) / 1000)))])
      }
      if (path === `${DEVICE_PATH}/claim` && request.method === 'POST') {
        const input = await body(request, native ? ['hostId', 'deviceId', 'claim'] : ['hostId'])
        let pending: Record<string, unknown> = input
        if (!native) {
          const encoded = cookie(request, PAIR_COOKIE)
          if (!encoded || encoded.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) throw denied()
          try { pending = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) }
          catch { throw denied() }
          if (!pending || typeof pending !== 'object' || Array.isArray(pending) || Object.keys(pending).length !== 3
            || pending.hostId !== input.hostId || typeof pending.deviceId !== 'string' || typeof pending.claim !== 'string') throw denied()
        }
        const claimed = this.authority.claim(input.hostId!, pending.deviceId as string, pending.claim as string)
        if (claimed.state === 'waiting') return json(202, { state: 'waiting', hostId: input.hostId })
        const state = { state: 'approved', hostId: input.hostId, device: claimed.device }
        if (native) return json(200, { ...state, credential: claimed.credential })
        return json(200, state, [cookieHeader(DEVICE_COOKIE, `${input.hostId}.${claimed.credential}`, 30 * 86400),
          cookieHeader(PAIR_COOKIE, '', 0)])
      }
      return json(405, { error: { code: 'INVALID_CONTROL_REQUEST', message: 'This device operation does not use that HTTP method.' } })
    } catch (error) {
      const code = error instanceof AgentMuxError ? error.code : 'CONTROL_UNAVAILABLE'
      const status = code === 'CONTROL_PERMISSION_DENIED' ? 401 : code === 'INVALID_CONTROL_REQUEST' ? 400
        : code === 'CONTROL_OWNER_BUSY' ? 429 : 503
      return json(status, { error: { code, message: status === 503
        ? 'Device access is unavailable. Preserve the original Host identity; existing Sessions are unaffected by this pairing request.'
        : status === 400 ? 'The device request is incomplete or invalid.' : 'Device approval or access was not confirmed.' } })
    }
  }
}
