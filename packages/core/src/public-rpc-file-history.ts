import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { noteHistoryRevision, parseNoteHistorySource, type NoteHistorySnapshot } from './note-history.js'
import { noteProvenanceResourceKey, parseNoteProvenanceWrite } from './note-provenance.js'
import type { NoteResource, NotebookActor } from './notebook-catalog.js'
import { parseFileReadParams, parseFileReadResult, type FileReadParams, type FileReadResource, type FileReadUnknown } from './public-rpc-files.js'

/** History belongs to the exact saved Note and full original Files mapping. */
export type FileHistoryParams = Omit<FileReadParams, 'maxBytes' | 'expectedResource'> & {
  expectedResource: FileReadResource; noteId: string; limit?: number; before?: number; eventId?: string; includeContent?: boolean
}
export type FileHistoryResult = { resource: FileReadResource | null; result: NoteHistorySnapshot | FileReadUnknown }
const fields = ['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'path', 'logicalDirectory'] as const
function invalid(message: string, code: string): never { throw new AgentMuxError(message, code) }
function text(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || !value.length || /[\0\r\n]/u.test(value)) invalid('An exact original Note history identity is required.', code)
}
function count(value: unknown, code: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid('The original history sequence or time is invalid.', code)
}
function revision(value: unknown, code: string): void {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) invalid('The complete original Note history revision is required.', code)
}
function actor(value: unknown, code: string): asserts value is NotebookActor | null {
  if (value === null) return
  const a = rpcRecord(value, ['kind', 'id'], code)
  text(a.id, code)
  if (!['user', 'agent', 'device'].includes(a.kind as string)) invalid('The original history actor is invalid.', code)
}
function originalResource(value: unknown, expected: FileReadResource, code: string): void {
  const resource = rpcRecord(value, ['hostId', 'workspaceId', 'workspacePath', 'path'], code)
  if (['hostId', 'workspaceId', 'workspacePath', 'path'].some(key => resource[key] !== expected[key as keyof FileReadResource])) invalid('History belongs to another original Note resource.', code)
}
export function parseFileHistoryParams(value: unknown): FileHistoryParams {
  const code = 'INVALID_CONTROL_REQUEST'
  const p = rpcRecord(value, ['zoneId', 'spaceId', 'path', 'expectedResource', 'noteId', 'limit', 'before', 'eventId', 'includeContent'], code)
  const original = rpcRecord(p.expectedResource, fields, code)
  const read = { zoneId: p.zoneId, ...(p.spaceId === undefined ? {} : { spaceId: p.spaceId }), path: p.path,
    expectedResource: { hostId: original.hostId, workspaceId: original.workspaceId, workspacePath: original.workspacePath } }
  parseFileReadParams(read)
  // The same Files mapping validator owns physical and logical Zone confinement.
  try { parseFileReadResult({ resource: original, result: { status: 'directory' } }, read as FileReadParams) }
  catch (error) { invalid(error instanceof Error ? error.message : 'The original Files mapping is invalid.', code) }
  text(p.noteId, code)
  if (p.limit !== undefined && (!Number.isSafeInteger(p.limit) || Number(p.limit) < 1 || Number(p.limit) > 200) ||
      p.before !== undefined && (!Number.isSafeInteger(p.before) || Number(p.before) < 1) ||
      p.includeContent !== undefined && typeof p.includeContent !== 'boolean') invalid('The original history query window is invalid.', code)
  if (p.eventId !== undefined) text(p.eventId, code)
  if (p.includeContent === true && p.eventId === undefined) invalid('Historical content requires one exact original event ID.', code)
  return p as FileHistoryParams
}
export function parseFileHistoryResult(value: unknown, params: FileHistoryParams): FileHistoryResult {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['resource', 'result'], code), r = rpcRecord(p.result, undefined, code)
  parseFileReadResult({ resource: p.resource, result: r.status === 'unknown' ? r : { status: 'directory' } }, params)
  if (p.resource !== null && fields.some(key => (p.resource as Record<string, unknown>)[key] !== params.expectedResource[key])) invalid('The original File history mapping changed.', code)
  if (r.status === 'unknown') return p as FileHistoryResult
  rpcRecord(r, ['noteId', 'resource', 'entries', 'batches', 'hasMore', 'status', 'reason'], code)
  if (r.noteId !== params.noteId || !['read', 'unconfirmed'].includes(r.status as string) ||
      r.status === 'read' && r.reason !== undefined || r.status === 'unconfirmed' && (typeof r.reason !== 'string' || !r.reason.length) ||
      typeof r.hasMore !== 'boolean' || !Array.isArray(r.entries) || r.entries.length > (params.limit ?? 200) || !Array.isArray(r.batches)) invalid('The original history observation is invalid.', code)
  if (r.status === 'unconfirmed') text(r.reason, code)
  originalResource(r.resource, params.expectedResource, code)
  const events = new Map<string, { batchId: string; actor: unknown; at: number }>()
  let previous = params.before ?? Infinity
  for (const raw of r.entries) {
    const entry = rpcRecord(raw, ['eventId', 'sequence', 'batchId', 'parentEventId', 'noteId', 'resource', 'originalResource', 'status', 'at', 'actor', 'operation', 'source', 'baseRevision', 'revision', ...(params.includeContent ? ['beforeContent', 'content', 'provenance'] : [])], code)
    text(entry.eventId, code); text(entry.batchId, code); count(entry.sequence, code); count(entry.at, code); actor(entry.actor, code)
    if (entry.parentEventId !== null) text(entry.parentEventId, code)
    if (entry.parentEventId === entry.eventId) invalid('A history event cannot be its own parent.', code)
    if (entry.noteId !== params.noteId || events.has(entry.eventId) || Number(entry.sequence) >= previous || params.eventId !== undefined && entry.eventId !== params.eventId ||
        !['prepared', 'committed', 'unconfirmed', 'not-applied'].includes(entry.status as string) || !['edit', 'restore', 'undo'].includes(entry.operation as string)) invalid('The original Note history event, ordering or status is invalid.', code)
    try {
      const source = parseNoteHistorySource(entry.operation as 'edit' | 'restore' | 'undo', entry.source)
      if (source && ('eventId' in source ? source.eventId : source.lastEventId) === entry.eventId) throw Error('Self-selected history event')
    } catch { invalid('The original history action source is invalid.', code) }
    originalResource(entry.resource, params.expectedResource, code)
    try { noteProvenanceResourceKey(entry.originalResource as NoteResource) }
    catch { invalid('The historical original resource is invalid.', code) }
    revision(entry.revision, code)
    if (entry.baseRevision !== null) revision(entry.baseRevision, code)
    if (params.includeContent) {
      if (typeof entry.content !== 'string' || noteHistoryRevision(entry.content) !== entry.revision ||
          (entry.beforeContent === null ? entry.baseRevision !== null : typeof entry.beforeContent !== 'string' || noteHistoryRevision(entry.beforeContent) !== entry.baseRevision)) invalid('The historical content does not match its original revision.', code)
      if (entry.provenance !== undefined) {
        let provenance
        try { provenance = parseNoteProvenanceWrite(entry.provenance) } catch { invalid('Historical Note attribution is invalid.', code) }
        if (provenance.noteId !== entry.noteId || provenance.revision !== entry.revision || noteProvenanceResourceKey(provenance.resource) !== noteProvenanceResourceKey(entry.resource as NoteResource)) invalid('Historical attribution belongs to another original body.', code)
        for (const block of Object.values(provenance.blocks)) for (const authorship of [block.created, block.lastEdited]) {
          if (authorship !== null) actor(authorship.actor, code)
        }
      }
    }
    previous = Number(entry.sequence)
    events.set(entry.eventId, { batchId: entry.batchId, actor: entry.actor, at: Number(entry.at) })
  }
  if (params.eventId !== undefined && (r.entries.length > 1 || r.hasMore)) invalid('An exact history event query cannot become a partial timeline.', code)
  if (r.hasMore && !r.entries.length) invalid('A partial history window requires a continuation sequence.', code)
  const grouped = new Set<string>(), batches = new Set<string>()
  for (const raw of r.batches) {
    const batch = rpcRecord(raw, ['batchId', 'actor', 'from', 'to', 'eventIds'], code)
    text(batch.batchId, code); actor(batch.actor, code); count(batch.from, code); count(batch.to, code)
    if (batches.has(batch.batchId) || !Array.isArray(batch.eventIds) || !batch.eventIds.length) invalid('The original history batch is invalid.', code)
    batches.add(batch.batchId)
    const times: number[] = []
    for (const eventId of batch.eventIds) {
      text(eventId, code)
      const event = events.get(eventId)
      const sameActor = event && (event.actor === null ? batch.actor === null : batch.actor !== null &&
        (event.actor as NotebookActor).kind === (batch.actor as NotebookActor).kind && (event.actor as NotebookActor).id === (batch.actor as NotebookActor).id)
      if (!event || grouped.has(eventId) || event.batchId !== batch.batchId || !sameActor) invalid('History grouping lost or replaced an original edit event.', code)
      grouped.add(eventId); times.push(event.at)
    }
    if (batch.from !== Math.min(...times) || batch.to !== Math.max(...times)) invalid('The original history batch time range is invalid.', code)
  }
  if (grouped.size !== events.size) invalid('History grouping must retain every original edit event.', code)
  return p as FileHistoryResult
}
