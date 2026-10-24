import type { BigIntStats } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { AgentMuxError } from '@agentmux/core'
import { parseFileShareUndoParams, type FileReadParams, type FileReadResource, type FileReadResult, type FileShareCollection, type FileShareUndoParams, type FileShareUndoResult, type FileWriteContext, type FileWriteParams, type FileWriteResult } from '@agentmux/core/files'
import { noteHistoryRevision, type NoteFileWitness, type NoteHistoryQuery, type NoteHistoryRecord, type NoteHistorySnapshot, type NoteHistorySource, type NoteHistoryWriteRecord } from '@agentmux/core/note-history'
import type { NoteResource } from '@agentmux/core/notebook-catalog'
import { noteProvenanceResourceKey, type NoteBlockProvenance } from '@agentmux/core/note-provenance'
import { deriveNoteCorpus } from '@agentmux/client-ui/note/note-corpus'
import { readNoteDocument, serializeNoteDocument, type NoteDocument } from '@agentmux/client-ui/note/note-document'
import type { WorkspaceRecord } from './content-types.js'
import { readNoteCorpusSources, type NoteCorpusSource } from './note-corpus-reader.js'
import type { WorkspaceFiles } from './content-types.js'
import type { SharedFileDeleteInput, SharedFileDeleteOutcome } from './note-shared-file-delete-owner.js'
import type { NoteHistoryWriteAction } from './note-history-actions.js'

type Node = NoteDocument['content']
type Target = { params: FileReadParams; resource: FileReadResource }
type Candidate = { item: FileShareCollection; create: NoteHistoryWriteRecord; originalSource: NoteHistoryWriteRecord; source: Target; sourceOperationId: string; sourceReferenceId: string; ownDestination: boolean; blocks: Record<string, NoteBlockProvenance>; deletionId: string }
type Scan = { hostId: string; complete: boolean; documents: NoteCorpusSource[]; physical: Map<string, NoteCorpusSource>; roots: string; directoryEntries: Map<string, string>; files: Map<string, string> }
export type NoteSharedUndoPorts = {
  files: Pick<WorkspaceFiles, 'read' | 'readDirectory'>
  workspaces(): Promise<{ workspaces: readonly WorkspaceRecord[]; complete: boolean }>
  target(resource: NoteResource): Promise<Target | null>
  read(params: FileReadParams): Promise<FileReadResult>
  write(params: FileWriteParams, context?: FileWriteContext): Promise<FileWriteResult>
  writeInverse(params: FileWriteParams, context: FileWriteContext | undefined, action: NoteHistoryWriteAction, transferred?: Record<string, NoteBlockProvenance>): Promise<FileWriteResult>
  history(query: NoteHistoryQuery): Promise<NoteHistorySnapshot>
  operation(operationId: string): Promise<NoteHistoryRecord | undefined>
  delete(resource: NoteResource, input: SharedFileDeleteInput, context?: FileWriteContext): Promise<SharedFileDeleteOutcome>
  lease<T>(work: () => Promise<T>): Promise<T>
  afterStage?(stage: 'destination' | 'source' | 'deletion', operationId: string): Promise<void>
}
const resourceKey = noteProvenanceResourceKey
const resourceOf = (r: FileReadResource): NoteResource => ({ hostId: r.hostId, workspaceId: r.workspaceId, workspacePath: r.workspacePath, path: r.path })
const visit = (node: Node): Node[] => [node, ...(node.content ?? []).flatMap(visit)]
const includes = (note: NoteDocument) => visit(note.content).filter(node => node.type === 'noteInclude')
const fingerprint = (params: FileShareUndoParams, actor?: FileWriteContext) => noteHistoryRevision(JSON.stringify(['agentmux.note.shared-undo.v1', params, actor?.actor ?? null]))
const stageId = (operation: string, stage: string, id: string) => operation + ':' + stage + ':' + noteHistoryRevision(id).slice(7)
function note(content: string): NoteDocument { const p = readNoteDocument(content); if (p.status !== 'valid') throw new AgentMuxError('Preserve the original Markdown: its exact shared undo structure is unconfirmed.', 'NOTE_SHARE_UNDO_STRUCTURE'); return p.note }
function retain(item: FileShareCollection, code: string, message: string) { item.retainedReason = { code, message } }
function receipt(event: NoteHistoryWriteRecord, resource: FileReadResource): FileWriteResult {
  return { resource, result: { status: 'written', revision: event.revision, content: event.content, noteHistory: { status: event.status, eventId: event.eventId, batchId: event.batchId, replayed: true }, ...(event.provenance ? { noteProvenance: { ...event.provenance, status: 'recorded' } } : {}) } }
}
const confirmed = (r: FileWriteResult | null) => r?.result.status === 'written' && r.result.noteHistory?.status === 'committed'
function statValue(s: BigIntStats): string { return [s.dev, s.ino, s.size, s.ctimeNs, s.mtimeNs].join(':') }
async function witness(path: string): Promise<NoteFileWitness> { const s = await lstat(path, { bigint: true }); if (!s.isFile() || s.isSymbolicLink()) throw Error('The original shared target is not a regular file.'); return { device: String(s.dev), inode: String(s.ino), size: String(s.size), ctimeNs: String(s.ctimeNs), mtimeNs: String(s.mtimeNs) } }
function replace(node: Node, referenceId: string, replacement: Node[]): Node[] {
  if (node.type === 'noteInclude' && node.attrs?.referenceId === referenceId) return replacement
  if (!node.content) return [node]
  const content = node.content.flatMap(child => replace(child, referenceId, replacement)), merged: Node[] = []
  for (const child of content) {
    const previous = merged.at(-1), list = child.type === 'orderedList' || child.type === 'bulletList' || child.type === 'taskList'
    const unordered = (n: Node) => n.type === 'bulletList' || n.type === 'taskList'
    const attrs = (n: Node) => { const { start: _start, ...rest } = n.attrs ?? {}; return JSON.stringify(rest) }
    if (list && previous && (previous.type === child.type || unordered(previous) && unordered(child)) && attrs(previous) === attrs(child) && (unordered(child) || Number(previous.attrs?.start ?? 1) + (previous.content?.length ?? 0) === Number(child.attrs?.start ?? 1))) {
      previous.content = [...(previous.content ?? []), ...(child.content ?? [])]
      if (unordered(previous)) previous.type = previous.content.every(item => item.type === 'taskItem') ? 'taskList' : 'bulletList'
    }
    else merged.push(child)
  }
  return [{ ...node, content: merged }]
}
/** An ordinary proposed save plus exact removed occurrences; no second body or relationship store. */
export class NoteSharedUndoOwner {
  constructor(private readonly ports: NoteSharedUndoPorts) {}
  async apply(input: FileShareUndoParams, context?: FileWriteContext, inspect = false, save?: (request: FileWriteParams, action: NoteHistoryWriteAction, transferred: Record<string, NoteBlockProvenance>) => Promise<FileWriteResult & { relatedWrites?: FileWriteResult[] }>): Promise<FileShareUndoResult> {
    const params = structuredClone(parseFileShareUndoParams(input)), operationId = params.destination.operationId!
    const result: FileShareUndoResult = { operationId, status: 'unknown', destination: null, collections: [] }
    if (inspect) { const original = await this.ports.operation(operationId); if (original) context = original.actor ? { actor: original.actor } : undefined }
    try { return await this.ports.lease(async () => this.run(params, context, inspect, result, save)) }
    catch (error) { return { ...result, status: error instanceof AgentMuxError ? 'error' : 'unknown', code: error instanceof AgentMuxError ? error.code : 'NOTE_SHARE_UNDO_UNCONFIRMED', message: error instanceof Error ? error.message : String(error) } }
  }
  private async scan(hostId: string): Promise<Scan> {
    const scope = await this.ports.workspaces()
    const workspaces = scope.workspaces.filter(w => w.hostId === hostId).map(w => ({ ...w })), documents: NoteCorpusSource[] = [], directoryEntries = new Map<string, string>(), files = new Map<string, string>(), physical = new Map<string, NoteCorpusSource>()
    let complete = scope.complete
    for (const workspace of workspaces) {
      if (workspace.hostId !== 'local') { complete = false; continue }
      try {
        const root = await realpath(workspace.path)
        const scanned = await readNoteCorpusSources({ workspace: id => workspaces.find(w => w.id === id), files: {
          readDirectory: async (owner, path) => { const entries = await this.ports.files.readDirectory(owner, path); directoryEntries.set(join(root, path), JSON.stringify(entries.map(e => [e.name, e.isDirectory, e.isSymlink]).sort())); return entries },
          read: async (owner, path, options) => { const file = join(root, path), before = statValue(await lstat(file, { bigint: true })); const read = await this.ports.files.read(owner, path, options), after = statValue(await lstat(file, { bigint: true })); if (before !== after) complete = false; files.set(file, after); return read }
        } }, { workspaceId: workspace.id, path: '.', maxFiles: 20000, maxDirectories: 20000, maxBytes: 64 * 1024 * 1024 })
        if (scanned.result.coverage.limited || scanned.result.coverage.issues.length) complete = false
        for (const source of scanned.documents) {
          const file = await realpath(join(root, source.resource.path))
          if (!physical.has(file)) { physical.set(file, source); documents.push(source) }
        }
      } catch { complete = false }
    }
    const derived = deriveNoteCorpus(documents, complete)
    if (derived.invalid.length || derived.duplicateNoteIds.length) complete = false
    return { hostId, complete, documents, physical, directoryEntries, files, roots: JSON.stringify(workspaces.map(w => [w.hostId, w.id, w.path]).sort()) }
  }
  private async canonicalResource(scan: Scan, resource: NoteResource): Promise<NoteCorpusSource | undefined> {
    // Overlapping configured roots name one physical file; trusted history still owns its original resource.
    if (!await this.ports.target(resource)) return
    const root = await realpath(resource.workspacePath), path = await realpath(join(resource.workspacePath, resource.path))
    if (path === root || !path.startsWith(root + '/')) return
    const observed = scan.physical.get(path)
    if (observed) observed.resource = { ...resource }
    return observed
  }
  private async unchanged(scan: Scan): Promise<boolean> {
    const scope = await this.ports.workspaces()
    if (!scope.complete || scan.roots !== JSON.stringify(scope.workspaces.filter(w => w.hostId === scan.hostId).map(w => [w.hostId, w.id, w.path]).sort())) return false
    for (const [path, stat] of scan.files) { try { if (statValue(await lstat(path, { bigint: true })) !== stat) return false } catch { return false } }
    for (const [path, entries] of scan.directoryEntries) {
      const owner = scope.workspaces.find(w => w.hostId === 'local' && (path === w.path || path.startsWith(w.path + '/')))
      if (!owner) return false
      try { const current = await this.ports.files.readDirectory(owner, relative(owner.path, path) || '.'); if (JSON.stringify(current.map(e => [e.name, e.isDirectory, e.isSymlink]).sort()) !== entries) return false } catch { return false }
    }
    return true
  }
  private async laterWrite(noteId: string, resource: NoteResource, sequence: number): Promise<boolean> {
    for (const alias of await this.historyResources(resource)) {
      let before: number | undefined
      for (;;) {
        const page = await this.ports.history({ noteId, resource: alias, limit: 200, ...(before === undefined ? {} : { before }) })
        if (page.status !== 'read') throw Error('The original history tail is unconfirmed.')
        for (const event of page.entries) { if (event.sequence <= sequence) break; if (event.status !== 'not-applied') return true }
        if (!page.hasMore || page.entries.some(event => event.sequence <= sequence)) break
        const next = page.entries.at(-1)?.sequence
        if (next === undefined || next === before) throw Error('The original history tail made no progress.')
        before = next
      }
    }
    return false
  }
  private async recordOwnWrite(scan: Scan, saved: FileWriteResult | null): Promise<boolean> {
    if (!saved?.resource || saved.result.status !== 'written') return false
    const target = await this.ports.target(resourceOf(saved.resource))
    if (!target) return false
    const path = await realpath(join(saved.resource.workspacePath, saved.resource.path))
    const before = statValue(await lstat(path, { bigint: true })), observed = await this.ports.read(target.params), after = statValue(await lstat(path, { bigint: true }))
    if (before !== after || observed.result.status !== 'read' || observed.result.document.revision !== saved.result.revision) return false
    const newlyCreated = !scan.files.has(path)
    scan.files.set(path, after)
    if (newlyCreated) { const parent = path.slice(0,path.lastIndexOf('/')), name = path.slice(path.lastIndexOf('/')+1), entries=scan.directoryEntries.get(parent); if(entries)scan.directoryEntries.set(parent,JSON.stringify([...(JSON.parse(entries) as unknown[]),[name,false,false]].sort())) }
    const index = scan.documents.findIndex(d => resourceKey(d.resource) === resourceKey(resourceOf(saved.resource!)))
    const source: NoteCorpusSource = { resource: resourceOf(saved.resource), document: observed.result.document }
    if (index >= 0) scan.documents[index] = source; else scan.documents.push(source)
    return true
  }
  private async historyResources(resource: NoteResource): Promise<NoteResource[]> {
    const path = await realpath(join(resource.workspacePath, resource.path)), resources = [resource]
    for (const workspace of (await this.ports.workspaces()).workspaces.filter(w => w.hostId === resource.hostId)) {
      const root = await realpath(workspace.path).catch(() => undefined)
      if (!root || !path.startsWith(root + '/')) continue
      const alias: NoteResource = { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path: relative(root, path) }
      if (resources.some(r => resourceKey(r) === resourceKey(alias)) || !await this.ports.target(alias)) continue
      resources.push(alias)
    }
    return resources
  }
  private async entries(noteId: string, resource: NoteResource, selected: Node[]): Promise<NoteHistoryRecord[]> {
    const records: NoteHistoryRecord[] = [], found = new Set<string>(); let before: number | undefined
    for (;;) {
      const page = await this.ports.history({ noteId, resource, limit: 200, ...(before === undefined ? {} : { before }) })
      if (page.status !== 'read') throw Error('The original history range is unconfirmed.')
      for (const entry of page.entries) {
        if (entry.status !== 'committed' || entry.operation === 'delete') continue
        const full = await this.ports.operation(entry.eventId); if (!full) throw Error('An original history event is missing.'); records.push(full)
        if (full.operation !== 'delete') try { const after = includes(note(full.content)), before = full.beforeContent ? includes(note(full.beforeContent)) : []; for (const node of selected) { const id = String(node.attrs!.referenceId); if (after.filter(n => n.attrs?.referenceId === id && n.attrs?.noteId === node.attrs!.noteId).length === 1 && !before.some(n => n.attrs?.referenceId === id)) found.add(id) } } catch { /* A damaged historical body cannot certify this insertion. */ }
        if (found.size === selected.length) return records
      }
      if (!page.hasMore) return records
      const next = page.entries.at(-1)?.sequence
      if (next === undefined || next === before) throw Error('The original history range made no progress.')
      before = next
    }
  }
  private async run(params: FileShareUndoParams, context: FileWriteContext | undefined, inspect: boolean, result: FileShareUndoResult, save?: (request: FileWriteParams, action: NoteHistoryWriteAction, transferred: Record<string, NoteBlockProvenance>) => Promise<FileWriteResult & { relatedWrites?: FileWriteResult[] }>): Promise<FileShareUndoResult> {
    const request = params.destination, base = note(request.baseContent!), proposed = note(request.content), baseIncludes = includes(base), nextIncludes = includes(proposed)
    if (base.noteId !== proposed.noteId) throw new AgentMuxError('The destination Note identity changed; preserve its original draft.', 'NOTE_SHARE_UNDO_IDENTITY')
    const selected = params.referenceIds.map(id => {
      const matches = baseIncludes.filter(n => n.attrs?.referenceId === id)
      if (matches.length !== 1 || nextIncludes.some(n => n.attrs?.referenceId === id)) throw new AgentMuxError('A selected saved occurrence is absent, duplicated or still present in this proposed save.', 'NOTE_SHARE_UNDO_OCCURRENCE')
      return matches[0]!
    })
    const oldDestination = await this.ports.operation(request.operationId!), naturalFingerprint = fingerprint(params, context)
    if (oldDestination) {
      const ordinaryFingerprint = noteHistoryRevision(JSON.stringify([resourceOf(request.expectedResource), base.noteId, request.expectedRevision, request.content, context?.actor ?? null]))
      if (oldDestination.operation === 'delete' || !(oldDestination.operation === 'undo' && oldDestination.requestFingerprint === naturalFingerprint || oldDestination.operation === 'edit' && (oldDestination.requestFingerprint === ordinaryFingerprint || oldDestination.requestFingerprint === naturalFingerprint)) || oldDestination.noteId !== base.noteId || resourceKey(oldDestination.resource) !== resourceKey(resourceOf(request.expectedResource))) throw new AgentMuxError('This original save operation belongs to another undo intent or actor.', 'NOTE_OPERATION_CONFLICT')
      if (oldDestination.status !== 'committed') {
        result.destination = {resource:request.expectedResource,result:{status:oldDestination.status === 'not-applied' ? 'conflict' : 'unknown',...(oldDestination.status === 'not-applied' ? {observedRevision:oldDestination.baseRevision} : {code:'NOTE_OPERATION_UNCONFIRMED',message:'The original destination undo remains unconfirmed; it was not replayed.'}),noteHistory:{status:oldDestination.status,eventId:oldDestination.eventId,batchId:oldDestination.batchId}}} as FileWriteResult
        return {...result,status:oldDestination.status === 'not-applied' ? 'conflict' : 'unknown',code:oldDestination.status === 'not-applied' ? 'NOTE_OPERATION_NOT_APPLIED' : 'NOTE_OPERATION_UNCONFIRMED',message:'The original destination stage was not replayed. Read this exact file before resolving a confirmed conflict or checking the same unknown operation.'}
      }
      result.destination = receipt(oldDestination, request.expectedResource)
    }
    let insertionEvents: NoteHistoryRecord[] = []
    try { for (const resource of await this.historyResources(resourceOf(request.expectedResource))) insertionEvents.push(...await this.entries(base.noteId, resource, selected)) } catch { /* Exact draft save remains available without collection history. */ }
    const inserted = (n: Node) => insertionEvents.find(e => { try { return e.operation !== 'delete' && e.status === 'committed' && includes(note(e.content)).filter(x => x.attrs?.referenceId === n.attrs!.referenceId && x.attrs?.noteId === n.attrs!.noteId).length === 1 && (!e.beforeContent || !includes(note(e.beforeContent)).some(x => x.attrs?.referenceId === n.attrs!.referenceId)) } catch { return false } })
    const scan = await this.scan(request.expectedResource.hostId).catch(() => ({ hostId: request.expectedResource.hostId, complete: false, documents: [], physical: new Map<string, NoteCorpusSource>(), roots: '', directoryEntries: new Map<string,string>(), files: new Map<string,string>() })), candidates: Candidate[] = [], sourcePlans = new Map<string, {base:string;content:string}>()
    const destinationObservation = await this.canonicalResource(scan, resourceOf(request.expectedResource)).catch(() => undefined)
    let destinationContent = oldDestination ? scan.documents.find(d => resourceKey(d.resource) === resourceKey(resourceOf(request.expectedResource)))?.document.content ?? request.content : request.content
    const transferred: Record<string, NoteBlockProvenance> = {}
    for (const sharedId of new Set(selected.map(n => String(n.attrs!.noteId)))) {
      const item: FileShareCollection = { noteId: sharedId, referenceIds: selected.filter(n => n.attrs!.noteId === sharedId).map(n => String(n.attrs!.referenceId)), resource: null, source: null, deletion: null }; result.collections.push(item)
      try {
      const deletionId = stageId(request.operationId!, 'delete', sharedId), previousDeletion = await this.ports.operation(deletionId)
      if (previousDeletion?.operation === 'delete') {
        const created = await this.ports.operation(previousDeletion.source.eventId)
        const deletionInput = { path: previousDeletion.resource.path, noteId: sharedId, expectedRevision: previousDeletion.baseRevision, witness: previousDeletion.fileWitness, operationId: deletionId, creationEventId: previousDeletion.source.eventId, undoFingerprint: naturalFingerprint }
        const expected = noteHistoryRevision(JSON.stringify(['agentmux.note.shared-delete.v1', previousDeletion.resource, deletionInput, context?.actor ?? null]))
        if (!oldDestination || !created || created.operation !== 'edit' || created.status !== 'committed' || created.baseRevision !== null || created.noteId !== sharedId || resourceKey(created.resource) !== resourceKey(previousDeletion.resource) || previousDeletion.noteId !== sharedId || previousDeletion.requestFingerprint !== expected || JSON.stringify(created.fileWitness) !== JSON.stringify(previousDeletion.fileWitness)) { retain(item, 'operation-conflict', 'The derived deletion stage belongs to another original logical operation.'); continue }
        const createdNote = note(created.content), sourceOriginal = createdNote.origin?.sourceOperationId ? await this.ports.operation(createdNote.origin.sourceOperationId) : undefined
        if (sourceOriginal && sourceOriginal.operation !== 'delete') {
          const sourceObservation = await this.canonicalResource(scan, sourceOriginal.resource), own = !!sourceObservation && sourceObservation === destinationObservation
          if (own) sourceObservation.resource = resourceOf(request.expectedResource)
          const sourceId = stageId(request.operationId!, 'source', resourceKey(sourceOriginal.resource))
          const restored = own ? oldDestination : await this.ports.operation(sourceId), restoredResource = own ? resourceOf(request.expectedResource) : sourceOriginal.resource, sourceTarget = await this.ports.target(restoredResource)
          const expectedSourceFingerprint = own ? naturalFingerprint : noteHistoryRevision(JSON.stringify([naturalFingerprint, sourceId]))
          if (sourceTarget && restored?.operation === 'undo' && restored.status === 'committed' && restored.noteId === sourceOriginal.noteId && resourceKey(restored.resource) === resourceKey(restoredResource) && restored.requestFingerprint === expectedSourceFingerprint) item.source = receipt(restored, sourceTarget.resource)
        }
        const target = await this.ports.target(previousDeletion.resource)
        if (target) { item.resource = target.resource; item.deletion = { resource: target.resource, result: { status: previousDeletion.status === 'committed' ? 'deleted' : previousDeletion.status === 'not-applied' ? 'conflict' : 'unknown', ...(previousDeletion.retainedPath ? { retainedPath: previousDeletion.retainedPath } : {}), noteHistory: { status: previousDeletion.status, eventId: previousDeletion.eventId, batchId: previousDeletion.batchId } } } }
        if (!target) retain(item, 'resource-unconfirmed', 'The original deleted resource mapping is unconfirmed.')
        continue
      }
      if (!selected.filter(n => n.attrs!.noteId === sharedId).every(n => inserted(n))) { retain(item, 'history-unconfirmed', 'The exact saved insertion history is unconfirmed; the ordinary proposed save is preserved.'); continue }
      const targets = scan.documents.filter(d => { const p = readNoteDocument(d.document.content); return p.status === 'valid' && p.note.noteId === sharedId })
      if (targets.length !== 1) { retain(item, 'identity-unconfirmed', 'The shared Markdown identity is missing or duplicated.'); continue }
      const original = targets[0]!, current = note(original.document.content), origin = current.origin
      let target = await this.ports.target(original.resource)
      if (!origin || current.kind !== 'shared-block' || !target) { retain(item, 'origin-unconfirmed', 'The exact original shared declaration or file resource is unconfirmed.'); continue }
      item.resource = target.resource
      const create = await this.ports.operation(origin.operationId + ':create')
      if (!create || create.operation !== 'edit' || create.status !== 'committed' || create.noteId !== sharedId || create.baseRevision !== null || create.resource.hostId !== original.resource.hostId || await this.canonicalResource(scan, create.resource) !== original || JSON.stringify(note(create.content).origin) !== JSON.stringify(origin)) { retain(item, 'origin-unconfirmed', 'The declaration does not match its trusted original creation.'); continue }
      target = await this.ports.target(create.resource)
      if (!target) { retain(item, 'origin-unconfirmed', 'The original creation resource is unavailable.'); continue }
      item.resource = target.resource
      const sourceEvent = origin.sourceOperationId ? await this.ports.operation(origin.sourceOperationId) : undefined
      if (!sourceEvent || sourceEvent.operation === 'delete' || sourceEvent.status !== 'committed' || sourceEvent.noteId !== origin.sourceNoteId) { retain(item, 'source-unconfirmed', 'The original source replacement phase is unconfirmed.'); continue }
      const sourceObservation = await this.canonicalResource(scan, sourceEvent.resource), ownDestination = !!sourceObservation && sourceObservation === destinationObservation
      if (ownDestination) sourceObservation.resource = resourceOf(request.expectedResource)
      const source = await this.ports.target(sourceEvent.resource)
      if (!source) { retain(item, 'source-unconfirmed', 'The original source file resource cannot be resolved.'); continue }
      const sourceReferenceId = origin.operationId + ':source', sourceOperationId = stageId(request.operationId!, 'source', resourceKey(sourceEvent.resource)), oldSource = ownDestination ? undefined : await this.ports.operation(sourceOperationId)
      if (oldSource) {
        const expected = noteHistoryRevision(JSON.stringify([naturalFingerprint, sourceOperationId]))
        if (oldSource.operation !== 'undo' || oldSource.requestFingerprint !== expected || oldSource.noteId !== sourceEvent.noteId || resourceKey(oldSource.resource) !== resourceKey(sourceEvent.resource)) { retain(item, 'source-unconfirmed', 'The same source-stage identity belongs to another or unconfirmed original action.'); continue }
        if (oldSource.status !== 'committed') { item.source = {resource:source.resource,result:{status:oldSource.status === 'not-applied' ? 'error' : 'unknown',code:'NOTE_OPERATION_UNCONFIRMED',message:'The original source restoration is not committed; it was not replayed.',noteHistory:{status:oldSource.status,eventId:oldSource.eventId,batchId:oldSource.batchId}}}; retain(item,'source-unconfirmed','The same original source restoration is unconfirmed.'); continue }
        item.source = receipt(oldSource, source.resource)
      } else if (ownDestination && oldDestination && !includes(note(oldDestination.content)).some(n => n.attrs?.referenceId === sourceReferenceId)) item.source = result.destination
      if (!scan.complete) { retain(item, 'scope-unconfirmed', 'The managed Note file scope is incomplete or ambiguous. The shared Markdown is retained.'); continue }
      if (params.preserveNoteIds?.includes(sharedId) || params.preserveNoteIds?.includes(sourceEvent.noteId)) { retain(item, 'dirty-draft', 'An existing local draft or unresolved input still needs this shared file.'); continue }
      if (!create.fileWitness || original.document.revision !== create.revision || await this.laterWrite(sharedId, original.resource, create.sequence)) { retain(item, 'later-edit', 'A later edit or unconfirmed write exists, or the original creation generation is unavailable.'); continue }
      const actualWitness = await witness(join(original.resource.workspacePath, original.resource.path))
      if (JSON.stringify(actualWitness) !== JSON.stringify(create.fileWitness)) { retain(item, 'later-edit', 'The original kernel file generation changed since creation.'); continue }
      let sourceContent: string
      const observed = ownDestination ? { result: { status: 'read' as const, document: { content: destinationContent, revision: request.expectedRevision } } } : await this.ports.read(source.params)
      if (!observed || observed.result.status !== 'read') { retain(item, 'source-changed', 'The original source cannot be read accurately.'); continue }
      const sourcePlan = sourcePlans.get(resourceKey(sourceEvent.resource)) ?? {base:observed.result.document.content,content:observed.result.document.content}
      const sourceNote = note(ownDestination ? destinationContent : sourcePlan.content), automatic = includes(sourceNote).filter(n => n.attrs?.referenceId === sourceReferenceId && n.attrs.blockId === origin.sourceBlockId && n.attrs.noteId === sharedId)
      if (sourceNote.noteId !== sourceEvent.noteId) { retain(item, 'source-changed', 'The current source Note identity differs from its original sharing event.'); continue }
      const historicalAutomatic = includes(note(sourceEvent.content)).filter(n => n.attrs?.referenceId === sourceReferenceId && n.attrs.blockId === origin.sourceBlockId && n.attrs.noteId === sharedId)
      if (historicalAutomatic.length !== 1 || automatic.length !== 1 && !(oldSource?.operation === 'undo' && oldSource.status === 'committed') && !(ownDestination && result.destination)) { retain(item, 'source-changed', 'The exact original automatic include changed; its current content is retained.'); continue }
      const graph = deriveNoteCorpus(scan.documents.map(d => resourceKey(d.resource) === resourceKey(resourceOf(request.expectedResource)) ? { ...d, document: { ...d.document, content: destinationContent, revision: noteHistoryRevision(destinationContent) } } : d), true)
      const other = graph.references.some(ref => {
        if (resourceKey(ref.sourceResource) === resourceKey(ownDestination ? resourceOf(request.expectedResource) : sourceEvent.resource) && ref.occurrence.kind === 'stored' && ref.occurrence.referenceId === sourceReferenceId && ref.source.blockId === origin.sourceBlockId) return false
        return ref.target.kind === 'unbound' ? ref.resolution === 'unknown' || ref.resolution === 'ambiguous' : ref.target.noteId === sharedId
      })
      // A remaining occurrence in the same proposed draft is also a use, including newly pasted ones.
      if (other || includes(note(destinationContent)).some(n => n.attrs?.noteId === sharedId && !(ownDestination && n.attrs.referenceId === sourceReferenceId))) { retain(item, 'other-references', 'Another saved or proposed occurrence still uses this shared Markdown.'); continue }
      sourceContent = automatic.length ? serializeNoteDocument({ ...sourceNote, content: replace(sourceNote.content, sourceReferenceId, structuredClone(note(create.content).content.content ?? []))[0]! }) : observed.result.document.content
      note(sourceContent)
      if (ownDestination && !result.destination) { destinationContent = sourceContent; Object.assign(transferred, create.provenance?.blocks) }
      if (oldSource) {
        const expected = noteHistoryRevision(JSON.stringify([naturalFingerprint, sourceOperationId]))
        if (oldSource.operation !== 'undo' || oldSource.requestFingerprint !== expected || oldSource.noteId !== sourceEvent.noteId || resourceKey(oldSource.resource) !== resourceKey(sourceEvent.resource)) { retain(item, 'source-unconfirmed', 'The same source-stage identity belongs to another or unconfirmed original action.'); continue }
        item.source = receipt(oldSource, source.resource)
      }
      else if (ownDestination && result.destination) item.source = result.destination
      sourcePlans.set(resourceKey(sourceEvent.resource), { ...sourcePlan, content: sourceContent })
      candidates.push({ item, create, originalSource: sourceEvent, source, sourceOperationId, sourceReferenceId, ownDestination, blocks: create.provenance?.blocks ?? {}, deletionId })
      } catch (error) { retain(item, 'collection-unconfirmed', 'Optional collection evidence is unavailable; the proposed save remains available. ' + (error instanceof Error ? error.message : String(error))) }
    }
    if (inspect) { result.status = confirmed(result.destination) && !result.collections.some(item => item.source && !confirmed(item.source) || item.deletion?.result.status === 'unknown') && result.collections.every(item => item.retainedReason || item.deletion?.result.status === 'deleted') ? result.collections.some(item => item.retainedReason && confirmed(item.source)) ? 'partial' : 'committed' : 'unknown'; return result }
    if (!result.destination) {
      const source: NoteHistorySource = { kind: 'shared', eventIds: [...new Set(selected.map(n => inserted(n)?.eventId).filter((id): id is string => !!id))], referenceIds: params.referenceIds }
      // Missing insertion history only narrows collection. Record this exact ordinary proposed save instead.
      const action: NoteHistoryWriteAction = 'eventIds' in source && source.eventIds.length ? { operation: 'undo', noteId: base.noteId, source, fingerprint: naturalFingerprint, draft: true } : { operation: 'edit', noteId: base.noteId, fingerprint: naturalFingerprint, draft: true }
      if (save) {
        const saved = await save({ ...request, content: destinationContent }, action, transferred), { relatedWrites, ...destination } = saved
        result.destination = destination
        for (const related of relatedWrites ?? []) if (confirmed(related) && !await this.recordOwnWrite(scan, related)) result.collections.forEach(item => retain(item, 'scope-changed', 'A related original shared-save resource changed after its confirmed write.'))
      } else result.destination = 'eventIds' in source && source.eventIds.length ? await this.ports.writeInverse({ ...request, content: destinationContent }, context, action, transferred) : await this.ports.write(request, context)
      if (!confirmed(result.destination)) return { ...result, status: result.destination.result.status === 'conflict' ? 'conflict' : 'unknown' }
      if (!await this.recordOwnWrite(scan, result.destination)) result.collections.forEach(item => retain(item, 'scope-changed', 'The destination changed after its confirmed save; the shared content is retained.'))
      await this.ports.afterStage?.('destination', request.operationId!)
    }
    for (const candidate of candidates) if (candidate.ownDestination) candidate.item.source = result.destination
    const graphAfterSave = deriveNoteCorpus(scan.documents, scan.complete)
    for (const candidate of candidates) if (!candidate.item.retainedReason) {
      const other = graphAfterSave.references.some(ref => {
        if (resourceKey(ref.sourceResource) === resourceKey(candidate.ownDestination ? resourceOf(request.expectedResource) : candidate.originalSource.resource) && ref.source.blockId === note(candidate.create.content).origin!.sourceBlockId && ref.occurrence.kind === 'stored' && ref.occurrence.referenceId === candidate.sourceReferenceId) return false
        return ref.target.kind === 'unbound' ? ref.resolution === 'unknown' || ref.resolution === 'ambiguous' : ref.target.noteId === candidate.item.noteId
      })
      if (other) retain(candidate.item, 'other-references', 'Another current saved occurrence uses this shared file; its original source include is retained where still present.')
    }
    if (!await this.unchanged(scan)) for (const candidate of candidates) if (!candidate.item.retainedReason) retain(candidate.item, 'scope-changed', 'A managed resource changed after destination save; optional source restoration has not started.')
    const groups = new Map<string, Candidate[]>()
    for (const candidate of candidates.filter(c => !c.item.retainedReason)) { const key = resourceKey(candidate.ownDestination ? resourceOf(request.expectedResource) : candidate.originalSource.resource); const group = groups.get(key) ?? []; group.push(candidate); groups.set(key, group) }
    for (const group of groups.values()) {
      const first = group[0]!, source = first.source, ownDestination = first.ownDestination
      let written: FileWriteResult | null = ownDestination ? result.destination : group.find(c => c.item.source)?.item.source ?? null
      if (!written) {
        const current = await this.ports.read(source.params)
        if (current.result.status !== 'read') { group.forEach(c => retain(c.item, 'source-changed', 'The original source observation changed before restoration.')); continue }
        const planned = sourcePlans.get(resourceKey(first.originalSource.resource))!, original = note(planned.base)
        let restored = note(current.result.document.content), exact = true
        for (const candidate of group) {
          const before = includes(original).filter(n => n.attrs?.referenceId === candidate.sourceReferenceId), actual = includes(restored).filter(n => n.attrs?.referenceId === candidate.sourceReferenceId)
          if (before.length !== 1 || actual.length !== 1 || JSON.stringify(before[0]) !== JSON.stringify(actual[0])) { exact = false; break }
          restored = { ...restored, content: replace(restored.content, candidate.sourceReferenceId, structuredClone(note(candidate.create.content).content.content ?? []))[0]! }
        }
        if (!exact) { group.forEach(c => retain(c.item, 'source-changed', 'The exact automatic source include changed before restoration.')); continue }
        const content = serializeNoteDocument(restored); note(content)
        const input: FileWriteParams = { ...source.params, expectedResource: source.resource, expectedRevision: current.result.document.revision, baseContent: current.result.document.content, content, operationId: first.sourceOperationId }
        written = await this.ports.writeInverse(input, context, { operation: 'undo', noteId: first.originalSource.noteId, source: { kind: 'shared', eventIds: [...new Set(group.flatMap(c => [c.create.eventId, c.originalSource.eventId]))], referenceIds: group.map(c => c.sourceReferenceId) }, fingerprint: noteHistoryRevision(JSON.stringify([naturalFingerprint, first.sourceOperationId])) }, Object.assign({}, ...group.map(c => c.blocks)))
      }
      const stable = await this.recordOwnWrite(scan, written)
      for (const candidate of group) { candidate.item.source = written; if (!stable) retain(candidate.item, 'scope-changed', 'The restored source changed after its confirmed save; shared content is retained.') }
      await this.ports.afterStage?.('source', first.sourceOperationId)
    }
    for (const candidate of candidates) {
      const { item, create } = candidate
      if (item.retainedReason) continue
      if (!confirmed(item.source) || !await this.unchanged(scan)) { retain(item, 'scope-changed', 'A managed scope resource changed during the operation; the shared Markdown is retained.'); continue }
      // The target has its own Zone mapping, which may differ from the source Zone.
      const target = await this.ports.target(resourceOf(item.resource!))
      const observed = target ? await this.ports.read(target.params) : null
      if (!observed || observed.result.status !== 'read' || observed.result.document.revision !== create.revision || await this.laterWrite(create.noteId, create.resource, create.sequence) || JSON.stringify(await witness(join(create.resource.workspacePath, create.resource.path))) !== JSON.stringify(create.fileWitness)) { retain(item, 'later-edit', 'The shared file changed during restoration; its content is retained.'); continue }
      item.deletion = { resource: item.resource!, result: await this.ports.delete(create.resource, { path: create.resource.path, noteId: create.noteId, expectedRevision: create.revision, witness: create.fileWitness!, operationId: candidate.deletionId, creationEventId: create.eventId, undoFingerprint: naturalFingerprint }, context) }
      if (item.deletion.result.status === 'conflict' || item.deletion.result.status === 'error') retain(item, 'delete-not-applied', 'The original source was restored; exact file collection was not applied. The shared file is retained.')
      if (item.deletion.result.status === 'deleted') {
        const path = join(create.resource.workspacePath, create.resource.path); scan.files.delete(path)
        scan.documents = scan.documents.filter(d => resourceKey(d.resource) !== resourceKey(create.resource))
        const parent = path.slice(0, path.lastIndexOf('/')), name = path.slice(path.lastIndexOf('/') + 1), entries = scan.directoryEntries.get(parent)
        if (entries) scan.directoryEntries.set(parent, JSON.stringify((JSON.parse(entries) as [string,boolean,boolean][]).filter(e => e[0] !== name)))
      }
      await this.ports.afterStage?.('deletion', candidate.deletionId)
    }
    result.status = confirmed(result.destination) && !result.collections.some(item => item.source && !confirmed(item.source) || item.deletion?.result.status === 'unknown') && result.collections.every(item => item.retainedReason || item.deletion?.result.status === 'deleted') ? result.collections.some(item => item.retainedReason && confirmed(item.source)) ? 'partial' : 'committed' : 'unknown'
    return result
  }
}
