import { AgentMuxError } from './errors.js'
import { noteHistoryRevision, type NoteHistoryReceipt } from './note-history.js'
import type { NoteResource, NotebookActor } from './notebook-catalog.js'
import { noteProvenanceResourceKey } from './note-provenance.js'

/** A title intent belongs to the existing original file/history owner, not a second journal. */
export type NoteTitleIntent = { operationId: string; noteId: string; resource: NoteResource; title: string; actor: NotebookActor }
export type NoteFileTitle = { status: 'read'; noteId: string; resource: NoteResource; title: string; revision: string }
  | { status: 'unknown' | 'missing' | 'invalid' | 'identity-mismatch'; noteId: string; resource: NoteResource; reason: string }
export type NoteTitleOperation = { status: 'absent'; operationId: string }
  | { status: 'unavailable' | 'different-operation'; operationId: string; reason: string }
  | { status: 'recorded'; intent: NoteTitleIntent; resource: NoteResource; revision: string; history: NoteHistoryReceipt }
export type NoteTitleProjection = { status: 'projected'; noteId: string; resource: NoteResource; revision: string; title: string; catalogRevision: number }
  | { status: 'not-registered'; noteId: string; resource: NoteResource }
  | { status: 'unconfirmed'; noteId: string; resource: NoteResource; code: 'host-unavailable' | 'source-unconfirmed' | 'resource-mismatch' | 'catalog-unavailable' | 'projection-mismatch'; message: string }
export type NoteTitleInspection = { operation: NoteTitleOperation; file: NoteFileTitle | null; projection: NoteTitleProjection | null }
export type NoteTitlePort = {
  inspect(operationId: string): Promise<NoteTitleOperation>
  write(intent: NoteTitleIntent): Promise<NoteTitleOperation>
  /** Raw Files/header read only: this can run under the original catalog lock, without metadata re-entry. */
  current(noteId: string, resource: NoteResource): Promise<NoteFileTitle>
}
const invalid = (message: string): never => { throw new AgentMuxError(message, 'NOTE_TITLE_INVALID') }
const object = (value: unknown, fields: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) invalid('Unexpected original Note title fields.')
  return value as Record<string, unknown>
}
const id = (value: unknown): string => typeof value === 'string' && !!value && !/[\0\r\n]/u.test(value) ? value : invalid('An exact original Note title identity is required.')
const member = (value: unknown, values: readonly string[]): boolean => typeof value === 'string' && values.includes(value)
const revision = (value: unknown): void => { if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) invalid('The exact original Note body revision is required.') }
const title = (value: unknown): string => { const text = id(value); if (!text.trim()) invalid('An original Note title must be nonempty.'); return text }
const resource = (value: unknown): NoteResource => {
  const original = object(value, ['hostId', 'workspaceId', 'workspacePath', 'path'])
  noteProvenanceResourceKey(original as NoteResource)
  for (const key of ['hostId', 'workspaceId', 'workspacePath', 'path']) id(original[key])
  return structuredClone(original) as NoteResource
}
export function parseNoteTitleIntent(value: unknown): NoteTitleIntent {
  const p = object(value, ['operationId', 'noteId', 'resource', 'title', 'actor'])
  id(p.operationId); id(p.noteId); resource(p.resource); title(p.title)
  const actor = object(p.actor, ['kind', 'id']); id(actor.id)
  if (!member(actor.kind, ['user', 'agent', 'device'])) invalid('The original title actor is unavailable.')
  return structuredClone(value) as NoteTitleIntent
}
/** Fixed domain encoding keeps ordinary file.write operation identities distinct. */
export function noteTitleEventId(operationId: string): string {
  return 'note-title:' + noteHistoryRevision(JSON.stringify(['agentmux.note.title.event.v1', id(operationId)])).slice('sha256:'.length)
}
/** Catalog revisions and mutable body bytes are deliberately outside this original intent. */
export function noteTitleIntentFingerprint(value: NoteTitleIntent): string {
  const intent = parseNoteTitleIntent(value)
  return noteHistoryRevision(JSON.stringify(['agentmux.note.title.intent.v1', intent.operationId, intent.noteId, noteProvenanceResourceKey(intent.resource), intent.title, intent.actor.kind, intent.actor.id]))
}
export function parseNoteFileTitle(value: unknown): NoteFileTitle {
  const p = object(value, ['status', 'noteId', 'resource', 'title', 'revision', 'reason'])
  id(p.noteId); resource(p.resource)
  if (p.status === 'read') { title(p.title); revision(p.revision); if (p.reason !== undefined) invalid('A confirmed title has no unknown-source reason.') }
  else if (!member(p.status, ['unknown', 'missing', 'invalid', 'identity-mismatch']) || typeof p.reason !== 'string' || !p.reason || p.title !== undefined || p.revision !== undefined) invalid('The original title observation is malformed.')
  return structuredClone(value) as NoteFileTitle
}
export function parseNoteTitleOperation(value: unknown, operationId: string): NoteTitleOperation {
  const p = object(value, ['status', 'operationId', 'reason', 'intent', 'resource', 'revision', 'history'])
  if (p.status !== 'recorded') {
    if (p.operationId !== operationId || p.intent !== undefined || p.resource !== undefined || p.revision !== undefined || p.history !== undefined) invalid('The title operation belongs to another original intent.')
    if (p.status === 'absent' ? p.reason !== undefined : !member(p.status, ['unavailable', 'different-operation']) || typeof p.reason !== 'string' || !p.reason) invalid('The title operation outcome is malformed.')
  } else {
    const intent = parseNoteTitleIntent(p.intent); resource(p.resource); revision(p.revision)
    if (intent.operationId !== operationId || p.operationId !== undefined || p.reason !== undefined) invalid('The title history belongs to another original intent.')
    const history = object(p.history, ['status', 'eventId', 'batchId', 'replayed', 'reason'])
    if (!member(history.status, ['prepared', 'committed', 'unconfirmed', 'not-applied']) || history.eventId !== noteTitleEventId(operationId)) invalid('The title outcome is not its original history event.')
    id(history.batchId)
    if (history.reason !== undefined && (history.status !== 'unconfirmed' || typeof history.reason !== 'string' || !history.reason)) invalid('The title history diagnostic is malformed.')
    if (history.replayed !== undefined && (history.replayed !== true || history.status !== 'committed')) invalid('Only confirmed title history can be replayed.')
  }
  return structuredClone(value) as NoteTitleOperation
}
export function parseNoteTitleProjection(value: unknown): NoteTitleProjection {
  const p = object(value, ['status', 'noteId', 'resource', 'revision', 'title', 'catalogRevision', 'code', 'message'])
  id(p.noteId); resource(p.resource)
  if (p.status === 'projected') {
    revision(p.revision); title(p.title)
    if (!Number.isSafeInteger(p.catalogRevision) || Number(p.catalogRevision) < 0 || p.code !== undefined || p.message !== undefined) invalid('The original title projection is malformed.')
  } else if (p.status === 'unconfirmed') {
    if (!member(p.code, ['host-unavailable', 'source-unconfirmed', 'resource-mismatch', 'catalog-unavailable', 'projection-mismatch']) || typeof p.message !== 'string' || !p.message) invalid('The title projection diagnostic is malformed.')
    if (p.revision !== undefined || p.title !== undefined || p.catalogRevision !== undefined) invalid('An unconfirmed projection cannot claim confirmed title data.')
  } else if (p.status !== 'not-registered' || p.revision !== undefined || p.title !== undefined || p.catalogRevision !== undefined || p.code !== undefined || p.message !== undefined) invalid('The title projection outcome is malformed.')
  return structuredClone(value) as NoteTitleProjection
}

export function parseNoteTitleInspection(value: unknown, operationId: string): NoteTitleInspection {
  const p = object(value, ['operation', 'file', 'projection']), operation = parseNoteTitleOperation(p.operation, operationId)
  if (operation.status !== 'recorded') {
    if (p.file !== null || p.projection !== null) invalid('An unavailable title operation cannot grant a file or projection.')
  } else {
    const file = parseNoteFileTitle(p.file), projection = parseNoteTitleProjection(p.projection)
    const matches = (noteId: string, original: NoteResource) => noteId === operation.intent.noteId && noteProvenanceResourceKey(original) === noteProvenanceResourceKey(operation.resource)
    if (!matches(file.noteId, file.resource) || !matches(projection.noteId, projection.resource)) invalid('The title inspection belongs to another original resource.')
    if (projection.status === 'projected' && (file.status !== 'read' || file.title !== projection.title || file.revision !== projection.revision)) invalid('The title projection is not its confirmed original file observation.')
  }
  return structuredClone(value) as NoteTitleInspection
}
