import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { AgentMuxRpcCallContext } from './public-rpc-service.js'

/** Public projection of the original Host Authority. Credentials remain private. */
export interface TrustedDevice {
  readonly deviceId: string
  readonly name: string
  readonly createdAt: number
  readonly revokedAt?: number
}
export type AgentMuxRpcDeviceParameterMap = {
  'device.ls': Record<string, never>
  'device.invite': Record<string, never>
  'device.approve': { deviceId: string; confirmationCode: string }
  'device.reject': { deviceId: string }
  'device.revoke': { deviceId: string }
}
export type AgentMuxRpcDeviceResultMap = {
  'device.ls': { hostId: string; devices: readonly TrustedDevice[];
    requests: readonly { device: TrustedDevice; confirmationCode: string; expiresAt: number }[] }
  'device.invite': { hostId: string; invitation: string; expiresAt: number }
  'device.approve': { hostId: string; device: TrustedDevice }
  'device.reject': { hostId: string; deviceId: string; state: 'denied' }
  'device.revoke': { hostId: string; device: TrustedDevice }
}
export type AgentMuxRpcDeviceMethod = keyof AgentMuxRpcDeviceParameterMap
export type AgentMuxRpcDeviceParams<M extends AgentMuxRpcDeviceMethod> = AgentMuxRpcDeviceParameterMap[M]
export type AgentMuxRpcDeviceResult<M extends AgentMuxRpcDeviceMethod> = AgentMuxRpcDeviceResultMap[M]
/** The Host owns confirmation and mutation; Core only borrows this finite tuple. */
export interface AgentMuxRpcDeviceAdministration {
  call<M extends AgentMuxRpcDeviceMethod>(method: M, params: AgentMuxRpcDeviceParams<M>,
    context: AgentMuxRpcCallContext): Promise<AgentMuxRpcDeviceResult<M>>
}
export const AGENTMUX_RPC_DEVICE_METHODS = {
  'device.ls': 'short', 'device.invite': 'long', 'device.approve': 'long',
  'device.reject': 'long', 'device.revoke': 'long'
} as const satisfies Record<AgentMuxRpcDeviceMethod, 'short' | 'long'>
export function isAgentMuxRpcDeviceMethod(value: unknown): value is AgentMuxRpcDeviceMethod {
  return typeof value === 'string' && Object.hasOwn(AGENTMUX_RPC_DEVICE_METHODS, value)
}
function identifier(value: unknown, code: string): void {
  if (typeof value !== 'string' || !value || value.length > 160 || /[\0\r\n]/u.test(value)) {
    throw new AgentMuxError('Device management identity is invalid.', code)
  }
}
function confirmationCode(value: unknown, code: string): void {
  if (typeof value !== 'string' || !/^[0-9]{6}$/u.test(value)) {
    throw new AgentMuxError('Device confirmation code must contain six digits.', code)
  }
}
/** No caller-supplied confirmation or transport fact is admitted. */
export function parseAgentMuxRpcDeviceParams<M extends AgentMuxRpcDeviceMethod>(method: M, value: unknown): AgentMuxRpcDeviceParams<M> {
  const keys = method === 'device.approve' ? ['deviceId', 'confirmationCode']
    : method === 'device.reject' || method === 'device.revoke' ? ['deviceId'] : []
  const p = rpcRecord(value, keys)
  if (Object.keys(p).length !== keys.length) throw new AgentMuxError('Device management requires its exact parameters.', 'INVALID_CONTROL_REQUEST')
  if (keys.includes('deviceId')) identifier(p.deviceId, 'INVALID_CONTROL_REQUEST')
  if (method === 'device.approve') confirmationCode(p.confirmationCode, 'INVALID_CONTROL_REQUEST')
  return p as AgentMuxRpcDeviceParams<M>
}
/** Strict public results contain no Authority credential, hash or claim. */
export function parseAgentMuxRpcDeviceResult<M extends AgentMuxRpcDeviceMethod>(method: M, value: unknown,
  params: AgentMuxRpcDeviceParams<M>): AgentMuxRpcDeviceResult<M> {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const fail = (): never => { throw new AgentMuxError('Device management result is malformed or belongs to another device.', code) }
  const time = (v: unknown): number => { if (!Number.isSafeInteger(v) || (v as number) < 0) fail(); return v as number }
  const device = (v: unknown): TrustedDevice => {
    const d = rpcRecord(v, ['deviceId', 'name', 'createdAt', 'revokedAt'], code)
    identifier(d.deviceId, code)
    if (typeof d.name !== 'string' || !d.name || d.name.length > 128) fail()
    const createdAt = time(d.createdAt)
    if (d.revokedAt !== undefined && time(d.revokedAt) < createdAt) fail()
    return d as unknown as TrustedDevice
  }
  const keys = method === 'device.ls' ? ['hostId', 'devices', 'requests']
    : method === 'device.invite' ? ['hostId', 'invitation', 'expiresAt']
    : method === 'device.reject' ? ['hostId', 'deviceId', 'state'] : ['hostId', 'device']
  const p = rpcRecord(value, keys, code)
  if (Object.keys(p).length !== keys.length) fail()
  identifier(p.hostId, code)
  if (method === 'device.ls') {
    if (!Array.isArray(p.devices) || !Array.isArray(p.requests)) fail()
    for (const d of p.devices as unknown[]) device(d)
    for (const value of p.requests as unknown[]) {
      const request = rpcRecord(value, ['device', 'confirmationCode', 'expiresAt'], code)
      device(request.device); confirmationCode(request.confirmationCode, code); time(request.expiresAt)
    }
  } else if (method === 'device.invite') {
    identifier(p.invitation, code); time(p.expiresAt)
  } else if (method === 'device.reject') {
    if (p.deviceId !== (params as AgentMuxRpcDeviceParams<'device.reject'>).deviceId || p.state !== 'denied') fail()
  } else {
    const actual = device(p.device)
    if (actual.deviceId !== (params as AgentMuxRpcDeviceParams<'device.approve'>).deviceId ||
      method === 'device.revoke' && actual.revokedAt === undefined) fail()
  }
  return p as AgentMuxRpcDeviceResult<M>
}
