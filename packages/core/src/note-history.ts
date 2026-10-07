import { sha256 } from '@noble/hashes/sha2.js'
import { AgentMuxError } from './errors.js'
import { noteProvenanceResourceKey, parseNoteProvenanceWrite, type NoteProvenanceWrite } from './note-provenance.js'
import type { NoteResource, NotebookActor } from './notebook-catalog.js'

export type NoteHistoryStatus = 'prepared' | 'committed' | 'unconfirmed' | 'not-applied'
/** Immutable selection behind a restoration or selective undo, held in the original event. */
export type NoteHistorySource = { eventId: string } | { batchId: string; lastEventId: string }
/** An edit event is not a body digest: restoring identical bytes is another event. */
export type NoteHistoryRecord = {
  eventId: string; sequence: number; batchId: string; noteId: string; resource: NoteResource; originalResource: NoteResource
  status: NoteHistoryStatus; at: number; actor: NotebookActor | null; parentEventId: string | null
  operation: 'edit' | 'restore' | 'undo'; requestFingerprint: string
  source?: NoteHistorySource
  baseRevision: string | null; revision: string; beforeContent: string | null; content: string
  provenance?: NoteProvenanceWrite
}
export type NoteHistoryEntry = Omit<NoteHistoryRecord, 'requestFingerprint' | 'beforeContent' | 'content' | 'provenance'> & {
  beforeContent?: string | null; content?: string; provenance?: NoteProvenanceWrite
}
export type NoteHistoryQuery = {
  noteId: string; resource: NoteResource; limit?: number; before?: number; eventId?: string; includeContent?: boolean
}
export type NoteHistoryBatch = { batchId: string; actor: NotebookActor | null; from: number; to: number; eventIds: string[] }
export type NoteHistorySnapshot = { noteId: string; resource: NoteResource; entries: NoteHistoryEntry[]; batches: NoteHistoryBatch[]; hasMore: boolean } & (
  | { status: 'read'; reason?: never }
  | { status: 'unconfirmed'; reason: string }
)
export type NoteHistoryReceipt = { eventId: string; batchId: string; status: NoteHistoryStatus; replayed?: true } | { status: 'unconfirmed'; reason: string; eventId?: string; batchId?: string }
export const NOTE_HISTORY_BATCH_WINDOW_MS = 5 * 60 * 1000
export function noteHistoryRevision(content: string): string {
  return 'sha256:' + Array.from(sha256(new TextEncoder().encode(content)), byte => byte.toString(16).padStart(2, '0')).join('')
}
const invalid = (message: string): never => { throw new AgentMuxError(message, 'NOTE_HISTORY_INVALID') }
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !/[\0\r\n]/u.test(value)
export function parseNoteHistorySource(operation: NoteHistoryRecord['operation'], source: unknown): NoteHistorySource | undefined {
  if (operation === 'edit') {
    if (source !== undefined) invalid('An ordinary edit cannot claim a restoration source.')
    return
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) invalid('The original history action source is required.')
  const value = source as Record<string, unknown>, fields = Object.keys(value)
  if (operation === 'restore' && fields.length === 1 && fields[0] === 'eventId' && id(value.eventId)) return { eventId: value.eventId }
  if (operation === 'undo' && fields.length === 2 && fields.every(key => key === 'batchId' || key === 'lastEventId') && id(value.batchId) && id(value.lastEventId)) return { batchId: value.batchId, lastEventId: value.lastEventId }
  return invalid('The original history source does not match its operation.')
}
export function parseNoteHistoryQuery(value: NoteHistoryQuery): NoteHistoryQuery {
  if (!id(value.noteId)) invalid('History requires the original Note identity.')
  noteProvenanceResourceKey(value.resource)
  if (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 200) ||
      value.before !== undefined && (!Number.isSafeInteger(value.before) || value.before < 1) ||
      value.eventId !== undefined && !id(value.eventId) || value.includeContent !== undefined && typeof value.includeContent !== 'boolean') invalid('The history window or event is invalid.')
  if (value.includeContent && !value.eventId) invalid('Select one exact history event before reading its original content. The metadata timeline remains available.')
  return structuredClone(value)
}
export function parseNoteHistoryRecord(value: NoteHistoryRecord): NoteHistoryRecord {
  parseNoteHistoryQuery({ noteId: value.noteId, resource: value.resource })
  noteProvenanceResourceKey(value.originalResource)
  if (![value.eventId, value.batchId, value.requestFingerprint].every(id) || value.parentEventId !== null && (!id(value.parentEventId) || value.parentEventId === value.eventId) || !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
      !Number.isSafeInteger(value.at) || value.at < 0 || !['prepared', 'committed', 'unconfirmed', 'not-applied'].includes(value.status) ||
      !['edit', 'restore', 'undo'].includes(value.operation) || typeof value.content !== 'string' || noteHistoryRevision(value.content) !== value.revision ||
      (value.beforeContent === null ? value.baseRevision !== null : typeof value.beforeContent !== 'string' || noteHistoryRevision(value.beforeContent) !== value.baseRevision)) invalid('The original history event, body or baseline cannot be confirmed.')
  const source = parseNoteHistorySource(value.operation, value.source)
  if (source && ('eventId' in source ? source.eventId : source.lastEventId) === value.eventId) invalid('A history action cannot select its own new event.')
  if (value.actor !== null && (!['user', 'agent', 'device'].includes(value.actor.kind) || !id(value.actor.id))) invalid('The original history actor is invalid.')
  if (value.provenance !== undefined) {
    const provenance = parseNoteProvenanceWrite(value.provenance)
    if (provenance.noteId !== value.noteId || provenance.revision !== value.revision || noteProvenanceResourceKey(provenance.resource) !== noteProvenanceResourceKey(value.resource)) invalid('History attribution belongs to another original body.')
  }
  return structuredClone(value)
}
/** Grouping is a view of durable batch membership; it never discards edit events. */
export function noteHistorySnapshot(query: NoteHistoryQuery, records: readonly NoteHistoryEntry[], hasMore: boolean): NoteHistorySnapshot {
  const entries: NoteHistoryEntry[] = records.map(record => {
    const { beforeContent, content, provenance, ...entry } = record
    // Structural typing also admits an internal record; private request fingerprints stay internal.
    delete (entry as Partial<NoteHistoryRecord>).requestFingerprint
    return { ...entry, ...(query.includeContent ? { beforeContent, content, ...(provenance ? { provenance } : {}) } : {}) }
  })
  const batches = new Map<string, NoteHistoryBatch>()
  for (const event of entries) {
    const batch = batches.get(event.batchId)
    if (batch) { batch.from = Math.min(batch.from, event.at); batch.to = Math.max(batch.to, event.at); batch.eventIds.push(event.eventId) }
    else batches.set(event.batchId, { batchId: event.batchId, actor: event.actor, from: event.at, to: event.at, eventIds: [event.eventId] })
  }
  return { noteId: query.noteId, resource: structuredClone(query.resource), entries, batches: [...batches.values()], hasMore, status: 'read' }
}
