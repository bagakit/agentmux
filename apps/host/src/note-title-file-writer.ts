import { readNoteMarkdownHeader, rewriteNoteMarkdownTitle } from '@agentmux/core/note-format'
import { noteHistoryRevision, type NoteHistoryWriteRecord } from '@agentmux/core/note-history'
import { noteProvenanceResourceKey } from '@agentmux/core/note-provenance'
import { noteTitleEventId, noteTitleIntentFingerprint, parseNoteTitleIntent,
  type NoteTitleIntent, type NoteTitleOperation, type NoteFileTitle } from '@agentmux/core/note-title'
import type { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import type { NoteResource } from '@agentmux/core/notebook-catalog'
import type { WorkspaceFiles } from './content-types.js'
import type { WorkspaceRecord } from './content-types.js'
import { readNoteDocument } from '@agentmux/client-ui/note/note-document'

/** Header-only writes borrow the original Files CAS and immutable Note journal. */
export class NoteTitleFileWriter {
  constructor(private readonly files: Pick<WorkspaceFiles, 'read' | 'write'>,
    private readonly history: Pick<AgentMuxNotebookStore, 'readHistoryOperation' | 'readHistory' | 'recordHistory' | 'readProvenance' | 'runWithWriteLease'>) {}
  async inspect(operationId: string): Promise<NoteTitleOperation> {
    try {
      const original = await this.history.readHistoryOperation(noteTitleEventId(operationId))
      if (!original) return { status: 'absent', operationId }
      if (original.operation !== 'edit') return { status: 'different-operation', operationId, reason: 'The original event is not a title edit.' }
      const header = readNoteMarkdownHeader(original.content)
      if (original.operation !== 'edit' || !original.actor || header.status !== 'valid' || header.title === undefined || header.noteId !== original.noteId) return { status: 'different-operation', operationId, reason: 'The original event does not confirm this title intent.' }
      const intent: NoteTitleIntent = { operationId, noteId: original.noteId, resource: original.originalResource, title: header.title, actor: original.actor }
      if (original.requestFingerprint !== noteTitleIntentFingerprint(intent)) return { status: 'different-operation', operationId, reason: 'This original event belongs to different file input.' }
      return { status: 'recorded', intent, resource: original.resource, revision: original.revision,
        history: { status: original.status, eventId: original.eventId, batchId: original.batchId } }
    } catch (error) { return { status: 'unavailable', operationId, reason: error instanceof Error ? error.message : String(error) } }
  }
  async current(workspace: WorkspaceRecord, noteId: string, resource: NoteResource): Promise<NoteFileTitle> {
    const unknown = (status: 'unknown' | 'missing' | 'invalid' | 'identity-mismatch', reason: string): NoteFileTitle => ({ status, noteId, resource, reason })
    if (!this.matches(workspace, resource)) return unknown('identity-mismatch', 'The current file mapping differs from this exact original resource.')
    try {
      const read = await this.files.read(workspace, resource.path)
      if (read.status !== 'read') return unknown(read.status === 'deleted' ? 'missing' : read.status === 'error' ? 'unknown' : 'invalid', read.status === 'error' ? read.message : 'The original Note is not a readable file.')
      if (read.document.path !== resource.path) return unknown('identity-mismatch', 'The original reader returned another file path.')
      const header = readNoteMarkdownHeader(read.document.content)
      if (header.status !== 'valid') return unknown('invalid', header.message)
      if (header.noteId !== noteId) return unknown('identity-mismatch', 'The file carries another original Note identity.')
      if (header.title === undefined) return unknown('unknown', 'The original file has no self-contained title yet. Save its known title through the original owner.')
      return { status: 'read', noteId, resource, title: header.title, revision: read.document.revision }
    } catch (error) { return unknown('unknown', error instanceof Error ? error.message : String(error)) }
  }
  async write(workspace: WorkspaceRecord, input: NoteTitleIntent): Promise<NoteTitleOperation> {
    const submitted = structuredClone(parseNoteTitleIntent(input)), run = () => this.writeLocked(workspace, submitted)
    return this.history.runWithWriteLease(run)
  }
  private async writeLocked(workspace: WorkspaceRecord, input: NoteTitleIntent): Promise<NoteTitleOperation> {
    const intent = structuredClone(parseNoteTitleIntent(input)), original = await this.inspect(intent.operationId)
    if (original.status !== 'absent') {
      if (original.status === 'recorded') {
        const sameResource = noteProvenanceResourceKey(intent.resource) === noteProvenanceResourceKey(original.resource)
        const requested = sameResource ? { ...intent, resource: original.intent.resource } : intent
        if (noteTitleIntentFingerprint(requested) !== noteTitleIntentFingerprint(original.intent)) return { status: 'different-operation', operationId: intent.operationId, reason: 'The original title operation belongs to another intent or actor.' }
      }
      return original
    }
    if (!this.matches(workspace, intent.resource)) return { status: 'unavailable', operationId: intent.operationId, reason: 'The original file mapping changed. Its body and title are retained.' }
    let event: NoteHistoryWriteRecord | undefined
    try {
      const read = await this.files.read(workspace, intent.resource.path)
      if (read.status !== 'read') throw new Error(read.status === 'error' ? read.message : 'The current original Note file is unavailable.')
      if (read.document.path !== intent.resource.path) throw new Error('The original reader returned another file path.')
      const header = readNoteMarkdownHeader(read.document.content)
      if (header.status !== 'valid' || header.noteId !== intent.noteId) throw new Error('The original file identity cannot be confirmed for this title change.')
      const content = rewriteNoteMarkdownTitle(read.document.content, intent.title)
      const previous = (await this.history.readHistory({ noteId: intent.noteId, resource: intent.resource, limit: 1 })).entries[0]
      const eventId = noteTitleEventId(intent.operationId)
      // Only read the shared schema for existing stable IDs. Header changes never
      // canonicalize a body, mint identities, or attribute its blocks to the renamer.
      let provenance: NoteHistoryWriteRecord['provenance']
      const parsed = readNoteDocument(read.document.content)
      if (parsed.status === 'valid') {
        const blockIds: string[] = []
        const visit = (node: typeof parsed.note.content) => { if (typeof node.attrs?.blockId === 'string') blockIds.push(node.attrs.blockId); node.content?.forEach(visit) }
        visit(parsed.note.content)
        try {
          const before = await this.history.readProvenance({ noteId: intent.noteId, resource: intent.resource, revision: read.document.revision, blockIds })
          provenance = { noteId: intent.noteId, resource: intent.resource, revision: noteHistoryRevision(content), blocks: before.blocks }
        } catch { /* A metadata read failure cannot invent block authors; the original read reports them unknown. */ }
      }
      event = await this.history.recordHistory({ eventId, batchId: eventId, sequence: 0, noteId: intent.noteId, resource: intent.resource,
        originalResource: intent.resource, status: 'prepared', operation: 'edit', actor: intent.actor, at: Date.now(),
        requestFingerprint: noteTitleIntentFingerprint(intent), parentEventId: previous?.status === 'committed' && previous.revision === read.document.revision ? previous.eventId : null,
        baseRevision: read.document.revision, beforeContent: read.document.content, revision: noteHistoryRevision(content), content, ...(provenance ? { provenance } : {}) }) as NoteHistoryWriteRecord
      let result: Awaited<ReturnType<WorkspaceFiles['write']>>
      try { result = await this.files.write(workspace, { path: intent.resource.path, expectedRevision: read.document.revision, content }) }
      catch (error) { result = { status: 'unknown', code: 'FILE_WRITE_UNCONFIRMED', message: error instanceof Error ? error.message : String(error) } }
      const status = result.status === 'written' && result.revision === event.revision ? 'committed' : result.status === 'conflict' || result.status === 'error' ? 'not-applied' : 'unconfirmed'
      event = await this.history.recordHistory({ ...event, status }) as NoteHistoryWriteRecord
      return { status: 'recorded', intent, resource: event.resource, revision: event.revision, history: { status, eventId: event.eventId, batchId: event.batchId } }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return event ? { status: 'recorded', intent, resource: event.resource, revision: event.revision,
        history: { status: 'unconfirmed', eventId: event.eventId, batchId: event.batchId, reason } } : { status: 'unavailable', operationId: intent.operationId, reason }
    }
  }
  private matches(workspace: WorkspaceRecord, resource: NoteResource): boolean {
    return noteProvenanceResourceKey(resource) === noteProvenanceResourceKey({ hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path: resource.path })
  }
}
