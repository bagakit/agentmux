import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseMobileWebObservation } from './client-incident.js'
import { isDeliveryLogId } from './delivery-log-id.js'
import type { MobileAssetManifest, MobileAssetRelease, MobileAssetsInspection, MobileAssetsLoadedReceipt,
  MobileAssetsActivationReceipt, MobileAssetsMethod, MobileAssetsParamsMap, MobileAssetsResultMap, MobileWebProducer,
  MobileWebReportParams, MobileWebReportReceipt } from './mobile-web.js'

const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && Boolean(value) && !/[\0\r\n]/u.test(value) && size(value) <= max + 2
/** The same build identity bound used by manifests and page observations. */
export const isMobileBuildId = (value: unknown): value is string => isText(value, 128)
const sameProducer = (a: MobileWebProducer, b: MobileWebProducer | undefined) =>
  a.devicePrincipalId === b?.devicePrincipalId && a.documentId === b.documentId
function boundary(result = false) {
  const code = result ? 'CONTROL_PROTOCOL_ERROR' : 'INVALID_CONTROL_REQUEST'
  const fail = (): never => { throw new AgentMuxError('Mobile Web data does not satisfy its finite original contract.', code) }
  const record = (value: unknown, keys: readonly string[]) => rpcRecord(value, keys, code)
  const text = (value: unknown, max = 512): void => {
    if (!isText(value, max)) fail()
  }
  const count = (value: unknown, max = Number.MAX_SAFE_INTEGER): void => {
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) fail()
  }
  const digest = (value: unknown): void => { if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) fail() }
  const member = (value: unknown, values: readonly unknown[]): void => { if (!values.includes(value)) fail() }
  const producer = (value: unknown): void => { const p = record(value, ['devicePrincipalId', 'documentId']); text(p.devicePrincipalId); text(p.documentId, 128) }
  return { fail, record, text, count, digest, member, producer }
}

export function isMobileAssetsMethod(value: string): value is MobileAssetsMethod {
  return value === 'app.mobile.assets.inspect' || value === 'app.mobile.assets.activate' || value === 'app.mobile.assets.loaded'
}
export function parseMobileAssetsParams<M extends MobileAssetsMethod>(method: M, value: unknown): MobileAssetsParamsMap[M] {
  const { record, text, count, digest, producer, fail } = boundary()
  if (method === 'app.mobile.assets.inspect') {
    const p = record(value, ['hostId', 'operationId', 'client']); text(p.hostId)
    if (p.operationId !== undefined) text(p.operationId, 128)
    if (p.client !== undefined) producer(p.client)
    if (p.operationId !== undefined && p.client !== undefined) fail()
  } else if (method === 'app.mobile.assets.activate') {
    const p = record(value, ['hostId', 'operationId', 'candidatePath', 'candidateDigest', 'expectedActiveRevision'])
    text(p.hostId); text(p.operationId, 128); text(p.candidatePath, 4096); digest(p.candidateDigest); count(p.expectedActiveRevision)
    const path = p.candidatePath as string
    if (/^(?:[\\/]|[A-Za-z]:)/u.test(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) fail()
  } else {
    const p = record(value, ['documentId', 'buildId', 'namespaceDigest', 'occurrenceId', 'observedAt'])
    text(p.documentId, 128); if (p.buildId !== null) text(p.buildId, 128)
    if (p.namespaceDigest !== null) digest(p.namespaceDigest)
    text(p.occurrenceId, 128); count(p.observedAt)
  }
  return value as MobileAssetsParamsMap[M]
}

export function parseMobileAssetManifest(value: unknown): MobileAssetManifest {
  const { record, text, count, digest, fail, member } = boundary(true)
  const p = record(value, ['schema', 'buildId', 'files', 'digest'])
  member(p.schema, ['agentmux.mobile-web-release.v1']); text(p.buildId, 128); digest(p.digest)
  if (!Array.isArray(p.files) || p.files.length < 1 || p.files.length > 1024) fail()
  const seen = new Set<string>(); let bytes = 0
  for (const file of p.files as unknown[]) {
    const f = record(file, ['path', 'bytes', 'digest']); text(f.path, 256); count(f.bytes, 16 * 1024 * 1024); digest(f.digest)
    if (f.path !== 'index.html' && !/^assets\/[A-Za-z0-9_.-]+\.(?:js|css|woff2?|ttf|otf|svg|png|jpe?g|webp|ico)$/u.test(f.path as string)) fail()
    if (seen.has(f.path as string)) fail()
    seen.add(f.path as string); bytes += f.bytes as number
  }
  if (!seen.has('index.html') || bytes > 32 * 1024 * 1024 || size(value) > 256 * 1024) fail()
  return value as MobileAssetManifest
}

function release(value: unknown): MobileAssetRelease {
  const { record, text, count, digest } = boundary(true)
  const p = record(value, ['buildId', 'digest', 'bytes', 'fileCount']); text(p.buildId, 128); digest(p.digest)
  count(p.bytes, 32 * 1024 * 1024); count(p.fileCount, 1024)
  return value as MobileAssetRelease
}
function loaded(value: unknown): MobileAssetsLoadedReceipt {
  const { record, text, count, member, producer, digest, fail } = boundary(true)
  const p = record(value, ['hostId', 'producer', 'hostInstanceId', 'buildId', 'namespaceDigest', 'occurrenceId', 'observedAt', 'receivedAt', 'accepted', 'reason'])
  text(p.hostId); producer(p.producer); text(p.hostInstanceId, 128); if (p.buildId !== null) text(p.buildId, 128)
  if (p.namespaceDigest !== null) digest(p.namespaceDigest)
  text(p.occurrenceId, 128); count(p.observedAt); count(p.receivedAt); member(p.accepted, [true, false]); member(p.reason, ['capacity', null])
  if (p.accepted !== (p.reason === null) || size(value) > 1024) fail()
  return value as MobileAssetsLoadedReceipt
}
function activation(value: unknown): MobileAssetsActivationReceipt {
  const { record, text, count, member, digest, fail } = boundary(true)
  const p = record(value, ['operationId', 'hostInstanceId', 'inputDigest', 'expectedActiveRevision', 'status', 'reason', 'candidate', 'activeRevision', 'persistence', 'observedAt'])
  text(p.operationId, 128); text(p.hostInstanceId, 128); digest(p.inputDigest); count(p.expectedActiveRevision)
  member(p.status, ['active', 'rejected', 'not-admitted']); member(p.reason, ['busy', 'capacity', 'stale-revision', 'candidate-invalid', 'source-changed', null])
  if (p.candidate !== null) release(p.candidate)
  count(p.activeRevision); member(p.persistence, ['not-requested']); count(p.observedAt)
  if (p.status === 'active' && (p.reason !== null || p.candidate === null || p.activeRevision !== (p.expectedActiveRevision as number) + 1) ||
      p.status !== 'active' && p.reason === null || size(value) > 4096) fail()
  return value as MobileAssetsActivationReceipt
}
export function parseMobileAssetsResult<M extends MobileAssetsMethod>(method: M, value: unknown, input: MobileAssetsParamsMap[M]): MobileAssetsResultMap[M] {
  const { record, text, count, member, producer, fail } = boundary(true)
  if (method === 'app.mobile.assets.loaded') {
    const result = loaded(value), p = input as MobileAssetsParamsMap['app.mobile.assets.loaded']
    if (result.producer.documentId !== p.documentId || result.buildId !== p.buildId || result.namespaceDigest !== p.namespaceDigest || result.occurrenceId !== p.occurrenceId || result.observedAt !== p.observedAt) fail()
  } else if (method === 'app.mobile.assets.activate') {
    const result = activation(value), p = input as MobileAssetsParamsMap['app.mobile.assets.activate']
    if (result.operationId !== p.operationId || result.expectedActiveRevision !== p.expectedActiveRevision || result.candidate && result.candidate.digest !== p.candidateDigest) fail()
  } else {
    const p = record(value, ['hostId', 'hostInstanceId', 'active', 'retained', 'retention', 'operation', 'clients', 'client', 'coverage', 'observedAt'])
    const query = input as MobileAssetsParamsMap['app.mobile.assets.inspect']
    text(p.hostId); if (p.hostId !== query.hostId) fail(); text(p.hostInstanceId, 128); count(p.observedAt)
    if (p.active !== null) {
      const active = record(p.active, ['buildId', 'digest', 'bytes', 'fileCount', 'revision']); count(active.revision)
      const { revision: _revision, ...body } = active; release(body)
    }
    member(p.retention, ['active-and-previous'])
    if (!Array.isArray(p.retained) || p.retained.length > 2 || !Array.isArray(p.clients) || p.clients.length > 32) fail()
    const releases = (p.retained as unknown[]).map(release)
    if (new Set(releases.map(r => r.buildId)).size !== releases.length || releases.reduce((sum, r) => sum + r.bytes, 0) > 64 * 1024 * 1024) fail()
    if (p.active !== null && !releases.some(r => r.digest === (p.active as MobileAssetRelease).digest)) fail()
    const clients = (p.clients as unknown[]).map(loaded)
    if (clients.some(c => !c.accepted || c.hostId !== p.hostId || c.hostInstanceId !== p.hostInstanceId) ||
      new Set(clients.map(c => JSON.stringify([c.producer.devicePrincipalId, c.producer.documentId]))).size !== clients.length) fail()
    if (p.operation !== null) {
      const op = record(p.operation, ['operationId', 'availability', 'receipt']); text(op.operationId, 128)
      if (op.operationId !== query.operationId) fail(); member(op.availability, ['found', 'in-flight', 'not-retained'])
      if (op.receipt !== null) { const r = activation(op.receipt); if (r.operationId !== op.operationId) fail() }
      if ((op.availability === 'found') !== (op.receipt !== null)) fail()
    } else if (query.operationId !== undefined) fail()
    if (p.client !== null) {
      const c = record(p.client, ['target', 'availability', 'loaded', 'namespace']); producer(c.target)
      if (!sameProducer(c.target as MobileWebProducer, query.client)) fail()
      member(c.availability, ['found', 'not-retained']); member(c.namespace, ['retained', 'not-retained', 'unknown'])
      if (c.loaded !== null) { const item = loaded(c.loaded); if (!sameProducer(item.producer, c.target as MobileWebProducer) || item.hostId !== p.hostId || item.hostInstanceId !== p.hostInstanceId) fail() }
      if ((c.availability === 'found') !== (c.loaded !== null)) fail()
    } else if (query.client !== undefined) fail()
    const coverage = record(p.coverage, ['lifetime', 'operationsRetained', 'operationsEvicted', 'loadedRetained', 'loadedRejected'])
    member(coverage.lifetime, ['current-host-instance']); count(coverage.operationsRetained, 64); count(coverage.operationsEvicted)
    count(coverage.loadedRetained, 32); count(coverage.loadedRejected)
  }
  return value as MobileAssetsResultMap[M]
}

export function parseMobileWebReportParams(value: unknown): MobileWebReportParams {
  const { record, text, count, digest, fail } = boundary()
  const p = record(value, ['documentId', 'buildId', 'namespaceDigest', 'occurrenceId', 'observedAt', 'observation', 'reporter'])
  text(p.documentId, 128); if (p.buildId !== null) text(p.buildId, 128)
  if (p.namespaceDigest !== null) digest(p.namespaceDigest)
  text(p.occurrenceId, 128); count(p.observedAt)
  // Incident identities have the same finite stable-machine alphabet as their original archive.
  if (![p.documentId, p.occurrenceId, ...(p.buildId === null ? [] : [p.buildId])].every(v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(v))) fail()
  parseMobileWebObservation(p.observation)
  const reporter = record(p.reporter, ['droppedCount', 'queuedCount', 'queuedBytes'])
  count(reporter.droppedCount); count(reporter.queuedCount, 16); count(reporter.queuedBytes, 64 * 1024)
  if (size(value) > 4096) fail()
  return value as MobileWebReportParams
}
export function parseMobileWebReportReceipt(value: unknown, input: MobileWebReportParams): MobileWebReportReceipt {
  const { record, text, member, producer, fail } = boundary(true)
  const p = record(value, ['hostId', 'producer', 'accepted', 'logId', 'recordRef', 'persistence'])
  text(p.hostId); producer(p.producer); member(p.accepted, [true, false]); member(p.persistence, ['unconfirmed'])
  if ((p.producer as MobileWebProducer).documentId !== input.documentId || p.logId !== null && !isDeliveryLogId(p.logId)) fail()
  if (p.recordRef !== null) {
    const ref = record(p.recordRef, ['domain', 'logId', 'authority', 'routeHostId'])
    member(ref.domain, ['client.incident']); if (ref.logId !== p.logId || ref.routeHostId !== p.hostId) fail()
    const authority = record(ref.authority, ['kind', 'id', 'lifetime'])
    member(authority.kind, ['client-incident-archive']); text(authority.id, 128); member(authority.lifetime, ['durable'])
  }
  if (!p.accepted && (p.logId !== null || p.recordRef !== null) || p.logId === null && p.recordRef !== null || size(value) > 2048) fail()
  return value as MobileWebReportReceipt
}
