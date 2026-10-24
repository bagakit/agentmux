import { noteShareRange, noteShareRangeContent } from '@agentmux/client-ui/note/note-share-range'
import type { NoteSharedUndoOwner } from './note-shared-undo-owner.js'
import type { FileShareUndoParams, FileShareUndoResult } from '@agentmux/core/files'
import type { NoteHistoryWriteAction } from './note-history-actions.js'
import type { NoteBlockProvenance } from '@agentmux/core/note-provenance'
import { AgentMuxError } from '@agentmux/core'
import { fileShareCreateOperation, fileShareSourceOperation, parseFileShareParams, type FileCreateParams, type FileReadParams, type FileReadResource, type FileReadResult, type FileShareParams, type FileShareInspectParams, type FileShareInspectResult, type FileSharedInspection, type FileShareEventObservation, type FileSharePromotion, type FileShareResult, type FileWriteContext, type FileWriteParams, type FileWriteResult } from '@agentmux/core/files'
import { readNoteMarkdownHeader } from '@agentmux/core/note-format'
import { noteHistoryRevision, type NoteHistoryRecord } from '@agentmux/core/note-history'
import { noteProvenanceResourceKey } from '@agentmux/core/note-provenance'
import { readNoteDocument, serializeNoteDocument, type NoteDocument } from '@agentmux/client-ui/note/note-document'
import { noteContentSchema } from '@agentmux/client-ui/note/note-content-schema'

type Node = NoteDocument['content']
type SourcePlan = { request: FileWriteParams; original: FileWriteParams; noteId: string; promotions: FileSharePromotion[] }
type Plan = { params: FileShareParams; fingerprint: string; shared: Map<string, { request: FileCreateParams; promotion: FileSharePromotion }>; sources: SourcePlan[]; destination: FileWriteParams }
const key = (p: { expectedResource: FileReadResource }) => noteProvenanceResourceKey({ hostId: p.expectedResource.hostId, workspaceId: p.expectedResource.workspaceId, workspacePath: p.expectedResource.workspacePath, path: p.expectedResource.path })
const readParams = (p: FileReadParams): FileReadParams => ({ zoneId: p.zoneId, ...(p.spaceId ? { spaceId: p.spaceId } : {}), path: p.path, expectedResource: { hostId: p.expectedResource.hostId, workspaceId: p.expectedResource.workspaceId, workspacePath: p.expectedResource.workspacePath } })
const sameActor = (a: FileWriteContext['actor'] | null, b: FileWriteContext['actor'] | null) => a?.kind === b?.kind && a?.id === b?.id
function parsed(content: string, noteId?: string): NoteDocument {
  const read = readNoteDocument(content)
  if (read.status !== 'valid' || noteId !== undefined && read.note.noteId !== noteId) throw new AgentMuxError('The exact original Markdown structure or identity changed. Keep the source and staged draft.', 'NOTE_SHARE_SOURCE_INVALID')
  return read.note
}
/** A plan has not published any file. Invalid ranges are an explicit rejected target. */
function serializeRange(note: NoteDocument): string {
  const tree = noteContentSchema.nodeFromJSON(note.content)
  let invalid = !tree.type.validContent(tree.content)
  tree.descendants(node => { if (!node.type.validContent(node.content)) invalid = true })
  if (invalid) throw new AgentMuxError('This exact block cannot be replaced by a shared include in its original container. Choose a whole table or list item; the source and draft are kept.', 'NOTE_SHARE_RANGE_UNSUPPORTED')
  const content = serializeNoteDocument(note); parsed(content, note.noteId); return content
}
function nodes(node: Node, predicate: (node: Node) => boolean): Node[] { return [...(predicate(node) ? [node] : []), ...(node.content ?? []).flatMap(child => nodes(child, predicate))] }
function findRange(note: NoteDocument, blockId: string) {
  const range = noteShareRange(note.content, blockId)
  if (!range) throw new AgentMuxError('The original source block is missing, duplicated or already shared. Keep the draft and copy its current source again.', 'NOTE_SHARE_SOURCE_CHANGED')
  return range
}
function include(promotion: FileSharePromotion, forwardedBlockIds: string[]): Node { return { type: 'noteInclude', attrs: { blockId: promotion.sourceBlockId, referenceId: promotion.operationId + ':source', noteId: promotion.shared.noteId, workspaceId: promotion.shared.expectedResource.workspaceId, path: promotion.shared.expectedResource.path, ...(forwardedBlockIds.length ? { forwardedBlockIds } : {}) } } }
/** Split the original list around an extracted item so no invalid listItem/include schema is invented. */
function replaceRange(node: Node, blockId: string, replacement: Node, count: number): Node[] {
  if (node.attrs?.blockId === blockId) return [replacement]
  if (!node.content) return [node]
  if (node.type === 'bulletList' || node.type === 'orderedList' || node.type === 'taskList') {
    const index = node.content.findIndex(child => child.attrs?.blockId === blockId)
    if (index >= 0) return [
      ...(index ? [{ ...node, content: node.content.slice(0, index) }] : []), replacement,
      ...(index + 1 < node.content.length ? [{ ...node, ...(node.type === 'orderedList' ? { attrs: { ...node.attrs, start: Number(node.attrs?.start ?? 1) + index + 1 } } : {}), content: node.content.slice(index + 1) }] : [])
    ]
  }
  const index = node.content.findIndex(child => child.attrs?.blockId === blockId)
  if (index >= 0) return [{ ...node, content: [...node.content.slice(0, index), replacement, ...node.content.slice(index + count)] }]
  return [{ ...node, content: node.content.flatMap(child => replaceRange(child, blockId, replacement, count)) }]
}
function replace(note: NoteDocument, promotion: FileSharePromotion): NoteDocument {
  const selected = findRange(note, promotion.sourceBlockId)
  const moved = selected.nodes.flatMap(node => nodes(node, () => true))
  const declared = moved.flatMap(node => node.type === 'noteInclude' && Array.isArray(node.attrs?.forwardedBlockIds) ? node.attrs.forwardedBlockIds as string[] : [])
  if (declared.includes(promotion.sourceBlockId)) throw new AgentMuxError('The selected original address has conflicting saved forwarding declarations. Preserve the source and choose an unambiguous block.', 'NOTE_SHARE_SOURCE_CHANGED')
  // Only the outer route is deduplicated; declarations inside the moved content stay intact,
  // so duplicate or conflicting original addresses remain ambiguous at the next hop.
  const forwardedBlockIds = [...new Set([...moved.flatMap(node => typeof node.attrs?.blockId === 'string' && node.attrs.blockId !== promotion.sourceBlockId ? [node.attrs.blockId as string] : []), ...declared])]
  const content = replaceRange(note.content, promotion.sourceBlockId, include(promotion, forwardedBlockIds), selected.count)[0]!
  return { ...note, content }
}
/** Only Markdown owns the new entity. Existing history proves each separate file write, never an atomic cross-file commit. */
export class NoteSharedBlockOwner {
  constructor(private readonly ports: {
    undo?: NoteSharedUndoOwner
    files: { read(params: FileReadParams): Promise<FileReadResult>; write(params: FileWriteParams, context?: FileWriteContext): Promise<FileWriteResult>; writeInverse?(params: FileWriteParams, context: FileWriteContext | undefined, action: NoteHistoryWriteAction, transferred?: Record<string, NoteBlockProvenance>): Promise<FileWriteResult>; createShared(params: FileCreateParams, operationId: string, context?: FileWriteContext, source?: FileWriteParams): Promise<FileWriteResult> }
    historyOperation(operationId: string): Promise<NoteHistoryRecord | undefined | null>
    withWriteLease<T>(work: () => Promise<T>): Promise<T>
    /** Phase faults exercise real interruption boundaries; production supplies no hook. */
    afterStage?(stage: 'shared' | 'source' | 'destination', operationId: string): Promise<void>
  }) {}
  async share(input: FileShareParams, context?: FileWriteContext): Promise<FileShareResult> { return input.undoReferenceIds?.length ? this.combined(input, context, false) : this.run(input, context, false) }
  private async combined(input: FileShareParams, context: FileWriteContext | undefined, inspect: boolean): Promise<FileShareResult> {
    if (!this.ports.undo || !this.ports.files.writeInverse) throw new AgentMuxError('The original shared inverse owner is unavailable.', 'CONTROL_UNAVAILABLE')
    const request: FileShareUndoParams = { destination: input.destination, referenceIds: input.undoReferenceIds!, ...(input.preserveNoteIds ? { preserveNoteIds: input.preserveNoteIds } : {}) }
    let result: FileShareResult | undefined
    const sharedFingerprint = noteHistoryRevision(JSON.stringify(['agentmux.note.shared-save.v1', input, context?.actor ?? null]))
    let inverse: { action: NoteHistoryWriteAction; transferred: Record<string, NoteBlockProvenance> } | undefined
    const undo = await this.ports.undo.apply(request, context, inspect, async (destination, action, transferred) => {
      inverse = { action, transferred }
      result = await this.run({ ...input, destination }, context, false, { ...inverse, fingerprint: sharedFingerprint })
      return result.destination ? { ...result.destination, relatedWrites: result.promotions.flatMap(p => [p.shared, p.source].filter((r): r is FileWriteResult => !!r)) } : { resource: input.destination.expectedResource, result: { status: 'unknown', code: result.code ?? 'NOTE_SHARE_UNCONFIRMED', message: result.message ?? 'An original shared-save phase is unconfirmed.' } }
    })
    if (!result) {
      const event = await this.ports.historyOperation(input.destination.operationId!)
      const actor = event?.actor ? { actor: event.actor } : context
      const action: NoteHistoryWriteAction = { operation: event?.operation === 'edit' ? 'edit' : 'undo', noteId: parsed(input.destination.content).noteId, ...(event?.source ? { source: event.source } : {}), fingerprint: noteHistoryRevision(JSON.stringify(['agentmux.note.shared-undo.v1', request, actor?.actor ?? null])) }
      result = await this.run(input, actor, true, { action, transferred: {}, fingerprint: noteHistoryRevision(JSON.stringify(['agentmux.note.shared-save.v1', input, actor?.actor ?? null])) })
    }
    return { ...result, undo, status: result.status === 'committed' && (undo.status === 'committed' || undo.status === 'partial') ? undo.status : 'unknown' }
  }
  async undoShare(input: FileShareUndoParams, context?: FileWriteContext): Promise<FileShareUndoResult> {
    if (!this.ports.undo) throw new AgentMuxError('The original shared undo owner is unavailable; ordinary files remain available.', 'CONTROL_UNAVAILABLE')
    return this.ports.undo.apply(input, context)
  }
  async inspectShare(input: FileShareInspectParams, context?: FileWriteContext): Promise<FileShareInspectResult> {
    if (input.mode === 'undo') {
      if (!this.ports.undo) throw new AgentMuxError('The original shared undo inspector is unavailable.', 'CONTROL_UNAVAILABLE')
      return { mode: 'undo', result: await this.ports.undo.apply(input.request, context, true) }
    }
    if (input.mode === 'request') return { mode: 'request', result: input.request.undoReferenceIds?.length ? await this.combined(input.request, context, true) : await this.run(input.request, context, true) }
    return this.inspectSharedFile(input.shared)
  }
  private async inspectSharedFile(input: FileReadParams): Promise<FileSharedInspection> {
    const unknown = (message: string): FileShareEventObservation => ({ status: 'unknown', code: 'NOTE_SHARE_HISTORY_UNCONFIRMED', message })
    const current = await this.ports.files.read(input)
    const result: FileSharedInspection = { mode: 'shared', current, declaration: { status: 'unconfirmed', message: 'The original shared Markdown declaration is unconfirmed.' }, create: unknown('The creation declaration is unconfirmed.'), source: unknown('The exact original source phase is unconfirmed.'), destination: unknown('The exact original destination phase is unconfirmed.'), batch: { status: 'unknown', message: 'This Markdown entity can locate its own original phases. It cannot reconstruct an absent whole save payload or certify every promotion and unsaved draft in that batch.' } }
    const event = async (operationId: string): Promise<NoteHistoryRecord | null | undefined> => { try { return await this.ports.historyOperation(operationId) ?? null } catch { return undefined } }
    const summary = (value: NoteHistoryRecord): FileShareEventObservation => value.operation === 'delete' ? unknown('This original stage is a deletion, not the selected sharing write.') : ({ status: 'read', event: { eventId: value.eventId, noteId: value.noteId, resource: value.resource, status: value.status, baseRevision: value.baseRevision, revision: value.revision } })
    if (current.result.status !== 'read' || !current.resource) return result
    const header = readNoteMarkdownHeader(current.result.document.content)
    if (header.status !== 'valid' || header.kind !== 'shared-block' || !header.origin) return result
    const original = await event(header.origin.operationId + ':create')
    if (original === null) { result.create = { status: 'missing' }; return result }
    if (!original) return result
    const expected = { hostId: current.resource.hostId, workspaceId: current.resource.workspaceId, workspacePath: current.resource.workspacePath, path: current.resource.path }
    // A moved file retains its stable ID. The original creation resource may have its old path;
    // another Host/Workspace or another Note can never be adopted through a mutable declaration.
    if (original.noteId !== header.noteId || original.operation !== 'edit' || original.baseRevision !== null || original.beforeContent !== null || original.resource.hostId !== expected.hostId || original.resource.workspaceId !== expected.workspaceId || original.resource.workspacePath !== expected.workspacePath) return result
    const created = readNoteMarkdownHeader(original.content), fields = ['operationId', 'sourceNoteId', 'sourcePath', 'sourceRevision', 'sourceBlockId', 'sourceOperationId', 'requestFingerprint'] as const
    const destinationFields = ['noteId', 'path', 'operationId', 'expectedRevision'] as const
    if (created.status !== 'valid' || created.kind !== 'shared-block' || created.noteId !== header.noteId || !created.origin || fields.some(field => created.origin![field] !== header.origin![field]) || destinationFields.some(field => created.origin!.destination?.[field] !== header.origin!.destination?.[field])) {
      result.declaration = { status: 'unconfirmed', message: 'The current Markdown origin differs from its original creation event. Current bytes are preserved; the edited declaration does not authorize adopting another history.' }
      return result
    }
    result.create = summary(original)
    if (original.status !== 'committed') return result
    result.declaration = { status: 'confirmed', noteId: header.noteId, origin: header.origin }
    const phase = async (operationId: string | undefined, noteId: string | undefined, path: string | undefined): Promise<FileShareEventObservation> => {
      if (!operationId || !noteId || !path) return unknown('The original creation does not declare this phase identity.')
      const record = await event(operationId)
      if (record === null) return { status: 'missing' }
      if (!record) return unknown('The original history owner could not observe this same event.')
      if (record.noteId !== noteId || record.resource.path !== path) return unknown('This declared event does not belong to the original Note and path.')
      return summary(record)
    }
    result.source = await phase(created.origin.sourceOperationId, created.origin.sourceNoteId, created.origin.sourcePath)
    result.destination = await phase(created.origin.destination?.operationId, created.origin.destination?.noteId, created.origin.destination?.path)
    return result
  }
  private plan(params: FileShareParams, context?: FileWriteContext, originalFingerprint?: string): Plan {
    const fingerprint = originalFingerprint ?? noteHistoryRevision(JSON.stringify(['agentmux.note.shared-save.v1', params, context?.actor ?? null]))
    const destinationNote = parsed(params.destination.content), shared = new Map<string, { request: FileCreateParams; promotion: FileSharePromotion }>(), groups = new Map<string, SourcePlan>()
    for (const promotion of params.promotions) {
      const original = parsed(promotion.source.content, promotion.sourceNoteId), selected = findRange(original, promotion.sourceBlockId)
      if (original.kind === 'shared-block') throw new AgentMuxError('Reuse this existing shared file directly instead of creating another entity for its same content.', 'NOTE_SHARE_ALREADY_SHARED')
      if (!nodes(destinationNote.content, node => node.type === 'noteInclude' && node.attrs?.referenceId === promotion.referenceId && node.attrs.noteId === promotion.shared.noteId && node.attrs.path === promotion.shared.expectedResource.path && (node.attrs.workspaceId === promotion.shared.expectedResource.workspaceId || node.attrs.workspaceId == null && promotion.shared.expectedResource.workspaceId === params.destination.expectedResource.workspaceId)).length) throw new AgentMuxError('This staged occurrence was removed or changed before save. No shared file was created.', 'NOTE_SHARE_OCCURRENCE_REMOVED')
      if (key(promotion.source) === key(promotion.shared)) throw new AgentMuxError('A shared file must be a distinct absent Markdown resource.', 'NOTE_SHARE_TARGET_INVALID')
      if (selected.nodes.some(node => nodes(node, node => node.type === 'noteInclude' && node.attrs?.noteId === promotion.shared.noteId).length)) throw new AgentMuxError('The proposed extraction would include itself. Keep the original source and draft.', 'NOTE_SHARE_CYCLE')
      const note: NoteDocument = { schema: original.schema, noteId: promotion.shared.noteId, kind: 'shared-block', ...(promotion.shared.title ? { title: promotion.shared.title } : {}),
        origin: { operationId: promotion.operationId, sourceNoteId: promotion.sourceNoteId, sourcePath: promotion.source.expectedResource.path, sourceRevision: promotion.source.expectedRevision, sourceBlockId: promotion.sourceBlockId, sourceOperationId: key(promotion.source) === key(params.destination) ? params.destination.operationId! : fileShareSourceOperation(params, promotion.source),
          requestFingerprint: fingerprint, destination: { noteId: destinationNote.noteId, path: params.destination.expectedResource.path, operationId: params.destination.operationId!, expectedRevision: params.destination.expectedRevision } },
        content: noteShareRangeContent(selected) }
      const { noteId: _noteId, title: _title, ...target } = promotion.shared
      const content = serializeRange(note)
      shared.set(promotion.operationId, { request: { ...target, expectedRevision: null, content }, promotion })
      const group = groups.get(key(promotion.source))
      if (group) {
        if (group.original.content !== promotion.source.content || group.original.baseContent !== promotion.source.baseContent || group.original.expectedRevision !== promotion.source.expectedRevision) throw new AgentMuxError('Staged blocks from one source must use the same original baseline and current draft.', 'NOTE_SHARE_SOURCE_CHANGED')
        group.promotions.push(promotion)
      } else groups.set(key(promotion.source), { original: promotion.source, request: promotion.source, noteId: promotion.sourceNoteId, promotions: [promotion] })
    }
    let destination = params.destination
    for (const group of groups.values()) {
      const ownDestination = key(group.original) === key(params.destination)
      if (ownDestination && (group.original.expectedRevision !== params.destination.expectedRevision || group.original.baseContent !== params.destination.baseContent)) throw new AgentMuxError('Same-page sharing requires one original file baseline for source and destination.', 'NOTE_SHARE_SOURCE_CHANGED')
      let note = ownDestination ? parsed(destination.content, group.noteId) : parsed(group.original.content, group.noteId)
      for (const promotion of group.promotions) {
        // Never extract a stale clipboard body after an intervening source edit.
        const original = findRange(parsed(group.original.content), promotion.sourceBlockId).nodes, current = findRange(note, promotion.sourceBlockId).nodes
        if (JSON.stringify(current) !== JSON.stringify(original)) throw new AgentMuxError('The selected original range changed in this draft. Preserve it and copy its current source again.', 'NOTE_SHARE_SOURCE_CHANGED')
        note = replace(note, promotion)
      }
      const content = serializeRange(note)
      if (ownDestination) destination = { ...destination, content }
      group.request = { ...group.original, content, operationId: ownDestination ? params.destination.operationId! : fileShareSourceOperation(params, group.original) }
    }
    return { params, fingerprint, shared, sources: [...groups.values()], destination }
  }
  private async run(input: FileShareParams, context: FileWriteContext | undefined, inspect: boolean, inverse?: { action: NoteHistoryWriteAction; transferred: Record<string, NoteBlockProvenance>; fingerprint: string }): Promise<FileShareResult> {
    const params = structuredClone(parseFileShareParams(input))
    let actor = context ? structuredClone(context) : undefined
    const result: FileShareResult = { operationId: params.operationId, status: 'unknown', promotions: params.promotions.map(p => ({ operationId: p.operationId, shared: null, source: null })), destination: null }
    try {
      if (inspect) {
        // Reading another permitted file operation is not a replay under the reader's identity.
        // Recover the original actor from trusted per-file history, never from request YAML.
        const events = [...params.promotions.map(fileShareCreateOperation), ...params.promotions.map(p => fileShareSourceOperation(params, p.source)), params.destination.operationId!]
        actor = undefined
        for (const operationId of events) {
          const event = await this.ports.historyOperation(operationId)
          if (event) { actor = event.actor ? { actor: event.actor } : undefined; break }
        }
      }
      const plan = this.plan(params, actor, inverse?.fingerprint)
      return await this.ports.withWriteLease(async () => {
        if (inspect) {
          await this.observe(plan, result, actor, inverse?.action)
          result.status = this.completed(result) ? 'committed' : 'unknown'
          if (result.status !== 'committed') { result.code = 'NOTE_SHARE_INSPECTION'; result.message = 'Per-file original receipts and current observations are separate. Missing or unconfirmed receipts do not certify an earlier multi-file commit.' }
          return result
        }
        for (const [index, promotion] of params.promotions.entries()) {
          const shared = plan.shared.get(promotion.operationId)!, progress = result.promotions[index]!
          const old = await this.original(shared.request, promotion.shared.noteId, fileShareCreateOperation(promotion), actor)
          if (old) progress.shared = old
          else {
            const current = await this.ports.files.read(readParams(promotion.shared))
            if (current.result.status !== 'deleted') {
              progress.currentShared = current
              return this.stop(result, current.result.status === 'read' ? 'conflict' : 'unknown', 'NOTE_SHARE_TARGET_OCCUPIED', 'The shared target is not confirmed absent; it was not overwritten. Inspect this original operation and target.')
            }
            progress.shared = await this.ports.files.createShared(shared.request, fileShareCreateOperation(promotion), actor, promotion.source)
          }
          if (!this.confirmed(progress.shared)) return this.failed(result, progress.shared)
          await this.ports.afterStage?.('shared', promotion.operationId)
        }
        for (const source of plan.sources) {
          if (key(source.original) === key(params.destination)) continue
          const old = await this.original(source.request, source.noteId, source.request.operationId!, actor)
          const receipt = old ?? await this.ports.files.write(source.request, actor)
          for (const promotion of source.promotions) result.promotions[params.promotions.indexOf(promotion)]!.source = receipt
          if (!this.confirmed(receipt)) return this.failed(result, receipt)
          await this.ports.afterStage?.('source', source.request.operationId!)
        }
        const destinationId = parsed(plan.destination.content).noteId
        result.destination = await this.original(plan.destination, destinationId, plan.destination.operationId!, actor, inverse?.action) ?? (inverse ? await this.ports.files.writeInverse!(plan.destination, actor, inverse.action, inverse.transferred) : await this.ports.files.write(plan.destination, actor))
        for (const source of plan.sources) if (key(source.original) === key(params.destination)) for (const promotion of source.promotions) result.promotions[params.promotions.indexOf(promotion)]!.source = result.destination
        if (!this.confirmed(result.destination)) return this.failed(result, result.destination)
        await this.ports.afterStage?.('destination', plan.destination.operationId!)
        result.status = 'committed'
        return result
      })
    } catch (error) {
      // Inspecting an old request never certifies its earlier effects from a new
      // planning rejection. Its original per-file receipts still need observation.
      if (inspect && error instanceof AgentMuxError && error.code === 'NOTE_SHARE_RANGE_UNSUPPORTED') return this.stop(result, 'unknown', 'NOTE_SHARE_INSPECTION', 'The original request has an unsupported range. Its earlier publication is unconfirmed; retain this same request and inspect its exact files and history.')
      return this.stop(result, error instanceof AgentMuxError ? 'error' : 'unknown', error instanceof AgentMuxError ? error.code : 'NOTE_SHARE_UNCONFIRMED', error instanceof Error ? error.message : String(error))
    }
  }
  private confirmed(receipt: FileWriteResult | null): boolean { return receipt?.result.status === 'written' && receipt.result.noteHistory?.status === 'committed' }
  private completed(result: FileShareResult): boolean { return this.confirmed(result.destination) && result.promotions.every(p => this.confirmed(p.shared) && this.confirmed(p.source)) }
  private stop(result: FileShareResult, status: FileShareResult['status'], code: string, message: string): FileShareResult { return { ...result, status, code, message } }
  private failed(result: FileShareResult, receipt: FileWriteResult): FileShareResult {
    const outcome = receipt.result
    return this.stop(result, outcome.status === 'conflict' ? 'conflict' : outcome.status === 'error' ? 'error' : 'unknown', 'NOTE_SHARE_PHASE_UNCONFIRMED', 'The shared save stopped at this original per-file outcome. Keep all staged inputs and IDs; inspect each original stage before deciding recovery.')
  }
  private async original(request: FileWriteParams | FileCreateParams, noteId: string, operationId: string, context?: FileWriteContext, inverse?: NoteHistoryWriteAction): Promise<FileWriteResult | null> {
    const event = await this.ports.historyOperation(operationId)
    if (!event) return null
    const resource = { hostId: request.expectedResource.hostId, workspaceId: request.expectedResource.workspaceId, workspacePath: request.expectedResource.workspacePath, path: request.expectedResource.path }
    const fingerprint = inverse?.fingerprint ?? noteHistoryRevision(JSON.stringify([resource, noteId, request.expectedRevision, request.content, context?.actor ?? null]))
    if (event.noteId !== noteId || event.operation !== (inverse?.operation ?? 'edit') || noteProvenanceResourceKey(event.resource) !== noteProvenanceResourceKey(resource) || event.requestFingerprint !== fingerprint || !sameActor(event.actor, context?.actor ?? null)) throw new AgentMuxError('A phase operation ID belongs to another original request, resource or actor. The original file and draft are retained.', 'NOTE_SHARE_OPERATION_CONFLICT')
    if (event.status === 'committed') return { resource: request.expectedResource, result: { status: 'written', content: event.content, revision: event.revision, noteHistory: { status: 'committed', eventId: event.eventId, batchId: event.batchId, replayed: true }, ...(event.provenance ? { noteProvenance: { ...event.provenance, status: 'recorded' as const } } : {}) } }
    return { resource: request.expectedResource, result: { status: event.status === 'not-applied' ? 'error' : 'unknown', code: event.status === 'not-applied' ? 'NOTE_OPERATION_NOT_APPLIED' : 'NOTE_OPERATION_UNCONFIRMED', message: 'This original per-file event was not confirmed committed; it was not replayed.', noteHistory: { status: event.status, eventId: event.eventId, batchId: event.batchId } } }
  }
  private async observe(plan: Plan, result: FileShareResult, context?: FileWriteContext, inverse?: NoteHistoryWriteAction) {
    for (const [index, promotion] of plan.params.promotions.entries()) {
      const progress = result.promotions[index]!, shared = plan.shared.get(promotion.operationId)!
      progress.shared = await this.original(shared.request, promotion.shared.noteId, fileShareCreateOperation(promotion), context)
      progress.currentShared = await this.ports.files.read(readParams(promotion.shared))
      const source = plan.sources.find(source => source.promotions.includes(promotion))!
      const ownDestination = key(source.original) === key(plan.params.destination)
      progress.source = await this.original(ownDestination ? plan.destination : source.request, source.noteId, ownDestination ? plan.destination.operationId! : source.request.operationId!, context, ownDestination ? inverse : undefined)
      progress.currentSource = await this.ports.files.read(readParams(source.original))
    }
    result.destination = await this.original(plan.destination, parsed(plan.destination.content).noteId, plan.destination.operationId!, context, inverse)
    result.currentDestination = await this.ports.files.read(readParams(plan.destination))
  }
}
