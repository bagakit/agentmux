import { FileResourceOwner } from './file-resource.js'
import type { FileShareParams, FileShareResult, FileShareInspectParams, FileShareInspectResult, FileShareUndoParams, FileShareUndoResult, AgentMuxRpcFileShareOwner } from '@agentmux/core/files'
import { AgentMuxError, parseFileCreateParams, type FileCreateParams, type FileCreateResult, parseFileWriteParams, type FileWriteParams, type FileWriteResult, type FileWriteContext, type AgentMuxRpcFilesOwner, type FileReadParams, type FileReadResource } from '@agentmux/core'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { WorkspaceRecord, WorkspaceFileRestoreInput, WorkspaceFileUndoInput, WorkspaceFileWriteResult } from './content-types.js'
import type { ScratchDirectoryFact } from './mote-topic-model.js'
import type { WorkspaceFiles } from './content-types.js'
import { parseFileHistoryParams, type FileHistoryParams, type FileHistoryResult, parseFileRestoreParams, parseFileUndoParams, type FileRestoreParams, type FileRestoreResult, type FileUndoParams, type FileUndoResult } from '@agentmux/core/files'
import type { NoteHistoryQuery, NoteHistorySnapshot } from '@agentmux/core/note-history'
import { fileUploadRevision, parseFileImportParams, type FileImportParams, type FileImportResult } from '@agentmux/core/files'

const publicWrite = (value: WorkspaceFileWriteResult): WorkspaceFileWriteResult => { if (value.status !== 'written') return value; const { fileWitness: _internal, ...receipt } = value; return receipt }

/** Resolve once from original spatial/resource facts, then delegate to original Files. */
export class FileReadOwner<W extends WorkspaceRecord = WorkspaceRecord> extends FileResourceOwner<W> implements AgentMuxRpcFilesOwner {
  constructor(protected override readonly ports: {
    share?: AgentMuxRpcFileShareOwner
    catalog(): Promise<AgentMuxSpaceCatalog | null>
    /** Original closed Zone descriptor from the same durable spatial resource owner. */
    retiredZone?(zoneId: string): Promise<unknown>
    topicForDirectory?(workspace: W, directory: string): Promise<ScratchDirectoryFact | null>
    workspace(id: string): W | undefined
    files: Pick<WorkspaceFiles<W>, 'read' | 'listFiles'> & {
      writeBytes?(workspace: W, input: Parameters<WorkspaceFiles<W>['writeBytes']>[1]): ReturnType<WorkspaceFiles<W>['writeBytes']>
      write(workspace: W, input: Parameters<WorkspaceFiles<W>['write']>[1], context?: FileWriteContext): ReturnType<WorkspaceFiles<W>['write']>
      writeSharedUndo?(workspace: W, input: Parameters<WorkspaceFiles<W>['write']>[1], context: FileWriteContext | undefined, action: import('./note-history-actions.js').NoteHistoryWriteAction, transferred?: Record<string, import('@agentmux/core/note-provenance').NoteBlockProvenance>): Promise<WorkspaceFileWriteResult>
      createShared?(workspace: W, input: Parameters<WorkspaceFiles<W>['write']>[1], context: FileWriteContext | undefined, source: { workspace: W; input: Parameters<WorkspaceFiles<W>['write']>[1] }): Promise<WorkspaceFileWriteResult>
      history?(workspace: W, input: Omit<NoteHistoryQuery, 'resource'> & { path: string }): Promise<NoteHistorySnapshot>
      restore?(workspace: W, input: WorkspaceFileRestoreInput, context?: FileWriteContext): Promise<WorkspaceFileWriteResult>
      undo?(workspace: W, input: WorkspaceFileUndoInput, context?: FileWriteContext): Promise<WorkspaceFileWriteResult>
    }
  }) { super(ports) }
  async share(input: FileShareParams, context?: FileWriteContext): Promise<FileShareResult> {
    if (!this.ports.share) throw new AgentMuxError('The original shared Markdown owner is unavailable; ordinary files remain available.', 'CONTROL_UNAVAILABLE')
    return this.ports.share.share(input, context)
  }
  async undoShare(input: FileShareUndoParams, context?: FileWriteContext): Promise<FileShareUndoResult> {
    if (!this.ports.share?.undoShare) throw new AgentMuxError('The original shared undo owner is unavailable. Ordinary files remain available.', 'CONTROL_UNAVAILABLE')
    return this.ports.share.undoShare(input, context)
  }
  /** Internal mapping from trusted history/corpus facts, never a synthetic Zone. */
  async targetForNote(original: import('@agentmux/core').NoteResource): Promise<{ params: FileReadParams; resource: FileReadResource } | null> {
    const catalog = await this.ports.catalog()
    if (!catalog) return null
    for (const zone of catalog.zones) {
      if (zone.workspaceId !== original.workspaceId || zone.hostId !== original.hostId || !zone.directoryPath) continue
      const root = original.workspacePath.replace(/\/+$/u, ''), directory = zone.directoryPath === root ? '' : zone.directoryPath.startsWith(root + '/') ? zone.directoryPath.slice(root.length + 1) : null
      if (directory === null || directory && !original.path.startsWith(directory + '/')) continue
      const params: FileReadParams = { zoneId: zone.zoneId, path: directory ? original.path.slice(directory.length + 1) : original.path, expectedResource: { hostId: original.hostId, workspaceId: original.workspaceId, workspacePath: original.workspacePath } }
      const resolved = await this.resolve(params)
      if (!('message' in resolved) && resolved.resource.path === original.path) return { params, resource: resolved.resource }
    }
    return null
  }
  async writeSharedInverse(input: FileWriteParams, context: FileWriteContext | undefined, action: import('./note-history-actions.js').NoteHistoryWriteAction, transferred?: Record<string, import('@agentmux/core/note-provenance').NoteBlockProvenance>): Promise<FileWriteResult> {
    const params = parseFileWriteParams(input), resolved = await this.resolve(params)
    if ('message' in resolved || !this.ports.files.writeSharedUndo) return { resource: null, result: { status: 'unknown', code: 'NOTE_SHARED_UNDO_UNAVAILABLE', message: 'The original inverse writer is unavailable. The file and draft are preserved.' } }
    const { resource, workspace } = resolved
    if (['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'path', 'logicalDirectory'].some(key => resource[key as keyof FileReadResource] !== params.expectedResource[key as keyof FileReadResource])) throw new AgentMuxError('The original inverse file mapping changed.', 'FILE_RESOURCE_MISMATCH')
    return { resource, result: await this.ports.files.writeSharedUndo(workspace, { path: resource.path, content: params.content, expectedRevision: params.expectedRevision, baseContent: params.baseContent!, operationId: params.operationId! }, context, action, transferred) }
  }
  async inspectShare(input: FileShareInspectParams, context?: FileWriteContext): Promise<FileShareInspectResult> {
    if (!this.ports.share) throw new AgentMuxError('The original shared Markdown owner is unavailable; ordinary files remain available.', 'CONTROL_UNAVAILABLE')
    return this.ports.share.inspectShare(input, context)
  }
  /** Trusted original-owner-only exclusive creation, with its durable per-file history operation. */
  async createShared(input: FileCreateParams, operationId: string, context?: FileWriteContext, source?: FileWriteParams): Promise<FileCreateResult> {
    const params = parseFileCreateParams(input), resolved = await this.resolve(params)
    if ('message' in resolved) return { resource: null, result: { status: 'unknown', code: 'FILE_CREATE_UNCONFIRMED', message: resolved.message } }
    const { resource, workspace } = resolved
    if (['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'path', 'logicalDirectory'].some(key => resource[key as keyof FileReadResource] !== params.expectedResource[key as keyof FileReadResource])) throw new AgentMuxError('The original shared Markdown mapping changed. Keep the original draft and inspect that target.', 'FILE_RESOURCE_MISMATCH')
    try {
      const write = { path: resource.path, content: params.content, expectedRevision: null, operationId }
      if (source) {
        const original = await this.resolve(source)
        if ('message' in original || !this.ports.files.createShared) return { resource, result: { status: 'unknown', code: 'NOTE_SHARE_SOURCE_UNCONFIRMED', message: 'The original source owner is unavailable. Original files and drafts are retained.' } }
        if (['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'path', 'logicalDirectory'].some(key => original.resource[key as keyof FileReadResource] !== source.expectedResource[key as keyof FileReadResource])) throw new AgentMuxError('The original source mapping changed before extraction.', 'FILE_RESOURCE_MISMATCH')
        return { resource, result: await this.ports.files.createShared(workspace, write, context, { workspace: original.workspace, input: { path: original.resource.path, content: source.content, expectedRevision: source.expectedRevision, ...(source.baseContent === undefined ? {} : { baseContent: source.baseContent }) } }) }
      }
      return { resource, result: publicWrite(await this.ports.files.write(workspace, write, context)) }
    }
    catch (error) { return { resource, result: { status: 'unknown', code: 'FILE_CREATE_UNCONFIRMED', message: error instanceof Error ? error.message : String(error) } } }
  }
  async history(input: FileHistoryParams): Promise<FileHistoryResult> {
    const params = parseFileHistoryParams(input), resolved = await this.resolve(params)
    if ('message' in resolved) return { resource: null, result: { status: 'unknown', code: 'FILE_HISTORY_UNCONFIRMED', message: resolved.message } }
    const { resource, workspace } = resolved
    if (['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'path', 'logicalDirectory'].some(key => resource[key as keyof FileReadResource] !== params.expectedResource[key as keyof FileReadResource])) throw new AgentMuxError('The original history resource mapping changed. Inspect the exact file before querying it again.', 'FILE_RESOURCE_MISMATCH')
    try {
      if (!this.ports.files.history) throw new Error('The original Note history owner is unavailable. Files and Agents remain available.')
      const result = await this.ports.files.history(workspace, { noteId: params.noteId, path: resource.path,
        ...(params.limit === undefined ? {} : { limit: params.limit }), ...(params.before === undefined ? {} : { before: params.before }),
        ...(params.eventId === undefined ? {} : { eventId: params.eventId }), ...(params.includeContent === undefined ? {} : { includeContent: params.includeContent }) })
      const current = this.ports.workspace(workspace.id)
      if (!current || current.hostId !== workspace.hostId || current.path !== workspace.path) throw new Error('The original File resource changed during history observation. Keep the original reference and refresh it.')
      return { resource, result }
    } catch (error) { return { resource, result: { status: 'unknown', code: 'FILE_HISTORY_UNCONFIRMED', message: error instanceof Error ? error.message : String(error) } } }
  }
  async import(input: FileImportParams): Promise<FileImportResult> {
    const params = parseFileImportParams(input), resolved = await this.resolve(params)
    const operationId = params.operationId
    if ('message' in resolved) return { operationId, resource: null, result: { status: 'unknown', code: 'FILE_IMPORT_UNCONFIRMED', message: resolved.message } }
    const { resource, workspace } = resolved
    if (['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'path', 'logicalDirectory'].some(key => resource[key as keyof FileReadResource] !== params.expectedResource[key as keyof FileReadResource])) throw new AgentMuxError('The original import mapping changed. Keep the selected file and draft; inspect that exact target.', 'FILE_RESOURCE_MISMATCH')
    const bytes = Buffer.from(params.dataBase64, 'base64')
    if (bytes.byteLength !== params.byteLength || bytes.toString('base64') !== params.dataBase64 || fileUploadRevision(bytes) !== params.revision)
      return { operationId, resource, result: { status: 'error', code: 'FILE_IMPORT_CONTENT_MISMATCH', message: 'The selected bytes differ from their original revision. Nothing was written.' } }
    if (!this.ports.files.writeBytes) return { operationId, resource, result: { status: 'error', code: 'FILE_IMPORT_UNAVAILABLE', message: 'This Host has no byte import owner. Your selected file and Note draft are retained.' } }
    try {
      const result = await this.ports.files.writeBytes(workspace, { path: resource.path, bytes })
      if (result.status === 'written') {
        if (result.revision !== params.revision) return { operationId, resource, result: { status: 'unknown', code: 'FILE_IMPORT_UNCONFIRMED', message: 'The returned revision differs from the selected bytes. Inspect this original file before another import.' } }
        return { operationId, resource, result: { status: 'written', revision: result.revision, byteLength: bytes.byteLength } }
      }
      return { operationId, resource, result }
    } catch (error) { return { operationId, resource, result: { status: 'unknown', code: 'FILE_IMPORT_UNCONFIRMED', message: error instanceof Error ? error.message : String(error) } } }
  }
  async restore(input: FileRestoreParams, context?: FileWriteContext): Promise<FileRestoreResult> {
    const params = parseFileRestoreParams(input), resolved = await this.resolve(params)
    if ('message' in resolved) return { resource: null, result: { status: 'unknown', code: 'FILE_RESTORE_UNCONFIRMED', message: resolved.message } }
    const { resource, workspace } = resolved
    if (['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'path', 'logicalDirectory'].some(key => resource[key as keyof FileReadResource] !== params.expectedResource[key as keyof FileReadResource])) throw new AgentMuxError('The original restore mapping changed. Read the exact file before deciding another operation.', 'FILE_RESOURCE_MISMATCH')
    if (!this.ports.files.restore) return { resource, result: { status: 'error', code: 'CONTROL_UNAVAILABLE', message: 'The original restore owner is unavailable. Original files, history and Agents remain available.' } }
    try { return { resource, result: await this.ports.files.restore(workspace, { path: resource.path, noteId: params.noteId, expectedRevision: params.expectedRevision, operationId: params.operationId, eventId: params.eventId }, context) } }
    catch (error) { return { resource, result: { status: 'unknown', code: 'FILE_RESTORE_UNCONFIRMED', message: error instanceof Error ? error.message : String(error) } } }
  }
  async undo(input: FileUndoParams, context?: FileWriteContext): Promise<FileUndoResult> {
    const params = parseFileUndoParams(input), resolved = await this.resolve(params)
    if ('message' in resolved) return { resource: null, result: { status: 'unknown', code: 'FILE_UNDO_UNCONFIRMED', message: resolved.message } }
    const { resource, workspace } = resolved
    if (['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'path', 'logicalDirectory'].some(key => resource[key as keyof FileReadResource] !== params.expectedResource[key as keyof FileReadResource])) throw new AgentMuxError('The original undo mapping changed. Read the exact file before deciding another operation.', 'FILE_RESOURCE_MISMATCH')
    if (!this.ports.files.undo) return { resource, result: { status: 'error', code: 'CONTROL_UNAVAILABLE', message: 'The original undo owner is unavailable. Original files, history and Agents remain available.' } }
    try { return { resource, result: await this.ports.files.undo(workspace, { path: resource.path, noteId: params.noteId, expectedRevision: params.expectedRevision, operationId: params.operationId, batchId: params.batchId, batchLastEventId: params.batchLastEventId }, context) } }
    catch (error) { return { resource, result: { status: 'unknown', code: 'FILE_UNDO_UNCONFIRMED', message: error instanceof Error ? error.message : String(error) } } }
  }
}
