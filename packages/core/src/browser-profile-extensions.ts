import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'

export type BrowserProfileExtensionInputSource =
  | { kind: 'local'; path: string }
  | { kind: 'package-url'; url: string }
  | { kind: 'update-manifest'; url: string; addonId: string }

/** Native extension semantics stay with the Browser host. These are approved package facts only. */
export type BrowserProfileExtensionSource = { kind: 'directory' | 'zip' | 'crx'; label: string; homepage?: string; updateUrl?: string; signature: 'not-verified' | 'package-verified'; retrieval?: { kind: 'package-url' | 'update-manifest'; origin: string; packageSha256: string; manifestSha256?: string; format?: 'chromium-xml' | 'webextensions-json' } }
export type BrowserProfileExtensionPermissions = { api: string[]; hosts: string[]; contentScripts: string[]; optional: string[]; fileAccess: false }
export type BrowserProfileExtensionApplication = { state: 'loaded' | 'unknown' | 'failed'; reason?: string }
export type BrowserProfileExtension = { id: string; nativeId: string; name: string; version: string; sha256: string; source: BrowserProfileExtensionSource;
  permissions: BrowserProfileExtensionPermissions; application: BrowserProfileExtensionApplication }
export type BrowserProfileExtensionReview = { reviewId: string; profileId: string; expectedRevision: string; extensionId: string;
  name: string; version: string; sha256: string; source: BrowserProfileExtensionSource; permissions: BrowserProfileExtensionPermissions;
  addedPermissions: string[]; previousVersion?: string }
export type BrowserProfileExtensionReceipt = { operationId: string; profileId: string; extensionId: string; kind: 'install' | 'update' | 'remove'; sha256: string }
export type BrowserProfileExtensionPending = BrowserProfileExtensionReceipt & { expectedRevision: string; version: string; previousSha256?: string; nativeId?: string }
export const BROWSER_PROFILE_EXTENSION_OPERATIONS = ['browser.profile.extension.ls', 'browser.profile.extension.prepare', 'browser.profile.extension.apply', 'browser.profile.extension.remove', 'browser.profile.extension.load'] as const
export type BrowserProfileExtensionOperation = typeof BROWSER_PROFILE_EXTENSION_OPERATIONS[number]
export function isBrowserProfileExtensionOperation(value: unknown): value is BrowserProfileExtensionOperation { return typeof value === 'string' && (BROWSER_PROFILE_EXTENSION_OPERATIONS as readonly string[]).includes(value) }
export type BrowserProfileExtensionPayload =
  | { operation: 'browser.profile.extension.ls'; profileId: string; operationId?: string }
  | { operation: 'browser.profile.extension.prepare'; profileId: string; expectedRevision: string; operationId: string; source: BrowserProfileExtensionInputSource; extensionId?: string }
  | { operation: 'browser.profile.extension.apply'; profileId: string; expectedRevision: string; reviewId: string }
  | { operation: 'browser.profile.extension.remove'; profileId: string; expectedRevision: string; extensionId: string; operationId: string }
  | { operation: 'browser.profile.extension.load'; profileId: string; extensionId: string }
export type BrowserProfileExtensionResult =
  | { operation: 'browser.profile.extension.ls'; profileId: string; profileRevision: string; extensions: BrowserProfileExtension[]; pending: BrowserProfileExtensionPending[]; receipt?: BrowserProfileExtensionReceipt | null }
  | { operation: 'browser.profile.extension.prepare'; review: BrowserProfileExtensionReview }
  | { operation: 'browser.profile.extension.apply' | 'browser.profile.extension.remove'; profileId: string; profileRevision: string; outcome: 'applied' | 'cancelled'; receipt: BrowserProfileExtensionReceipt | null; application?: BrowserProfileExtensionApplication }
  | { operation: 'browser.profile.extension.load'; profileId: string; extensionId: string; application: BrowserProfileExtensionApplication }
const fail = (): never => { throw new AgentMuxError('The exact extension request or receipt is invalid.', 'INVALID_CONTROL_REQUEST') }
const text = (value: unknown): string => { if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/.test(value)) return fail(); return value }
const strings = (value: unknown): string[] => { if (!Array.isArray(value)) return fail(); return value.map(text) }
export function parseBrowserProfileExtensionSource(value: unknown): BrowserProfileExtensionSource {
  const r = rpcRecord(value, ['kind', 'label', 'homepage', 'updateUrl', 'signature', 'retrieval'])
  if (!['directory', 'zip', 'crx'].includes(r.kind as string) || !['not-verified', 'package-verified'].includes(r.signature as string)) return fail()
  return { kind: r.kind as BrowserProfileExtensionSource['kind'], label: text(r.label), signature: r.signature as BrowserProfileExtensionSource['signature'],
    ...(r.retrieval === undefined ? {} : { retrieval: retrieval(r.retrieval) }),
    ...(r.homepage === undefined ? {} : { homepage: text(r.homepage) }), ...(r.updateUrl === undefined ? {} : { updateUrl: text(r.updateUrl) }) }
}
export function parseBrowserProfileExtensionInputSource(value: unknown): BrowserProfileExtensionInputSource {
  const r = rpcRecord(value)
  if (r.kind === 'local') { rpcRecord(r, ['kind', 'path']); return { kind: 'local', path: text(r.path) } }
  if (r.kind !== 'package-url' && r.kind !== 'update-manifest') return fail()
  rpcRecord(r, r.kind === 'package-url' ? ['kind', 'url'] : ['kind', 'url', 'addonId'])
  let url: URL
  try { url = new URL(text(r.url)) } catch { return fail() }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return fail()
  return r.kind === 'package-url' ? { kind: r.kind, url: url.href } : { kind: r.kind, url: url.href, addonId: text(r.addonId) }
}
function retrieval(value: unknown): NonNullable<BrowserProfileExtensionSource['retrieval']> {
  const r = rpcRecord(value, ['kind', 'origin', 'packageSha256', 'manifestSha256', 'format'])
  if (!['package-url', 'update-manifest'].includes(r.kind as string)) return fail()
  const origin = text(r.origin)
  try { if (new URL(origin).origin !== origin || !origin.startsWith('https://')) return fail() } catch { return fail() }
  if (r.format !== undefined && !['chromium-xml', 'webextensions-json'].includes(r.format as string)) return fail()
  return { kind: r.kind as 'package-url' | 'update-manifest', origin, packageSha256: digest(r.packageSha256),
    ...(r.manifestSha256 === undefined ? {} : { manifestSha256: digest(r.manifestSha256) }), ...(r.format === undefined ? {} : { format: r.format as 'chromium-xml' | 'webextensions-json' }) }
}
export function parseBrowserProfileExtensionPermissions(value: unknown): BrowserProfileExtensionPermissions {
  const r = rpcRecord(value, ['api', 'hosts', 'contentScripts', 'optional', 'fileAccess'])
  if (r.fileAccess !== false) return fail()
  return { api: strings(r.api), hosts: strings(r.hosts), contentScripts: strings(r.contentScripts), optional: strings(r.optional), fileAccess: false }
}
function application(value: unknown): BrowserProfileExtensionApplication {
  const r = rpcRecord(value, ['state', 'reason']); if (!['loaded', 'unknown', 'failed'].includes(r.state as string)) return fail()
  return { state: r.state as BrowserProfileExtensionApplication['state'], ...(r.reason === undefined ? {} : { reason: text(r.reason) }) }
}
function digest(value: unknown): string { const v = text(value); if (!/^[a-f0-9]{64}$/.test(v)) return fail(); return v }
function receipt(value: unknown): BrowserProfileExtensionReceipt {
  const r = rpcRecord(value, ['operationId', 'profileId', 'extensionId', 'kind', 'sha256']); if (!['install', 'update', 'remove'].includes(r.kind as string)) return fail()
  return { operationId: text(r.operationId), profileId: text(r.profileId), extensionId: text(r.extensionId), kind: r.kind as BrowserProfileExtensionReceipt['kind'], sha256: digest(r.sha256) }
}
export function parseBrowserProfileExtensionPayload(value: unknown): BrowserProfileExtensionPayload {
  const r = rpcRecord(value), operation = r.operation as BrowserProfileExtensionOperation, profileId = text(r.profileId)
  const fields = operation === 'browser.profile.extension.ls' ? ['operationId'] : operation === 'browser.profile.extension.prepare'
    ? ['expectedRevision', 'operationId', 'source', 'extensionId'] : operation === 'browser.profile.extension.apply'
      ? ['expectedRevision', 'reviewId'] : operation === 'browser.profile.extension.remove' ? ['expectedRevision', 'extensionId', 'operationId'] : operation === 'browser.profile.extension.load' ? ['extensionId'] : fail()
  rpcRecord(r, ['operation', 'profileId', 'requestId', 'schemaVersion', ...fields], 'INVALID_CONTROL_REQUEST')
  if (operation === 'browser.profile.extension.ls') return { operation, profileId, ...(r.operationId === undefined ? {} : { operationId: text(r.operationId) }) }
  if (operation === 'browser.profile.extension.prepare') return { operation, profileId, expectedRevision: text(r.expectedRevision), operationId: text(r.operationId), source: parseBrowserProfileExtensionInputSource(r.source), ...(r.extensionId === undefined ? {} : { extensionId: text(r.extensionId) }) }
  if (operation === 'browser.profile.extension.apply') return { operation, profileId, expectedRevision: text(r.expectedRevision), reviewId: text(r.reviewId) }
  if (operation === 'browser.profile.extension.remove') return { operation, profileId, expectedRevision: text(r.expectedRevision), extensionId: text(r.extensionId), operationId: text(r.operationId) }
  return { operation: 'browser.profile.extension.load', profileId, extensionId: text(r.extensionId) }
}
function pending(value: unknown): BrowserProfileExtensionPending {
  const r = rpcRecord(value, ['operationId', 'profileId', 'extensionId', 'kind', 'sha256', 'expectedRevision', 'version', 'previousSha256', 'nativeId'])
  const { expectedRevision, version, previousSha256, nativeId, ...ack } = r
  return { ...receipt(ack), expectedRevision: text(expectedRevision), version: text(version), ...(previousSha256 === undefined ? {} : { previousSha256: digest(previousSha256) }), ...(nativeId === undefined ? {} : { nativeId: text(nativeId) }) }
}
function extensionResult(operation: BrowserProfileExtensionOperation, value: unknown): BrowserProfileExtensionResult {
  const r = rpcRecord(value)
  const resultFields = operation === 'browser.profile.extension.prepare' ? ['review'] : operation === 'browser.profile.extension.ls' ? ['profileId', 'profileRevision', 'extensions', 'pending', 'receipt'] : operation === 'browser.profile.extension.load' ? ['profileId', 'extensionId', 'application'] : ['profileId', 'profileRevision', 'outcome', 'receipt', 'application']
  rpcRecord(r, ['operation', ...resultFields], 'CONTROL_PROTOCOL_ERROR')
  if (r.operation !== undefined && r.operation !== operation) return fail()
  if (operation === 'browser.profile.extension.prepare') {
    const v = rpcRecord(r.review, ['reviewId', 'profileId', 'expectedRevision', 'extensionId', 'name', 'version', 'sha256', 'source', 'permissions', 'addedPermissions', 'previousVersion'])
    return { operation, review: { reviewId: text(v.reviewId), profileId: text(v.profileId), expectedRevision: text(v.expectedRevision), extensionId: text(v.extensionId),
      name: text(v.name), version: text(v.version), sha256: digest(v.sha256), source: parseBrowserProfileExtensionSource(v.source), permissions: parseBrowserProfileExtensionPermissions(v.permissions),
      addedPermissions: strings(v.addedPermissions), ...(v.previousVersion === undefined ? {} : { previousVersion: text(v.previousVersion) }) } }
  }
  const profileId = text(r.profileId)
  if (operation === 'browser.profile.extension.load') return { operation, profileId, extensionId: text(r.extensionId), application: application(r.application) }
  const profileRevision = text(r.profileRevision)
  if (operation === 'browser.profile.extension.ls') {
    if (!Array.isArray(r.extensions)) return fail()
    const extensions = r.extensions.map(value => { const v = rpcRecord(value, ['id', 'nativeId', 'name', 'version', 'sha256', 'source', 'permissions', 'application']);
      return { id: text(v.id), nativeId: text(v.nativeId), name: text(v.name), version: text(v.version), sha256: digest(v.sha256), source: parseBrowserProfileExtensionSource(v.source), permissions: parseBrowserProfileExtensionPermissions(v.permissions), application: application(v.application) } })
    if (new Set(extensions.map(extension => extension.id)).size !== extensions.length) return fail()
    if (!Array.isArray(r.pending)) return fail()
    const intents = r.pending.map(pending)
    if (new Set(intents.map(intent => intent.operationId)).size !== intents.length) return fail()
    return { operation, profileId, profileRevision, extensions, pending: intents, ...(r.receipt === undefined ? {} : { receipt: r.receipt === null ? null : receipt(r.receipt) }) }
  }
  if (r.outcome !== 'applied' && r.outcome !== 'cancelled') return fail()
  const acknowledged = r.receipt === null ? null : receipt(r.receipt)
  if (r.outcome === 'applied' ? !acknowledged : acknowledged !== null || r.application !== undefined) return fail()
  if (acknowledged && (operation === 'browser.profile.extension.remove' ? acknowledged.kind !== 'remove' : acknowledged.kind === 'remove')) return fail()
  return { operation, profileId, profileRevision, outcome: r.outcome, receipt: acknowledged, ...(r.application === undefined ? {} : { application: application(r.application) }) }
}

export function parseBrowserProfileExtensionResult(operation: BrowserProfileExtensionOperation, value: unknown): BrowserProfileExtensionResult {
  try { return extensionResult(operation, value) }
  catch { throw new AgentMuxError('The extension owner returned invalid package or native application facts.', 'CONTROL_PROTOCOL_ERROR') }
}
export function assertBrowserProfileExtensionTarget(request: BrowserProfileExtensionPayload, result: BrowserProfileExtensionResult): void {
  const wrong = (): never => { throw new AgentMuxError('The extension receipt belongs to another original request or Profile.', 'CONTROL_PROTOCOL_ERROR') }
  if (request.operation !== result.operation) return wrong()
  if (result.operation === 'browser.profile.extension.prepare') {
    if (request.operation !== result.operation || result.review.profileId !== request.profileId || result.review.reviewId !== request.operationId || result.review.expectedRevision !== request.expectedRevision || request.extensionId !== undefined && result.review.extensionId !== request.extensionId) return wrong()
  } else {
    if (result.profileId !== request.profileId) return wrong()
    if (result.operation === 'browser.profile.extension.load' && request.operation === result.operation && result.extensionId !== request.extensionId) return wrong()
    if ((result.operation === 'browser.profile.extension.apply' || result.operation === 'browser.profile.extension.remove') && result.receipt &&
        (result.receipt.profileId !== request.profileId || request.operation === 'browser.profile.extension.apply' && result.receipt.operationId !== request.reviewId || request.operation === 'browser.profile.extension.remove' && (result.receipt.operationId !== request.operationId || result.receipt.extensionId !== request.extensionId))) return wrong()
    if (result.operation === 'browser.profile.extension.ls' && request.operation === result.operation && (result.pending.some(intent => intent.profileId !== request.profileId || request.operationId !== undefined && intent.operationId !== request.operationId) || request.operationId !== undefined && !Object.hasOwn(result, 'receipt'))) return wrong()
    if (result.operation === 'browser.profile.extension.ls' && request.operation === result.operation && result.receipt && (result.receipt.profileId !== request.profileId || result.receipt.operationId !== request.operationId)) return wrong()
  }
}
