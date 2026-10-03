import { parseConnectionOfferUrl } from '@agentmux/relay/offer'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { AgentMuxRpcCallContext } from './public-rpc-service.js'

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
}
export interface DeviceOperation { readonly id: string; readonly method: string; readonly target: string; readonly at: number; readonly result: 'confirmed' | 'failed' | 'unknown' }
export type AgentMuxRpcMobileAccessState = { readonly state: 'starting' | 'connected' | 'disconnected' | 'unavailable'; readonly message: string; readonly origin?: string }
export type AgentMuxRpcDeviceParameterMap = {
  'device.ls': Record<string, never>
  'device.link': Record<string, never>
  'device.hello': { name: string }
  'device.revoke': { deviceId: string }
}
export type AgentMuxRpcDeviceResultMap = {
  'device.ls': { hostId: string; devices: readonly TrustedDevice[]; mobileAccess: AgentMuxRpcMobileAccessState }
  'device.link': { hostId: string; url: string }
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
export function parseAgentMuxRpcDeviceParams<M extends AgentMuxRpcDeviceMethod>(method: M, value: unknown): AgentMuxRpcDeviceParams<M> {
  const keys = method === 'device.revoke' ? ['deviceId'] : method === 'device.hello' ? ['name'] : []
  const p = rpcRecord(value, keys)
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
    const d = rpcRecord(v, ['deviceId', 'name', 'createdAt', 'revokedAt', 'online', 'lastSeenAt', 'operationIssue', 'operations'], code)
    identifier(d.deviceId, code)
    if (typeof d.name !== 'string' || !d.name || d.name.length > 128) fail()
    const createdAt = time(d.createdAt)
    if (d.revokedAt !== undefined && time(d.revokedAt) < createdAt) fail()
    if (d.operationIssue !== undefined && (typeof d.operationIssue !== 'string' || d.operationIssue.length > 4096)) fail()
    if (d.online !== undefined && typeof d.online !== 'boolean') fail()
    if (d.lastSeenAt !== undefined) time(d.lastSeenAt)
    if (d.operations !== undefined) {
      if (!Array.isArray(d.operations) || d.operations.length > 100) fail()
      for (const value of d.operations as unknown[]) {
        const o = rpcRecord(value, ['id', 'method', 'target', 'at', 'result'], code)
        identifier(o.id, code); identifier(o.method, code); identifier(o.target, code); time(o.at)
        if (!['confirmed', 'failed', 'unknown'].includes(o.result as string)) fail()
      }
    }
    return d as unknown as TrustedDevice
  }
  const keys = method === 'device.ls' ? ['hostId', 'devices', 'mobileAccess'] : method === 'device.link' ? ['hostId', 'url'] : ['hostId', 'device']
  const p = rpcRecord(value, keys, code)
  if (Object.keys(p).length !== keys.length) fail()
  identifier(p.hostId, code)
  if (method === 'device.link') {
    if (typeof p.url !== 'string') fail()
    const offer = parseConnectionOfferUrl(p.url as string)
    if (!offer || offer.serverId !== p.hostId) fail()
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
