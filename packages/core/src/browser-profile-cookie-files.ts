import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { FileResource } from './public-rpc-files.js'

/** Cookie bodies belong to Main, the native Session and the explicitly selected file only. */
export type BrowserProfileCookieFileLocation = { kind: 'local'; path: string } | { kind: 'workspace'; resource: FileResource; path: string }
export type BrowserProfileCookieScope = { kind: 'profile' } | { kind: 'sites'; sites: string[] }
export type BrowserProfileCookieFileItem = { index: number; status: 'applied' | 'skipped' | 'rejected' | 'unknown' | 'not-attempted'; reason?: 'invalid-cookie' | 'expired' | 'duplicate-in-file' | 'outside-scope' | 'unsupported-cookie' | 'native-rejected' | 'native-unconfirmed' | 'not-dispatched' }
export type BrowserProfileCookieFileCounts = { total: number; applied: number; skipped: number; rejected: number; unknown: number; notAttempted: number }
export type BrowserProfileCookieFileReceipt = { operationId: string; profileId: string; kind: 'import' | 'export'; scope: BrowserProfileCookieScope;
  status: 'pending' | 'completed' | 'partial' | 'failed' | 'cancelled'; fileOutcome?: 'written' | 'not-written' | 'unknown'; counts: BrowserProfileCookieFileCounts; warning?: string }
export type BrowserProfileCookieImportReview = { reviewId: string; profileId: string; scope: BrowserProfileCookieScope; total: number; valid: number; skipped: number; sites: string[]; sourceKind: BrowserProfileCookieFileLocation['kind'] }
export type BrowserProfileCookieFileInspection = { profileId: string; pending: BrowserProfileCookieFileReceipt[]; recent: BrowserProfileCookieFileReceipt[];
  receipt?: BrowserProfileCookieFileReceipt | null; items: BrowserProfileCookieFileItem[]; offset: number; nextOffset: number | null }
export const BROWSER_PROFILE_COOKIE_FILE_OPERATIONS = ['browser.profile.cookie-file.prepare-import', 'browser.profile.cookie-file.import', 'browser.profile.cookie-file.export', 'browser.profile.cookie-file.inspect', 'browser.profile.cookie-file.discard', 'browser.profile.cookie-file.reveal'] as const
export type BrowserProfileCookieFileOperation = typeof BROWSER_PROFILE_COOKIE_FILE_OPERATIONS[number]
export const isBrowserProfileCookieFileOperation = (v: unknown): v is BrowserProfileCookieFileOperation => typeof v === 'string' && (BROWSER_PROFILE_COOKIE_FILE_OPERATIONS as readonly string[]).includes(v)
export type BrowserProfileCookieFilePayload =
  | { operation: 'browser.profile.cookie-file.prepare-import'; profileId: string; operationId: string; source: BrowserProfileCookieFileLocation; scope: BrowserProfileCookieScope }
  | { operation: 'browser.profile.cookie-file.import'; profileId: string; reviewId: string }
  | { operation: 'browser.profile.cookie-file.discard'; profileId: string; reviewId: string }
  | { operation: 'browser.profile.cookie-file.export'; profileId: string; operationId: string; destination: BrowserProfileCookieFileLocation; scope: BrowserProfileCookieScope }
  | { operation: 'browser.profile.cookie-file.inspect'; profileId: string; operationId?: string; offset?: number; limit?: number }
  | { operation: 'browser.profile.cookie-file.reveal'; profileId: string; operationId: string }
export type BrowserProfileCookieFileResult =
  | { operation: 'browser.profile.cookie-file.prepare-import'; review: BrowserProfileCookieImportReview }
  | { operation: 'browser.profile.cookie-file.import'; receipt: BrowserProfileCookieFileReceipt }
  | { operation: 'browser.profile.cookie-file.export'; receipt: BrowserProfileCookieFileReceipt }
  | ({ operation: 'browser.profile.cookie-file.inspect' } & BrowserProfileCookieFileInspection)
  | { operation: 'browser.profile.cookie-file.discard'; profileId: string; reviewId: string; discarded: true }
  | { operation: 'browser.profile.cookie-file.reveal'; profileId: string; operationId: string; revealed: boolean }
const fail = (): never => { throw new AgentMuxError('The exact Cookie file request or safe receipt is invalid.', 'INVALID_CONTROL_REQUEST') }
const text = (v: unknown): string => typeof v === 'string' && v.trim() && !/[\u0000-\u001f\u007f]/u.test(v) ? v : fail()
const count = (v: unknown): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : fail()
const array = <T>(v: unknown, parse: (v: unknown) => T): T[] => Array.isArray(v) ? v.map(parse) : fail()
export function parseBrowserProfileCookieScope(value: unknown): BrowserProfileCookieScope {
  const r = rpcRecord(value)
  if (r.kind === 'profile') { rpcRecord(r, ['kind']); return { kind: 'profile' } }
  rpcRecord(r, ['kind', 'sites']); if (r.kind !== 'sites') return fail()
  const sites = array(r.sites, text); if (!sites.length || new Set(sites).size !== sites.length) return fail()
  return { kind: 'sites', sites }
}
export function parseBrowserProfileCookieFileLocation(value: unknown): BrowserProfileCookieFileLocation {
  const r = rpcRecord(value), path = text(r.path)
  if (r.kind === 'local') { rpcRecord(r, ['kind', 'path']); return { kind: 'local', path } }
  rpcRecord(r, ['kind', 'resource', 'path']); if (r.kind !== 'workspace') return fail()
  const v = rpcRecord(r.resource, ['hostId', 'workspaceId', 'workspacePath'])
  return { kind: 'workspace', path, resource: { hostId: text(v.hostId), workspaceId: text(v.workspaceId), workspacePath: text(v.workspacePath) } }
}
export function parseBrowserProfileCookieFilePayload(value: unknown): BrowserProfileCookieFilePayload {
  const r = rpcRecord(value), operation = r.operation as BrowserProfileCookieFileOperation, profileId = text(r.profileId)
  const keys = operation === 'browser.profile.cookie-file.prepare-import' ? ['operationId', 'source', 'scope'] : operation === 'browser.profile.cookie-file.import' || operation === 'browser.profile.cookie-file.discard' ? ['reviewId']
    : operation === 'browser.profile.cookie-file.export' ? ['operationId', 'destination', 'scope'] : operation === 'browser.profile.cookie-file.inspect' ? ['operationId', 'offset', 'limit'] : operation === 'browser.profile.cookie-file.reveal' ? ['operationId'] : fail()
  rpcRecord(r, ['operation', 'profileId', 'schemaVersion', 'requestId', ...keys])
  if (operation === 'browser.profile.cookie-file.import' || operation === 'browser.profile.cookie-file.discard') return { operation, profileId, reviewId: text(r.reviewId) }
  if (operation === 'browser.profile.cookie-file.inspect') { const limit = r.limit === undefined ? undefined : count(r.limit); if (limit !== undefined && (limit < 1 || limit > 64) || r.operationId === undefined && (r.offset !== undefined || limit !== undefined)) return fail(); return { operation, profileId, ...(r.operationId === undefined ? {} : { operationId: text(r.operationId) }), ...(r.offset === undefined ? {} : { offset: count(r.offset) }), ...(limit === undefined ? {} : { limit }) } }
  const operationId = text(r.operationId)
  if (operation === 'browser.profile.cookie-file.reveal') return { operation, profileId, operationId }
  const scope = parseBrowserProfileCookieScope(r.scope)
  return operation === 'browser.profile.cookie-file.prepare-import' ? { operation, profileId, operationId, source: parseBrowserProfileCookieFileLocation(r.source), scope } : { operation: 'browser.profile.cookie-file.export', profileId, operationId, destination: parseBrowserProfileCookieFileLocation(r.destination), scope }
}
export function parseBrowserProfileCookieFileReceipt(value: unknown): BrowserProfileCookieFileReceipt {
  const r = rpcRecord(value, ['operationId', 'profileId', 'kind', 'scope', 'status', 'fileOutcome', 'counts', 'warning']), c = rpcRecord(r.counts, ['total', 'applied', 'skipped', 'rejected', 'unknown', 'notAttempted'])
  if (!['import', 'export'].includes(r.kind as string) || !['pending', 'completed', 'partial', 'failed', 'cancelled'].includes(r.status as string)) return fail()
  if (r.fileOutcome !== undefined && (r.kind !== 'export' || !['written','not-written','unknown'].includes(r.fileOutcome as string))) return fail()
  const counts = { total: count(c.total), applied: count(c.applied), skipped: count(c.skipped), rejected: count(c.rejected), unknown: count(c.unknown), notAttempted: count(c.notAttempted) }
  if (counts.total !== counts.applied + counts.skipped + counts.rejected + counts.unknown + counts.notAttempted) return fail()
  if(r.kind==='export'&&(r.fileOutcome===undefined||r.status==='completed'&&r.fileOutcome!=='written'||r.status==='pending'&&r.fileOutcome!=='unknown'||r.status==='cancelled'&&r.fileOutcome!=='not-written'||r.fileOutcome==='unknown'&&r.status!=='pending'||r.status==='partial'&&r.fileOutcome!=='written'))return fail()
  if(r.status==='completed'&&counts.applied!==counts.total||r.status==='cancelled'&&(counts.applied||counts.rejected||counts.unknown))return fail()
  if(counts.unknown&&r.status!=='pending'||r.kind==='export'&&counts.applied>0&&r.fileOutcome!=='written')return fail()
  return { operationId: text(r.operationId), profileId: text(r.profileId), kind: r.kind as 'import' | 'export', scope: parseBrowserProfileCookieScope(r.scope), status: r.status as BrowserProfileCookieFileReceipt['status'], ...(r.fileOutcome === undefined ? {} : { fileOutcome: r.fileOutcome as NonNullable<BrowserProfileCookieFileReceipt['fileOutcome']> }), counts, ...(r.warning === undefined ? {} : { warning: text(r.warning) }) }
}
export function parseBrowserProfileCookieFileItem(value: unknown): BrowserProfileCookieFileItem {
  const r = rpcRecord(value, ['index', 'status', 'reason'])
  if (!['applied', 'skipped', 'rejected', 'unknown', 'not-attempted'].includes(r.status as string) || r.reason !== undefined && !['invalid-cookie', 'expired', 'duplicate-in-file', 'outside-scope', 'unsupported-cookie', 'native-rejected', 'native-unconfirmed', 'not-dispatched'].includes(r.reason as string)) return fail()
  return { index: count(r.index), status: r.status as BrowserProfileCookieFileItem['status'], ...(r.reason === undefined ? {} : { reason: r.reason as NonNullable<BrowserProfileCookieFileItem['reason']> }) }
}
export function parseBrowserProfileCookieFileResult(operation: BrowserProfileCookieFileOperation, value: unknown): BrowserProfileCookieFileResult {
  try {
    const r = rpcRecord(value); if (r.operation !== undefined && r.operation !== operation) return fail()
    if (operation === 'browser.profile.cookie-file.prepare-import') { rpcRecord(r, ['operation', 'review']); const v = rpcRecord(r.review, ['reviewId', 'profileId', 'scope', 'total', 'valid', 'skipped', 'sites', 'sourceKind']); if (!['local', 'workspace'].includes(v.sourceKind as string) || count(v.total) !== count(v.valid) + count(v.skipped)) return fail(); return { operation, review: { reviewId: text(v.reviewId), profileId: text(v.profileId), scope: parseBrowserProfileCookieScope(v.scope), total: count(v.total), valid: count(v.valid), skipped: count(v.skipped), sites: array(v.sites, text), sourceKind: v.sourceKind as 'local' | 'workspace' } } }
    if (operation === 'browser.profile.cookie-file.import' || operation === 'browser.profile.cookie-file.export') { rpcRecord(r, ['operation', 'receipt']); return { operation, receipt: parseBrowserProfileCookieFileReceipt(r.receipt) } }
    if (operation === 'browser.profile.cookie-file.discard') { rpcRecord(r, ['operation', 'profileId', 'reviewId', 'discarded']); if (r.discarded !== true) return fail(); return { operation, profileId: text(r.profileId), reviewId: text(r.reviewId), discarded: true } }
    if (operation === 'browser.profile.cookie-file.reveal') { rpcRecord(r, ['operation', 'profileId', 'operationId', 'revealed']); if (typeof r.revealed !== 'boolean') return fail(); return { operation, profileId: text(r.profileId), operationId: text(r.operationId), revealed: r.revealed } }
    rpcRecord(r, ['operation', 'profileId', 'pending', 'recent', 'receipt', 'items', 'offset', 'nextOffset']); const pending = array(r.pending, parseBrowserProfileCookieFileReceipt), recent = array(r.recent, parseBrowserProfileCookieFileReceipt)
    if (pending.some(v => v.status !== 'pending') || new Set(pending.map(v => v.operationId)).size !== pending.length) return fail()
    return { operation, profileId: text(r.profileId), pending, recent, ...(r.receipt === undefined ? {} : { receipt: r.receipt === null ? null : parseBrowserProfileCookieFileReceipt(r.receipt) }), items: array(r.items, parseBrowserProfileCookieFileItem), offset: count(r.offset), nextOffset: r.nextOffset === null ? null : count(r.nextOffset) }
  } catch { throw new AgentMuxError('The Cookie file owner returned invalid safe operation facts.', 'CONTROL_PROTOCOL_ERROR') }
}
const sameScope = (a: BrowserProfileCookieScope, b: BrowserProfileCookieScope) => a.kind === b.kind && (a.kind === 'profile' || b.kind === 'sites' && a.sites.length === b.sites.length && a.sites.every(s => b.sites.includes(s)))
export function assertBrowserProfileCookieFileTarget(request: BrowserProfileCookieFilePayload, result: BrowserProfileCookieFileResult): void {
  const wrong = (): never => { throw new AgentMuxError('The Cookie file receipt belongs to another original Profile, scope or operation.', 'CONTROL_PROTOCOL_ERROR') }
  if (request.operation !== result.operation) return wrong()
  if (result.operation === 'browser.profile.cookie-file.prepare-import') { if (request.operation !== result.operation || result.review.profileId !== request.profileId || result.review.reviewId !== request.operationId || !sameScope(result.review.scope, request.scope)) return wrong(); return }
  if (result.operation === 'browser.profile.cookie-file.import' || result.operation === 'browser.profile.cookie-file.export') { if (request.operation !== result.operation || result.receipt.profileId !== request.profileId || result.receipt.operationId !== (request.operation === 'browser.profile.cookie-file.import' ? request.reviewId : request.operationId) || result.receipt.kind !== (request.operation === 'browser.profile.cookie-file.import' ? 'import' : 'export') || request.operation === 'browser.profile.cookie-file.export' && !sameScope(result.receipt.scope, request.scope)) return wrong(); return }
  if (result.profileId !== request.profileId) return wrong()
  if (result.operation === 'browser.profile.cookie-file.discard' && request.operation === result.operation && result.reviewId !== request.reviewId) return wrong()
  if (result.operation === 'browser.profile.cookie-file.reveal' && request.operation === result.operation && result.operationId !== request.operationId) return wrong()
  if (result.operation === 'browser.profile.cookie-file.inspect' && request.operation === result.operation) {
    if ([...result.pending, ...result.recent, ...(result.receipt ? [result.receipt] : [])].some(r => r.profileId !== request.profileId) || request.operationId !== undefined && (!Object.hasOwn(result, 'receipt') || result.receipt && result.receipt.operationId !== request.operationId) || result.offset !== (request.offset ?? 0) || result.items.length > (request.limit ?? 64) || result.items.some((v,i) => v.index !== result.offset+i)) return wrong()
  }
}
