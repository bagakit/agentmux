import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { FileWriteContext } from '@agentmux/core/files'
import { noteHistoryRevision, type NoteFileWitness, type NoteHistoryDeleteRecord } from '@agentmux/core/note-history'
import type { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { noteProvenanceResourceKey } from '@agentmux/core/note-provenance'
import type { WorkspaceRecord } from './content-types.js'
import type { WorkspaceFiles } from './content-types.js'

export type SharedFileDeleteInput = { path: string; noteId: string; expectedRevision: string; witness: NoteFileWitness; operationId: string; creationEventId: string; undoFingerprint: string }
export type SharedFileDeleteOutcome = { status: 'deleted' | 'conflict' | 'unknown' | 'error'; code?: string; message?: string; retainedPath?: string; noteHistory?: import('@agentmux/core/note-history').NoteHistoryReceipt }
/** Deletion uses the existing per-file history. Absence is never an earlier receipt. */
export class NoteSharedFileDeleteOwner {
  constructor(private readonly files: Pick<WorkspaceFiles, 'read' | 'deleteExact'>,
    private readonly history: Pick<AgentMuxNotebookStore, 'readHistoryOperation' | 'readHistory' | 'recordHistory' | 'runWithWriteLease'>) {}
  async delete(workspace: WorkspaceRecord, input: SharedFileDeleteInput, context?: FileWriteContext): Promise<SharedFileDeleteOutcome> {
    return this.history.runWithWriteLease(async () => {
      const resource = { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path: input.path }
      const fingerprint = noteHistoryRevision(JSON.stringify(['agentmux.note.shared-delete.v1', resource, input, context?.actor ?? null]))
      let event: NoteHistoryDeleteRecord | undefined
      const unknown = (message: string): SharedFileDeleteOutcome => ({ status: 'unknown', code: 'NOTE_DELETE_UNCONFIRMED', message,
        ...(event?.retainedPath ? { retainedPath: event.retainedPath } : {}), noteHistory: { status: 'unconfirmed', eventId: input.operationId, ...(event ? { batchId: event.batchId } : {}), reason: message } })
      try {
        const original = await this.history.readHistoryOperation(input.operationId)
        if (original) {
          if (original.operation !== 'delete' || original.requestFingerprint !== fingerprint || original.noteId !== input.noteId || noteProvenanceResourceKey(original.resource) !== noteProvenanceResourceKey(resource)) return { status: 'error', code: 'NOTE_OPERATION_CONFLICT', message: 'This deletion operation belongs to another original file or intent.' }
          event = original
          if (original.status === 'committed') return { status: 'deleted', noteHistory: { status: 'committed', eventId: original.eventId, batchId: original.batchId, replayed: true } }
          if (original.status === 'not-applied') return { status: 'conflict', code: 'NOTE_OPERATION_NOT_APPLIED', message: 'The original deletion was not applied.', noteHistory: { status: 'not-applied', eventId: original.eventId, batchId: original.batchId } }
          return unknown('This same deletion is prepared or unconfirmed. Inspect its retained path and original history; it has not been replayed.')
        }
        const observed = await this.files.read(workspace, input.path)
        if (observed.status !== 'read' || observed.document.revision !== input.expectedRevision) return { status: 'conflict', code: 'NOTE_DELETE_CHANGED', message: 'The exact original shared Markdown changed or is absent; it was not deleted.' }
        const previous = (await this.history.readHistory({ noteId: input.noteId, resource, limit: 1 })).entries[0]
        const prepared = await this.history.recordHistory({ eventId: input.operationId, sequence: 0, batchId: input.operationId,
          noteId: input.noteId, resource, originalResource: resource, status: 'prepared', at: Date.now(), actor: context?.actor ?? null,
          retainedPath: posix.join(posix.dirname(input.path), '.agentmux-reclaim-' + createHash('sha256').update(JSON.stringify([`${workspace.hostId}\0${workspace.path}\0${input.path}`, input.operationId])).digest('hex') + '.note.md'),
          operation: 'delete', source: { eventId: input.creationEventId }, requestFingerprint: fingerprint,
          parentEventId: previous?.status === 'committed' && previous.revision === input.expectedRevision ? previous.eventId : null,
          baseRevision: input.expectedRevision, beforeContent: observed.document.content, revision: null, content: null, fileWitness: input.witness })
        if (prepared.operation !== 'delete') return unknown('The original deletion preparation returned another event kind.')
        event = prepared
        const result = await this.files.deleteExact(workspace, { path: input.path, expectedRevision: input.expectedRevision, witness: input.witness, operationId: input.operationId })
        const status = result.status === 'deleted' ? 'committed' : result.status === 'conflict' || result.status === 'error' ? 'not-applied' : 'unconfirmed'
        const saved = await this.history.recordHistory({ ...event, status, ...('retainedPath' in result && result.retainedPath ? { retainedPath: result.retainedPath } : {}) })
        return { ...result, noteHistory: { status: saved.status, eventId: saved.eventId, batchId: saved.batchId } }
      } catch (error) { return unknown(error instanceof Error ? error.message : String(error)) }
    })
  }
}
