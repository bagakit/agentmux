import { AgentMuxError } from './errors.js'
export { AgentMuxError } from './errors.js'
import type { NotebookState, NoteResource } from './notebook-catalog.js'

/** Original file observations, never another Note body or relationship store. */
export type NoteContentObservation = { noteId: string; resource: NoteResource } & (
  | { status: 'read'; revision: string; content: string; actualNoteId: string; blockIds: string[] }
  | { status: 'missing' | 'unknown' | 'invalid' | 'identity-mismatch'; message: string; revision?: string; actualNoteId?: string })
export type NoteContentMetadata = NoteContentObservation extends infer O ? O extends NoteContentObservation ? Omit<O, 'content'> : never : never
export type NotebookGraphParams = { notebookId?: string; noteId?: string; maxBytes?: number }
export type NotebookGraphScope = { kind: 'catalog' } | { kind: 'notebook'; notebookId: string } | { kind: 'note'; noteId: string }
export type NoteGraphEndpoint = { noteId: string; blockId: string }
export type NotebookGraph = {
  catalogRevision: number
  scope: NotebookGraphScope
  /** Incoming links require examining the catalog, including closed pages in other Notebooks. */
  scannedScope: 'catalog'
  completeness: 'complete' | 'partial' | 'unknown'
  observations: NoteContentMetadata[]
  duplicateNoteIds: string[]
  hierarchy: { parentNoteId: string; noteId: string }[]
  references: { source: NoteGraphEndpoint; sourceResource: NoteResource; target: NoteGraphEndpoint; referenceId: string;
    mode: 'reference' | 'embed'; resolution: 'resolved' | 'missing' | 'unknown' | 'ambiguous' }[]
}
export type NotebookObservationPort = {
  content(state: NotebookState, noteId: string, options?: { maxBytes?: number; signal?: AbortSignal }): Promise<NoteContentObservation>
  graph(state: NotebookState, params: NotebookGraphParams, options?: { signal?: AbortSignal }): Promise<NotebookGraph>
}
const bad = (message: string): never => { throw new AgentMuxError(message, 'INVALID_CONTROL_REQUEST') }
const object = (value: unknown, fields: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) bad('Unexpected Note observation fields.')
  return value as Record<string, unknown>
}
const id = (value: unknown): string => typeof value === 'string' && value.length > 0 && !value.includes('\0') ? value : bad('An exact Note observation identity is required.')
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : bad('A Note observation list is required.')
const member = (value: unknown, values: readonly string[]) => { if (!values.includes(value as string)) bad('Unknown Note observation state.') }
const count = (value: unknown) => { if (!Number.isSafeInteger(value) || (value as number) < 0) bad('Invalid Note observation revision.') }
const resource = (value: unknown): NoteResource => { const r = object(value, ['hostId', 'workspaceId', 'workspacePath', 'path']); for (const key of ['hostId', 'workspaceId', 'workspacePath', 'path']) id(r[key]); if ((r.path as string).startsWith('/') || (r.path as string).split(/[\\/]/).includes('..')) bad('A Note requires its original relative resource.'); return r as NoteResource }
export function parseNotebookObservationParams(value: unknown, inspect = false): NotebookGraphParams & { operationId?: string; content?: boolean } {
  const p = object(value, inspect ? ['notebookId', 'noteId', 'operationId', 'content', 'maxBytes'] : ['notebookId', 'noteId', 'maxBytes'])
  for (const key of ['notebookId', 'noteId', 'operationId']) if (p[key] !== undefined) id(p[key])
  if ([p.notebookId, p.noteId, p.operationId].filter(v => v !== undefined).length > 1) bad('Choose exactly one original Notebook, Note or operation.')
  if (p.content !== undefined && typeof p.content !== 'boolean') bad('Note content observation must be explicit.')
  if (p.content === true && p.noteId === undefined) bad('Content requires an exact Note ID.')
  if (p.maxBytes !== undefined && (!Number.isSafeInteger(p.maxBytes) || (p.maxBytes as number) < 1)) bad('The per-file read byte cap must be a positive integer.')
  if (inspect && p.maxBytes !== undefined && p.content !== true) bad('A content byte cap requires --content.')
  return p as ReturnType<typeof parseNotebookObservationParams>
}
function protocolResult<T>(read: () => T): T {
  try { return read() } catch (error) {
    if (error instanceof AgentMuxError && error.code === 'INVALID_CONTROL_REQUEST') throw new AgentMuxError(error.message, 'CONTROL_PROTOCOL_ERROR')
    throw error
  }
}
export function parseNoteContentObservation(value: unknown): NoteContentObservation
export function parseNoteContentObservation(value: unknown, includeContent: true): NoteContentObservation
export function parseNoteContentObservation(value: unknown, includeContent: false): NoteContentMetadata
export function parseNoteContentObservation(value: unknown, includeContent = true): NoteContentObservation | NoteContentMetadata {
  return protocolResult(() => validateNoteContentObservation(value, includeContent))
}
function validateNoteContentObservation(value: unknown, includeContent: boolean): NoteContentObservation | NoteContentMetadata {
  const p = object(value, ['noteId', 'resource', 'status', 'revision', 'content', 'actualNoteId', 'blockIds', 'message'])
  id(p.noteId); resource(p.resource)
  if (p.status === 'read') {
    id(p.revision); id(p.actualNoteId); if (p.noteId !== p.actualNoteId) bad('A confirmed Note body belongs to another identity.')
    if (includeContent ? typeof p.content !== 'string' : p.content !== undefined) bad('Invalid Note content payload.')
    list(p.blockIds).forEach(id); if (new Set(p.blockIds as string[]).size !== (p.blockIds as string[]).length) bad('Duplicated observed block identities.'); if (p.message !== undefined) bad('Unexpected read issue.')
  } else {
    member(p.status, ['missing', 'unknown', 'invalid', 'identity-mismatch']); id(p.message)
    if (p.revision !== undefined) id(p.revision); if (p.actualNoteId !== undefined) id(p.actualNoteId)
    if (p.content !== undefined || p.blockIds !== undefined) bad('Unconfirmed Note body cannot report parsed content.')
  }
  return value as NoteContentObservation | NoteContentMetadata
}
export function parseNotebookGraph(value: unknown, params: NotebookGraphParams): NotebookGraph {
  return protocolResult(() => validateNotebookGraph(value, params))
}
function validateNotebookGraph(value: unknown, params: NotebookGraphParams): NotebookGraph {
  const p = object(value, ['catalogRevision', 'scope', 'scannedScope', 'completeness', 'observations', 'duplicateNoteIds', 'hierarchy', 'references'])
  count(p.catalogRevision)
  const expected: NotebookGraphScope = params.noteId ? { kind: 'note', noteId: params.noteId } : params.notebookId ? { kind: 'notebook', notebookId: params.notebookId } : { kind: 'catalog' }
  const s = object(p.scope, ['kind', 'notebookId', 'noteId'])
  if (s.kind !== expected.kind || s.noteId !== ('noteId' in expected ? expected.noteId : undefined) || s.notebookId !== ('notebookId' in expected ? expected.notebookId : undefined)) bad('The graph belongs to another requested scope.')
  if (p.scannedScope !== 'catalog') bad('The incoming graph scan scope is unconfirmed.')
  member(p.completeness, ['complete', 'partial', 'unknown'])
  const observations = list(p.observations).map(v => parseNoteContentObservation(v, false))
  list(p.duplicateNoteIds).forEach(id)
  if (new Set(observations.map(o => o.noteId)).size !== observations.length) bad('Duplicated catalog observations.')
  const byNoteId = new Map(observations.map(o => [o.noteId, o]))
  const observedBlocks = new Map(observations.filter(o => o.status === 'read').map(o => [o.noteId, new Set(o.blockIds)]))
  const resourceKey = (r: NoteResource) => JSON.stringify([r.hostId, r.workspaceId, r.workspacePath, r.path])
  const identities = new Map<string, Set<string>>()
  for (const observed of observations) if (observed.actualNoteId) {
    const locations = identities.get(observed.actualNoteId) ?? new Set<string>()
    locations.add(resourceKey(observed.resource)); identities.set(observed.actualNoteId, locations)
  }
  const duplicates = [...identities].filter(([, locations]) => locations.size > 1).map(([noteId]) => noteId)
  if (new Set(p.duplicateNoteIds as string[]).size !== duplicates.length || duplicates.some(noteId => !(p.duplicateNoteIds as string[]).includes(noteId))) bad('The duplicated Note identities do not match their original resources.')
  if (params.noteId && !byNoteId.has(params.noteId)) bad('The requested Note observation is missing.')
  if (p.completeness === 'complete' && (observations.some(o => o.status !== 'read') || (p.duplicateNoteIds as unknown[]).length > 0)) bad('Incomplete file observations cannot confirm the whole graph.')
  list(p.hierarchy).forEach(v => { const e = object(v, ['parentNoteId', 'noteId']); id(e.parentNoteId); id(e.noteId); if (![e.parentNoteId, e.noteId].every(noteId => byNoteId.has(noteId as string))) bad('An original hierarchy endpoint is outside the observed catalog.') })
  const endpoint = (v: unknown) => { const e = object(v, ['noteId', 'blockId']); id(e.noteId); id(e.blockId) }
  list(p.references).forEach(v => {
    const e = object(v, ['source', 'sourceResource', 'target', 'referenceId', 'mode', 'resolution']); endpoint(e.source); endpoint(e.target); resource(e.sourceResource); id(e.referenceId); member(e.mode, ['reference', 'embed']); member(e.resolution, ['resolved', 'missing', 'unknown', 'ambiguous'])
    const source = e.source as NoteGraphEndpoint, target = e.target as NoteGraphEndpoint
    const original = byNoteId.get(source.noteId)
    if (!original || original.status !== 'read' || resourceKey(original.resource) !== resourceKey(e.sourceResource as NoteResource) || !observedBlocks.get(source.noteId)?.has(source.blockId)) bad('The reference source is not an accurately observed original block.')
    if (params.noteId && source.noteId !== params.noteId && target.noteId !== params.noteId) bad('The returned edge does not touch the requested Note.')
    if (e.resolution === 'resolved') {
      const destination = byNoteId.get(target.noteId)
      if (!destination || destination.status !== 'read' || duplicates.includes(target.noteId) || !observedBlocks.get(target.noteId)?.has(target.blockId)) bad('The reference target is not an accurately observed original block.')
    }
    if (p.completeness === 'complete' && !byNoteId.has(target.noteId)) bad('The graph contains an unobserved external target.')
    if (e.resolution === 'missing') { const destination = byNoteId.get(target.noteId); if (!destination || destination.status !== 'missing' && !(destination.status === 'read' && !observedBlocks.get(target.noteId)?.has(target.blockId))) bad('The original target is unknown, not confirmed missing.') }
    if (e.resolution === 'ambiguous' && !duplicates.includes(target.noteId)) bad('The ambiguous target has no observed duplicate identity.')
  })
  return value as NotebookGraph
}
