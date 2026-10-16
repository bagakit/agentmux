import type { FileShareParams, FileShareResult, FileShareInspectParams, FileShareInspectResult, FileShareUndoParams, FileShareUndoResult, AgentMuxRpcFileShareOwner } from '@agentmux/core/files'
import { AgentMuxError, parseFileReadParams, parseFileCreateParams, type FileCreateParams, type FileCreateResult, parseFileWriteParams, type FileWriteParams, type FileWriteResult, type FileWriteContext, parseFileListParams, type AgentMuxRpcFilesOwner, type FileReadParams, type FileReadResource, type FileReadResult, type FileListParams, type FileListResult } from '@agentmux/core'
import type { AgentMuxSpaceCatalog, AgentMuxZoneFact } from '@agentmux/core/control'
import type { WorkspaceRecord, WorkspaceFileRestoreInput, WorkspaceFileUndoInput, WorkspaceFileWriteResult } from '../shared/contracts'
import { SCRATCH_WORKSPACE_ID, type ScratchDirectoryFact } from '../shared/scratch-topics'
import { zoneFileResource } from '../shared/zone-file-resource'
import type { WorkspaceFiles } from './workspace-files'
import type { WorkspaceFileReadBudget } from '../shared/workspace-file-bytes'
import { parseFileHistoryParams, type FileHistoryParams, type FileHistoryResult, parseFileRestoreParams, parseFileUndoParams, type FileRestoreParams, type FileRestoreResult, type FileUndoParams, type FileUndoResult } from '@agentmux/core/files'
import type { NoteHistoryQuery, NoteHistorySnapshot } from '@agentmux/core/note-history'

const publicWrite = (value: WorkspaceFileWriteResult): WorkspaceFileWriteResult => { if (value.status !== 'written') return value; const { fileWitness: _internal, ...receipt } = value; return receipt }

/** Resolve once from original spatial/resource facts, then delegate to original Files. */
export class FileReadOwner implements AgentMuxRpcFilesOwner {
  constructor(private readonly ports: {
    share?: AgentMuxRpcFileShareOwner
    catalog(): Promise<AgentMuxSpaceCatalog | null>
    /** Original closed Zone descriptor from the same durable spatial resource owner. */
    retiredZone?(zoneId: string): Promise<unknown>
    topicForDirectory?(workspace: WorkspaceRecord, directory: string): Promise<ScratchDirectoryFact | null>
    workspace(id: string): WorkspaceRecord | undefined
    files: Pick<WorkspaceFiles, 'read' | 'listFiles'> & {
      write(workspace: WorkspaceRecord, input: Parameters<WorkspaceFiles['write']>[1], context?: FileWriteContext): ReturnType<WorkspaceFiles['write']>
      writeSharedUndo?(workspace: WorkspaceRecord, input: Parameters<WorkspaceFiles['write']>[1], context: FileWriteContext | undefined, action: import('./note-history-actions.js').NoteHistoryWriteAction, transferred?: Record<string, import('@agentmux/core/note-provenance').NoteBlockProvenance>): Promise<WorkspaceFileWriteResult>
      createShared?(workspace: WorkspaceRecord, input: Parameters<WorkspaceFiles['write']>[1], context: FileWriteContext | undefined, source: { workspace: WorkspaceRecord; input: Parameters<WorkspaceFiles['write']>[1] }): Promise<WorkspaceFileWriteResult>
      history?(workspace: WorkspaceRecord, input: Omit<NoteHistoryQuery, 'resource'> & { path: string }): Promise<NoteHistorySnapshot>
      restore?(workspace: WorkspaceRecord, input: WorkspaceFileRestoreInput, context?: FileWriteContext): Promise<WorkspaceFileWriteResult>
      undo?(workspace: WorkspaceRecord, input: WorkspaceFileUndoInput, context?: FileWriteContext): Promise<WorkspaceFileWriteResult>
    }
  }) {}
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
  async read(input: FileReadParams, budget?: WorkspaceFileReadBudget): Promise<FileReadResult> {
    budget?.signal?.throwIfAborted()
    const params = parseFileReadParams(input)
    if (params.maxBytes !== undefined) budget = { ...budget, maxFileBytes: Math.min(params.maxBytes, budget?.maxFileBytes ?? params.maxBytes) }
    const resolved = await this.resolve(params)
    if ('message' in resolved) return { resource: null, result: { status: 'unknown', code: 'FILE_READ_UNCONFIRMED', message: resolved.message } }
    const { resource, workspace } = resolved
    try { return { resource, result: await this.ports.files.read(workspace, resource.path, budget) } }
    catch (error) { return { resource, result: { status: 'unknown', code: 'FILE_READ_UNCONFIRMED', message: error instanceof Error ? error.message : String(error) } } }
  }
  async list(input: FileListParams, options?: { signal?: AbortSignal }): Promise<FileListResult> {
    options?.signal?.throwIfAborted()
    const params = parseFileListParams(input), resolved = await this.resolve(params)
    if ('message' in resolved) return { resource: null, result: { status: 'unknown', code: 'FILE_LIST_UNCONFIRMED', message: resolved.message } }
    const { resource, workspace } = resolved
    try {
      const result = await this.ports.files.listFiles(workspace, resource.path, params.limit, options)
      const current = this.ports.workspace(workspace.id)
      if (!current || current.hostId !== workspace.hostId || current.path !== workspace.path) throw new Error('The original File resource changed during discovery. Inspect it before retrying.')
      return { resource, result }
    } catch (error) { return { resource, result: { status: 'unknown', code: 'FILE_LIST_UNCONFIRMED', message: error instanceof Error ? error.message : String(error) } } }
  }
  async write(input: FileWriteParams, context?: FileWriteContext): Promise<FileWriteResult> {
    const params = parseFileWriteParams(input), resolved = await this.resolve(params)
    if ('message' in resolved) return { resource: null, result: { status: 'unknown', code: 'FILE_WRITE_UNCONFIRMED', message: resolved.message } }
    const { resource, workspace } = resolved
    if (['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'path', 'logicalDirectory'].some(key => resource[key as keyof FileReadResource] !== params.expectedResource[key as keyof FileReadResource])) throw new AgentMuxError('The original File mapping changed. Read that exact file before deciding another save.', 'FILE_RESOURCE_MISMATCH')
    try {
      return { resource, result: publicWrite(await this.ports.files.write(workspace, { path: resource.path, content: params.content, expectedRevision: params.expectedRevision,
        ...(params.baseContent === undefined ? {} : { baseContent: params.baseContent, operationId: params.operationId! }) }, context)) }
    } catch (error) { return { resource, result: { status: 'unknown', code: 'FILE_WRITE_UNCONFIRMED', message: error instanceof Error ? error.message : String(error) } } }
  }
  async create(input: FileCreateParams, context?: FileWriteContext): Promise<FileCreateResult> {
    const params = parseFileCreateParams(input), resolved = await this.resolve(params)
    if ('message' in resolved) return { resource: null, result: { status: 'unknown', code: 'FILE_CREATE_UNCONFIRMED', message: resolved.message } }
    const { resource, workspace } = resolved
    if (['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'path', 'logicalDirectory'].some(key => resource[key as keyof FileReadResource] !== params.expectedResource[key as keyof FileReadResource])) throw new AgentMuxError('The original File mapping changed. Read that exact target before deciding another create.', 'FILE_RESOURCE_MISMATCH')
    try {
      return { resource, result: publicWrite(await this.ports.files.write(workspace, { path: resource.path, content: params.content, expectedRevision: null }, context)) }
    } catch (error) { return { resource, result: { status: 'unknown', code: 'FILE_CREATE_UNCONFIRMED', message: error instanceof Error ? error.message : String(error) } } }
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
  private async resolve(params: FileReadParams): Promise<{ resource: FileReadResource; workspace: WorkspaceRecord } | { message: string }> {
    const unknown = (message: string) => ({ message })
    let catalog: AgentMuxSpaceCatalog | null
    try { catalog = await this.ports.catalog() } catch (error) { return unknown(error instanceof Error ? error.message : String(error)) }
    if (!catalog) return unknown('The original Zone observation is unavailable. Keep the original file reference and retry discovery.')
    const zones = catalog.zones.filter(zone => zone.zoneId === params.zoneId)
    let zone = zones[0]
    let retired: { zone: AgentMuxZoneFact; spaceId: unknown } | null = null
    if (zones.length === 0 && this.ports.retiredZone) {
      try { retired = this.retainedZone(params.zoneId, await this.ports.retiredZone(params.zoneId)); zone = retired?.zone }
      catch (error) { return unknown(error instanceof Error ? error.message : String(error)) }
    }
    if (zones.length > 1 || !zone || zone.kind === 'unknown' || zone.hostId === null || zone.directoryPath === null) {
      return unknown('The exact original Zone resource is unconfirmed. Keep the original file reference and retry discovery.')
    }
    if (params.spaceId && !(retired ? retired.spaceId === params.spaceId : catalog.bindings.some(binding => binding.zoneId === zone.zoneId && binding.spaceId === params.spaceId))) {
      throw new AgentMuxError('The requested Space is not bound to this original Zone.', 'FILE_RESOURCE_MISMATCH')
    }
    const workspace = this.ports.workspace(zone.workspaceId)
    if (!workspace) return unknown('The original Files Workspace is unconfirmed. Keep the original reference and retry discovery.')
    const expected = params.expectedResource
    if (workspace.hostId !== expected.hostId || workspace.id !== expected.workspaceId || workspace.path !== expected.workspacePath || zone.hostId !== expected.hostId) {
      throw new AgentMuxError('The original File resource changed. Inspect its exact Host and Workspace before retrying this read.', 'FILE_RESOURCE_MISMATCH')
    }
    const root = workspace.path.replace(/\/+$/, '') || '/', directory = zone.directoryPath.replace(/\/+$/, '') || '/'
    let topic: ScratchDirectoryFact | null = null
    if (workspace.id === SCRATCH_WORKSPACE_ID && directory !== root && !directory.startsWith(root === '/' ? '/' : root + '/')) {
      try { topic = await this.ports.topicForDirectory?.(workspace, directory) ?? null }
      catch (error) { return unknown(error instanceof Error ? error.message : String(error)) }
    }
    const mapped = zoneFileResource(workspace, zone, params.path, topic ? [topic] : [])
    const resource = { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path,
      zoneId: zone.zoneId, zonePath: mapped.directoryPath, path: mapped.path,
      ...(mapped.logicalDirectory === undefined ? {} : { logicalDirectory: mapped.logicalDirectory }) }
    return { resource, workspace: { ...workspace } }
  }

  private retainedZone(zoneId: string, value: unknown): { zone: AgentMuxZoneFact; spaceId: unknown } | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const descriptor = value as Record<string, unknown>, original = descriptor.originalZone
    if (!original || typeof original !== 'object' || Array.isArray(original)) return null
    const zone = original as Record<string, unknown>
    if (zone.zoneId !== zoneId || !['worktree', 'directory'].includes(String(zone.kind)) || typeof zone.workspaceId !== 'string') return null
    const workspace = this.ports.workspace(zone.workspaceId)
    if (!workspace || workspace.kind !== 'worktree' || !workspace.closeout ||
        workspace.closeout.targetWorkspaceId !== descriptor.closeoutTargetWorkspaceId ||
        workspace.hostId !== zone.hostId || workspace.path !== zone.directoryPath) return null
    const target = this.ports.workspace(workspace.closeout.targetWorkspaceId)
    if (!target || target.closeout || target.hostId !== workspace.hostId || target.path !== workspace.repoPath) return null
    return { zone: zone as AgentMuxZoneFact, spaceId: descriptor.spaceId }
  }
}
