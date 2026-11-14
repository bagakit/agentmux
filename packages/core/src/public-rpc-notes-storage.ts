import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString } from './rpc-data.js'
import type { NotesStorageChange, NotesStorageOperation, NotesStorageSnapshot, NotesResourceChange, NotesConversionIssue } from './notes-storage.js'

export const NOTES_STORAGE_METHODS = { 'notebook.storage.inspect': 'long', 'notebook.storage.change': 'long' } as const
export type NotesStorageMethod = keyof typeof NOTES_STORAGE_METHODS
export type NotesStorageOperationInspection = Pick<NotesStorageOperation, 'operationId' | 'expectedDirectory' | 'directory' | 'phase' | 'resourceChanges'> & { kind: 'move' | 'convert' }
export type NotesStorageInspection = Omit<NotesStorageSnapshot, 'operation'> & {
  operation: NotesStorageOperationInspection | null
  coverage: { resourceChanges: 'retained-committed-operations'; directoryChanges: 'retained-committed-operations'; conversionIssues: 'latest-directory-observation' }
}
export type NotesStorageParamsMap = { 'notebook.storage.inspect': { operationId?: string }; 'notebook.storage.change': NotesStorageChange }
export type NotesStorageResultMap = { [M in NotesStorageMethod]: NotesStorageInspection }
export type NotesStoragePort = { call<M extends NotesStorageMethod>(method: M, params: NotesStorageParamsMap[M]): Promise<NotesStorageResultMap[M]> }
export function parseNotesStorageParams<M extends NotesStorageMethod>(method: M, value: unknown): NotesStorageParamsMap[M] {
  const p = rpcRecord(value, method === 'notebook.storage.inspect' ? ['operationId'] : ['operationId', 'expectedDirectory', 'directory'])
  if (method === 'notebook.storage.inspect') return (p.operationId === undefined ? {} : { operationId: rpcString(p.operationId, 'Original Notes operation ID') }) as NotesStorageParamsMap[M]
  // The original storage owner validates host-native absolute paths. Do not apply
  // identifier/one-line restrictions to valid filesystem names.
  if (typeof p.expectedDirectory !== 'string' || typeof p.directory !== 'string') throw new AgentMuxError('Notes directories must be strings.', 'INVALID_CONTROL_REQUEST')
  return { operationId: rpcString(p.operationId, 'Original Notes operation ID'), expectedDirectory: p.expectedDirectory, directory: p.directory } as NotesStorageParamsMap[M]
}
function invalid(): never { throw new AgentMuxError('The original Notes storage owner returned invalid operation facts.', 'CONTROL_PROTOCOL_ERROR') }
function text(value: unknown): string { if (typeof value !== 'string' || !value || value.includes('\0')) invalid(); return value as string }
function resources(value: unknown): NotesResourceChange[] {
  if (!Array.isArray(value)) invalid()
  return value.map(item => {
    const p = rpcRecord(item, ['noteId', 'from', 'to', 'conversion'], 'CONTROL_PROTOCOL_ERROR')
    text(p.noteId)
    for (const key of ['from', 'to']) { const r = rpcRecord(p[key], ['hostId', 'workspaceId', 'workspacePath', 'path'], 'CONTROL_PROTOCOL_ERROR'); for (const field of ['hostId', 'workspaceId', 'workspacePath', 'path']) text(r[field]) }
    if (p.conversion !== undefined) { const c = rpcRecord(p.conversion, ['sourceRevision', 'targetRevision'], 'CONTROL_PROTOCOL_ERROR'); text(c.sourceRevision); text(c.targetRevision) }
    return structuredClone(p) as unknown as NotesResourceChange
  })
}
export function notesStorageOperationInspection(value: NotesStorageOperation): NotesStorageOperationInspection {
  return { operationId: value.operationId, expectedDirectory: value.expectedDirectory, directory: value.directory,
    kind: value.kind ?? 'move', phase: value.phase, resourceChanges: structuredClone(value.resourceChanges) }
}
export function notesStorageInspection(value: NotesStorageSnapshot): NotesStorageInspection {
  return { directory: value.directory, catalogPath: value.catalogPath,
    operation: value.operation ? notesStorageOperationInspection(value.operation) : null,
    resourceChanges: structuredClone(value.resourceChanges), directoryChanges: structuredClone(value.directoryChanges),
    ...(value.conversionIssues === undefined ? {} : { conversionIssues: structuredClone(value.conversionIssues) }),
    coverage: { resourceChanges: 'retained-committed-operations', directoryChanges: 'retained-committed-operations', conversionIssues: 'latest-directory-observation' } }
}
export function parseNotesStorageOperationInspection(value: unknown): NotesStorageOperationInspection {
  const o = rpcRecord(value, ['operationId', 'expectedDirectory', 'directory', 'kind', 'phase', 'resourceChanges'], 'CONTROL_PROTOCOL_ERROR')
  if (!['prepared', 'committed'].includes(o.phase as string) || !['move', 'convert'].includes(o.kind as string)) invalid()
  return { operationId: text(o.operationId), expectedDirectory: text(o.expectedDirectory), directory: text(o.directory), kind: o.kind as 'move' | 'convert', phase: o.phase as 'prepared' | 'committed', resourceChanges: resources(o.resourceChanges) }
}
export function parseNotesStorageInspection(value: unknown, operationId?: string): NotesStorageInspection {
  const p = rpcRecord(value, ['directory', 'catalogPath', 'operation', 'resourceChanges', 'directoryChanges', 'conversionIssues', 'coverage'], 'CONTROL_PROTOCOL_ERROR')
  const operation = p.operation === null ? null : parseNotesStorageOperationInspection(p.operation)
  if (operation && operationId !== undefined && operation.operationId !== operationId) invalid()
  const coverage = rpcRecord(p.coverage, ['resourceChanges', 'directoryChanges', 'conversionIssues'], 'CONTROL_PROTOCOL_ERROR')
  if (coverage.resourceChanges !== 'retained-committed-operations' || coverage.directoryChanges !== 'retained-committed-operations' || coverage.conversionIssues !== 'latest-directory-observation' || !Array.isArray(p.directoryChanges)) invalid()
  const directoryChanges = p.directoryChanges.map(value => { const d = rpcRecord(value, ['from', 'to'], 'CONTROL_PROTOCOL_ERROR'); return { from: text(d.from), to: text(d.to) } })
  if (p.conversionIssues !== undefined) {
    if (!Array.isArray(p.conversionIssues)) invalid()
    for (const value of p.conversionIssues) {
      const issue = rpcRecord(value, ['noteId', 'resource', 'code', 'message'], 'CONTROL_PROTOCOL_ERROR')
      if (issue.noteId !== null) text(issue.noteId)
      if (issue.resource !== null) { const r = rpcRecord(issue.resource, ['hostId', 'workspaceId', 'workspacePath', 'path'], 'CONTROL_PROTOCOL_ERROR'); for (const key of ['hostId', 'workspaceId', 'workspacePath', 'path']) text(r[key]) }
      text(issue.code); text(issue.message)
    }
  }
  return { directory: text(p.directory), catalogPath: text(p.catalogPath), operation, resourceChanges: resources(p.resourceChanges), directoryChanges,
    ...(p.conversionIssues === undefined ? {} : { conversionIssues: structuredClone(p.conversionIssues) as NotesConversionIssue[] }),
    coverage: { resourceChanges: 'retained-committed-operations', directoryChanges: 'retained-committed-operations', conversionIssues: 'latest-directory-observation' } }
}
