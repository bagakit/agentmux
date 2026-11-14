import { parseConnectionLinkUrl } from '@agentmux/relay/offer'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { AgentMuxRpcCallContext } from './public-rpc-service.js'

// The public device codec is also consumed by the browser's encrypted hello.
const isIPv4 = (value: string) => /^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/u.test(value) && value.split('.').every(octet => Number(octet) <= 255)

/** Public projection of the original Host Authority. Credentials remain private. */
export interface TrustedDevice {
  readonly deviceId: string
  readonly name: string
  readonly createdAt: number
  readonly revokedAt?: number
  readonly online?: boolean
  readonly lastSeenAt?: number
  readonly operationIssue?: string
  readonly operations?: readonly DeviceOperation[]
  /** SHA256 of the authenticated peer's base64-encoded public key text. */
  readonly keyFingerprint?: string
  readonly connection?: DeviceConnection
  readonly connectionIssue?: string
}
/** Latest authenticated connected interval; identification never grants permission. */
export interface DeviceConnection {
  readonly connectedAt: number
  readonly observedAt?: number
  readonly disconnectedAt?: number
  readonly address?: string
  /** HTTP client declaration, not a verified device model or browser identity. */
  readonly userAgent?: string
}
/** device.ls carries at most this many newest operations per device. Older records stay with the Host device owner. */
export const DEVICE_OPERATION_WINDOW = 100
export interface DeviceOperation { readonly id: string; readonly method: string; readonly target: string; readonly at: number; readonly result: 'confirmed' | 'failed' | 'unknown' }
/** One local-network address a phone may reach this Host at. The interface name and its OS port
 * label describe the local adapter only; they do not prove the phone can reach it. */
export type AgentMuxRpcMobileLinkCandidate = { readonly address: string; readonly interface: string; readonly label?: string; readonly preferred: boolean }
export type AgentMuxRpcMobileAccessState = { readonly state: 'starting' | 'connected' | 'disconnected' | 'unavailable'; readonly message: string; readonly origin?: string }
export type AgentMuxRpcDeviceParameterMap = {
  'device.ls': Record<string, never>
  'device.link': { address?: string }
  'device.hello': { name: string }
  'device.revoke': { deviceId: string }
}
export type AgentMuxRpcDeviceResultMap = {
  'device.ls': { hostId: string; devices: readonly TrustedDevice[]; mobileAccess: AgentMuxRpcMobileAccessState }
  'device.link': { hostId: string; url: string; pageUrl: string; relay: { endpoint: string; useTls: boolean }; mobileAccess: AgentMuxRpcMobileAccessState
    /** Addresses the link could use; the url uses the requested one, or the preferred one. */
    candidates: readonly AgentMuxRpcMobileLinkCandidate[] }
  'device.hello': { hostId: string; device: TrustedDevice }
  'device.revoke': { hostId: string; device: TrustedDevice }
}
export type AgentMuxRpcDeviceMethod = keyof AgentMuxRpcDeviceParameterMap
export type AgentMuxRpcDeviceParams<M extends AgentMuxRpcDeviceMethod> = AgentMuxRpcDeviceParameterMap[M]
export type AgentMuxRpcDeviceResult<M extends AgentMuxRpcDeviceMethod> = AgentMuxRpcDeviceResultMap[M]
export interface AgentMuxRpcDeviceAdministration {
  call<M extends AgentMuxRpcDeviceMethod>(method: M, params: AgentMuxRpcDeviceParams<M>, context: AgentMuxRpcCallContext): Promise<AgentMuxRpcDeviceResult<M>>
}
export const AGENTMUX_RPC_DEVICE_METHODS = { 'device.ls': 'short', 'device.link': 'short', 'device.hello': 'long', 'device.revoke': 'long' } as const
export function isAgentMuxRpcDeviceMethod(value: unknown): value is AgentMuxRpcDeviceMethod { return typeof value === 'string' && Object.hasOwn(AGENTMUX_RPC_DEVICE_METHODS, value) }
function identifier(value: unknown, code: string): void {
  if (typeof value !== 'string' || !value || value.length > 160 || /[\0\r\n]/u.test(value)) throw new AgentMuxError('Device identity is invalid.', code)
}
export function parseDeviceConnection(value: unknown): DeviceConnection {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const c = rpcRecord(value, ['connectedAt', 'observedAt', 'disconnectedAt', 'address', 'userAgent'], code)
  if (!Number.isSafeInteger(c.connectedAt) || (c.connectedAt as number) < 0
    || (c.observedAt !== undefined && (!Number.isSafeInteger(c.observedAt) || (c.observedAt as number) < (c.connectedAt as number)))
    || (c.disconnectedAt !== undefined && (!Number.isSafeInteger(c.disconnectedAt) || (c.disconnectedAt as number) < (c.connectedAt as number)))
    || (c.address !== undefined && (typeof c.address !== 'string' || !c.address || c.address.length > 128 || /[\0\r\n]/u.test(c.address)))
    || (c.userAgent !== undefined && (typeof c.userAgent !== 'string' || !c.userAgent || /[\0\r\n]/u.test(c.userAgent)))) {
    throw new AgentMuxError('Device connection result is malformed.', code)
  }
  return c as unknown as DeviceConnection
}
export function parseAgentMuxRpcDeviceParams<M extends AgentMuxRpcDeviceMethod>(method: M, value: unknown): AgentMuxRpcDeviceParams<M> {
  const keys = method === 'device.revoke' ? ['deviceId'] : method === 'device.hello' ? ['name'] : method === 'device.link' ? ['address'] : []
  const p = rpcRecord(value, keys)
  if (method === 'device.link') {
    if (p.address !== undefined && (typeof p.address !== 'string' || !isIPv4(p.address))) throw new AgentMuxError('A link address must be one IPv4 address.', 'INVALID_CONTROL_REQUEST')
    return p as AgentMuxRpcDeviceParams<M>
  }
  if (Object.keys(p).length !== keys.length) throw new AgentMuxError('Device method requires its exact parameters.', 'INVALID_CONTROL_REQUEST')
  if (method === 'device.revoke') identifier(p.deviceId, 'INVALID_CONTROL_REQUEST')
  if (method === 'device.hello' && (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 128)) throw new AgentMuxError('Device name is invalid.', 'INVALID_CONTROL_REQUEST')
  return p as AgentMuxRpcDeviceParams<M>
}
export function parseAgentMuxRpcDeviceResult<M extends AgentMuxRpcDeviceMethod>(method: M, value: unknown, params: AgentMuxRpcDeviceParams<M>): AgentMuxRpcDeviceResult<M> {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const fail = (): never => { throw new AgentMuxError('Device result is malformed.', code) }
  const time = (v: unknown): number => { if (!Number.isSafeInteger(v) || (v as number) < 0) fail(); return v as number }
  const device = (v: unknown): TrustedDevice => {
    const d = rpcRecord(v, ['deviceId', 'name', 'createdAt', 'revokedAt', 'online', 'lastSeenAt', 'operationIssue', 'operations', 'keyFingerprint', 'connection', 'connectionIssue'], code)
    identifier(d.deviceId, code)
    if (typeof d.name !== 'string' || !d.name || d.name.length > 128) fail()
    const createdAt = time(d.createdAt)
    if (d.revokedAt !== undefined && time(d.revokedAt) < createdAt) fail()
    if (d.operationIssue !== undefined && (typeof d.operationIssue !== 'string' || d.operationIssue.length > 4096)) fail()
    if (d.online !== undefined && typeof d.online !== 'boolean') fail()
    if (d.lastSeenAt !== undefined) time(d.lastSeenAt)
    if (d.keyFingerprint !== undefined && (typeof d.keyFingerprint !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(d.keyFingerprint))) fail()
    if (d.connection !== undefined) parseDeviceConnection(d.connection)
    if (d.connectionIssue !== undefined && (typeof d.connectionIssue !== 'string' || !d.connectionIssue || d.connectionIssue.length > 4096)) fail()
    if (d.operations !== undefined) {
      if (!Array.isArray(d.operations) || d.operations.length > DEVICE_OPERATION_WINDOW) fail()
      for (const value of d.operations as unknown[]) {
        const o = rpcRecord(value, ['id', 'method', 'target', 'at', 'result'], code)
        identifier(o.id, code); identifier(o.method, code); identifier(o.target, code); time(o.at)
        if (!['confirmed', 'failed', 'unknown'].includes(o.result as string)) fail()
      }
    }
    return d as unknown as TrustedDevice
  }
  const keys = method === 'device.ls' ? ['hostId', 'devices', 'mobileAccess'] : method === 'device.link' ? ['hostId', 'url', 'pageUrl', 'relay', 'mobileAccess', 'candidates'] : ['hostId', 'device']
  const p = rpcRecord(value, keys, code)
  if (Object.keys(p).length !== keys.length) fail()
  identifier(p.hostId, code)
  if (method === 'device.link') {
    if (typeof p.url !== 'string') fail()
    const link = parseConnectionLinkUrl(p.url as string)
    if (!link) fail()
    const page = new URL(p.url as string); page.hash = ''
    const relay = rpcRecord(p.relay, ['endpoint', 'useTls'], code)
    if (p.pageUrl !== page.href) fail()
    if (link!.kind === 'offer') {
      if (link!.offer.serverId !== p.hostId || relay.endpoint !== link!.offer.relay.endpoint || relay.useTls !== link!.offer.relay.useTls) fail()
    } else if (relay.endpoint !== page.host || relay.useTls !== (page.protocol === 'https:') || page.username || page.password || page.search) fail()
    const access = rpcRecord(p.mobileAccess, ['state', 'message', 'origin'], code)
    if (!['starting', 'connected', 'disconnected', 'unavailable'].includes(access.state as string) || typeof access.message !== 'string' || access.message.length > 4096 || access.origin !== page.origin) fail()
    if (!Array.isArray(p.candidates) || p.candidates.length > 32) fail()
    const seen = new Set<string>()
    for (const raw of p.candidates as unknown[]) {
      const c = rpcRecord(raw, ['address', 'interface', 'label', 'preferred'], code)
      if (typeof c.address !== 'string' || !isIPv4(c.address) || seen.has(c.address) || typeof c.interface !== 'string' || !c.interface || c.interface.length > 64 ||
        c.label !== undefined && (typeof c.label !== 'string' || !c.label || c.label.length > 128) || typeof c.preferred !== 'boolean') fail()
      seen.add(c.address as string)
    }
    const host = new URL(`ws://${relay.endpoint}`).hostname
    if ((p.candidates as unknown[]).length && !seen.has(host)) fail()
    const requested = (params as AgentMuxRpcDeviceParams<'device.link'>).address
    if (requested !== undefined && host !== requested) fail()
  } else if (method === 'device.ls') {
    const access = rpcRecord(p.mobileAccess, ['state','message','origin'], code)
    if (!['starting','connected','disconnected','unavailable'].includes(access.state as string) || typeof access.message !== 'string' || access.message.length > 4096) fail()
    if (access.origin !== undefined && typeof access.origin !== 'string') fail()
    if (!Array.isArray(p.devices) || p.devices.length > 100) fail()
    for (const d of p.devices as unknown[]) device(d)
  } else {
    const actual = device(p.device)
    if (method === 'device.revoke' && (actual.deviceId !== (params as AgentMuxRpcDeviceParams<'device.revoke'>).deviceId || actual.revokedAt === undefined)) fail()
  }
  return p as AgentMuxRpcDeviceResult<M>
}
