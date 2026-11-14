import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString } from './rpc-business-codec.js'
import { parseRemoteCoreHost, parseRemoteCoreUpgradeExpected, parseRemoteCoreUpgradeReceipt } from './remote-core-upgrade-codec.js'
import { parseRemoteCoreInstallExpected, parseRemoteCoreInstallReceipt } from './remote-core-install-codec.js'
import { remoteCoreUpgradeTargetDigest, type RemoteCoreUpgradeExpected, type RemoteCoreUpgradeHost, type RemoteCoreUpgradeReceipt } from './remote-core-upgrade.js'
import type { RemoteCoreInstallExpected, RemoteCoreInstallReceipt } from './remote-core-install.js'

export const AGENTMUX_RPC_HOST_MAINTENANCE_METHODS = {
  'settings.hosts.maintenance-request': 'long',
  'settings.hosts.maintenance-inspect': 'long',
  'settings.hosts.maintenance-review': 'long'
} as const
export type HostMaintenanceMethod = keyof typeof AGENTMUX_RPC_HOST_MAINTENANCE_METHODS
export type HostMaintenanceActor = { kind: 'agent' | 'user' | 'device'; id: string; hostId?: string; runtimeId?: string; runId?: string }
export const sameHostMaintenanceActor = (a: HostMaintenanceActor, b: HostMaintenanceActor): boolean =>
  a.kind === b.kind && a.id === b.id && a.hostId === b.hostId && (!a.runtimeId || !b.runtimeId || a.runtimeId === b.runtimeId)
export type HostMaintenanceRequest = { id: string; host: RemoteCoreUpgradeHost; operationId: string } & (
  | { action: 'install'; expected: RemoteCoreInstallExpected }
  | { action: 'upgrade'; expected: RemoteCoreUpgradeExpected }
)
export type HostMaintenanceReview = { operationId: string; requestDigest: string; decision: 'approve' | 'reject' }
export type HostMaintenanceRecord = {
  request: HostMaintenanceRequest; requester: HostMaintenanceActor; createdAt: number; requestDigest: string
  state: 'pending' | 'rejected' | 'executing' | 'finished' | 'unconfirmed'
  review?: { actor: HostMaintenanceActor; decision: 'approve' | 'reject'; reviewedAt: number }
  result?: RemoteCoreInstallReceipt | RemoteCoreUpgradeReceipt
  issue?: { code: string; message: string }
}
export type HostMaintenanceParamsMap = {
  'settings.hosts.maintenance-request': HostMaintenanceRequest
  'settings.hosts.maintenance-inspect': { operationId: string }
  'settings.hosts.maintenance-review': HostMaintenanceReview
}
export type HostMaintenanceResultMap = {
  [M in HostMaintenanceMethod]: { record: HostMaintenanceRecord | null }
}
export type HostMaintenanceAdministration = {
  request(input: HostMaintenanceRequest, actor: HostMaintenanceActor, assertCurrent: () => Promise<void>): Promise<HostMaintenanceRecord>
  inspect(operationId: string, actor: HostMaintenanceActor): Promise<HostMaintenanceRecord | null>
  review(input: HostMaintenanceReview, actor: HostMaintenanceActor, assertCurrent: () => Promise<void>): Promise<HostMaintenanceRecord>
}
export function isHostMaintenanceMethod(method: unknown): method is HostMaintenanceMethod {
  return typeof method === 'string' && Object.hasOwn(AGENTMUX_RPC_HOST_MAINTENANCE_METHODS, method)
}
function operation(value: unknown): string {
  const result = rpcString(value, 'Original maintenance operation ID')
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(result)) throw new AgentMuxError('Use the original maintenance operation ID (letters, digits, underscore or hyphen, at most 128 characters).', 'INVALID_CONTROL_REQUEST')
  return result
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new AgentMuxError('The original request digest is required.', 'INVALID_CONTROL_REQUEST')
  return value
}
export function parseHostMaintenanceParams<M extends HostMaintenanceMethod>(method: M, value: unknown): HostMaintenanceParamsMap[M] {
  if (method === 'settings.hosts.maintenance-inspect') {
    const p = rpcRecord(value, ['operationId'])
    return { operationId: operation(p.operationId) } as HostMaintenanceParamsMap[M]
  }
  if (method === 'settings.hosts.maintenance-review') {
    const p = rpcRecord(value, ['operationId', 'requestDigest', 'decision'])
    if (p.decision !== 'approve' && p.decision !== 'reject') throw new AgentMuxError('Choose approve or reject for this exact request.', 'INVALID_CONTROL_REQUEST')
    return { operationId: operation(p.operationId), requestDigest: digest(p.requestDigest), decision: p.decision } as HostMaintenanceParamsMap[M]
  }
  const p = rpcRecord(value, ['action', 'id', 'host', 'expected', 'operationId'])
  if (p.action !== 'install' && p.action !== 'upgrade') throw new AgentMuxError('A maintenance request must choose install or upgrade.', 'INVALID_CONTROL_REQUEST')
  const host = parseRemoteCoreHost(p.host), id = rpcString(p.id, 'Saved Host ID')
  const expected = p.action === 'install' ? parseRemoteCoreInstallExpected(p.expected) : parseRemoteCoreUpgradeExpected(p.expected)
  if (host.id !== id || host.kind !== 'ssh' || expected.targetDigest !== remoteCoreUpgradeTargetDigest(host)) throw new AgentMuxError('The request must pin the exact saved SSH Host and its original check.', 'INVALID_CONTROL_REQUEST')
  return { action: p.action, id, host, expected, operationId: operation(p.operationId) } as HostMaintenanceParamsMap[M]
}
function actor(value: unknown): HostMaintenanceActor {
  const p = rpcRecord(value, ['kind', 'id', 'hostId', 'runtimeId', 'runId'], 'CONTROL_PROTOCOL_ERROR')
  if (!['agent', 'user', 'device'].includes(p.kind as string) || p.kind !== 'agent' && (p.runId !== undefined || p.hostId !== undefined || p.runtimeId !== undefined)) throw new AgentMuxError('Maintenance attribution is invalid.', 'CONTROL_PROTOCOL_ERROR')
  return { kind: p.kind as HostMaintenanceActor['kind'], id: rpcString(p.id, 'Original actor'), ...(p.hostId === undefined ? {} : { hostId: rpcString(p.hostId, 'Original caller Host') }), ...(p.runtimeId === undefined ? {} : { runtimeId: rpcString(p.runtimeId, 'Original caller Runtime') }), ...(p.runId === undefined ? {} : { runId: rpcString(p.runId, 'Original Run') }) }
}
function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new AgentMuxError('Maintenance timestamp is invalid.', 'CONTROL_PROTOCOL_ERROR')
  return value as number
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]))
}
export function hostMaintenanceRequestDigest(value: Pick<HostMaintenanceRecord, 'request' | 'requester' | 'createdAt'>): string {
  return createHash('sha256').update(JSON.stringify(canonical({ request: value.request, requester: value.requester, createdAt: value.createdAt }))).digest('hex')
}
export function parseHostMaintenanceRecord(value: unknown): HostMaintenanceRecord {
  const p = rpcRecord(value, ['request', 'requester', 'createdAt', 'requestDigest', 'state', 'review', 'result', 'issue'], 'CONTROL_PROTOCOL_ERROR')
  const request = parseHostMaintenanceParams('settings.hosts.maintenance-request', p.request), requester = actor(p.requester), createdAt = timestamp(p.createdAt)
  const requestDigest = digest(p.requestDigest)
  const fail = (): never => { throw new AgentMuxError('The maintenance receipt does not match its original request.', 'CONTROL_PROTOCOL_ERROR') }
  if (hostMaintenanceRequestDigest({ request, requester, createdAt }) !== requestDigest || !['pending', 'rejected', 'executing', 'finished', 'unconfirmed'].includes(p.state as string)) fail()
  let review: HostMaintenanceRecord['review']
  if (p.review !== undefined) {
    const r = rpcRecord(p.review, ['actor', 'decision', 'reviewedAt'], 'CONTROL_PROTOCOL_ERROR'), reviewer = actor(r.actor)
    if (reviewer.kind === 'agent' && !sameHostMaintenanceActor(requester, reviewer) || r.decision !== 'approve' && r.decision !== 'reject') fail()
    review = { actor: reviewer, decision: r.decision as 'approve' | 'reject', reviewedAt: timestamp(r.reviewedAt) }
  }
  if (p.state === 'pending' ? review !== undefined : review === undefined) fail()
  if (p.state === 'rejected' ? review?.decision !== 'reject' : review?.decision === 'reject') fail()
  let result: HostMaintenanceRecord['result']
  if (p.result !== undefined) {
    result = request.action === 'install' ? parseRemoteCoreInstallReceipt(p.result) : parseRemoteCoreUpgradeReceipt(p.result)
    if (result.operationId !== request.operationId || !isDeepStrictEqual(result.input, request.host) || !isDeepStrictEqual(result.expected, request.expected) || review?.decision !== 'approve') fail()
  }
  if (p.state === 'finished' && result === undefined || (p.state === 'pending' || p.state === 'rejected') && (result !== undefined || p.issue !== undefined)) fail()
  let issue: HostMaintenanceRecord['issue']
  if (p.issue !== undefined) { const i = rpcRecord(p.issue, ['code', 'message'], 'CONTROL_PROTOCOL_ERROR'); issue = { code: rpcString(i.code, 'Maintenance issue code'), message: rpcString(i.message, 'Maintenance issue') } }
  return { request, requester, createdAt, requestDigest, state: p.state as HostMaintenanceRecord['state'], ...(review ? { review } : {}), ...(result ? { result } : {}), ...(issue ? { issue } : {}) }
}
export function parseHostMaintenanceResult<M extends HostMaintenanceMethod>(method: M, value: unknown, input: HostMaintenanceParamsMap[M]): HostMaintenanceResultMap[M] {
  const p = rpcRecord(value, ['record'], 'CONTROL_PROTOCOL_ERROR')
  if (p.record === null) {
    if (method !== 'settings.hosts.maintenance-inspect') throw new AgentMuxError('The maintenance request receipt is missing.', 'CONTROL_PROTOCOL_ERROR')
    return { record: null }
  }
  const record = parseHostMaintenanceRecord(p.record)
  if (record.request.operationId !== input.operationId || method === 'settings.hosts.maintenance-request' && !isDeepStrictEqual(record.request, input) ||
      method === 'settings.hosts.maintenance-review' && (record.requestDigest !== (input as HostMaintenanceReview).requestDigest || record.review?.decision !== (input as HostMaintenanceReview).decision)) {
    throw new AgentMuxError('The maintenance result belongs to another original request.', 'CONTROL_PROTOCOL_ERROR')
  }
  return { record }
}
