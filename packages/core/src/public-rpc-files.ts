import { parseNoteTitleProjection } from './note-title.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { parseNoteProvenanceSnapshot, noteProvenanceResourceKey, type NoteProvenanceSnapshot } from './note-provenance.js'
import { NOTE_FILE_EXTENSION, readNoteMarkdownHeader } from './note-format.js'
import type { FileShareParams, FileShareResult, FileShareInspectParams, FileShareInspectResult, FileShareUndoParams, FileShareUndoResult, AgentMuxRpcFileShareOwner } from './public-rpc-file-share.js'
export * from './public-rpc-file-share.js'
import type { FileImportParams, FileImportResult } from './public-rpc-file-import.js'
export * from './public-rpc-file-import.js'
import { parseFileHistoryParams, type FileHistoryParams, type FileHistoryResult } from './public-rpc-file-history.js'
export { parseFileHistoryParams, parseFileHistoryResult, type FileHistoryParams, type FileHistoryResult } from './public-rpc-file-history.js'

/** The original Files owner and resource, independent of display occurrences. */
export type FileResource = { hostId: string; workspaceId: string; workspacePath: string }
export type FileReadResource = FileResource & { zoneId: string; zonePath: string; path: string; logicalDirectory?: string }
export type FileDocument = { path: string; content: string; revision: string; noteProvenance?: NoteProvenanceSnapshot }
export type FileDocumentReadResult =
  | { status: 'read'; document: FileDocument }
  | { status: 'binary'; path: string; revision: string; byteLength: number }
  | { status: 'deleted' }
  | { status: 'directory' }
  | { status: 'error'; code: string; message: string }
/** Public observation failure; this is not a new state invented for WorkspaceFiles. */
export type FileReadUnknown = { status: 'unknown'; code: string; message: string }
export type FileReadParams = { zoneId: string; spaceId?: string; path: string; expectedResource: FileResource; maxBytes?: number }
export type FileReadResult = { resource: FileReadResource | null; result: FileDocumentReadResult | FileReadUnknown }
export type FileListParams = Omit<FileReadParams, 'maxBytes'> & { limit?: number }
/** Names only. A bounded observation does not claim to be a complete filesystem index. */
export type FileNameListing = { status: 'listed'; files: string[]; complete: boolean; omitted: 'git-ignored' | 'none'; partialReason: 'limit' | 'budget' | 'unreadable' | null }
export type FileListResult = { resource: FileReadResource | null; result: FileNameListing | FileReadUnknown }
/** Save an existing original text file; null revisions/new-file creation are outside this method. */
export type FileWriteParams = Omit<FileReadParams, 'maxBytes' | 'expectedResource'> & { expectedResource: FileReadResource; content: string; expectedRevision: string;
  /** Both fields are present for an original, durable Note edit; otherwise this remains ordinary CAS. */
  baseContent?: string; operationId?: string }
/** Create one absent file at the exact original read mapping; never overwrite existing bytes. */
export type FileCreateParams = Omit<FileWriteParams, 'expectedRevision' | 'baseContent' | 'operationId'> & { expectedRevision: null }
export type FileCreateResult = FileWriteResult
/** A new revision selected from immutable history, without caller-supplied body or author. */
export type FileRestoreParams = Omit<FileHistoryParams, 'limit' | 'before' | 'includeContent' | 'eventId'> & { expectedRevision: string; operationId: string; eventId: string }
export type FileUndoParams = Omit<FileRestoreParams, 'eventId'> & { batchId: string; batchLastEventId: string }
export type FileRestoreResult = FileWriteResult
export type FileUndoResult = FileWriteResult
/** Host-internal authority, never accepted from a File request body. */
export type FileWriteContext = { actor?: import('./notebook-catalog.js').NotebookActor | undefined }
export type NoteWriteAttribution = { status: 'recorded' } | { status: 'unconfirmed'; reason: string }
export type NoteWriteConflict = { reason: 'overlap' | 'identity' | 'invalid-structure'; baseContent: string; currentContent: string; proposedContent: string }
export type FileWriteReceipt =
  ( { status: 'written'; revision: string; content?: string; contentUnavailable?: string; noteAttribution?: NoteWriteAttribution; noteProvenance?: NoteProvenanceSnapshot; noteTitleProjection?: import('./note-title.js').NoteTitleProjection }
  | { status: 'conflict'; observedRevision: string | null; noteConflict?: NoteWriteConflict; noteConflictUnavailable?: string }
  | { status: 'error' | 'unknown'; code: string; message: string }) & { noteHistory?: import('./note-history.js').NoteHistoryReceipt }
export type FileWriteResult = { resource: FileReadResource | null; result: FileWriteReceipt }
/** One bounded file, below the original encrypted Relay frame/backlog budget even after both base64 layers. */
export const FILE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024
/** Browser-safe digest of the pinned local bytes, also usable on insecure LAN origins. */
export function fileUploadRevision(bytes: Uint8Array): string {
  return 'sha256:' + Array.from(sha256(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}
export type FileUploadIdentity = { hostId: string; agentSessionId: string; expectedRun: { runId: string }; operationId: string;
  name: string; mimeType: string; byteLength: number; revision: string }
export type FileUploadParams = FileUploadIdentity & { dataBase64: string }
export type FileUploadResult = FileUploadIdentity & (
  | { status: 'uploaded'; path: string }
  | { status: 'missing' }
  | { status: 'error' | 'unknown'; code: string; message: string }
)
/** Host-owned files only. This port neither sends input nor owns a Runtime. */
export interface AgentMuxRpcFileUploadsOwner {
  upload(params: FileUploadParams): Promise<FileUploadResult>
  inspect(params: FileUploadIdentity): Promise<FileUploadResult>
  read?(identity: FileUploadIdentity, maxBytes: number): Promise<{ dataBase64: string; byteLength: number; mimeType: string; revision: string } | null>
}
export type FileParameterMap = { 'file.import': FileImportParams; 'file.share.undo': FileShareUndoParams; 'file.share': FileShareParams; 'file.share.inspect': FileShareInspectParams; 'file.read': FileReadParams; 'file.list': FileListParams; 'file.history': FileHistoryParams; 'file.write': FileWriteParams; 'file.create': FileCreateParams; 'file.restore': FileRestoreParams; 'file.undo': FileUndoParams;
  'file.upload': FileUploadParams; 'file.upload.inspect': FileUploadIdentity }
export type FileResultMap = { 'file.import': FileImportResult; 'file.share.undo': FileShareUndoResult; 'file.share': FileShareResult; 'file.share.inspect': FileShareInspectResult; 'file.read': FileReadResult; 'file.list': FileListResult; 'file.history': FileHistoryResult; 'file.write': FileWriteResult; 'file.create': FileCreateResult; 'file.restore': FileRestoreResult; 'file.undo': FileUndoResult;
  'file.upload': FileUploadResult; 'file.upload.inspect': FileUploadResult }
export type FileMethod = keyof FileParameterMap
export interface AgentMuxRpcFilesOwner extends Partial<AgentMuxRpcFileShareOwner> { import?(params: FileImportParams): Promise<FileImportResult>; read(params: FileReadParams): Promise<FileReadResult>; list(params: FileListParams): Promise<FileListResult>; history?(params: FileHistoryParams): Promise<FileHistoryResult>; write(params: FileWriteParams, context?: FileWriteContext): Promise<FileWriteResult>; create(params: FileCreateParams, context?: FileWriteContext): Promise<FileCreateResult>;
  restore?(params: FileRestoreParams, context?: FileWriteContext): Promise<FileRestoreResult>; undo?(params: FileUndoParams, context?: FileWriteContext): Promise<FileUndoResult> }
export const AGENTMUX_RPC_FILE_METHODS = { 'file.import': 'long', 'file.share.undo': 'long', 'file.share': 'long', 'file.share.inspect': 'long', 'file.read': 'short', 'file.list': 'long', 'file.history': 'long', 'file.write': 'long', 'file.create': 'long', 'file.restore': 'long', 'file.undo': 'long', 'file.upload': 'long', 'file.upload.inspect': 'long' } as const
export function isFileMethod(value: unknown): value is FileMethod { return typeof value === 'string' && Object.hasOwn(AGENTMUX_RPC_FILE_METHODS, value) }

const uploadFields = ['hostId', 'agentSessionId', 'expectedRun', 'operationId', 'name', 'mimeType', 'byteLength', 'revision'] as const
export function parseFileUploadIdentity(value: unknown, code = 'INVALID_CONTROL_REQUEST'): FileUploadIdentity {
  const p = rpcRecord(value, uploadFields, code)
  for (const field of ['hostId', 'agentSessionId', 'operationId'] as const) {
    if (typeof p[field] !== 'string' || !p[field].length || p[field].length > 256 || /[\0\r\n]/u.test(p[field])) invalid('The exact original upload target and operation are required.', code)
  }
  const run = rpcRecord(p.expectedRun, ['runId'], code)
  if (typeof run.runId !== 'string' || !run.runId.length || run.runId.length > 256 || /[\0\r\n]/u.test(run.runId)) invalid('The original upload Run is required.', code)
  if (typeof p.name !== 'string' || !p.name.length || p.name.length > 256 || /[\0\r\n/\\]/u.test(p.name)) invalid('A local file name, without a destination path, is required.', code)
  if (typeof p.mimeType !== 'string' || p.mimeType.length > 128 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(p.mimeType) || /^(?:audio|video)\//u.test(p.mimeType)) invalid('Choose an image or ordinary file; audio and video transfer are unavailable.', code)
  if (p.mimeType.startsWith('image/') && !['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/heic', 'image/heif'].includes(p.mimeType)) invalid('Choose a PNG, JPEG, GIF, WebP or HEIC/HEIF image.', code)
  if (!Number.isSafeInteger(p.byteLength) || Number(p.byteLength) < 1 || Number(p.byteLength) > FILE_UPLOAD_MAX_BYTES) invalid('Choose one nonempty file up to 4 MiB.', code)
  revision(p.revision, code)
  return p as FileUploadIdentity
}
export function parseFileUploadParams(value: unknown): FileUploadParams {
  const code = 'INVALID_CONTROL_REQUEST', p = rpcRecord(value, [...uploadFields, 'dataBase64'], code), { dataBase64, ...identity } = p
  const original = parseFileUploadIdentity(identity)
  if (typeof dataBase64 !== 'string' || dataBase64.length !== Math.ceil(original.byteLength / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(dataBase64) ||
      (dataBase64.endsWith('==') ? 2 : dataBase64.endsWith('=') ? 1 : 0) !== (3 - original.byteLength % 3) % 3) invalid('The complete bounded file bytes are required.', code)
  return p as FileUploadParams
}
export function parseFileUploadResult(value: unknown, params: FileUploadIdentity): FileUploadResult {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, undefined, code)
  const fields = p.status === 'uploaded' ? ['path'] : p.status === 'missing' ? [] : ['error', 'unknown'].includes(String(p.status)) ? ['code', 'message'] : null
  if (!fields) invalid('The original upload receipt is unconfirmed.', code)
  rpcRecord(p, [...uploadFields, 'status', ...fields], code)
  const identity = Object.fromEntries(uploadFields.map(field => [field, p[field]]))
  parseFileUploadIdentity(identity, code)
  for (const field of uploadFields) {
    if (field === 'expectedRun' ? (p.expectedRun as { runId: string }).runId !== params.expectedRun.runId : p[field] !== params[field]) invalid('Another upload target or file was returned.', code)
  }
  if (p.status === 'uploaded') {
    string(p.path, code)
    if (!(p.path as string).startsWith('/')) invalid('The Host did not return its exact file path.', code)
  } else if (p.status !== 'missing') { string(p.code, code); string(p.message, code) }
  return p as FileUploadResult
}

function invalid(message: string, code: string): never { throw new AgentMuxError(message, code) }
function string(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > 16384 || /[\0\r\n]/u.test(value)) invalid('An exact File identity or path is required.', code)
}
function revision(value: unknown, code: string): void {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) invalid('The complete original File revision is required.', code)
}
function resource(value: unknown, code: string, read = false): FileResource | FileReadResource {
  const p = rpcRecord(value, ['hostId', 'workspaceId', 'workspacePath', ...(read ? ['zoneId', 'zonePath', 'path', 'logicalDirectory'] : [])], code)
  for (const key of ['hostId', 'workspaceId', 'workspacePath', ...(read ? ['zoneId', 'zonePath', 'path'] : [])]) string(p[key], code)
  return p as FileResource | FileReadResource
}
export function parseFileReadParams(value: unknown): FileReadParams {
  const code = 'INVALID_CONTROL_REQUEST', p = rpcRecord(value, ['zoneId', 'spaceId', 'path', 'expectedResource', 'maxBytes'], code)
  string(p.zoneId, code); string(p.path, code)
  if (p.spaceId !== undefined) string(p.spaceId, code)
  if ((p.path as string).startsWith('/') || /^[A-Za-z]:/u.test(p.path as string) || (p.path as string).includes('\\') ||
      (p.path as string).split('/').some(segment => segment === '..')) invalid('Choose a relative file path inside the original Zone.', code)
  resource(p.expectedResource, code)
  if (p.maxBytes !== undefined && (!Number.isSafeInteger(p.maxBytes) || (p.maxBytes as number) < 1 || (p.maxBytes as number) > 16 * 1024 * 1024)) invalid('A file read byte cap must be from 1 to 16 MiB.', code)
  return p as FileReadParams
}
export function parseFileListParams(value: unknown): FileListParams {
  const code = 'INVALID_CONTROL_REQUEST', p = rpcRecord(value, ['zoneId', 'spaceId', 'path', 'expectedResource', 'limit'], code)
  const { limit, ...read } = p
  parseFileReadParams(read)
  if (limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 20000)) invalid('File discovery limit must be between 1 and 20000.', code)
  return p as FileListParams
}
export function parseFileListResult(value: unknown, params: FileListParams): FileListResult {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['resource', 'result'], code)
  const r = rpcRecord(p.result, undefined, code)
  // Reuse the exact Zone/root mapping validation, independently of the discovered child names.
  parseFileReadResult({ resource: p.resource, result: r.status === 'unknown' ? r : { status: 'directory' } }, params)
  if (r.status === 'unknown') return p as FileListResult
  rpcRecord(r, ['status', 'files', 'complete', 'omitted', 'partialReason'], code)
  if (r.status !== 'listed' || !Array.isArray(r.files) || r.files.length > (params.limit ?? 20000) ||
      typeof r.complete !== 'boolean' || !['git-ignored', 'none'].includes(r.omitted as string) ||
      ![null, 'limit', 'budget', 'unreadable'].includes(r.partialReason as null)) invalid('File discovery evidence is invalid.', code)
  if (r.complete !== (r.partialReason === null)) invalid('A partial File listing requires its original reason.', code)
  const names = new Set<string>()
  for (const path of r.files) {
    string(path, code)
    if (path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') || names.has(path)) invalid('File discovery must retain distinct confined relative paths.', code)
    names.add(path)
  }
  return p as FileListResult
}
function validateFileNoteProvenance(value: unknown, bodyRevision: unknown, original: FileReadResource, content: string): void {
  let metadata: NoteProvenanceSnapshot
  try { metadata = parseNoteProvenanceSnapshot(value) }
  catch { return invalid('The original Note metadata could not be confirmed.', 'CONTROL_PROTOCOL_ERROR') }
  const header = readNoteMarkdownHeader(content)
  if (metadata.revision !== bodyRevision || fileUploadRevision(new TextEncoder().encode(content)) !== bodyRevision || header.status !== 'valid' || metadata.noteId !== header.noteId ||
      noteProvenanceResourceKey(metadata.resource) !== noteProvenanceResourceKey({ hostId: original.hostId, workspaceId: original.workspaceId, workspacePath: original.workspacePath, path: original.path })) {
    invalid('The Note metadata belongs to another original body, resource or revision.', 'CONTROL_PROTOCOL_ERROR')
  }
}
export function parseFileReadResult(value: unknown, params: FileReadParams): FileReadResult {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['resource', 'result'], code)
  const r = rpcRecord(p.result, undefined, code)
  const fields = r.status === 'read' ? ['status', 'document'] : r.status === 'binary' ? ['status', 'path', 'revision', 'byteLength']
    : r.status === 'deleted' || r.status === 'directory' ? ['status'] : r.status === 'error' || r.status === 'unknown' ? ['status', 'code', 'message'] : null
  if (!fields) invalid('The original File read status is invalid.', code)
  rpcRecord(r, fields, code)
  if (p.resource === null) { if (r.status !== 'unknown') invalid('File data requires a confirmed original resource.', code) }
  else {
    const original = resource(p.resource, code, true) as FileReadResource
    if (original.zoneId !== params.zoneId || original.hostId !== params.expectedResource.hostId ||
        original.workspaceId !== params.expectedResource.workspaceId || original.workspacePath !== params.expectedResource.workspacePath) invalid('Another File resource was returned.', code)
    const root = original.workspacePath.replace(/\/+$/u, '') || '/', zone = original.zonePath.replace(/\/+$/u, '') || '/'
    const prefix = root === '/' ? '/' : root + '/'
    let directory: string
    if (original.logicalDirectory !== undefined) {
      const declared = original.logicalDirectory
      if (typeof declared !== 'string' || declared.length > 16384 || /[\0\r\n\\]/u.test(declared) || declared.startsWith('/') || /^[A-Za-z]:/u.test(declared) ||
          declared !== '' && declared.split('/').some(part => !part || part === '.' || part === '..')) invalid('The declared File logical directory is invalid.', code)
      directory = declared
    } else {
      if (zone !== root && !zone.startsWith(prefix)) invalid('The File Zone is outside its original Workspace.', code)
      directory = zone === root ? '' : zone.slice(prefix.length)
    }
    const relative = params.path.split('/').filter(part => part && part !== '.').join('/')
    if (directory.split('/').some(part => part === '.' || part === '..' || part.includes('\\'))) invalid('The returned File Zone is invalid.', code)
    const mapped = directory && relative ? directory + '/' + relative : directory || relative || '.'
    if (original.path !== mapped) invalid('Another File path was returned.', code)
  }
  if (r.status === 'read') {
    const d = rpcRecord(r.document, ['path', 'content', 'revision', 'noteProvenance'], code)
    string(d.path, code); revision(d.revision, code)
    if (typeof d.content !== 'string') invalid('File content must be text.', code)
    if (params.maxBytes !== undefined && new TextEncoder().encode(d.content).byteLength > params.maxBytes) invalid('The original File read exceeded its requested byte cap.', code)
    if ((p.resource as FileReadResource | null)?.path !== d.path) invalid('Another File document was returned.', code)
    if (d.noteProvenance !== undefined) validateFileNoteProvenance(d.noteProvenance, d.revision, p.resource as FileReadResource, d.content as string)
  } else if (r.status === 'binary') {
    string(r.path, code); revision(r.revision, code)
    if (!Number.isSafeInteger(r.byteLength) || (r.byteLength as number) < 0 || (p.resource as FileReadResource | null)?.path !== r.path) invalid('The original binary File evidence is invalid.', code)
    if (params.maxBytes !== undefined && (r.byteLength as number) > params.maxBytes) invalid('The original binary File read exceeded its byte cap.', code)
  } else if (r.status === 'error' || r.status === 'unknown') { string(r.code, code); string(r.message, code) }
  return p as FileReadResult
}

function parseFileMutationParams(value: unknown, enhanced = false): Record<string, unknown> {
  const code = 'INVALID_CONTROL_REQUEST', p = rpcRecord(value, ['zoneId', 'spaceId', 'path', 'expectedResource', 'content', 'expectedRevision', ...(enhanced ? ['baseContent', 'operationId'] : [])], code)
  const { content, expectedRevision, baseContent: _base, operationId: _operation, ...read } = p
  const original = resource(p.expectedResource, code, true) as FileReadResource
  parseFileReadParams({ ...read, expectedResource: { hostId: original.hostId, workspaceId: original.workspaceId, workspacePath: original.workspacePath } })
  try { parseFileReadResult({ resource: original, result: { status: 'directory' } }, read as FileReadParams) }
  catch (error) {
    if (error instanceof AgentMuxError && error.code === 'CONTROL_PROTOCOL_ERROR') invalid(error.message, code)
    throw error
  }
  if (typeof content !== 'string') invalid('File content must be text.', code)
  return p
}
export function parseFileWriteParams(value: unknown): FileWriteParams {
  const code = 'INVALID_CONTROL_REQUEST', p = parseFileMutationParams(value, true)
  revision(p.expectedRevision, code)
  if ((p.baseContent !== undefined) !== (p.operationId !== undefined)) invalid('A durable Note edit requires both its exact base content and original operation ID.', code)
  if (p.baseContent !== undefined) {
    string(p.operationId, code)
    if (typeof p.baseContent !== 'string' || fileUploadRevision(new TextEncoder().encode(p.baseContent)) !== p.expectedRevision) invalid('The exact base content must match the original expected revision.', code)
  }
  return p as FileWriteParams
}
export function parseFileCreateParams(value: unknown): FileCreateParams {
  const p = parseFileMutationParams(value)
  if (p.expectedRevision !== null) invalid('File creation requires explicit expected absence (null).', 'INVALID_CONTROL_REQUEST')
  return p as FileCreateParams
}
function parseFileHistoryMutationParams(value: unknown, undo: boolean): FileRestoreParams | FileUndoParams {
  const code = 'INVALID_CONTROL_REQUEST', p = rpcRecord(value, ['zoneId', 'spaceId', 'path', 'expectedResource', 'noteId', 'expectedRevision', 'operationId', ...(undo ? ['batchId', 'batchLastEventId'] : ['eventId'])], code)
  const { expectedRevision, operationId, eventId, batchId, batchLastEventId, ...target } = p
  parseFileHistoryParams(target)
  revision(expectedRevision, code); string(operationId, code)
  if (undo) { string(batchId, code); string(batchLastEventId, code) }
  else string(eventId, code)
  if ((undo ? batchLastEventId : eventId) === operationId) invalid('A history action requires a new operation distinct from its selected event.', code)
  return p as FileRestoreParams | FileUndoParams
}
export function parseFileRestoreParams(value: unknown): FileRestoreParams { return parseFileHistoryMutationParams(value, false) as FileRestoreParams }
export function parseFileUndoParams(value: unknown): FileUndoParams { return parseFileHistoryMutationParams(value, true) as FileUndoParams }
function parseFileMutationResult(value: unknown, params: FileWriteParams | FileCreateParams | FileRestoreParams | FileUndoParams): FileWriteResult {
  const historyAction = 'noteId' in params
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['resource', 'result'], code), r = rpcRecord(p.result, undefined, code)
  const keys = r.status === 'written' ? ['status', 'revision', 'content', 'contentUnavailable', 'noteAttribution', 'noteProvenance', 'noteTitleProjection'] : r.status === 'conflict' ? ['status', 'observedRevision', 'noteConflict', 'noteConflictUnavailable']
    : r.status === 'error' || r.status === 'unknown' ? ['status', 'code', 'message'] : null
  if (!keys) invalid('The original File write status is invalid.', code)
  rpcRecord(r, [...keys, 'noteHistory'], code)
  if (r.noteHistory !== undefined) {
    const history = rpcRecord(r.noteHistory, ['status', 'eventId', 'batchId', 'reason', 'replayed'], code)
    if (!['prepared', 'committed', 'unconfirmed', 'not-applied'].includes(history.status as string)) invalid('The original Note history outcome is invalid.', code)
    if (history.status !== 'unconfirmed' || history.eventId !== undefined) string(history.eventId, code)
    if (history.status !== 'unconfirmed' || history.batchId !== undefined) string(history.batchId, code)
    if (history.reason !== undefined && (typeof history.reason !== 'string' || !history.reason.length)) invalid('The original Note history diagnostic must remain nonempty text.', code)
    if (history.status !== 'unconfirmed' && history.reason !== undefined) invalid('Only unconfirmed Note history carries a diagnostic.', code)
    if (history.status === 'unconfirmed' && history.eventId === undefined && history.reason === undefined) invalid('Unconfirmed history requires its original event or a diagnostic.', code)
    if ('operationId' in params && params.operationId !== undefined && history.eventId !== undefined && history.eventId !== params.operationId) invalid('The history receipt belongs to another original operation.', code)
    if (history.replayed !== undefined && (history.replayed !== true || history.status !== 'committed' || r.status !== 'written' || !('operationId' in params) || params.operationId === undefined)) invalid('A replay requires the committed original Note operation.', code)
  }
  // Keep the original resource/path mapping checks shared with reads.
  parseFileReadResult({ resource: p.resource, result: p.resource === null ? { status: r.status, code: r.code, message: 'Original write diagnostic follows.' } : { status: 'directory' } }, params)
  if (p.resource !== null && ['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'path', 'logicalDirectory'].some(key => (p.resource as Record<string, unknown>)[key] !== (params.expectedResource as unknown as Record<string, unknown>)[key])) invalid('The original File mapping changed.', code)
  if (r.status === 'written') {
    revision(r.revision, code)
    const unavailable = r.contentUnavailable !== undefined
    if (unavailable && (!(historyAction || 'content' in params && params.path.endsWith(NOTE_FILE_EXTENSION) && readNoteMarkdownHeader(params.content).status === 'valid') ||
        'baseContent' in params && params.baseContent !== undefined && params.operationId === undefined ||
        typeof r.contentUnavailable !== 'string' || !r.contentUnavailable.length || r.content !== undefined ||
        r.noteProvenance !== undefined || r.noteAttribution !== undefined || r.noteTitleProjection !== undefined)) invalid('Unavailable canonical content requires an original Note operation without inline content or its dependent metadata.', code)
    if ('operationId' in params && params.operationId !== undefined && (typeof r.content !== 'string' && !unavailable ||
        !r.noteHistory || (r.noteHistory as Record<string, unknown>).eventId !== params.operationId)) invalid('The original Note edit requires its canonical saved content and operation receipt.', code)
    if (r.content !== undefined && (typeof r.content !== 'string' || fileUploadRevision(new TextEncoder().encode(r.content)) !== r.revision)) invalid('The canonical saved content does not match its revision.', code)
    if (historyAction && !unavailable) {
      const header = readNoteMarkdownHeader(r.content as string)
      if (header.status !== 'valid' || header.noteId !== params.noteId) invalid('The canonical history action belongs to another original Note.', code)
    }
    if (r.noteAttribution !== undefined) {
      const attribution = rpcRecord(r.noteAttribution, ['status', 'reason'], code)
      if (attribution.status !== 'recorded' && attribution.status !== 'unconfirmed' || attribution.status === 'recorded' && attribution.reason !== undefined || attribution.status === 'unconfirmed' && (typeof attribution.reason !== 'string' || !attribution.reason)) invalid('The Note write attribution is unconfirmed.', code)
    }
    if (r.noteTitleProjection !== undefined) {
      let projection: import('./note-title.js').NoteTitleProjection
      try { projection = parseNoteTitleProjection(r.noteTitleProjection) } catch { return invalid('The original Note title projection receipt is malformed.', code) }
      const saved = readNoteMarkdownHeader((r.content as string | undefined) ?? ('content' in params ? params.content : ''))
      if (saved.status !== 'valid' || saved.noteId !== projection.noteId) invalid('The title projection belongs to another original Note identity.', code)
      const original = p.resource as FileReadResource
      if (noteProvenanceResourceKey(projection.resource) !== noteProvenanceResourceKey({ hostId: original.hostId, workspaceId: original.workspaceId, workspacePath: original.workspacePath, path: original.path })) invalid('The title projection belongs to another original file write.', code)
    }
    if (r.noteProvenance !== undefined) validateFileNoteProvenance(r.noteProvenance, r.revision, p.resource as FileReadResource, (r.content as string | undefined) ?? ('content' in params ? params.content : ''))
  }
  else if (r.status === 'conflict') {
    if (r.observedRevision !== null) revision(r.observedRevision, code)
    if (r.noteConflictUnavailable !== undefined && (!(historyAction || 'baseContent' in params && params.baseContent !== undefined) || r.noteConflict !== undefined ||
        typeof r.noteConflictUnavailable !== 'string' || !r.noteConflictUnavailable.length)) invalid('Unavailable conflict content requires an enhanced Note conflict and a nonempty diagnostic, without inline content.', code)
    if (r.noteConflict !== undefined) {
      const conflict = rpcRecord(r.noteConflict, ['reason', 'baseContent', 'currentContent', 'proposedContent'], code)
      if (!['overlap', 'identity', 'invalid-structure'].includes(conflict.reason as string) || typeof conflict.baseContent !== 'string' || typeof conflict.proposedContent !== 'string' ||
          !historyAction && (!('baseContent' in params) || params.baseContent === undefined || conflict.baseContent !== params.baseContent || !('content' in params) || conflict.proposedContent !== params.content) || typeof conflict.currentContent !== 'string' ||
          fileUploadRevision(new TextEncoder().encode(conflict.currentContent)) !== r.observedRevision) invalid('The Note conflict must retain the exact original base, current and proposed content.', code)
    }
  }
  else { string(r.code, code); if (typeof r.message !== 'string') invalid('File write diagnostics must remain text.', code) }
  return p as FileWriteResult
}

export function parseFileWriteResult(value: unknown, params: FileWriteParams): FileWriteResult { return parseFileMutationResult(value, params) }
export function parseFileCreateResult(value: unknown, params: FileCreateParams): FileCreateResult { return parseFileMutationResult(value, params) }
export function parseFileRestoreResult(value: unknown, params: FileRestoreParams): FileRestoreResult { return parseFileMutationResult(value, params) }
export function parseFileUndoResult(value: unknown, params: FileUndoParams): FileUndoResult { return parseFileMutationResult(value, params) }
