import { sha256 } from '@noble/hashes/sha2.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { CONNECTION_PROFILE_TRANSPORT_CODES } from './connection-profile-contract.js'
export { CONNECTION_PROFILE_TRANSPORT_CODES } from './connection-profile-contract.js'
import type { ConnectionProfileMethod, ConnectionProfileObservation, ConnectionProfileOperation, ConnectionProfileParamsMap, ConnectionProfileResultMap, ConnectionProfileReason, DesiredConnectionProfile } from './connection-profile-contract.js'

export const CONNECTION_PROFILE_RPC_METHODS = { 'connection.profile.get': 'long', 'connection.profile.inspect': 'long', 'connection.profile.ls': 'long' } as const
export const isConnectionProfileMethod = (v: unknown): v is ConnectionProfileMethod => typeof v === 'string' && Object.hasOwn(CONNECTION_PROFILE_RPC_METHODS, v)
const fail = (): never => { throw new AgentMuxError('Profile data does not describe the original application operation.', 'INVALID_CONNECTION_PROFILE_DATA') }
const object = (v: unknown, fields: string[]) => rpcRecord(v, fields, 'INVALID_CONNECTION_PROFILE_DATA')
function text(v: unknown, empty = false): string { if (typeof v !== 'string' || !empty && !v.trim() || typeof v === 'string' && /[\0\r\n]/u.test(v)) fail(); return v as string }
function description(v: unknown): string { if (typeof v !== 'string' || v.includes('\0')) fail(); return v as string }
function id(v: unknown): string { const s = text(v); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(s)) fail(); return s }
function integer(v: unknown, max = Number.MAX_SAFE_INTEGER): number { if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > max) fail(); return v as number }
function choice<T extends string>(v: unknown, values: readonly T[]): T { if (!values.includes(v as T)) fail(); return v as T }
const reasons: readonly ConnectionProfileReason[] = ['adapter-unavailable','credential-unavailable','connection-revised','source-unconfirmed','storage-unconfirmed','permission-required','creation-origin-unsupported','application-under-review','platform-rejected','effect-unconfirmed','online-unconfirmed']
const reason = (v: unknown) => v === undefined ? {} : { reason: choice(v, reasons) }
function application(v: unknown) { const p = object(v, ['domain','appId']), domain = text(p.domain); if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(domain)) fail(); return { domain, appId: id(p.appId) } }
export function connectionProfileAvatarDigest(pngDataUrl: string): string {
  let bytes: Uint8Array
  try { bytes = Uint8Array.from(atob(pngDataUrl.slice(22)), char => char.charCodeAt(0)) } catch { return fail() }
  return Array.from(sha256(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}
function url(v: unknown): string { const s = text(v); try { const u = new URL(s); if (u.protocol !== 'https:' || u.username || u.password) fail() } catch { fail() }; return s }
export function parseDesiredConnectionProfile(v: unknown): DesiredConnectionProfile {
  const p = object(v, ['name','description','avatar']), out: DesiredConnectionProfile = {}
  if (p.name !== undefined) out.name = text(p.name)
  if (p.description !== undefined) out.description = description(p.description)
  if (p.avatar !== undefined) {
    const a = object(p.avatar, ['pngDataUrl'])
    // The original saved-avatar wire bound, rather than a platform-wide image limit.
    if (typeof a.pngDataUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(a.pngDataUrl) || a.pngDataUrl.length > Math.ceil(512 * 1024 / 3) * 4 + 22 || (a.pngDataUrl.length - 22) % 4) fail()
    out.avatar = { pngDataUrl: a.pngDataUrl as string }
  }
  if (!Object.keys(out).length) fail(); return out
}
export function parseConnectionProfileObservation(v: unknown): ConnectionProfileObservation {
  const p = object(v, ['connectionId','connectionRevision','application','language','state','profile','metadata','botId','onlineVersionId','reviewingVersionId','version','managementUrl','reason'])
  const f = p.profile === null ? null : object(p.profile, ['name','description','avatarUrl']), m = p.metadata === null ? null : object(p.metadata, ['description']), ver = p.version === null ? null : object(p.version, ['versionId','status'])
  const result: ConnectionProfileObservation = { connectionId: id(p.connectionId), connectionRevision: integer(p.connectionRevision), application: application(p.application), language: p.language === null ? null : text(p.language), state: choice(p.state,['observed','unknown','unavailable']),
    profile: f === null ? null : { ...(f.name === undefined ? {} : { name: text(f.name) }), ...(f.description === undefined ? {} : { description: description(f.description) }), ...(f.avatarUrl === undefined ? {} : { avatarUrl: url(f.avatarUrl) }) },
    metadata: m === null ? null : { ...(m.description === undefined ? {} : { description: description(m.description) }) },
    botId: p.botId === null ? null : text(p.botId), onlineVersionId: p.onlineVersionId === null ? null : text(p.onlineVersionId), reviewingVersionId: p.reviewingVersionId === null ? null : text(p.reviewingVersionId),
    version: ver === null ? null : { versionId: text(ver.versionId), status: choice(ver.status,['unknown','approved','rejected','reviewing','unsubmitted']) }, ...(p.managementUrl === undefined ? {} : { managementUrl: url(p.managementUrl) }), ...reason(p.reason) }
  if (result.version && result.version.versionId !== result.onlineVersionId || result.profile?.description !== undefined && !result.version) fail()
  return result
}
export function parseConnectionProfileOperation(v: unknown): ConnectionProfileOperation {
  const p = object(v, ['operationId','connectionId','connectionRevision','application','language','fields','desired','upload','patch','publication','online','managementUrl','reason']), d = object(p.desired,['name','description','avatarSha256'])
  if (!Array.isArray(p.fields) || !p.fields.length || new Set(p.fields).size !== p.fields.length) fail()
  const fields = (p.fields as unknown[]).map(f => choice(f,['name','description','avatar'] as const)), desired = { ...(d.name === undefined ? {} : { name: text(d.name) }), ...(d.description === undefined ? {} : { description: description(d.description) }), ...(d.avatarSha256 === undefined ? {} : { avatarSha256: text(d.avatarSha256) }) }
  if (desired.avatarSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(desired.avatarSha256) || fields.includes('name') !== (d.name !== undefined) || fields.includes('description') !== (d.description !== undefined) || fields.includes('avatar') !== (d.avatarSha256 !== undefined)) fail()
  const stage = (v: unknown, slot: 'upload' | 'patch') => {
    const s = object(v,['state','diagnostic']), state = choice(s.state,['not-required','not-dispatched','dispatching','confirmed','refused','unknown'])
    if (s.diagnostic === undefined) return { state }
    const d = object(s.diagnostic,['stage','nativeCode','httpStatus','transportCode'])
    const diagnostic = { stage: choice(d.stage,slot === 'upload' ? ['upload'] as const : ['prepare-patch','patch'] as const),
      ...(d.nativeCode === undefined ? {} : { nativeCode: (() => { if (!Number.isSafeInteger(d.nativeCode)) fail(); return d.nativeCode as number })() }),
      ...(d.httpStatus === undefined ? {} : { httpStatus: (() => { const status=integer(d.httpStatus,599); if(status<100)fail(); return status })() }),
      ...(d.transportCode === undefined ? {} : { transportCode: choice(d.transportCode,CONNECTION_PROFILE_TRANSPORT_CODES) }) }
    if (!['not-dispatched','unknown','refused'].includes(state) || diagnostic.stage === 'prepare-patch' && state !== 'not-dispatched') fail()
    return { state, diagnostic }
  }
  const result: ConnectionProfileOperation = { operationId:id(p.operationId),connectionId:id(p.connectionId),connectionRevision:integer(p.connectionRevision),application:application(p.application),language:p.language===null?null:text(p.language),fields,desired,upload:stage(p.upload,'upload'),patch:stage(p.patch,'patch'),publication:choice(p.publication,['not-requested','platform-review-required']),online:p.online === null ? null : parseConnectionProfileObservation(p.online),...(p.managementUrl === undefined ? {} : { managementUrl: url(p.managementUrl) }), ...reason(p.reason) }
  if ((result.upload.state === 'not-required') !== !fields.includes('avatar') || result.patch.state === 'not-required' || (result.patch.state === 'confirmed') !== (result.publication === 'platform-review-required')) fail()
  if (result.patch.state !== 'not-dispatched' && !['confirmed', 'not-required'].includes(result.upload.state)) fail()
  if (result.online && (result.online.connectionId !== result.connectionId || result.online.connectionRevision !== result.connectionRevision || JSON.stringify(result.online.application) !== JSON.stringify(result.application))) fail()
  return result
}
export function parseConnectionProfileParams<M extends ConnectionProfileMethod>(method:M,v:unknown):ConnectionProfileParamsMap[M] {
  const p=object(v,method==='connection.profile.get'?['connectionId','expectedConnectionRevision']:method==='connection.profile.ls'?['connectionId','cursor','limit']:['operationId'])
  if(method==='connection.profile.get')return {connectionId:id(p.connectionId),expectedConnectionRevision:integer(p.expectedConnectionRevision)} as ConnectionProfileParamsMap[M]
  if(method==='connection.profile.ls')return {connectionId:id(p.connectionId),...(p.cursor===undefined?{}:{cursor:text(p.cursor)}),...(p.limit===undefined?{}:{limit:integer(p.limit,100)})} as ConnectionProfileParamsMap[M]
  return {operationId:id(p.operationId)} as ConnectionProfileParamsMap[M]
}
export function parseConnectionProfileResult<M extends ConnectionProfileMethod>(method:M,v:unknown,input:ConnectionProfileParamsMap[M]):ConnectionProfileResultMap[M] {
  if(method==='connection.profile.get'){const r=parseConnectionProfileObservation(v),i=input as ConnectionProfileParamsMap['connection.profile.get'];if(r.connectionId!==i.connectionId||r.connectionRevision!==i.expectedConnectionRevision)fail();return r as ConnectionProfileResultMap[M]}
  if(method==='connection.profile.ls'){const p=object(v,['operations','next']),i=input as ConnectionProfileParamsMap['connection.profile.ls'];if(!Array.isArray(p.operations)||p.operations.length>(i.limit??25))fail();const operations=(p.operations as unknown[]).map(parseConnectionProfileOperation);if(new Set(operations.map(o=>o.operationId)).size!==operations.length||operations.some(o=>o.connectionId!==i.connectionId))fail();return {operations,next:p.next===null?null:text(p.next)} as ConnectionProfileResultMap[M]}
  const p=object(v,['operation']),operation=p.operation===null?null:parseConnectionProfileOperation(p.operation)
  if(operation&&operation.operationId!==(input as {operationId:string}).operationId)fail()
  return {operation} as ConnectionProfileResultMap[M]
}
