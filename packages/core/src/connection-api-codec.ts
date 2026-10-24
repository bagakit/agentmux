import { sha256 } from '@noble/hashes/sha2.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { ConnectionApiDescription, ConnectionApiIdentity, ConnectionApiJson, ConnectionApiOperation, ConnectionApiParamsMap, ConnectionApiRequest, ConnectionApiRequestInput, ConnectionApiResultMap, ConnectionApiRpcMethod, ConnectionApiSelector } from './connection-api-contract.js'

/** Public wire limits, independent of a platform's potentially smaller native limits. */
export const CONNECTION_API_LIMITS = Object.freeze({ bodyBytes: 256 * 1024, totalFileBytes: 4 * 1024 * 1024, files: 8, responseBytes: 1024 * 1024, jsonDepth: 32 })
export const CONNECTION_API_RPC_METHODS = { 'connection.api.identities': 'long', 'connection.api.request': 'long', 'connection.api.inspect': 'long' } as const
export const isConnectionApiMethod = (value: unknown): value is ConnectionApiRpcMethod => typeof value === 'string' && Object.hasOwn(CONNECTION_API_RPC_METHODS, value)
const fail = (): never => { throw new AgentMuxError('Native API data is malformed or does not identify the original request.', 'INVALID_CONNECTION_API_DATA') }
const object = (value: unknown, fields?: readonly string[]) => rpcRecord(value, fields, 'INVALID_CONNECTION_API_DATA')
const bytes = (value: string) => Buffer.byteLength(value, 'utf8')
function text(value: unknown, limit = 1024): string { if (typeof value !== 'string' || !value || value.length > limit || /[\u0000-\u001f\u007f]/u.test(value)) fail(); return value as string }
function id(value: unknown): string { const v = text(value); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(v)) fail(); return v }
function revision(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 1) fail(); return value as number }
function method(value: unknown): ConnectionApiRequest['method'] { if (typeof value !== 'string' || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(value)) fail(); return value as ConnectionApiRequest['method'] }
function path(value: unknown): string {
  const v = text(value, 4096)
  if (!v.startsWith('/') || v.startsWith('//') || /[\\?#]/u.test(v) || /%(?![a-f0-9]{2})/iu.test(v)) fail()
  for (const part of v.slice(1).split('/')) {
    let decoded: string
    try { decoded = decodeURIComponent(part) } catch { return fail() }
    if (!part || decoded === '.' || decoded === '..' || /[\u0000-\u001f\u007f/\\?#%]/u.test(decoded) || encodeURI(decoded) !== part) fail()
  }
  return v
}
function array(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > limit) fail()
  const entries = value as unknown[]
  const descriptors = Object.getOwnPropertyDescriptors(entries)
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue
    const d = descriptors[key as string]
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= entries.length || !d?.enumerable || !('value' in d)) fail()
  }
  for (let i = 0; i < entries.length; i++) if (!Object.hasOwn(entries, i)) fail()
  return entries
}
/** Clone data without invoking accessors/toJSON. Bounded visits prevent wide objects
 * from consuming unbounded work before their serialized byte check. */
function json(value: unknown, maximumBytes: number): ConnectionApiJson {
  let remaining = maximumBytes
  const active = new Set<object>()
  const take = (n: number) => { remaining -= n; if (remaining < 0) fail() }
  const visit = (input: unknown, depth: number): ConnectionApiJson => {
    if (depth > CONNECTION_API_LIMITS.jsonDepth) fail()
    if (input === null || typeof input === 'boolean') { take(input === null || input === true ? 4 : 5); return input }
    if (typeof input === 'number') { if (!Number.isFinite(input)) fail(); take(bytes(String(input))); return input }
    if (typeof input === 'string') { take(bytes(JSON.stringify(input))); return input }
    if (typeof input !== 'object' || !input || active.has(input)) return fail()
    active.add(input)
    try {
      if (Array.isArray(input)) { take(2 + Math.max(0, input.length - 1)); return array(input, maximumBytes).map(v => visit(v, depth + 1)) }
      const record = object(input), result: Record<string, ConnectionApiJson> = {}
      take(2)
      const keys = Object.keys(record)
      if (keys.length > remaining) fail()
      let first = true
      for (const key of keys.sort()) {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') fail()
        take(bytes(JSON.stringify(key)) + 1 + (first ? 0 : 1)); first = false
        Object.defineProperty(result, key, { value: visit(record[key], depth + 1), enumerable: true, writable: true, configurable: true })
      }
      return result
    } finally { active.delete(input) }
  }
  const result = visit(value, 0)
  if (bytes(JSON.stringify(result)) > maximumBytes) fail()
  return result
}
export function parseConnectionApiSelector(value: unknown): ConnectionApiSelector {
  const p = object(value, ['bindingId', 'bindingRevision', 'connectionId', 'connectionRevision'])
  return { bindingId: id(p.bindingId), bindingRevision: revision(p.bindingRevision), connectionId: id(p.connectionId), connectionRevision: revision(p.connectionRevision) }
}
function formats<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  const entries = array(value, allowed.length)
  if (!entries.length || entries.some(v => !allowed.includes(v as T)) || new Set(entries).size !== entries.length) fail()
  return [...entries] as T[]
}
function description(value: unknown): ConnectionApiDescription {
  const p = object(value, ['documentationUrl', 'requestFormats', 'responseFormats']), documentationUrl = text(p.documentationUrl, 4096)
  try { const u = new URL(documentationUrl); if (u.protocol !== 'https:' || u.username || u.password) fail() } catch { return fail() }
  return { documentationUrl, requestFormats: formats(p.requestFormats, ['json', 'multipart']), responseFormats: formats(p.responseFormats, ['json', 'empty']) }
}
export function parseConnectionApiIdentity(value: unknown): ConnectionApiIdentity {
  const p = object(value, ['bindingId', 'bindingRevision', 'connectionId', 'connectionRevision', 'adapterId', 'application', 'label', 'executionHostId', 'agentSessionId', 'executionRuntimeId', 'externalConversationId', 'api'])
  const application = object(p.application, ['domain', 'appId']), domain = text(application.domain, 253)
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(domain)) fail()
  return { ...parseConnectionApiSelector({ bindingId: p.bindingId, bindingRevision: p.bindingRevision, connectionId: p.connectionId, connectionRevision: p.connectionRevision }),
    adapterId: id(p.adapterId), application: { domain, appId: id(application.appId) }, label: text(p.label, 4096),
    executionHostId: id(p.executionHostId), agentSessionId: id(p.agentSessionId), ...(p.executionRuntimeId === undefined ? {} : { executionRuntimeId: id(p.executionRuntimeId) }),
    externalConversationId: text(p.externalConversationId, 4096), api: description(p.api) }
}
export function parseConnectionApiRequest(value: unknown): ConnectionApiRequest {
  const p = object(value, ['method', 'path', 'query', 'body', 'files'])
  let query: ConnectionApiRequest['query']
  if (p.query !== undefined) {
    const q = object(p.query); query = {}
    if (Object.keys(q).length > 128) fail()
    for (const key of Object.keys(q).sort()) {
      text(key, 256); if (['__proto__', 'prototype', 'constructor'].includes(key)) fail()
      const value = q[key]
      if (typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string' && bytes(value) > 16_384) fail()
      query[key] = value as string | boolean | number
    }
    if (bytes(JSON.stringify(query)) > CONNECTION_API_LIMITS.bodyBytes) fail()
  }
  const body = p.body === undefined ? undefined : json(p.body, CONNECTION_API_LIMITS.bodyBytes)
  let total = 0
  const files = p.files === undefined ? undefined : array(p.files, CONNECTION_API_LIMITS.files).map(value => {
    const f = object(value, ['field', 'name', 'contentType', 'base64']), base64 = f.base64
    if (typeof base64 !== 'string' || base64.length > Math.ceil(CONNECTION_API_LIMITS.totalFileBytes / 3) * 4 ||
        base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(base64)) fail()
    const data = Buffer.from(base64 as string, 'base64')
    if (data.toString('base64') !== base64) fail()
    total += data.byteLength; if (total > CONNECTION_API_LIMITS.totalFileBytes) fail()
    const field = text(f.field, 128), name = text(f.name, 255), contentType = text(f.contentType, 127)
    if (/[\\/]/u.test(name) || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(contentType)) fail()
    return { field, name, contentType, base64: base64 as string }
  })
  return { method: method(p.method), path: path(p.path), ...(query === undefined ? {} : { query }), ...(body === undefined ? {} : { body }), ...(files === undefined ? {} : { files }) }
}
/** One platform-independent digest of the complete normalized request. Resource
 * bytes contribute their own digest, never their private base64 to a journal. */
export function connectionApiRequestDigest(value: Pick<ConnectionApiRequestInput, 'identity' | 'request'>): string {
  const identity = parseConnectionApiSelector(value.identity), request = parseConnectionApiRequest(value.request)
  const digest = (bytes: Uint8Array) => Buffer.from(sha256(bytes)).toString('hex')
  return digest(Buffer.from(JSON.stringify({ identity, request: { ...request, ...(request.files ? { files: request.files.map(({ base64, ...metadata }) => ({ ...metadata, sha256: digest(Buffer.from(base64, 'base64')) })) } : {}) } })))
}
export function parseConnectionApiOperation(value: unknown): ConnectionApiOperation {
  const p = object(value, ['operationId', 'identity', 'request', 'state', 'code', 'response']), r = object(p.request, ['method', 'path', 'digest'])
  if (typeof r.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(r.digest)) fail()
  const base = { operationId: id(p.operationId), identity: parseConnectionApiIdentity(p.identity), request: { method: method(r.method), path: text(r.path, 4096), digest: r.digest as string } }
  if (p.state === 'unknown' && p.response === undefined) return { ...base, state: 'unknown', ...(p.code === undefined ? {} : { code: id(p.code) }) }
  if (p.state !== 'responded' || p.code !== undefined) return fail()
  const response = object(p.response, ['status', 'body', 'redacted']), b = object(response.body, ['format', 'value', 'reason'])
  if (!Number.isInteger(response.status) || Number(response.status) < 100 || Number(response.status) > 599 || typeof response.redacted !== 'boolean') fail()
  const body = b.format === 'json' && b.reason === undefined ? { format: 'json' as const, value: json(b.value, CONNECTION_API_LIMITS.responseBytes) }
    : b.format === 'empty' && b.value === undefined && b.reason === undefined ? { format: 'empty' as const }
    : b.format === 'unavailable' && b.value === undefined && typeof b.reason === 'string' && ['unsupported-format', 'too-large', 'unreadable'].includes(b.reason) ? { format: 'unavailable' as const, reason: b.reason as 'unsupported-format' | 'too-large' | 'unreadable' } : fail()
  return { ...base, state: 'responded', response: { status: response.status as number, body, redacted: response.redacted as boolean } }
}
export function parseConnectionApiParams<M extends ConnectionApiRpcMethod>(method: M, value: unknown): ConnectionApiParamsMap[M] {
  if (method === 'connection.api.identities') return { agentSessionId: id(object(value, ['agentSessionId']).agentSessionId) } as ConnectionApiParamsMap[M]
  if (method === 'connection.api.inspect') return { operationId: id(object(value, ['operationId']).operationId) } as ConnectionApiParamsMap[M]
  const p = object(value, ['operationId', 'identity', 'request'])
  return { operationId: id(p.operationId), identity: parseConnectionApiSelector(p.identity), request: parseConnectionApiRequest(p.request) } as ConnectionApiParamsMap[M]
}
export function parseConnectionApiResult<M extends ConnectionApiRpcMethod>(method: M, value: unknown, input: ConnectionApiParamsMap[M]): ConnectionApiResultMap[M] {
  if (method === 'connection.api.identities') {
    const p = object(value, ['identities']), identities = array(p.identities, 1024).map(parseConnectionApiIdentity)
    if (identities.some(v => v.agentSessionId !== (input as { agentSessionId: string }).agentSessionId) || new Set(identities.map(v => v.bindingId)).size !== identities.length || bytes(JSON.stringify(identities)) > CONNECTION_API_LIMITS.responseBytes) fail()
    return { identities } as ConnectionApiResultMap[M]
  }
  const operation = method === 'connection.api.inspect' ? object(value, ['operation']).operation : value
  const parsed = operation === null && method === 'connection.api.inspect' ? null : parseConnectionApiOperation(operation)
  if (parsed && parsed.operationId !== (input as { operationId: string }).operationId) fail()
  if (method === 'connection.api.request') {
    const expected = input as ConnectionApiParamsMap['connection.api.request']
    if (!parsed || Object.entries(expected.identity).some(([key, value]) => parsed.identity[key as keyof ConnectionApiSelector] !== value) ||
        parsed.request.method !== expected.request.method || parsed.request.digest !== connectionApiRequestDigest(expected)) fail()
  }
  return (method === 'connection.api.inspect' ? { operation: parsed } : parsed) as ConnectionApiResultMap[M]
}
