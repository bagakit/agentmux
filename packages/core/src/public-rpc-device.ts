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
/** Facts supplied by the original Host; the public parser never executes this locator. */
export interface AgentMuxRpcCertificatePreparation {
  readonly executable: string
  readonly entry: string
  readonly electronRunAsNode: boolean
}
export type AgentMuxRpcPrivateAccessState =
  | { readonly state: 'unconfigured' | 'unavailable'; readonly message: string;
      readonly configurationPath?: string; readonly certificatePreparation?: AgentMuxRpcCertificatePreparation }
  | { readonly state: 'listening'; readonly message: string; readonly origin: string;
      readonly issuerHostId: string; readonly certificateFingerprint: string; readonly expiresAt: number;
      readonly mobileBuildDigest?: string; readonly assetIssue?: string;
      readonly configurationPath?: string; readonly certificatePreparation?: AgentMuxRpcCertificatePreparation }

/** Reject only this malformed observation; no Runtime or Authority lifecycle is changed. */
export function parseAgentMuxRpcPrivateAccessState(value: unknown, hostId: string): AgentMuxRpcPrivateAccessState {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const fail = (): never => { throw new AgentMuxError('Private access facts are malformed or belong to another Host.', code) }
  const text = (v: unknown): void => { if (typeof v !== 'string' || !v.trim() || v.length > 4096) fail() }
  const path = (v: unknown): void => {
    if (typeof v !== 'string' || !v.startsWith('/') || new TextEncoder().encode(v).byteLength > 4096 ||
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(v)) fail()
  }
  const common = ['state', 'message', 'configurationPath', 'certificatePreparation']
  const listening = ['origin', 'issuerHostId', 'certificateFingerprint', 'expiresAt', 'mobileBuildDigest', 'assetIssue']
  const p = rpcRecord(value, [...common, ...listening], code)
  if (p.state !== 'unconfigured' && p.state !== 'unavailable' && p.state !== 'listening') fail()
  text(p.message)
  if (p.configurationPath !== undefined) path(p.configurationPath)
  if (p.certificatePreparation !== undefined) {
    const locator = rpcRecord(p.certificatePreparation, ['executable', 'entry', 'electronRunAsNode'], code)
    if (Object.keys(locator).length !== 3 || typeof locator.electronRunAsNode !== 'boolean') fail()
    path(locator.executable); path(locator.entry)
  }
  if (p.state === 'listening') {
    identifier(hostId, code)
    if (p.issuerHostId !== hostId) fail()
    if (typeof p.origin !== 'string') fail()
    let origin: URL
    try { origin = new URL(p.origin as string) } catch { return fail() }
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' ||
      origin.search || origin.hash || origin.origin !== p.origin) fail()
    if (typeof p.certificateFingerprint !== 'string' || !/^[0-9a-f]{2}(?::[0-9a-f]{2}){31}$/iu.test(p.certificateFingerprint)) fail()
    if (!Number.isSafeInteger(p.expiresAt) || (p.expiresAt as number) < 0) fail()
    for (const key of ['mobileBuildDigest', 'assetIssue']) if (p[key] !== undefined) text(p[key])
  } else {
    rpcRecord(p, common, code)
  }
  return p as AgentMuxRpcPrivateAccessState
}

export type AgentMuxRpcDeviceParameterMap = {
  'device.ls': Record<string, never>
  'device.invite': Record<string, never>
  'device.link': { intent?: string }
  'device.intent': { intent: string }
  'device.approve': { deviceId: string; confirmationCode: string }
  'device.reject': { deviceId: string }
  'device.revoke': { deviceId: string }
}
export type AgentMuxRpcDeviceResultMap = {
  'device.ls': { hostId: string; devices: readonly TrustedDevice[];
    requests: readonly { device: TrustedDevice; confirmationCode: string; expiresAt: number }[];
    privateAccess: AgentMuxRpcPrivateAccessState }
  'device.invite': { hostId: string; invitation: string; expiresAt: number }
  'device.link': { hostId: string; url: string; expiresAt: number }
  'device.intent': { confirmed: boolean }
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
  'device.link': 'long', 'device.intent': 'short',
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
  if (method === 'device.link' || method === 'device.intent') {
    const p = rpcRecord(value, ['intent'])
    if (method === 'device.intent' || p.intent !== undefined) identifier(p.intent, 'INVALID_CONTROL_REQUEST')
    return p as AgentMuxRpcDeviceParams<M>
  }
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
  if (method === 'device.intent') {
    const p = rpcRecord(value, ['confirmed'], 'CONTROL_PROTOCOL_ERROR')
    if (typeof p.confirmed !== 'boolean') throw new AgentMuxError('Device intent result is invalid.', 'CONTROL_PROTOCOL_ERROR')
    return p as AgentMuxRpcDeviceResult<M>
  }
  if (method === 'device.link') {
    const p = rpcRecord(value, ['hostId', 'url', 'expiresAt'], 'CONTROL_PROTOCOL_ERROR')
    identifier(p.hostId, 'CONTROL_PROTOCOL_ERROR')
    const url = new URL(p.url as string)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || !url.hash.startsWith('#connect=') || !Number.isSafeInteger(p.expiresAt))
      throw new AgentMuxError('Device connection link is invalid.', 'CONTROL_PROTOCOL_ERROR')
    return p as AgentMuxRpcDeviceResult<M>
  }
  const code = 'CONTROL_PROTOCOL_ERROR'
  const fail = (): never => { throw new AgentMuxError('Device management result is malformed or belongs to another device.', code) }
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
  const keys = method === 'device.ls' ? ['hostId', 'devices', 'requests', 'privateAccess']
    : method === 'device.invite' ? ['hostId', 'invitation', 'expiresAt']
    : method === 'device.reject' ? ['hostId', 'deviceId', 'state'] : ['hostId', 'device']
  const p = rpcRecord(value, keys, code)
  if (Object.keys(p).length !== keys.length) fail()
  identifier(p.hostId, code)
  if (method === 'device.ls') {
    parseAgentMuxRpcPrivateAccessState(p.privateAccess, p.hostId as string)
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
