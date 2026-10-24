import { mintObjectId } from '@agentmux/core/object-id'
import { replacesEditedBlock } from '@agentmux/client-ui/note/note-merge-identity'
import type { FileWriteContext } from '@agentmux/core'
import { NOTE_FILE_EXTENSION, NOTE_BLOCK_TYPES, readNoteDocument, serializeNoteDocument, type NoteDocument } from '@agentmux/client-ui/note/note-document'
import { attributeNoteBlocks } from '@agentmux/client-ui/note/note-provenance'
import { hydrateNoteProvenance } from '@agentmux/client-ui/note/note-metadata'
import { noteContentSchema } from '@agentmux/client-ui/note/note-content-schema'
import type { WorkspaceFileReadResult, WorkspaceFileWriteInput, WorkspaceFileWriteResult, WorkspaceFileRestoreInput, WorkspaceFileUndoInput, WorkspaceRecord } from './content-types.js'
import type { WorkspaceFiles } from './content-types.js'

import { prepareNoteWikiLinks, bindNoteWikiLink } from '@agentmux/client-ui/note/note-wikilinks'
import type { NotebookState } from '@agentmux/core/notebook-catalog'
import type { NotebookObservationOwner } from './notebook-observation-owner.js'
import type { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import type { NoteProvenanceSnapshot, NoteBlockProvenance } from '@agentmux/core/note-provenance'
import { noteProvenanceResourceKey } from '@agentmux/core/note-provenance'
import { NOTE_HISTORY_BATCH_WINDOW_MS, noteHistoryRevision, type NoteHistoryRecord, type NoteHistoryReceipt, type NoteHistoryQuery } from '@agentmux/core/note-history'
import { readNoteMarkdownHeader } from '@agentmux/core/note-format'
import { NoteHistoryActions, type NoteHistoryWriteAction } from './note-history-actions.js'
import type { NoteTitleProjection } from '@agentmux/core/note-title'
import { mergeNoteTextInWorker } from '@agentmux/core/note-merge-node'

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
    private readonly metadata?: Pick<AgentMuxNotebookStore, 'readProvenance' | 'recordProvenance'> & Partial<Pick<AgentMuxNotebookStore, 'readHistory' | 'recordHistory' | 'readHistoryOperation' | 'read' | 'refreshFileTitle' | 'readHistoryBatch' | 'runWithWriteLease'>>) {}
  async history(workspace: WorkspaceRecord, input: Omit<NoteHistoryQuery, 'resource'> & { path: string }) {
    if (!this.metadata?.readHistory) throw new Error('The original Note history owner is unavailable. Original files remain available.')
    const { path, ...query } = input
    return this.metadata.readHistory({ ...query, resource: resourceOf(workspace, path) })
  }
  /** A rejected enhanced operation is still the same operation after the surrounding file changes. */
  private async rejectedSubmission(workspace: WorkspaceRecord, input: WorkspaceFileWriteInput, noteId: string, requestFingerprint: string,
    current: Extract<WorkspaceFileReadResult, { status: 'read' }> | undefined, reason: 'overlap' | 'identity' | 'invalid-structure', context?: FileWriteContext, action?: NoteHistoryWriteAction): Promise<WorkspaceFileWriteResult> {
    const eventId = input.operationId!, resource = resourceOf(workspace, input.path)
    const result: WorkspaceFileWriteResult = { status: 'conflict', observedRevision: current?.document.revision ?? null,
      ...(!action && current ? { noteConflict: { reason, baseContent: input.baseContent!, currentContent: current.document.content, proposedContent: input.content } } : {}) }
    try {
      if (!this.metadata?.recordHistory || !this.metadata.readHistory) throw new Error('The original operation journal is unavailable.')
      const previous = (await this.metadata.readHistory({ noteId, resource, limit: 1 })).entries[0]
      await this.metadata.recordHistory({ eventId, batchId: eventId, sequence: 0, noteId, resource, originalResource: resource, actor: context?.actor ?? null,
        parentEventId: previous?.status === 'committed' && previous.revision === current?.document.revision ? previous.eventId : null,
        at: Date.now(), operation: action?.operation ?? 'edit', ...(action?.source ? { source: action.source } : {}), requestFingerprint, status: 'not-applied', beforeContent: current?.document.content ?? null,
        baseRevision: current?.document.revision ?? null, content: input.content, revision: noteHistoryRevision(input.content) })
      return { ...result, noteHistory: { status: 'not-applied', eventId, batchId: eventId } }
    } catch (error) { return { ...result, noteHistory: { status: 'unconfirmed', eventId, reason: error instanceof Error ? error.message : String(error) } } }
  }
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
  async restore(workspace: WorkspaceRecord, input: WorkspaceFileRestoreInput, context?: FileWriteContext) { return this.historyAction(workspace, input, context) }
  async undo(workspace: WorkspaceRecord, input: WorkspaceFileUndoInput, context?: FileWriteContext) { return this.historyAction(workspace, input, context) }
  private async historyAction(workspace: WorkspaceRecord, input: WorkspaceFileRestoreInput | WorkspaceFileUndoInput, context?: FileWriteContext): Promise<WorkspaceFileWriteResult> {
    const metadata = this.metadata
    if (!metadata?.readHistoryOperation || !metadata.readHistoryBatch || !metadata.readHistory || !metadata.recordHistory || !metadata.runWithWriteLease) return { status: 'unknown', code: 'NOTE_HISTORY_ACTION_UNAVAILABLE', message: 'The original durable Note history owner is unavailable. Ordinary Files and Agents remain available.', noteHistory: { status: 'unconfirmed', eventId: input.operationId, reason: 'Keep this original history action identity for inspection.' } }
    return new NoteHistoryActions({ runWithWriteLease: metadata.runWithWriteLease.bind(metadata), readHistoryOperation: metadata.readHistoryOperation.bind(metadata), readHistoryBatch: metadata.readHistoryBatch.bind(metadata), readHistory: metadata.readHistory.bind(metadata), readProvenance: metadata.readProvenance.bind(metadata), recordHistory: metadata.recordHistory.bind(metadata) },
      this.read.bind(this), (owner, request, author, action) => this.writeOriginal(owner, request, author, action)).apply(workspace, input, context)
  }
  /** Trusted extraction only: move original authorship, never accept attribution from request YAML. */
  async createShared(workspace: WorkspaceRecord, input: WorkspaceFileWriteInput, context: FileWriteContext | undefined,
    source: { workspace: WorkspaceRecord; input: WorkspaceFileWriteInput }): Promise<WorkspaceFileWriteResult> {
    const observed = await this.read(source.workspace, source.input.path)
    if (observed.status !== 'read') return { status: 'unknown', code: 'NOTE_SHARE_SOURCE_UNCONFIRMED', message: 'The original source and trusted authorship could not be read. No shared file was created.' }
    if (observed.document.revision !== source.input.expectedRevision) return { status: 'error', code: 'NOTE_SHARE_SOURCE_CHANGED', message: 'The exact original source revision changed before extraction. No shared file was created; refresh the source draft before deciding another save.' }
    const baseline = readNoteDocument(observed.document.content), proposed = readNoteDocument(source.input.content)
    if (baseline.status !== 'valid' || proposed.status !== 'valid' || baseline.note.noteId !== proposed.note.noteId) return { status: 'error', code: 'NOTE_SHARE_SOURCE_INVALID', message: 'The exact source Note identity and structure are required for extraction.' }
    const normalize = (note: NoteDocument): NoteDocument => ({ ...note, content: noteContentSchema.nodeFromJSON(note.content).toJSON() })
    const before = hydrateNoteProvenance(normalize(baseline.note), observed.document.noteProvenance, observed.document.revision)
    const attributed = attributeNoteBlocks(before, normalize(proposed.note), context?.actor, Date.now())
    return this.writeOriginal(workspace, input, context, undefined, blockMetadata(attributed))
  }
  /** Only the original shared owner may supply a verified inverse and trusted transferred creators. */
  async writeSharedUndo(workspace: WorkspaceRecord, input: WorkspaceFileWriteInput, context: FileWriteContext | undefined, action: NoteHistoryWriteAction, transferredBlocks?: Record<string, NoteBlockProvenance>): Promise<WorkspaceFileWriteResult> { return this.writeOriginal(workspace, input, context, action, transferredBlocks) }
  async write(workspace: WorkspaceRecord, input: WorkspaceFileWriteInput, context?: FileWriteContext): Promise<WorkspaceFileWriteResult> { return this.writeOriginal(workspace, input, context) }
  private async writeOrdinaryFile(workspace: WorkspaceRecord, input: WorkspaceFileWriteInput): Promise<WorkspaceFileWriteResult> { const result = await this.files.write(workspace, input); if (result.status !== 'written') return result; const { fileWitness: _internal, ...receipt } = result; return receipt }
  private async writeOriginal(workspace: WorkspaceRecord, input: WorkspaceFileWriteInput, context?: FileWriteContext, action?: NoteHistoryWriteAction, transferredBlocks?: Record<string, NoteBlockProvenance>): Promise<WorkspaceFileWriteResult> {
    const submitted = { ...input }, enhanced = input.baseContent !== undefined || input.operationId !== undefined
    // Only the shared-file owner submits an operation-tagged exclusive creation.
    const creating = input.expectedRevision === null && input.baseContent === undefined && typeof input.operationId === 'string'
    input = submitted
    if (!input.path.endsWith(NOTE_FILE_EXTENSION)) return enhanced
      ? { status: 'error', code: 'NOTE_SUBMISSION_UNSUPPORTED', message: 'Baseline-aware submissions apply to original Note Markdown files. Ordinary file revision saves remain available.' }
      : this.writeOrdinaryFile(workspace, input)
    let candidate = readNoteDocument(input.content)
    let requestFingerprint: string | undefined, submissionBaseline: NoteDocument | undefined, submissionNoteId: string | undefined
    if (enhanced) {
      if (typeof input.operationId !== 'string' || !input.operationId || /[\0\r\n]/u.test(input.operationId) || (!creating && (typeof input.baseContent !== 'string' || input.expectedRevision === null || noteHistoryRevision(input.baseContent) !== input.expectedRevision))) {
        return { status: 'error', code: 'NOTE_SUBMISSION_INVALID', message: 'Keep the original operation ID and exact baseline bytes matching expectedRevision. The original file and draft are unchanged.' }
      }
      const base = creating ? candidate : readNoteDocument(input.baseContent!)
      const header = action ? readNoteMarkdownHeader(input.baseContent!) : undefined
      if (action ? header?.status !== 'valid' || header.noteId !== action.noteId : base.status !== 'valid') return { status: 'error', code: 'NOTE_SUBMISSION_INVALID', message: 'The original Note baseline is not valid. Preserve its bytes and inspect the same source before another submission.' }
      submissionBaseline = base.status === 'valid' ? base.note : undefined
      submissionNoteId = action?.noteId ?? submissionBaseline!.noteId
      requestFingerprint = action?.fingerprint ?? noteHistoryRevision(JSON.stringify([resourceOf(workspace, input.path), submissionNoteId, input.expectedRevision, input.content, context?.actor ?? null]))
      try {
        if (!this.metadata?.readHistoryOperation || !this.metadata.recordHistory) throw new Error('The original durable operation owner is unavailable. Ordinary revision saves remain available.')
        const original = await this.metadata.readHistoryOperation(input.operationId)
        if (original) {
          if (original.requestFingerprint !== requestFingerprint || original.noteId !== submissionNoteId || original.operation !== (action?.operation ?? 'edit') ||
              noteProvenanceResourceKey(original.resource) !== noteProvenanceResourceKey(resourceOf(workspace, input.path))) return { status: 'error', code: 'NOTE_OPERATION_CONFLICT', message: 'This operation ID belongs to another original request, actor or resource. Its body and event are retained.' }
          if (original.status === 'committed') return { status: 'written', revision: original.revision, content: original.content,
            noteHistory: { status: 'committed', eventId: original.eventId, batchId: original.batchId, replayed: true },
            ...(original.provenance ? { noteProvenance: { ...original.provenance, status: 'recorded' as const } } : {}) }
          if (original.status === 'not-applied') return { status: 'error', code: 'NOTE_OPERATION_NOT_APPLIED', message: 'The original operation was confirmed not applied. Inspect current content before deciding a new edit.', noteHistory: { status: original.status, eventId: original.eventId, batchId: original.batchId } }
          return { status: 'unknown', code: 'NOTE_OPERATION_UNCONFIRMED', message: 'The original operation remains unconfirmed. Inspect that same event; it has not been replayed.', noteHistory: { status: original.status, eventId: original.eventId, batchId: original.batchId } }
        }
      } catch (error) { return { status: 'unknown', code: 'NOTE_OPERATION_UNCONFIRMED', message: error instanceof Error ? error.message : String(error), noteHistory: { status: 'unconfirmed', eventId: input.operationId, reason: 'The original operation could not be inspected; it has not been replayed.' } } }
    }
    let content = input.content, reason: string | undefined
    let attributed: NoteDocument | undefined
    const at = Date.now()
    let baseline: Extract<WorkspaceFileReadResult, { status: 'read' }> | undefined
    let baselineObservation: WorkspaceFileReadResult | undefined, baselineIssue: string | undefined
    if (input.expectedRevision !== null) {
      try { baselineObservation = await this.read(workspace, input.path); if (baselineObservation.status === 'read') { if (baselineObservation.document.path === input.path) baseline = baselineObservation; else baselineObservation = { status: 'error', code: 'NOTE_READ_TARGET_MISMATCH', message: 'The original reader returned another file path.' } } }
      catch (error) { baselineIssue = error instanceof Error ? error.message : String(error) }
    }
    if (enhanced && !creating) {
      const conflict = (why: 'overlap' | 'identity' | 'invalid-structure') => this.rejectedSubmission(workspace, submitted, submissionNoteId!, requestFingerprint!, baseline, why, context, action)
      if (!baseline) {
        if (baselineObservation?.status === 'deleted' || baselineObservation?.status === 'directory' || baselineObservation?.status === 'binary') return conflict('invalid-structure')
        return { status: 'unknown', code: 'NOTE_BASELINE_UNAVAILABLE', message: baselineIssue ?? (baselineObservation?.status === 'error' ? baselineObservation.message : 'The current original Note could not be observed. Keep the baseline, draft and operation ID; no merge or write was attempted.'),
          noteHistory: { status: 'unconfirmed', eventId: submitted.operationId!, reason: 'Current baseline observation is unavailable. This is not a confirmed content conflict.' } }
      }
      if (action) {
        const currentHeader = readNoteMarkdownHeader(baseline.document.content)
        if (currentHeader.status !== 'valid' || currentHeader.noteId !== action.noteId) return conflict('identity')
        if (baseline.document.revision !== input.expectedRevision) return conflict('overlap')
      } else {
      const current = readNoteDocument(baseline.document.content)
      if (candidate.status !== 'valid' || current.status !== 'valid') return conflict('invalid-structure')
      if (candidate.note.noteId !== submissionBaseline!.noteId || current.note.noteId !== submissionBaseline!.noteId || replacesEditedBlock(submissionBaseline!, current.note, candidate.note)) return conflict('identity')
      let merged: Awaited<ReturnType<typeof mergeNoteTextInWorker>>
      try { merged = await mergeNoteTextInWorker(submitted.baseContent!, baseline.document.content, submitted.content) }
      catch (error) { return { status: 'unknown', code: 'NOTE_MERGE_UNAVAILABLE', message: error instanceof Error ? error.message : String(error), noteHistory: { status: 'unconfirmed', eventId: submitted.operationId!, reason: 'The merge could not be observed; the original file and proposed bytes are retained without a write.' } } }
      if (merged.status === 'conflict') return conflict('overlap')
      candidate = readNoteDocument(merged.content)
      if (candidate.status !== 'valid' || candidate.note.noteId !== submissionBaseline!.noteId) return conflict('invalid-structure')
      content = merged.content
      input = { ...input, content, expectedRevision: baseline.document.revision }
      }
    }
    if (candidate.status !== 'valid') reason = 'This source is not a valid Note. Its file bytes were saved without confirmed block attribution.'
    else {
      if (!action && candidate.note.title === undefined) {
        try {
          const original = baseline && readNoteMarkdownHeader(baseline.document.content)
          if (original?.status === 'valid' && original.noteId === candidate.note.noteId && original.title !== undefined) candidate = { ...candidate, note: { ...candidate.note, title: original.title } }
          else if (input.expectedRevision === null || original?.status === 'valid' && original.noteId === candidate.note.noteId && original.title === undefined) {
            const state = await (this.links?.state() ?? this.metadata?.read?.()), page = state?.pages[candidate.note.noteId]
            if (page && noteProvenanceResourceKey(page.resource) === noteProvenanceResourceKey(resourceOf(workspace, input.path))) candidate = { ...candidate, note: { ...candidate.note, title: page.title } }
          }
        } catch { /* Saving remains available; a missing confirmed title stays explicit in the file projection. */ }
      }
      let before = null
      if (input.expectedRevision !== null) {
        try {
          const observed = baseline
          if (observed?.document.revision === input.expectedRevision) {
            const parsed = readNoteDocument(observed.document.content)
            if (parsed.status === 'valid') before = hydrateNoteProvenance(parsed.note, observed.document.noteProvenance, observed.document.revision)
            else reason = 'The original block authorship baseline is unconfirmed.'
          } else reason = 'The original file revision could not be observed for block attribution.'
        } catch { reason = 'The original file could not be read for block attribution.' }
      }
      const confirmedBaseline = input.expectedRevision === null || before?.noteId === candidate.note.noteId
      if (before && before.noteId !== candidate.note.noteId) reason = 'The original Note identity changed; block attribution is unconfirmed.'
      // Compare the original schema's canonical nodes so editor-added default attributes are not edits.
      const normalized = (note: NoteDocument) => ({ ...note, content: noteContentSchema.nodeFromJSON(note.content).toJSON() })
      const identified = normalized(candidate.note)
      const identify = (node: typeof identified.content) => {
        if (NOTE_BLOCK_TYPES.some(type => type === node.type) && node.attrs?.blockId == null) node.attrs = { ...node.attrs, blockId: mintObjectId() }
        node.content?.forEach(identify)
      }
      if (!action || action.draft) identify(identified.content)
      const prepared = action && !action.draft ? { note: identified, pending: [] } : prepareNoteWikiLinks(identified, mintObjectId)
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
      const next = attributeNoteBlocks(before ? normalized(before) : null, linked, confirmedBaseline || action ? context?.actor : undefined, at)
      if (action) {
        const existing = before ? blockMetadata(before) : Object.create(null) as Record<string, NoteBlockProvenance>
        const restoreCreators = (node: NoteDocument['content']) => {
          const id = typeof node.attrs?.blockId === 'string' ? node.attrs.blockId : undefined
          if (id !== undefined && !Object.hasOwn(existing, id)) node.attrs = { ...node.attrs,
            provenance: { created: action.historicalBlocks?.[id]?.created ?? null, lastEdited: node.attrs?.provenance?.lastEdited ?? null } }
          node.content?.forEach(restoreCreators)
        }
        restoreCreators(next.content)
      }
      if (transferredBlocks && (creating || action)) {
        const restoreTransferred = (node: NoteDocument['content']) => {
          const original = typeof node.attrs?.blockId === 'string' ? transferredBlocks[node.attrs.blockId] : undefined
          if (original) node.attrs = { ...node.attrs, provenance: creating ? original : { created: original.created, lastEdited: node.attrs?.provenance?.lastEdited ?? null } }
          node.content?.forEach(restoreTransferred)
        }
        restoreTransferred(next.content)
      }
      attributed = next
      if (!action || action.draft) content = serializeNoteDocument(next)
      if (!context?.actor) reason = 'The original write actor is unknown; changed block attribution is unconfirmed.'
    }
    let journal: NoteHistoryRecord | undefined
    let historyIdentity: Pick<NoteHistoryRecord, 'eventId' | 'batchId'> | undefined
    let historyIssue: string | undefined
    try {
      if (!this.metadata?.readHistory || !this.metadata.recordHistory) throw new Error('The original Note history owner is unavailable.')
      const old = baseline && readNoteDocument(baseline.document.content)
      const noteId = action?.noteId ?? (candidate.status === 'valid' ? candidate.note.noteId : old?.status === 'valid' ? old.note.noteId : undefined)
      if (!noteId || input.expectedRevision !== null && !baseline || old?.status === 'valid' && old.note.noteId !== noteId) throw new Error('The original Note identity or history baseline cannot be confirmed.')
      const resource = resourceOf(workspace, input.path), previous = (await this.metadata.readHistory({ noteId, resource, limit: 1 })).entries[0]
      const eventId = submitted.operationId ?? mintObjectId(), actor = context?.actor ?? null
      const sameActivity = !action && previous?.status === 'committed' && previous.operation === 'edit' && previous.revision === baseline?.document.revision &&
        previous.actor !== null && actor !== null && previous.actor.kind === actor.kind && previous.actor.id === actor.id && at >= previous.at && at - previous.at <= NOTE_HISTORY_BATCH_WINDOW_MS
      historyIdentity = { eventId, batchId: sameActivity ? previous.batchId : eventId }
      journal = await this.metadata.recordHistory({ eventId, sequence: 0, batchId: sameActivity ? previous.batchId : eventId,
        noteId, resource, originalResource: { ...resource }, status: 'prepared', at, actor, operation: action?.operation ?? 'edit', ...(action?.source ? { source: action.source } : {}),
        parentEventId: previous?.status === 'committed' && previous.revision === baseline?.document.revision ? previous.eventId : null,
        requestFingerprint: requestFingerprint ?? noteHistoryRevision(JSON.stringify([input.expectedRevision, input.content, actor])),
        baseRevision: baseline?.document.revision ?? null, beforeContent: baseline?.document.content ?? null,
        revision: noteHistoryRevision(content), content })
    } catch (error) { historyIssue = error instanceof Error ? error.message : String(error) }
    // This opt-in request promises durable operation identity. Do not execute it without its original prepared event.
    // Ordinary CAS saves above retain the existing body-first availability when history bookkeeping fails.
    if (enhanced && !journal) return { status: 'unknown', code: 'NOTE_OPERATION_UNCONFIRMED', message: historyIssue ?? 'The original operation preparation is unconfirmed.',
      noteHistory: { status: 'unconfirmed', ...historyIdentity, eventId: submitted.operationId!, reason: historyIssue ?? 'Inspect this same operation before another save.' } }
    let result: WorkspaceFileWriteResult
    try { result = await this.files.write(workspace, { ...input, content }) }
    catch (error) { result = { status: 'unknown', code: 'FILE_WRITE_UNCONFIRMED', message: error instanceof Error ? error.message : String(error) } }
    const bodyReason = reason
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
    let noteHistory: NoteHistoryReceipt = { status: 'unconfirmed', ...historyIdentity, reason: historyIssue ?? 'The original history outcome is unconfirmed.' }
    if (journal) {
      try {
        const status = result.status === 'written' && result.revision === journal.revision ? 'committed' : result.status === 'conflict' || result.status === 'error' ? 'not-applied' : 'unconfirmed'
        const provenance = attributed && result.status === 'written' ? { noteId: attributed.noteId, resource: journal.resource, revision: result.revision, blocks: blockMetadata(attributed) } : undefined
        journal = await this.metadata!.recordHistory!({ ...journal, status, ...(provenance ? { provenance } : {}), ...(result.status === 'written' && result.fileWitness ? { fileWitness: result.fileWitness } : {}) })
        noteHistory = { eventId: journal.eventId, batchId: journal.batchId, status }
        if (status === 'committed' && provenance) { noteProvenance = { ...provenance, status: 'recorded' }; reason = bodyReason }
      } catch (error) { noteHistory = { status: 'unconfirmed', eventId: journal.eventId, batchId: journal.batchId, reason: error instanceof Error ? error.message : String(error) } }
    }
    let noteTitleProjection: NoteTitleProjection | undefined
    if (result.status === 'written' && candidate.status === 'valid' && this.metadata?.refreshFileTitle) {
      const resource = resourceOf(workspace, input.path)
      try { noteTitleProjection = await this.metadata.refreshFileTitle(candidate.note.noteId, resource) }
      catch (error) { noteTitleProjection = { status: 'unconfirmed', noteId: candidate.note.noteId, resource, code: 'catalog-unavailable', message: error instanceof Error ? error.message : String(error) } }
    }
    if (result.status !== 'written') return { ...result, noteHistory }
    const { fileWitness: _nativeWitness, ...publicResult } = result
    return { ...publicResult, ...(enhanced || content !== input.content ? { content } : {}), noteHistory, ...(noteTitleProjection ? { noteTitleProjection } : {}),
      ...(noteProvenance ? { noteProvenance } : {}), noteAttribution: reason ? { status: 'unconfirmed', reason } : { status: 'recorded' } }
  }
}
