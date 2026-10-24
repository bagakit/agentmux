import { replacesEditedBlock } from '@agentmux/client-ui/note/note-merge-identity'
import type { FileWriteContext } from '@agentmux/core/files'
import type { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { noteHistoryRevision, type NoteHistorySource, type NoteHistoryRecord } from '@agentmux/core/note-history'
import { readNoteMarkdownHeader } from '@agentmux/core/note-format'
import { noteProvenanceResourceKey, type NoteBlockProvenance } from '@agentmux/core/note-provenance'
import { mergeNoteTextInWorker } from '@agentmux/core/note-merge-node'
import { newNoteDocument, readNoteDocument, serializeNoteDocument, type NoteDocument } from '@agentmux/client-ui/note/note-document'
import type { WorkspaceRecord, WorkspaceFileReadResult, WorkspaceFileWriteInput, WorkspaceFileWriteResult, WorkspaceFileRestoreInput, WorkspaceFileUndoInput } from './content-types.js'

export type NoteHistoryWriteAction = { operation: 'edit' | 'restore' | 'undo'; noteId: string; source?: NoteHistorySource; fingerprint: string; historicalBlocks?: Record<string, NoteBlockProvenance>; draft?: true }
type ActionInput = WorkspaceFileRestoreInput | WorkspaceFileUndoInput
type Metadata = Pick<AgentMuxNotebookStore, 'readHistoryOperation' | 'readHistoryBatch' | 'readHistory' | 'readProvenance' | 'recordHistory' | 'runWithWriteLease'>
const resourceOf = (workspace: WorkspaceRecord, path: string) => ({ hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path })
/** Restorations use the original writer, original journal and original serialized storage lock. */
export class NoteHistoryActions {
  constructor(private readonly metadata: Metadata,
    private readonly read: (workspace: WorkspaceRecord, path: string) => Promise<WorkspaceFileReadResult>,
    private readonly save: (workspace: WorkspaceRecord, input: WorkspaceFileWriteInput, context: FileWriteContext | undefined, action: NoteHistoryWriteAction) => Promise<WorkspaceFileWriteResult>) {}
  async apply(workspace: WorkspaceRecord, input: ActionInput, context?: FileWriteContext): Promise<WorkspaceFileWriteResult> {
    const submitted = structuredClone(input), recorded = context ? structuredClone(context) : undefined
    const run = () => this.applyLocked(workspace, submitted, recorded)
    try { return await this.metadata.runWithWriteLease(run) }
    catch (error) { return { status: 'unknown', code: 'NOTE_HISTORY_ACTION_UNCONFIRMED', message: error instanceof Error ? error.message : String(error), noteHistory: { status: 'unconfirmed', eventId: submitted.operationId, reason: 'The original history action lease is unavailable; preserve this same intent.' } } }
  }
  private async applyLocked(workspace: WorkspaceRecord, input: ActionInput, context?: FileWriteContext): Promise<WorkspaceFileWriteResult> {
    const resource = resourceOf(workspace, input.path), operation = 'eventId' in input ? 'restore' : 'undo'
    const source: NoteHistorySource = 'eventId' in input ? { eventId: input.eventId } : { batchId: input.batchId, lastEventId: input.batchLastEventId }
    const fingerprint = noteHistoryRevision(JSON.stringify(['agentmux.note.history.action.v1', operation, noteProvenanceResourceKey(resource), input.noteId, input.expectedRevision, source, context?.actor ?? null]))
    const action: NoteHistoryWriteAction = { operation, source, fingerprint, noteId: input.noteId }
    const unknown = (code: string, message: string): WorkspaceFileWriteResult => ({ status: 'unknown', code, message,
      noteHistory: { status: 'unconfirmed', eventId: input.operationId, reason: message } })
    const original = (event: NoteHistoryRecord) => event.noteId === input.noteId && noteProvenanceResourceKey(event.resource) === noteProvenanceResourceKey(resource)
    try {
      const existing = await this.metadata.readHistoryOperation(input.operationId)
      if (existing) {
        if (!original(existing) || existing.operation !== operation || existing.requestFingerprint !== fingerprint) return { status: 'error', code: 'NOTE_OPERATION_CONFLICT', message: 'This operation ID belongs to another original history action, actor or resource.' }
        if (existing.status === 'committed') return { status: 'written', revision: existing.revision, content: existing.content,
          noteHistory: { status: 'committed', eventId: existing.eventId, batchId: existing.batchId, replayed: true },
          ...(existing.provenance ? { noteProvenance: { ...existing.provenance, status: 'recorded' } } : {}) }
        if (existing.status === 'not-applied') return { status: 'error', code: 'NOTE_OPERATION_NOT_APPLIED', message: 'This original history action was confirmed not applied.', noteHistory: { status: existing.status, eventId: existing.eventId, batchId: existing.batchId } }
        return unknown('NOTE_OPERATION_UNCONFIRMED', 'The original history action remains unconfirmed. Inspect that same event; it has not been replayed.')
      }
      let base: string | undefined, proposed: string, first: NoteHistoryRecord | undefined, creatorSource: { content: string; revision: string } | undefined
      if ('eventId' in input) {
        const selected = await this.metadata.readHistoryOperation(input.eventId)
        if (!selected || !original(selected) || selected.status !== 'committed' || selected.operation === 'delete') return { status: 'error', code: 'NOTE_HISTORY_SOURCE_INVALID', message: 'Select one committed event of this exact original Note and resource.' }
        proposed = selected.content
        creatorSource = { content: selected.content, revision: selected.revision }
        if (selected.provenance) action.historicalBlocks = selected.provenance.blocks
      } else {
        const entries = await this.metadata.readHistoryBatch({ noteId: input.noteId, resource, batchId: input.batchId }), tail = entries.at(-1)
        if (!tail || tail.eventId !== input.batchLastEventId) return { status: 'error', code: 'NOTE_HISTORY_BATCH_CHANGED', message: 'The complete original batch differs from the selected tail. Read its current membership before selecting a new undo.' }
        const author = entries[0]!.actor
        if (entries.some((entry, index) => entry.status !== 'committed' || entry.operation !== 'edit' || entry.actor?.kind !== author?.kind || entry.actor?.id !== author?.id || index > 0 && (entry.parentEventId !== entries[index - 1]!.eventId || entry.baseRevision !== entries[index - 1]!.revision))) return { status: 'error', code: 'NOTE_HISTORY_BATCH_INVALID', message: 'The full batch is not a confirmed continuous original edit activity.' }
        first = await this.metadata.readHistoryOperation(entries[0]!.eventId)
        const last = await this.metadata.readHistoryOperation(tail.eventId)
        if (!first || !last || first.operation === 'delete' || last.operation === 'delete' || !original(first) || !original(last) || first.status !== 'committed' || last.status !== 'committed') return unknown('NOTE_HISTORY_SOURCE_UNCONFIRMED', 'The original batch endpoints are unavailable.')
        if (first.beforeContent === null && first.parentEventId !== null) return unknown('NOTE_HISTORY_SOURCE_UNCONFIRMED', 'The missing prior body is not a confirmed original creation.')
        if (first.parentEventId !== null) {
          const prior = await this.metadata.readHistoryOperation(first.parentEventId)
          if (prior && original(prior) && prior.status === 'committed' && prior.revision === first.baseRevision && prior.provenance) action.historicalBlocks = prior.provenance.blocks
        }
        base = last.content; proposed = first.beforeContent ?? ''
        if (first.beforeContent !== null && first.baseRevision !== null) creatorSource = { content: first.beforeContent, revision: first.baseRevision }
      }
      const observed = await this.read(workspace, input.path)
      if (observed.status !== 'read') {
        if (observed.status === 'error') return unknown('NOTE_BASELINE_UNAVAILABLE', observed.message)
        return this.reject(workspace, input, action, undefined, proposed, context)
      }
      if (observed.document.path !== input.path) return unknown('NOTE_BASELINE_UNAVAILABLE', 'The original reader returned another file path.')
      const header = readNoteMarkdownHeader(observed.document.content)
      if (header.status !== 'valid' || header.noteId !== input.noteId) return this.reject(workspace, input, action, observed, proposed, context)
      if (observed.document.revision !== input.expectedRevision) return this.reject(workspace, input, action, observed, proposed, context)
      if (base !== undefined) {
        if (first!.beforeContent === null) {
          const initial = readNoteDocument(first!.content!)
          let blockId: string | undefined
          const visit = (node: NoteDocument['content']) => { if (!blockId && typeof node.attrs?.blockId === 'string') blockId = node.attrs.blockId; node.content?.forEach(visit) }
          if (initial.status === 'valid') visit(initial.note.content)
          proposed = serializeNoteDocument(newNoteDocument('', input.noteId, blockId ?? 'undo-empty-' + noteHistoryRevision(input.operationId).slice(7), header.title))
        }
        const before = readNoteDocument(base), current = readNoteDocument(observed.document.content), inverse = readNoteDocument(proposed)
        if (before.status !== 'valid' || current.status !== 'valid' || inverse.status !== 'valid') return this.reject(workspace, input, action, observed, proposed, context, base, 'invalid-structure')
        if (before.note.noteId !== input.noteId || inverse.note.noteId !== input.noteId) return { status: 'error', code: 'NOTE_HISTORY_SOURCE_INVALID', message: 'The selected inverse endpoints belong to another original Note.' }
        if (replacesEditedBlock(before.note, current.note, inverse.note)) return this.reject(workspace, input, action, observed, proposed, context, base, 'identity')
        const merged = await mergeNoteTextInWorker(base, observed.document.content, proposed)
        if (merged.status === 'conflict') return this.reject(workspace, input, action, observed, proposed, context, base)
        const mergedNote = readNoteDocument(merged.content)
        if (mergedNote.status !== 'valid' || mergedNote.note.noteId !== input.noteId) return this.reject(workspace, input, action, observed, proposed, context, base, 'invalid-structure')
        proposed = merged.content
      }
      const target = readNoteMarkdownHeader(proposed)
      if (target.status !== 'valid' || target.noteId !== input.noteId) return { status: 'error', code: 'NOTE_HISTORY_SOURCE_INVALID', message: 'The selected historical bytes do not preserve this original Note identity.' }
      if (creatorSource) {
        // Parent events may be unknown after a rejected operation. Stable creators remain
        // independent trusted facts at the exact original source revision.
        const original = readNoteDocument(creatorSource.content), blockIds: string[] = []
        const collect = (node: NoteDocument['content']) => { if (typeof node.attrs?.blockId === 'string') blockIds.push(node.attrs.blockId); node.content?.forEach(collect) }
        if (original.status === 'valid' && original.note.noteId === input.noteId) {
          collect(original.note.content)
          try {
            const provenance = await this.metadata.readProvenance({ noteId: input.noteId, resource, revision: creatorSource.revision, blockIds })
            if (provenance.noteId === input.noteId && provenance.revision === creatorSource.revision && noteProvenanceResourceKey(provenance.resource) === noteProvenanceResourceKey(resource)) {
              action.historicalBlocks = { ...action.historicalBlocks }
              for (const id of blockIds) if (!action.historicalBlocks[id]?.created && provenance.blocks[id]?.created)
                action.historicalBlocks[id] = { created: provenance.blocks[id]!.created, lastEdited: null }
            }
          } catch { /* Missing attribution does not take away a confirmed historical body action. */ }
        }
      }
      return this.save(workspace, { path: input.path, expectedRevision: input.expectedRevision, baseContent: observed.document.content, content: proposed, operationId: input.operationId }, context, action)
    } catch (error) { return unknown('NOTE_HISTORY_ACTION_UNCONFIRMED', error instanceof Error ? error.message : String(error)) }
  }
  private async reject(workspace: WorkspaceRecord, input: ActionInput, action: NoteHistoryWriteAction,
    current: Extract<WorkspaceFileReadResult, { status: 'read' }> | undefined, proposed: string, context?: FileWriteContext, base?: string, reason: 'overlap' | 'identity' | 'invalid-structure' = 'overlap'): Promise<WorkspaceFileWriteResult> {
    const result: WorkspaceFileWriteResult = { status: 'conflict', observedRevision: current?.document.revision ?? null,
      ...(base !== undefined && current ? { noteConflict: { reason, baseContent: base, currentContent: current.document.content, proposedContent: proposed } } : {}) }
    try {
      const resource = resourceOf(workspace, input.path)
      await this.metadata.recordHistory({ eventId: input.operationId, batchId: input.operationId, sequence: 0, noteId: input.noteId, resource, originalResource: resource,
        operation: action.operation, ...(action.source ? { source: action.source } : {}), requestFingerprint: action.fingerprint, actor: context?.actor ?? null, status: 'not-applied', at: Date.now(), parentEventId: null,
        baseRevision: current?.document.revision ?? null, beforeContent: current?.document.content ?? null, revision: noteHistoryRevision(proposed), content: proposed })
      return { ...result, noteHistory: { status: 'not-applied', eventId: input.operationId, batchId: input.operationId } }
    } catch (error) { return { ...result, noteHistory: { status: 'unconfirmed', eventId: input.operationId, reason: error instanceof Error ? error.message : String(error) } } }
  }
}
