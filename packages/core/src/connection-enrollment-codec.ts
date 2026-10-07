import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseConnectionRecord } from './connections-codec.js'
import type { ConnectionEnrollmentBeginInput, ConnectionEnrollmentCapability, ConnectionEnrollmentChallenge, ConnectionEnrollmentMethod, ConnectionEnrollmentOperation, ConnectionEnrollmentParamsMap, ConnectionEnrollmentReason, ConnectionEnrollmentResultMap } from './connection-enrollment-contract.js'

export const CONNECTION_ENROLLMENT_RPC_METHODS = { 'connection.enrollment.begin': 'long', 'connection.enrollment.advance': 'long', 'connection.enrollment.inspect': 'long', 'connection.enrollment.ls': 'long' } as const
export const isConnectionEnrollmentMethod = (value: unknown): value is ConnectionEnrollmentMethod => typeof value === 'string' && Object.hasOwn(CONNECTION_ENROLLMENT_RPC_METHODS, value)
const fail = (): never => { throw new AgentMuxError('Enrollment data does not describe the original application operation.', 'INVALID_CONNECTION_ENROLLMENT_DATA') }
const object = (v: unknown, fields: string[]) => rpcRecord(v, fields, 'INVALID_CONNECTION_ENROLLMENT_DATA')
function text(v: unknown): string { if (typeof v !== 'string' || !v.trim() || /[\0\r\n]/u.test(v)) fail(); return v as string }
function id(v: unknown): string { const s = text(v); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(s)) fail(); return s }
function domain(v: unknown): string { const s = text(v); if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(s)) fail(); return s }
function integer(v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number { if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) fail(); return v as number }
function choice<T extends string>(v: unknown, values: readonly T[]): T { if (!values.includes(v as T)) fail(); return v as T }
const reasons: readonly ConnectionEnrollmentReason[] = ['adapter-unavailable', 'secure-storage-unavailable', 'storage-unconfirmed', 'begin-unconfirmed', 'poll-unconfirmed', 'credential-unconfirmed', 'configuration-unconfirmed', 'connection-conflict', 'authority-unavailable', 'platform-denied', 'platform-expired', 'platform-not-applied']
export function parseConnectionEnrollmentBegin(value: unknown): ConnectionEnrollmentBeginInput {
  const p = object(value, ['operationId', 'connectionId', 'adapterId', 'domain', 'label'])
  return { operationId: id(p.operationId), connectionId: id(p.connectionId), adapterId: id(p.adapterId), domain: domain(p.domain), label: text(p.label) }
}
export function parseConnectionEnrollmentChallenge(value: unknown): ConnectionEnrollmentChallenge {
  const p = object(value, ['verificationUrl', 'userCode', 'expiresAt', 'nextPollAt']), url = text(p.verificationUrl)
  try { const u = new URL(url); if (u.protocol !== 'https:' || u.username || u.password) fail() } catch { fail() }
  return { verificationUrl: url, ...(p.userCode === undefined ? {} : { userCode: text(p.userCode) }), expiresAt: p.expiresAt === null ? null : integer(p.expiresAt, 0), nextPollAt: integer(p.nextPollAt, 0) }
}
export function parseConnectionEnrollmentOperation(value: unknown): ConnectionEnrollmentOperation {
  const p = object(value, ['operationId', 'connectionId', 'adapterId', 'domain', 'label', 'revision', 'authorization', 'credential', 'configuration', 'application', 'challenge', 'configured', 'reason'])
  const input = parseConnectionEnrollmentBegin(Object.fromEntries(['operationId', 'connectionId', 'adapterId', 'domain', 'label'].map(k => [k, p[k]])))
  const app = p.application === null ? null : object(p.application, ['domain', 'appId'])
  const application = app ? { domain: domain(app.domain), appId: id(app.appId) } : null
  if (application && application.domain !== input.domain) fail()
  let configured: ConnectionEnrollmentOperation['configured'] = null
  if (p.configured !== null) {
    const c = object(p.configured, ['operationId', 'status', 'connection'])
    if (c.status !== 'configured') fail()
    configured = { operationId: id(c.operationId), status: 'configured', connection: parseConnectionRecord(c.connection) }
    const config = configured.connection.config
    if (!application || config.connectionId !== input.connectionId || config.adapterId !== input.adapterId || config.label !== input.label || config.application.domain !== application.domain || config.application.appId !== application.appId) fail()
  }
  const result: ConnectionEnrollmentOperation = { ...input, revision: integer(p.revision, 1), authorization: choice(p.authorization, ['not-started', 'pending', 'authorized', 'denied', 'expired', 'unknown']), credential: choice(p.credential, ['not-started', 'storing', 'stored', 'unknown']), configuration: choice(p.configuration, ['not-started', 'saving', 'configured', 'unknown', 'refused']), application, challenge: p.challenge === null ? null : parseConnectionEnrollmentChallenge(p.challenge), configured, ...(p.reason === undefined ? {} : { reason: choice(p.reason, reasons) }) }
  if (configured && (configured.connection.revision !== 1 || !configured.connection.config.enabled)) fail()
  if ((result.configuration === 'configured') !== (configured !== null) || configured && (result.credential !== 'stored' || result.authorization !== 'authorized') || result.authorization === 'authorized' && !application || result.credential === 'stored' && !application || result.authorization === 'pending' && !result.challenge) fail()
  return result
}
function capability(value: unknown): ConnectionEnrollmentCapability {
  const p = object(value, ['adapterId', 'domain', 'label', 'availability', 'reason'])
  return { adapterId: id(p.adapterId), domain: domain(p.domain), label: text(p.label), availability: choice(p.availability, ['available', 'unavailable', 'unknown']), ...(p.reason === undefined ? {} : { reason: choice(p.reason, ['adapter-unavailable', 'secure-storage-unavailable']) }) }
}
export function parseConnectionEnrollmentParams<M extends ConnectionEnrollmentMethod>(method: M, value: unknown): ConnectionEnrollmentParamsMap[M] {
  if (method === 'connection.enrollment.begin') return parseConnectionEnrollmentBegin(value) as ConnectionEnrollmentParamsMap[M]
  if (method === 'connection.enrollment.ls') { const p = object(value, ['cursor', 'limit']); return { ...(p.cursor === undefined ? {} : { cursor: text(p.cursor) }), ...(p.limit === undefined ? {} : { limit: integer(p.limit, 1, 100) }) } as ConnectionEnrollmentParamsMap[M] }
  const p = object(value, ['operationId']); return { operationId: id(p.operationId) } as ConnectionEnrollmentParamsMap[M]
}
export function parseConnectionEnrollmentResult<M extends ConnectionEnrollmentMethod>(method: M, value: unknown, input: ConnectionEnrollmentParamsMap[M]): ConnectionEnrollmentResultMap[M] {
  if (method === 'connection.enrollment.ls') {
    const p = object(value, ['operations', 'next', 'capabilities'])
    if (!Array.isArray(p.operations) || !Array.isArray(p.capabilities) || p.operations.length > ((input as ConnectionEnrollmentParamsMap['connection.enrollment.ls']).limit ?? 25)) fail()
    const operations = (p.operations as unknown[]).map(parseConnectionEnrollmentOperation), capabilities = (p.capabilities as unknown[]).map(capability)
    if (new Set(operations.map(o => o.operationId)).size !== operations.length || new Set(capabilities.map(c => JSON.stringify([c.adapterId, c.domain]))).size !== capabilities.length) fail()
    return { operations, capabilities, next: p.next === null ? null : text(p.next) } as ConnectionEnrollmentResultMap[M]
  }
  const operation = method === 'connection.enrollment.inspect' ? (() => { const p = object(value, ['operation']); return p.operation === null ? null : parseConnectionEnrollmentOperation(p.operation) })() : parseConnectionEnrollmentOperation(value)
  if (operation && operation.operationId !== (input as { operationId: string }).operationId) fail()
  if (operation && method === 'connection.enrollment.begin' && JSON.stringify(parseConnectionEnrollmentBegin(Object.fromEntries(['operationId', 'connectionId', 'adapterId', 'domain', 'label'].map(k => [k, operation[k as keyof typeof operation]])))) !== JSON.stringify(input)) fail()
  return (method === 'connection.enrollment.inspect' ? { operation } : operation) as ConnectionEnrollmentResultMap[M]
}
