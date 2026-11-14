import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseFileHistoryParams, type FileHistoryParams } from './public-rpc-file-history.js'
import { noteFileDeleteEventId, type NoteHistoryStatus } from './note-history.js'
import { noteProvenanceResourceKey } from './note-provenance.js'
import type { NoteResource } from './notebook-catalog.js'
import { AGENTMUX_RPC_MAX_MESSAGE_BYTES } from './public-rpc-frame.js'
/** Reserve the remaining wire budget for live mapping projection and envelope. */
export const FILE_DELETE_SNAPSHOT_REFERENCE_BYTES = AGENTMUX_RPC_MAX_MESSAGE_BYTES / 4
import { parseFileReadParams, parseFileReadResource, parseFileReadResult,
  type FileReadParams, type FileReadResource, type FileWriteContext } from './public-rpc-files.js'

/** An observation of one original directory entry, never an authorization token. */
export type FileEntryWitness = { device: string; inode: string; size: string; ctimeNs: string; mtimeNs: string; birthtimeNs: string | null }
/** Provenance of this body, not a current path observation or mutation receipt. */
export type FileReadIdentity = { entry: FileEntryWitness; ancestorWitnesses: FileEntryWitness[] }
export const FILE_READ_IDENTITY_MAX_BYTES = 64 * 1024
export const FILE_READ_IDENTITY_MAX_ANCESTORS = 256
export type FilePathScopeWitness = { root: FileEntryWitness; parent: FileEntryWitness }
export type FileStatParams = Omit<FileReadParams, 'maxBytes'> & { includeRevision?: boolean }
export type FilePathObservation = FilePathScopeWitness & {
  parentPath: string
  entry: { kind: 'absent' } | { kind: 'file' | 'directory' | 'symlink' | 'other'; witness: FileEntryWitness }
  revision?: { status: 'observed'; revision: string } | { status: 'not-applicable' }
  implementation: { platform: 'darwin' | 'linux'; stat: 'native'; mkdir: 'native-no-replace' | 'generation-unavailable' }
}
export type FileStatResult = { resource: FileReadResource | null; result:
  | { status: 'observed'; observation: FilePathObservation }
  | { status: 'unknown' | 'unsupported'; code: string; message: string } }
export type FileMkdirParams = Omit<FileStatParams, 'expectedResource' | 'includeRevision'> & {
  operationId: string; expectedResource: FileReadResource; expectedAbsent: true; expected: FilePathScopeWitness
}
export type FileMutationInspectParams = Omit<FileStatParams, 'expectedResource' | 'includeRevision'> & { operationId: string; expectedResource: FileReadResource }
export type FileMoveEntry = Exclude<FilePathObservation['entry'], { kind: 'absent' }>
export type FileMoveParams = FileMutationInspectParams & {
  expected: FilePathScopeWitness & { entry: FileMoveEntry }
  destination: Omit<FileMutationInspectParams, 'operationId'> & { expectedAbsent: true; expected: FilePathScopeWitness }
}
export type FileMoveReceipt = {
  action: 'move'; phase: 'prepared' | 'claimed' | 'published' | 'settled'
  filesystem: 'moved' | 'not-applied' | 'unknown'; durability: 'confirmed' | 'unconfirmed'
  movedWitness?: FileEntryWitness
  nameAudit?: { operationId: string; status: 'recorded' | 'unconfirmed'; message?: string }
  noteMetadata?: { status: 'recorded' | 'unconfirmed'; message?: string }
  code?: string; message?: string
}
export type FileMoveResult = { operationId: string; resource: FileReadResource | null; destination: FileReadResource | null; result: FileMoveReceipt }
export type FileDeleteParams = FileMutationInspectParams & {
  expected: FilePathScopeWitness & { entry: FileMoveEntry }
  expectedRevision?: string; recursive?: boolean
}
export type FileDeleteReceipt = {
  action: 'delete'; phase: 'prepared' | 'claimed' | 'deleted' | 'settled'
  filesystem: 'deleted' | 'not-applied' | 'unknown'; durability: 'confirmed' | 'unconfirmed'
  deletedWitness?: FileEntryWitness
  /** Recorded or Native-reported claim address; current reachability is unconfirmed. */
  retainedPath?: string
  noteHistory?: { status: 'recorded' | 'unconfirmed'; message?: string }
  code?: string; message?: string
}
export type FileDeleteResult = { operationId: string; resource: FileReadResource | null; result: FileDeleteReceipt }
export type FileDeleteSnapshotsParams = FileMutationInspectParams & { limit?: number; cursor?: string }
export type FileDeleteSnapshotReference = {
  noteId: string; originalResource: FileReadResource; currentHistoryResource: NoteResource
  eventId: string; batchId: string; status: NoteHistoryStatus
  historyQuery?: FileHistoryParams; historyUnavailable?: string
}
export type FileDeleteSnapshotsResult = { operationId: string; resource: FileReadResource | null; result:
  | { status: 'read'; entries: FileDeleteSnapshotReference[]; hasMore: boolean; cursor: string | null; rootRevision: string | null; filesystem: FileDeleteReceipt['filesystem'] }
  | { status: 'unknown'; code: string; message: string; cursor: string | null }
}

/** Original transport provenance is supplied by the Host, never by a JSON request. */
export type FilePathMutationContext = FileWriteContext & { callerHostId?: string; transport?: string }
export type FilePathMutationReceipt = {
  action: 'mkdir'; phase: 'prepared' | 'published' | 'settled'
  filesystem: 'created' | 'not-applied' | 'unknown'; durability: 'confirmed' | 'unconfirmed'
  createdWitness?: FileEntryWitness; code?: string; message?: string
}
export type FileMkdirResult = { operationId: string; resource: FileReadResource | null; result: FilePathMutationReceipt }
export type FileMutationInspectResult = { operationId: string; resource: FileReadResource | null; result:
  | (FilePathMutationReceipt & { original: FileMkdirParams })
  | (FileMoveReceipt & { original: FileMoveParams })
  | (FileDeleteReceipt & { original: FileDeleteParams })
  | { action: 'unknown'; phase: 'absent' | 'unavailable'; filesystem: 'unknown'; durability: 'unconfirmed'; code: string; message: string } }

export interface AgentMuxRpcFilePathsOwner {
  stat(params: FileStatParams): Promise<FileStatResult>
  move(params: FileMoveParams, context?: FilePathMutationContext): Promise<FileMoveResult>
  delete(params: FileDeleteParams, context?: FilePathMutationContext): Promise<FileDeleteResult>
  deleteSnapshots(params: FileDeleteSnapshotsParams, context?: FilePathMutationContext): Promise<FileDeleteSnapshotsResult>
  mkdir(params: FileMkdirParams, context?: FilePathMutationContext): Promise<FileMkdirResult>
  inspectMutation(params: FileMutationInspectParams, context?: FilePathMutationContext): Promise<FileMutationInspectResult>
}
const keys = ['device', 'inode', 'size', 'ctimeNs', 'mtimeNs', 'birthtimeNs'] as const
const wellFormed = (value: string): boolean => !/[\uD800-\uDFFF]/u.test(value)
const invalid = (message: string, code: string): never => { throw new AgentMuxError(message, code) }
function text(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > 16384 || /[\0\r\n]/u.test(value)) invalid('The exact original Files identity is required.', code)
}
function pathText(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > 16384 || /\0/u.test(value) || !wellFormed(value)) invalid('The exact original path data is required.', code)
}
function message(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string') invalid('The original Files diagnostic must remain text.', code)
}
export function parseFileEntryWitness(value: unknown, code = 'INVALID_CONTROL_REQUEST'): FileEntryWitness {
  const p = rpcRecord(value, [...keys], code)
  for (const key of keys) if (!(key === 'birthtimeNs' && p[key] === null) && (typeof p[key] !== 'string' || !(key.endsWith('Ns') ? /^-?\d{1,30}$/u : /^\d{1,30}$/u).test(p[key]))) invalid('An original native entry witness is required.', code)
  return p as FileEntryWitness
}
export function parseFileReadIdentity(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): FileReadIdentity {
  const p = rpcRecord(value, ['entry', 'ancestorWitnesses'], code)
  if (!Array.isArray(p.ancestorWitnesses) || !p.ancestorWitnesses.length || p.ancestorWitnesses.length > FILE_READ_IDENTITY_MAX_ANCESTORS ||
      JSON.stringify(value).length > FILE_READ_IDENTITY_MAX_BYTES) invalid('The original body read scope is unavailable.', code)
  const entry = parseFileEntryWitness(p.entry, code), ancestorWitnesses = (p.ancestorWitnesses as unknown[]).map(item => parseFileEntryWitness(item, code))
  if (entry.birthtimeNs === null || ancestorWitnesses.some(item => item.birthtimeNs === null)) invalid('The original body generation is unavailable.', code)
  return { entry, ancestorWitnesses }
}
export function parseFilePathScopeWitness(value: unknown, code = 'INVALID_CONTROL_REQUEST'): FilePathScopeWitness {
  const p = rpcRecord(value, ['root', 'parent'], code)
  return { root: parseFileEntryWitness(p.root, code), parent: parseFileEntryWitness(p.parent, code) }
}
export function parseFileStatParams(value: unknown): FileStatParams {
  const p = rpcRecord(value, ['zoneId', 'spaceId', 'path', 'expectedResource', 'includeRevision'])
  const { includeRevision, ...read } = p
  if (includeRevision !== undefined && typeof includeRevision !== 'boolean') invalid('Revision observation must be explicitly selected.', 'INVALID_CONTROL_REQUEST')
  const parsed = parseFileReadParams(read)
  if (!wellFormed(parsed.path)) invalid('The original path must be well-formed Unicode; its bytes are not rewritten.', 'INVALID_CONTROL_REQUEST')
  return p as FileStatParams
}
function mutationParams(value: unknown, mkdir: boolean): FileMkdirParams | FileMutationInspectParams {
  const code = 'INVALID_CONTROL_REQUEST'
  const p = rpcRecord(value, ['zoneId', 'spaceId', 'path', 'expectedResource', 'operationId', ...(mkdir ? ['expectedAbsent', 'expected'] : [])], code)
  const original = parseFileReadResource(p.expectedResource, code)
  if (typeof p.path !== 'string' || !wellFormed(p.path) || Object.values(original).some(value => typeof value === 'string' && !wellFormed(value))) invalid('The exact original path descriptor must be well-formed Unicode.', code)
  parseFileReadParams({ zoneId: p.zoneId, ...(p.spaceId === undefined ? {} : { spaceId: p.spaceId }), path: p.path,
    expectedResource: { hostId: original.hostId, workspaceId: original.workspaceId, workspacePath: original.workspacePath } })
  // The original public mapper owns Zone-relative to Workspace-relative paths.
  try { parseFileReadResult({ resource: original, result: { status: 'directory' } }, p as unknown as FileReadParams) }
  catch { invalid('The complete original Files resource does not match its exact Zone-relative target.', code) }
  text(p.operationId, code)
  if ((p.operationId as string).length > 512) invalid('Keep one bounded original Files operation ID.', code)
  if (mkdir) {
    if (original.path === '.' || original.path === '') invalid('The original Workspace root cannot be created or replaced.', code)
    if (p.expectedAbsent !== true) invalid('Directory creation requires an explicitly observed absent entry.', code)
    parseFilePathScopeWitness(p.expected, code)
  }
  return p as FileMkdirParams | FileMutationInspectParams
}
export const parseFileMkdirParams = (value: unknown): FileMkdirParams => mutationParams(value, true) as FileMkdirParams
export const parseFileMutationInspectParams = (value: unknown): FileMutationInspectParams => mutationParams(value, false) as FileMutationInspectParams

export function parseFileDeleteSnapshotsParams(value: unknown): FileDeleteSnapshotsParams {
  const p = rpcRecord(value, ['zoneId', 'spaceId', 'path', 'expectedResource', 'operationId', 'limit', 'cursor'])
  const { limit, cursor, ...original } = p
  parseFileMutationInspectParams(original)
  if (limit !== undefined && (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 50)) invalid('Snapshot pages contain from 1 to 50 references.', 'INVALID_CONTROL_REQUEST')
  if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(cursor))) invalid('Keep the original snapshot cursor.', 'INVALID_CONTROL_REQUEST')
  return p as FileDeleteSnapshotsParams
}
export function parseFileDeleteSnapshotsResult(value: unknown, params: FileDeleteSnapshotsParams): FileDeleteSnapshotsResult {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['operationId', 'resource', 'result'], code)
  if (p.operationId !== params.operationId) invalid('Another deletion snapshot query was returned.', code)
  const resource = resultResource(p.resource, params, code), r = rpcRecord(p.result, undefined, code)
  if (resource && targetResourceKeys.some(key => resource[key] !== params.expectedResource[key])) invalid('The snapshot query belongs to another original target.', code)
  if (r.status === 'unknown') {
    rpcRecord(r, ['status', 'code', 'message', 'cursor'], code); text(r.code, code); message(r.message, code)
    if (r.cursor !== (params.cursor ?? null)) invalid('An unknown query must preserve its original cursor.', code)
  } else {
    rpcRecord(r, ['status', 'entries', 'hasMore', 'cursor', 'rootRevision', 'filesystem'], code)
    if (r.status !== 'read' || !resource || !Array.isArray(r.entries) || r.entries.length > (params.limit ?? 25) || typeof r.hasMore !== 'boolean' ||
        !['deleted', 'not-applied', 'unknown'].includes(r.filesystem as string) || r.rootRevision !== null && (typeof r.rootRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(r.rootRevision)) ||
        (r.hasMore ? typeof r.cursor !== 'string' || !r.cursor || r.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(r.cursor) || r.rootRevision === null : r.cursor !== null)) invalid('The bounded original snapshot page is invalid.', code)
    const seen = new Set<string>()
    for (const raw of r.entries as unknown[]) {
      const entry = rpcRecord(raw, ['noteId', 'originalResource', 'currentHistoryResource', 'eventId', 'batchId', 'status', 'historyQuery', 'historyUnavailable'], code)
      if (typeof entry.noteId !== 'string' || !entry.noteId || /[\0\r\n]/u.test(entry.noteId)) invalid('The original snapshot Note identity is invalid.', code)
      const original = parseFileReadResource(entry.originalResource, code)
      const suffix = original.path.slice(params.expectedResource.path.length)
      if (targetResourceKeys.some(key => key !== 'path' && original[key] !== params.expectedResource[key]) || original.path !== params.expectedResource.path && !original.path.startsWith(params.expectedResource.path + '/')) invalid('The snapshot is outside the original deletion subtree.', code)
      parseFileReadResult({ resource: original, result: { status: 'directory' } }, { ...params, path: params.path + suffix })
      const current = rpcRecord(entry.currentHistoryResource, ['hostId', 'workspaceId', 'workspacePath', 'path'], code)
      try { noteProvenanceResourceKey(current as NoteResource) } catch { invalid('The current history resource is unconfirmed.', code) }
      if (entry.eventId !== noteFileDeleteEventId(params.operationId, entry.noteId as string, original) || entry.batchId !== params.operationId ||
          !['prepared', 'committed', 'unconfirmed', 'not-applied'].includes(entry.status as string) || seen.has(entry.eventId as string)) invalid('The snapshot reference belongs to another original operation.', code)
      seen.add(entry.eventId as string)
      if (entry.historyQuery !== undefined) {
        const query = parseFileHistoryParams(entry.historyQuery)
        if (entry.historyUnavailable !== undefined || query.noteId !== entry.noteId || query.eventId !== entry.eventId || query.includeContent !== true ||
            ['hostId', 'workspaceId', 'workspacePath', 'path'].some(key => query.expectedResource[key as keyof FileReadResource] !== current[key])) invalid('The history query belongs to another snapshot or current resource.', code)
      } else if (typeof entry.historyUnavailable !== 'string' || !entry.historyUnavailable) invalid('An unavailable live history mapping needs its original source discovery guidance.', code)
    }
  }
  if (new TextEncoder().encode(JSON.stringify(p)).byteLength > AGENTMUX_RPC_MAX_MESSAGE_BYTES / 2) invalid('Snapshot references exceed their bounded RPC packet share. Choose a smaller page.', code)
  return { operationId: params.operationId, resource, result: r as FileDeleteSnapshotsResult['result'] }
}

export function parseFileMoveParams(value: unknown): FileMoveParams {
  const code = 'INVALID_CONTROL_REQUEST'
  const p = rpcRecord(value, ['zoneId', 'spaceId', 'path', 'expectedResource', 'operationId', 'expected', 'destination'], code)
  const { expected, destination, ...source } = p
  const original = parseFileMutationInspectParams(source)
  const e = rpcRecord(expected, ['root', 'parent', 'entry'], code)
  parseFilePathScopeWitness({ root: e.root, parent: e.parent }, code)
  const entry = rpcRecord(e.entry, ['kind', 'witness'], code)
  if (!['file', 'directory', 'symlink', 'other'].includes(entry.kind as string)) invalid('Move requires one observed original entry.', code)
  parseFileEntryWitness(entry.witness, code)
  const d = rpcRecord(destination, ['zoneId', 'spaceId', 'path', 'expectedResource', 'expectedAbsent', 'expected'], code)
  const { expectedAbsent, expected: scope, ...target } = d
  const to = parseFileMutationInspectParams({ ...target, operationId: original.operationId })
  parseFilePathScopeWitness(scope, code)
  if (expectedAbsent !== true) invalid('Move requires an explicitly absent destination.', code)
  if (['hostId', 'workspaceId', 'workspacePath'].some(key => original.expectedResource[key as keyof FileReadResource] !== to.expectedResource[key as keyof FileReadResource])) invalid('Move must stay in its original Host and Workspace.', code)
  if (['', '.'].includes(original.expectedResource.path) || ['', '.'].includes(to.expectedResource.path) || original.expectedResource.path === to.expectedResource.path) invalid('Move requires two distinct non-root entries.', code)
  return p as FileMoveParams
}
export function parseFileDeleteParams(value: unknown): FileDeleteParams {
  const code = 'INVALID_CONTROL_REQUEST'
  const p = rpcRecord(value, ['zoneId', 'spaceId', 'path', 'expectedResource', 'operationId', 'expected', 'expectedRevision', 'recursive'], code)
  const { expected, expectedRevision, recursive, ...scope } = p
  const original = parseFileMutationInspectParams(scope), e = rpcRecord(expected, ['root', 'parent', 'entry'], code)
  parseFilePathScopeWitness({ root: e.root, parent: e.parent }, code)
  const entry = rpcRecord(e.entry, ['kind', 'witness'], code)
  if (!['file', 'directory', 'symlink'].includes(entry.kind as string) || ['', '.'].includes(original.expectedResource.path)) invalid('Delete requires one exact non-root file, directory or symlink entry.', code)
  parseFileEntryWitness(entry.witness, code)
  if (entry.kind === 'file') {
    if (typeof expectedRevision !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(expectedRevision)) invalid('Regular file deletion requires its complete original body revision from file read.', code)
    if (recursive !== undefined) invalid('Recursive authorization is only for a directory subtree.', code)
  } else {
    if (expectedRevision !== undefined) invalid('A file revision does not freeze a directory subtree or a symlink target.', code)
    if (recursive !== undefined && (entry.kind !== 'directory' || typeof recursive !== 'boolean')) invalid('Choose explicit recursive authorization only for the exact original directory.', code)
  }
  return p as FileDeleteParams
}
export function parseFileDeleteReceipt(value: unknown, expected: FileEntryWitness, code = 'CONTROL_PROTOCOL_ERROR'): FileDeleteReceipt {
  const r = rpcRecord(value, ['action', 'phase', 'filesystem', 'durability', 'deletedWitness', 'retainedPath', 'noteHistory', 'code', 'message'], code)
  if (r.action !== 'delete' || !['prepared', 'claimed', 'deleted', 'settled'].includes(r.phase as string) || !['deleted', 'not-applied', 'unknown'].includes(r.filesystem as string) || !['confirmed', 'unconfirmed'].includes(r.durability as string)) invalid('The original delete receipt is invalid.', code)
  if (r.filesystem === 'deleted') {
    if (!sameFileEntryIdentity(parseFileEntryWitness(r.deletedWitness, code), expected)) invalid('The deleted object is not the original source generation. Keep the original operation and inspect without replaying.', code)
  } else if (r.deletedWitness !== undefined) invalid('An unconfirmed deletion cannot claim an original deleted object.', code)
  if (r.retainedPath !== undefined) pathText(r.retainedPath, code)
  if (r.noteHistory !== undefined) {
    const history = rpcRecord(r.noteHistory, ['status', 'message'], code)
    if (!['recorded', 'unconfirmed'].includes(history.status as string)) invalid('The original Note history result is invalid.', code)
    if (history.message !== undefined) message(history.message, code)
  }
  if (r.code !== undefined) text(r.code, code)
  if (r.message !== undefined) message(r.message, code)
  if (r.filesystem === 'unknown' && (r.durability !== 'unconfirmed' || !r.code || !r.message)) invalid('An unknown deletion needs its original retained-operation reason.', code)
  return r as FileDeleteReceipt
}
export function parseFileDeleteResult(value: unknown, params: FileDeleteParams): FileDeleteResult {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['operationId', 'resource', 'result'], code)
  if (p.operationId !== params.operationId) invalid('Another original Files deletion was returned.', code)
  const resource = resultResource(p.resource, params, code), result = parseFileDeleteReceipt(p.result, params.expected.entry.witness, code)
  if (resource && targetResourceKeys.some(key => resource[key] !== params.expectedResource[key])) invalid('Another original deletion resource was returned.', code)
  if (result.filesystem !== 'unknown' && !resource) invalid('A known deletion requires its original resource.', code)
  return { operationId: params.operationId, resource, result }
}
const targetResourceKeys = ['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'path', 'logicalDirectory'] as const
export function sameFileEntryIdentity(left: FileEntryWitness, right: FileEntryWitness): boolean {
  return left.device === right.device && left.inode === right.inode && left.birthtimeNs !== null && left.birthtimeNs === right.birthtimeNs
}
export function parseFileMoveReceipt(value: unknown, expected: FileEntryWitness, code = 'CONTROL_PROTOCOL_ERROR'): FileMoveReceipt {
  const r = rpcRecord(value, ['action', 'phase', 'filesystem', 'durability', 'movedWitness', 'nameAudit', 'noteMetadata', 'code', 'message'], code)
  if (r.action !== 'move' || !['prepared', 'claimed', 'published', 'settled'].includes(r.phase as string) ||
      !['moved', 'not-applied', 'unknown'].includes(r.filesystem as string) || !['confirmed', 'unconfirmed'].includes(r.durability as string)) invalid('The original move receipt is invalid.', code)
  if (r.filesystem === 'moved') {
    if (!sameFileEntryIdentity(parseFileEntryWitness(r.movedWitness, code), expected)) invalid('The moved object is not the original source generation. Preserve the original request and inspect without replaying.', code)
  } else if (r.movedWitness !== undefined) invalid('An unconfirmed move cannot claim a destination identity.', code)
  if (r.nameAudit !== undefined) {
    const audit = rpcRecord(r.nameAudit, ['operationId', 'status', 'message'], code); text(audit.operationId, code)
    if (!['recorded', 'unconfirmed'].includes(audit.status as string)) invalid('The original name audit result is invalid.', code)
    if (audit.message !== undefined) message(audit.message, code)
  }
  if (r.noteMetadata !== undefined) {
    const notes = rpcRecord(r.noteMetadata, ['status', 'message'], code)
    if (!['recorded', 'unconfirmed'].includes(notes.status as string)) invalid('The original Note relocation result is invalid.', code)
    if (notes.message !== undefined) message(notes.message, code)
  }
  if (r.code !== undefined) text(r.code, code)
  if (r.message !== undefined) message(r.message, code)
  if (r.filesystem === 'unknown' && (r.durability !== 'unconfirmed' || !r.code || !r.message)) invalid('An unknown move needs its original recovery reason.', code)
  return r as FileMoveReceipt
}
export function parseFileMoveResult(value: unknown, params: FileMoveParams): FileMoveResult {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['operationId', 'resource', 'destination', 'result'], code)
  if (p.operationId !== params.operationId) invalid('Another Files move was returned.', code)
  const resource = resultResource(p.resource, params, code), destination = resultResource(p.destination, params.destination, code)
  for (const [actual, expected] of [[resource, params.expectedResource], [destination, params.destination.expectedResource]] as const)
    if (actual && ['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'path', 'logicalDirectory'].some(key => actual[key as keyof FileReadResource] !== expected[key as keyof FileReadResource])) invalid('Another original move resource was returned.', code)
  const result = parseFileMoveReceipt(p.result, params.expected.entry.witness, code)
  if (result.filesystem !== 'unknown' && (!resource || !destination)) invalid('A known move result requires both original resources.', code)
  return { operationId: params.operationId, resource, destination, result }
}

function resultResource(value: unknown, params: FileStatParams, code: string): FileReadResource | null {
  if (value === null) return null
  parseFileReadResult({ resource: value, result: { status: 'directory' } }, params)
  return parseFileReadResource(value, code)
}
export function parseFileStatResult(value: unknown, params: FileStatParams): FileStatResult {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['resource', 'result'], code)
  const resource = resultResource(p.resource, params, code), r = rpcRecord(p.result, undefined, code)
  if (r.status === 'observed') {
    rpcRecord(r, ['status', 'observation'], code)
    if (!resource) invalid('A native entry observation requires its original resource.', code)
    const o = rpcRecord(r.observation, ['root', 'parent', 'parentPath', 'entry', 'implementation', 'revision'], code)
    parseFilePathScopeWitness({ root: o.root, parent: o.parent }, code); pathText(o.parentPath, code)
    const e = rpcRecord(o.entry, undefined, code)
    rpcRecord(e, e.kind === 'absent' ? ['kind'] : ['kind', 'witness'], code)
    if (!['absent', 'file', 'directory', 'symlink', 'other'].includes(e.kind as string)) invalid('The original entry kind is unconfirmed.', code)
    if (e.kind !== 'absent') parseFileEntryWitness(e.witness, code)
    if (params.includeRevision === true) {
      const revision = rpcRecord(o.revision, e.kind === 'file' ? ['status', 'revision'] : ['status'], code)
      if (e.kind === 'file' ? revision.status !== 'observed' || typeof revision.revision !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(revision.revision) : revision.status !== 'not-applicable') invalid('The explicitly requested exact file revision is unconfirmed.', code)
    } else if (o.revision !== undefined) invalid('An entry-only stat cannot claim an unrequested body revision.', code)
    const implementation = rpcRecord(o.implementation, ['platform', 'stat', 'mkdir'], code)
    if (!['darwin', 'linux'].includes(implementation.platform as string) || implementation.stat !== 'native' || !['native-no-replace', 'generation-unavailable'].includes(implementation.mkdir as string)) invalid('The Files helper implementation is unconfirmed.', code)
  } else {
    rpcRecord(r, ['status', 'code', 'message'], code)
    if (!['unknown', 'unsupported'].includes(r.status as string)) invalid('The original File stat status is invalid.', code)
    text(r.code, code); message(r.message, code)
  }
  return p as FileStatResult
}
export function parseFilePathMutationReceipt(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): FilePathMutationReceipt {
  const r = rpcRecord(value, ['action', 'phase', 'filesystem', 'durability', 'createdWitness', 'code', 'message'], code)
  if (r.action !== 'mkdir' || !['prepared', 'published', 'settled'].includes(r.phase as string) ||
      !['created', 'not-applied', 'unknown'].includes(r.filesystem as string) || !['confirmed', 'unconfirmed'].includes(r.durability as string)) invalid('The original directory creation receipt is invalid.', code)
  if (r.filesystem === 'created') parseFileEntryWitness(r.createdWitness, code)
  else if (r.createdWitness !== undefined) invalid('An unconfirmed entry cannot claim a created object.', code)
  if (r.code !== undefined) text(r.code, code)
  if (r.message !== undefined) message(r.message, code)
  if (r.filesystem === 'unknown' && (r.durability !== 'unconfirmed' || !r.code || !r.message)) invalid('An unknown directory effect requires its original recovery reason.', code)
  return r as FilePathMutationReceipt
}
export function parseFileMkdirResult(value: unknown, params: FileMkdirParams): FileMkdirResult {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['operationId', 'resource', 'result'], code)
  if (p.operationId !== params.operationId) invalid('Another Files operation was returned.', code)
  const resource = resultResource(p.resource, params, code), result = parseFilePathMutationReceipt(p.result, code)
  if (resource && ['hostId','workspaceId','workspacePath','zoneId','zonePath','path','logicalDirectory'].some(key => resource[key as keyof FileReadResource] !== params.expectedResource[key as keyof FileReadResource])) invalid('Another original mutation resource was returned.', code)
  if (result.filesystem !== 'unknown' && !resource) invalid('A directory effect requires its original resource.', code)
  return { operationId: params.operationId, resource, result }
}
export function parseFileMutationInspectResult(value: unknown, params: FileMutationInspectParams): FileMutationInspectResult {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['operationId', 'resource', 'result'], code)
  if (p.operationId !== params.operationId) invalid('Another original Files operation was returned.', code)
  const resource = resultResource(p.resource, params, code), r = rpcRecord(p.result, undefined, code)
  if (resource && ['hostId','workspaceId','workspacePath','zoneId','zonePath','path','logicalDirectory'].some(key => resource[key as keyof FileReadResource] !== params.expectedResource[key as keyof FileReadResource])) invalid('Another original mutation resource was returned.', code)
  if (r.phase === 'absent' || r.phase === 'unavailable') {
    rpcRecord(r, ['action', 'phase', 'filesystem', 'durability', 'code', 'message'], code)
    if (r.action !== 'unknown' || r.filesystem !== 'unknown' || r.durability !== 'unconfirmed') invalid('An absent operation cannot claim an original effect.', code)
    text(r.code, code); message(r.message, code)
  } else {
    const { original, ...receipt } = r
    const input = r.action === 'move' ? parseFileMoveParams(original) : r.action === 'delete' ? parseFileDeleteParams(original) : parseFileMkdirParams(original)
    if (r.action === 'move') parseFileMoveReceipt(receipt, (input as FileMoveParams).expected.entry.witness, code)
    else if (r.action === 'delete') parseFileDeleteReceipt(receipt, (input as FileDeleteParams).expected.entry.witness, code)
    else parseFilePathMutationReceipt(receipt, code)
    if (input.operationId !== params.operationId || params.spaceId !== undefined && input.spaceId !== params.spaceId || input.zoneId !== params.zoneId || input.path !== params.path ||
        ['hostId','workspaceId','workspacePath','zoneId','zonePath','path','logicalDirectory'].some(key => input.expectedResource[key as keyof FileReadResource] !== params.expectedResource[key as keyof FileReadResource])) invalid('The retained Files intent belongs to another target.', code)
  }
  return { operationId: params.operationId, resource, result: r as FileMutationInspectResult['result'] }
}
