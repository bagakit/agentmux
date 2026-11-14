import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { AgentMuxControlCaller } from './control.js'

/** The original Profile owner keeps exact addresses. Receipts and diagnostics never echo them. */
export type BrowserProfileBookmarkFolder = { id: string; parentId: string | null; label: string; revision: string }
export type BrowserProfileBookmark = { id: string; folderId: string | null; title: string; url: string; revision: string }
export type BrowserProfileBookmarkConflict = { index: number; reason: 'duplicate' | 'unsupported-address' | 'invalid-entry' }
export type BrowserProfileBookmarkReceipt = { operationId: string; expectedRevision: string; folderId?: string | null; entryRevision?: string; kind: 'edit' | 'import' | 'export' | 'open'; status: 'pending' | 'completed' | 'failed';
  entryId?: string; browserId?: string; createdIds: string[]; conflicts: BrowserProfileBookmarkConflict[]; warning?: string }
export type BrowserProfileBookmarkList = { profileId: string; revision: string; folderId: string | null; ancestors: BrowserProfileBookmarkFolder[];
  folders: BrowserProfileBookmarkFolder[]; bookmarks: BrowserProfileBookmark[]; pending: BrowserProfileBookmarkReceipt[]; receipt?: BrowserProfileBookmarkReceipt | null }
export type BrowserProfileBookmarkMutation = { profileId: string; revision: string; receipt: BrowserProfileBookmarkReceipt }
export type BrowserProfileBookmarkChange =
  | { kind: 'create-folder'; parentId: string | null; label: string }
  | { kind: 'rename-folder'; id: string; label: string }
  | { kind: 'move-folder'; id: string; parentId: string | null }
  | { kind: 'remove-folder'; id: string }
  | { kind: 'save'; id?: string; folderId: string | null; title: string; url?: string }
  | { kind: 'remove'; id: string }
export const BROWSER_PROFILE_BOOKMARK_OPERATIONS = ['browser.profile.bookmark.ls', 'browser.profile.bookmark.edit', 'browser.profile.bookmark.import', 'browser.profile.bookmark.export', 'browser.profile.bookmark.open'] as const
export type BrowserProfileBookmarkOperation = typeof BROWSER_PROFILE_BOOKMARK_OPERATIONS[number]
export const isBrowserProfileBookmarkOperation = (v: unknown): v is BrowserProfileBookmarkOperation => typeof v === 'string' && (BROWSER_PROFILE_BOOKMARK_OPERATIONS as readonly string[]).includes(v)
export type BrowserProfileBookmarkPayload =
  | { operation: 'browser.profile.bookmark.ls'; profileId: string; folderId: string | null; operationId?: string }
  | { operation: 'browser.profile.bookmark.edit'; profileId: string; expectedRevision: string; operationId: string; change: BrowserProfileBookmarkChange }
  | { operation: 'browser.profile.bookmark.import'; profileId: string; folderId: string | null; expectedRevision: string; operationId: string; sourcePath: string }
  | { operation: 'browser.profile.bookmark.export'; profileId: string; folderId: string | null; expectedRevision: string; operationId: string; destinationPath: string }
  | { operation: 'browser.profile.bookmark.open'; profileId: string; bookmarkId: string; browserId: string; expectedRevision: string; operationId: string; caller?: AgentMuxControlCaller }
export type BrowserProfileBookmarkResult = { operation: 'browser.profile.bookmark.ls' } & BrowserProfileBookmarkList
  | { operation: Exclude<BrowserProfileBookmarkOperation, 'browser.profile.bookmark.ls'> } & BrowserProfileBookmarkMutation
const bad = (): never => { throw new AgentMuxError('The exact bookmark request or receipt is invalid.', 'INVALID_CONTROL_REQUEST') }
const text = (v: unknown): string => typeof v === 'string' && v.trim() && !/[\u0000-\u001f\u007f]/u.test(v) ? v : bad()
const nullable = (v: unknown): string | null => v === null ? null : text(v)
function array<T>(v: unknown, parse: (v: unknown) => T): T[] { if (!Array.isArray(v)) return bad(); return v.map(parse) }
export function parseBrowserProfileBookmarkChange(v: unknown): BrowserProfileBookmarkChange {
  const r = rpcRecord(v)
  switch (r.kind) {
    case 'create-folder': rpcRecord(r, ['kind', 'parentId', 'label']); return { kind: r.kind, parentId: nullable(r.parentId), label: text(r.label) }
    case 'rename-folder': rpcRecord(r, ['kind', 'id', 'label']); return { kind: r.kind, id: text(r.id), label: text(r.label) }
    case 'move-folder': rpcRecord(r, ['kind', 'id', 'parentId']); return { kind: r.kind, id: text(r.id), parentId: nullable(r.parentId) }
    case 'remove-folder': case 'remove': rpcRecord(r, ['kind', 'id']); return { kind: r.kind, id: text(r.id) }
    case 'save': rpcRecord(r, ['kind', 'id', 'folderId', 'title', 'url']); if (r.id === undefined && r.url === undefined) return bad()
      return { kind: r.kind, folderId: nullable(r.folderId), title: text(r.title), ...(r.id === undefined ? {} : { id: text(r.id) }), ...(r.url === undefined ? {} : { url: text(r.url) }) }
    default: return bad()
  }
}
export function parseBrowserProfileBookmarkPayload(v: unknown): BrowserProfileBookmarkPayload {
  const r = rpcRecord(v), operation = r.operation as BrowserProfileBookmarkOperation, profileId = text(r.profileId)
  const keys = operation === 'browser.profile.bookmark.ls' ? ['folderId', 'operationId'] : operation === 'browser.profile.bookmark.edit' ? ['expectedRevision', 'operationId', 'change']
    : operation === 'browser.profile.bookmark.import' ? ['expectedRevision', 'operationId', 'folderId', 'sourcePath'] : operation === 'browser.profile.bookmark.export' ? ['expectedRevision', 'operationId', 'folderId', 'destinationPath']
      : operation === 'browser.profile.bookmark.open' ? ['expectedRevision', 'operationId', 'bookmarkId', 'browserId', 'caller'] : bad()
  rpcRecord(r, ['operation', 'schemaVersion', 'requestId', 'profileId', ...keys])
  if (operation === 'browser.profile.bookmark.ls') return { operation, profileId, folderId: nullable(r.folderId), ...(r.operationId === undefined ? {} : { operationId: text(r.operationId) }) }
  const base = { profileId, expectedRevision: text(r.expectedRevision), operationId: text(r.operationId) }
  if (operation === 'browser.profile.bookmark.edit') return { operation, ...base, change: parseBrowserProfileBookmarkChange(r.change) }
  if (operation === 'browser.profile.bookmark.import') return { operation, ...base, folderId: nullable(r.folderId), sourcePath: text(r.sourcePath) }
  if (operation === 'browser.profile.bookmark.export') return { operation, ...base, folderId: nullable(r.folderId), destinationPath: text(r.destinationPath) }
  let caller: AgentMuxControlCaller | undefined
  if (r.caller !== undefined) { const c = rpcRecord(r.caller, ['agentSessionId', 'capability']); caller = { agentSessionId: text(c.agentSessionId), ...(c.capability === undefined ? {} : { capability: text(c.capability) }) } }
  return { operation: 'browser.profile.bookmark.open', ...base, bookmarkId: text(r.bookmarkId), browserId: text(r.browserId), ...(caller ? { caller } : {}) }
}
function folder(v: unknown): BrowserProfileBookmarkFolder { const r = rpcRecord(v, ['id', 'parentId', 'label', 'revision']); return { id: text(r.id), parentId: nullable(r.parentId), label: text(r.label), revision: text(r.revision) } }
function bookmark(v: unknown): BrowserProfileBookmark { const r = rpcRecord(v, ['id', 'folderId', 'title', 'url', 'revision']); return { id: text(r.id), folderId: nullable(r.folderId), title: text(r.title), url: text(r.url), revision: text(r.revision) } }
export function parseBrowserProfileBookmarkReceipt(v: unknown): BrowserProfileBookmarkReceipt {
  const r = rpcRecord(v, ['operationId', 'expectedRevision', 'folderId', 'entryRevision', 'kind', 'status', 'entryId', 'browserId', 'createdIds', 'conflicts', 'warning'])
  if (!['edit', 'import', 'export', 'open'].includes(r.kind as string) || !['pending', 'completed', 'failed'].includes(r.status as string)) return bad()
  return { operationId: text(r.operationId), expectedRevision: text(r.expectedRevision), ...(r.folderId === undefined ? {} : { folderId: nullable(r.folderId) }), ...(r.entryRevision === undefined ? {} : { entryRevision: text(r.entryRevision) }), kind: r.kind as BrowserProfileBookmarkReceipt['kind'], status: r.status as BrowserProfileBookmarkReceipt['status'],
    ...(r.entryId === undefined ? {} : { entryId: text(r.entryId) }), ...(r.browserId === undefined ? {} : { browserId: text(r.browserId) }), createdIds: array(r.createdIds, text),
    conflicts: array(r.conflicts, v => { const c = rpcRecord(v, ['index', 'reason']); if (!Number.isSafeInteger(c.index) || (c.index as number) < 0 || !['duplicate', 'unsupported-address', 'invalid-entry'].includes(c.reason as string)) return bad(); return { index: c.index as number, reason: c.reason as BrowserProfileBookmarkConflict['reason'] } }),
    ...(r.warning === undefined ? {} : { warning: text(r.warning) }) }
}
export function parseBrowserProfileBookmarkList(v: unknown): BrowserProfileBookmarkList {
  const r = rpcRecord(v, ['profileId', 'revision', 'folderId', 'ancestors', 'folders', 'bookmarks', 'pending', 'receipt'])
  const result = { profileId: text(r.profileId), revision: text(r.revision), folderId: nullable(r.folderId), ancestors: array(r.ancestors, folder), folders: array(r.folders, folder), bookmarks: array(r.bookmarks, bookmark), pending: array(r.pending, parseBrowserProfileBookmarkReceipt), ...(r.receipt === undefined ? {} : { receipt: r.receipt === null ? null : parseBrowserProfileBookmarkReceipt(r.receipt) }) }
  if (result.pending.some(r => r.status !== 'pending') || new Set(result.pending.map(r => r.operationId)).size !== result.pending.length) return bad()
  if (result.folders.some(f => f.parentId !== result.folderId) || result.bookmarks.some(b => b.folderId !== result.folderId) || new Set([...result.folders, ...result.bookmarks].map(e => e.id)).size !== result.folders.length + result.bookmarks.length) return bad()
  return result
}
export function parseBrowserProfileBookmarkMutation(v: unknown): BrowserProfileBookmarkMutation {
  const r = rpcRecord(v, ['profileId', 'revision', 'receipt']); return { profileId: text(r.profileId), revision: text(r.revision), receipt: parseBrowserProfileBookmarkReceipt(r.receipt) }
}
export function parseBrowserProfileBookmarkResult(operation: BrowserProfileBookmarkOperation, v: unknown): BrowserProfileBookmarkResult {
  try { const r = rpcRecord(v), { operation: op, ...body } = r; if (op !== undefined && op !== operation) return bad(); return operation === 'browser.profile.bookmark.ls' ? { operation, ...parseBrowserProfileBookmarkList(body) } : { operation, ...parseBrowserProfileBookmarkMutation(body) } }
  catch { throw new AgentMuxError('The bookmark owner returned invalid original facts.', 'CONTROL_PROTOCOL_ERROR') }
}
export function assertBrowserProfileBookmarkTarget(request: BrowserProfileBookmarkPayload, result: BrowserProfileBookmarkResult): void {
  const wrong = () => { throw new AgentMuxError('The bookmark receipt belongs to another original Profile, folder or operation.', 'CONTROL_PROTOCOL_ERROR') }
  if (request.operation !== result.operation || request.profileId !== result.profileId) return wrong()
  if (request.operation === 'browser.profile.bookmark.ls' && result.operation === request.operation) {
    if (request.folderId !== result.folderId || request.operationId !== undefined && (!Object.hasOwn(result, 'receipt') || result.receipt && result.receipt.operationId !== request.operationId)) return wrong()
  } else if (request.operation !== 'browser.profile.bookmark.ls' && result.operation !== 'browser.profile.bookmark.ls') {
    if (result.receipt.operationId !== request.operationId || result.receipt.expectedRevision !== request.expectedRevision || result.receipt.kind !== request.operation.split('.').at(-1)) return wrong()
    if (request.operation === 'browser.profile.bookmark.open' && (result.receipt.entryId !== request.bookmarkId || result.receipt.browserId !== request.browserId)) return wrong()
    if ((request.operation === 'browser.profile.bookmark.import' || request.operation === 'browser.profile.bookmark.export') && (!Object.hasOwn(result.receipt, 'folderId') || result.receipt.folderId !== request.folderId)) return wrong()
    if (request.operation === 'browser.profile.bookmark.edit' && 'id' in request.change && request.change.id !== undefined && result.receipt.entryId !== request.change.id) return wrong()
  }
}
