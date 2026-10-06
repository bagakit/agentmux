import type { FileWriteContext } from '@agentmux/core'
import { NOTE_FILE_EXTENSION, NOTE_BLOCK_TYPES, readNoteDocument, serializeNoteDocument, type NoteDocument } from '../shared/note-document.js'
import { attributeNoteBlocks } from '@agentmux/client-ui/note/note-provenance'
import { hydrateNoteProvenance } from '@agentmux/client-ui/note/note-metadata'
import { noteContentSchema } from '../shared/note-content-schema.js'
import type { WorkspaceFileReadResult, WorkspaceFileWriteInput, WorkspaceFileWriteResult, WorkspaceRecord } from '../shared/contracts.js'
import type { WorkspaceFiles } from './workspace-files.js'
import { randomUUID } from 'node:crypto'
import { prepareNoteWikiLinks, bindNoteWikiLink } from '@agentmux/client-ui/note/note-wikilinks'
import type { NotebookState } from '@agentmux/core/notebook-catalog'
import type { NotebookObservationOwner } from './notebook-observation-owner.js'
import type { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import type { NoteProvenanceSnapshot, NoteBlockProvenance } from '@agentmux/core/note-provenance'

const resourceOf = (workspace: WorkspaceRecord, path: string) => ({ hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path })
function blockMetadata(note: NoteDocument): Record<string, NoteBlockProvenance> {
  const blocks: Record<string, NoteBlockProvenance> = Object.create(null)
  function visit(node: NoteDocument['content']) {
    if (typeof node.attrs?.blockId === 'string') blocks[node.attrs.blockId] = node.attrs.provenance ?? { created: null, lastEdited: null }
    node.content?.forEach(visit)
  }
  visit(note.content); return blocks
}

/** The original Files writer, enriched with Note metadata; neither a content store nor a new save lane. */
export class NoteFileWriter {
  constructor(private readonly files: Pick<WorkspaceFiles, 'read' | 'write'>,
    private readonly links?: { state(): Promise<NotebookState>; owner: NotebookObservationOwner },
    private readonly metadata?: Pick<AgentMuxNotebookStore, 'readProvenance' | 'recordProvenance'>) {}
  /** Same original file read, enriched independently; metadata failure never removes readable bytes. */
  async read(workspace: WorkspaceRecord, path: string, options?: Parameters<WorkspaceFiles['read']>[2]): Promise<WorkspaceFileReadResult> {
    const result = await this.files.read(workspace, path, options)
    if (result.status !== 'read' || !path.endsWith(NOTE_FILE_EXTENSION)) return result
    const parsed = readNoteDocument(result.document.content)
    if (parsed.status !== 'valid') return result
    const query = { noteId: parsed.note.noteId, resource: resourceOf(workspace, path), revision: result.document.revision, blockIds: Object.keys(blockMetadata(parsed.note)) }
    let noteProvenance: NoteProvenanceSnapshot
    try {
      if (!this.metadata) throw new Error('The original Note metadata owner is unavailable.')
      noteProvenance = await this.metadata.readProvenance(query)
    } catch (error) {
      const { blockIds, ...original } = query
      noteProvenance = { ...original, blocks: Object.fromEntries(blockIds.map(id => [id, { created: null, lastEdited: null }])), status: 'unconfirmed', reason: error instanceof Error ? error.message : String(error) }
    }
    options?.signal?.throwIfAborted()
    return { ...result, document: { ...result.document, noteProvenance } }
  }
  async write(workspace: WorkspaceRecord, input: WorkspaceFileWriteInput, context?: FileWriteContext): Promise<WorkspaceFileWriteResult> {
    if (!input.path.endsWith(NOTE_FILE_EXTENSION)) return this.files.write(workspace, input)
    const candidate = readNoteDocument(input.content)
    let content = input.content, reason: string | undefined
    let attributed: NoteDocument | undefined
    if (candidate.status !== 'valid') reason = 'This source is not a valid Note. Its file bytes were saved without confirmed block attribution.'
    else {
      let before = null
      if (input.expectedRevision !== null) {
        try {
          const observed = await this.read(workspace, input.path)
          if (observed.status === 'read' && observed.document.revision === input.expectedRevision) {
            const parsed = readNoteDocument(observed.document.content)
            if (parsed.status === 'valid') before = hydrateNoteProvenance(parsed.note, observed.document.noteProvenance, observed.document.revision)
            else reason = 'The original block authorship baseline is unconfirmed.'
          } else reason = 'The original file revision could not be observed for block attribution.'
        } catch { reason = 'The original file could not be read for block attribution.' }
      }
      const confirmedBaseline = input.expectedRevision === null || before?.noteId === candidate.note.noteId
      if (before && before.noteId !== candidate.note.noteId) reason = 'The original Note identity changed; block attribution is unconfirmed.'
      // Compare the original schema's canonical nodes so editor-added default attributes are not edits.
      const normalized = (note: typeof candidate.note) => ({ ...note, content: noteContentSchema.nodeFromJSON(note.content).toJSON() })
      const identified = normalized(candidate.note)
      const identify = (node: typeof identified.content) => {
        if (NOTE_BLOCK_TYPES.some(type => type === node.type) && node.attrs?.blockId == null) node.attrs = { ...node.attrs, blockId: randomUUID() }
        node.content?.forEach(identify)
      }
      identify(identified.content)
      const prepared = prepareNoteWikiLinks(identified, randomUUID)
      let linked = prepared.note
      if (prepared.pending.length && this.links) {
        try {
          const targets = await this.links.owner.resolvePending(await this.links.state(), prepared.pending, {
            resource: { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path: input.path },
            document: { path: input.path, content: serializeNoteDocument(prepared.note), revision: input.expectedRevision ?? 'pending-create' }
          })
          for (const link of prepared.pending) { const target = targets.get(link.referenceId); if (target) linked = bindNoteWikiLink(linked, { referenceId: link.referenceId, text: link.text, target }) }
        } catch { /* Name observation cannot take away saving; structured unbound queries are retained. */ }
      }
      const next = attributeNoteBlocks(before ? normalized(before) : null, linked, confirmedBaseline ? context?.actor : undefined, Date.now())
      attributed = next
      content = serializeNoteDocument(next)
      if (!context?.actor) reason = 'The original write actor is unknown; changed block attribution is unconfirmed.'
    }
    const result = await this.files.write(workspace, { ...input, content })
    let noteProvenance: NoteProvenanceSnapshot | undefined
    if (result.status === 'written' && attributed) {
      const record = { noteId: attributed.noteId, resource: resourceOf(workspace, input.path), revision: result.revision, blocks: blockMetadata(attributed) }
      try {
        if (!this.metadata) throw new Error('The original Note metadata owner is unavailable.')
        noteProvenance = await this.metadata.recordProvenance(record)
      } catch (error) {
        reason = 'The original body was saved; its block attribution is unconfirmed. Read this exact Note and revision to reconcile. ' + (error instanceof Error ? error.message : String(error))
        noteProvenance = { ...record, blocks: Object.fromEntries(Object.entries(record.blocks).map(([id, block]) => [id, { created: block.created, lastEdited: null }])), status: 'unconfirmed', reason }
      }
    }
    return result.status === 'written' ? { ...result, ...(content !== input.content ? { content } : {}),
      ...(noteProvenance ? { noteProvenance } : {}), noteAttribution: reason ? { status: 'unconfirmed', reason } : { status: 'recorded' } } : result
  }
}
