import { zoneFileResource, type FileWorkspace } from './file-resource-model.js'
export { zoneFileResource, type FileWorkspace } from './file-resource-model.js'
import { AgentMuxError } from '@agentmux/core'
import { parseFileReadParams, parseFileListParams, parseFileWriteParams, parseFileCreateParams,
  type FileReadParams, type FileReadResource, type FileReadResult, type FileListParams, type FileListResult,
  type FileWriteParams, type FileWriteResult, type FileCreateParams, type FileCreateResult, type FileWriteContext,
  type FileDocumentReadResult, type FileWriteReceipt, type FileNameListing } from '@agentmux/core/files'
import type { AgentMuxSpaceCatalog, AgentMuxZoneFact } from '@agentmux/core/control'
import { SCRATCH_WORKSPACE_ID, type ScratchDirectoryFact } from './mote-topic-model.js'
import type { WorkspaceFileReadBudget } from './workspace-file-bytes.js'

export type FileResourcePorts<W extends FileWorkspace> = {
  catalog(): Promise<AgentMuxSpaceCatalog | null>
  retiredZone?(zoneId: string): Promise<unknown>
  topicForDirectory?(workspace: W, directory: string): Promise<ScratchDirectoryFact | null>
  workspace(id: string): W | undefined | Promise<W | undefined>
  files: {
    read(workspace: W, path: string, budget?: WorkspaceFileReadBudget): Promise<FileDocumentReadResult>
    listFiles(workspace: W, path: string, limit?: number, options?: { signal?: AbortSignal }): Promise<FileNameListing>
    write(workspace: W, input: { path: string; content: string; expectedRevision: string | null; baseContent?: string; operationId?: string },
      context?: FileWriteContext): Promise<FileWriteReceipt & { fileWitness?: unknown }>
  }
}
const publicWrite = (value: FileWriteReceipt & { fileWitness?: unknown }): FileWriteReceipt => {
  if (value.status !== 'written') return value
  const { fileWitness: _internal, ...receipt } = value
  return receipt
}

/** Original public ordinary methods; richer Main backends keep their existing Note semantics. */
export class FileResourceOwner<W extends FileWorkspace> {
  constructor(protected readonly ports: FileResourcePorts<W>) {}
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
      const current = await this.ports.workspace(workspace.id)
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
  protected async resolve(params: FileReadParams): Promise<{ resource: FileReadResource; workspace: W } | { message: string }> {
    const unknown = (message: string) => ({ message })
    let catalog: AgentMuxSpaceCatalog | null
    try { catalog = await this.ports.catalog() } catch (error) { return unknown(error instanceof Error ? error.message : String(error)) }
    if (!catalog) return unknown('The original Zone observation is unavailable. Keep the original file reference and retry discovery.')
    const zones = catalog.zones.filter(zone => zone.zoneId === params.zoneId)
    let zone = zones[0]
    let retired: { zone: AgentMuxZoneFact; spaceId: unknown } | null = null
    if (zones.length === 0 && this.ports.retiredZone) {
      try { retired = await this.retainedZone(params.zoneId, await this.ports.retiredZone(params.zoneId)); zone = retired?.zone }
      catch (error) { return unknown(error instanceof Error ? error.message : String(error)) }
    }
    if (zones.length > 1 || !zone || zone.kind === 'unknown' || zone.hostId === null || zone.directoryPath === null) {
      return unknown('The exact original Zone resource is unconfirmed. Keep the original file reference and retry discovery.')
    }
    if (params.spaceId && !(retired ? retired.spaceId === params.spaceId : catalog.bindings.some(binding => binding.zoneId === zone.zoneId && binding.spaceId === params.spaceId))) {
      throw new AgentMuxError('The requested Space is not bound to this original Zone.', 'FILE_RESOURCE_MISMATCH')
    }
    const workspace = await this.ports.workspace(zone.workspaceId)
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

  private async retainedZone(zoneId: string, value: unknown): Promise<{ zone: AgentMuxZoneFact; spaceId: unknown } | null> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const descriptor = value as Record<string, unknown>, original = descriptor.originalZone
    if (!original || typeof original !== 'object' || Array.isArray(original)) return null
    const zone = original as Record<string, unknown>
    if (zone.zoneId !== zoneId || !['worktree', 'directory'].includes(String(zone.kind)) || typeof zone.workspaceId !== 'string') return null
    const workspace = await this.ports.workspace(zone.workspaceId)
    if (!workspace || workspace.kind !== 'worktree' || !workspace.closeout ||
        workspace.closeout.targetWorkspaceId !== descriptor.closeoutTargetWorkspaceId ||
        workspace.hostId !== zone.hostId || workspace.path !== zone.directoryPath) return null
    const target = await this.ports.workspace(workspace.closeout.targetWorkspaceId)
    if (!target || target.closeout || target.hostId !== workspace.hostId || target.path !== workspace.repoPath) return null
    return { zone: zone as AgentMuxZoneFact, spaceId: descriptor.spaceId }
  }
}
