import { AgentMuxError, parseFileReadParams, parseFileCreateParams, type FileCreateParams, type FileCreateResult, parseFileWriteParams, type FileWriteParams, type FileWriteResult, type FileWriteContext, parseFileListParams, type AgentMuxRpcFilesOwner, type FileReadParams, type FileReadResource, type FileReadResult, type FileListParams, type FileListResult } from '@agentmux/core'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { WorkspaceRecord } from '../shared/contracts'
import { SCRATCH_WORKSPACE_ID, type ScratchDirectoryFact } from '../shared/scratch-topics'
import { zoneFileResource } from '../shared/zone-file-resource'
import type { WorkspaceFiles } from './workspace-files'
import type { WorkspaceFileReadBudget } from '../shared/workspace-file-bytes'

/** Resolve once from original spatial/resource facts, then delegate to original Files. */
export class FileReadOwner implements AgentMuxRpcFilesOwner {
  constructor(private readonly ports: {
    catalog(): Promise<AgentMuxSpaceCatalog | null>
    topicForDirectory?(workspace: WorkspaceRecord, directory: string): Promise<ScratchDirectoryFact | null>
    workspace(id: string): WorkspaceRecord | undefined
    files: Pick<WorkspaceFiles, 'read' | 'listFiles'> & { write(workspace: WorkspaceRecord, input: Parameters<WorkspaceFiles['write']>[1], context?: FileWriteContext): ReturnType<WorkspaceFiles['write']> }
  }) {}
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
      return { resource, result: await this.ports.files.write(workspace, { path: resource.path, content: params.content, expectedRevision: params.expectedRevision }, context) }
    } catch (error) { return { resource, result: { status: 'unknown', code: 'FILE_WRITE_UNCONFIRMED', message: error instanceof Error ? error.message : String(error) } } }
  }
  async create(input: FileCreateParams, context?: FileWriteContext): Promise<FileCreateResult> {
    const params = parseFileCreateParams(input), resolved = await this.resolve(params)
    if ('message' in resolved) return { resource: null, result: { status: 'unknown', code: 'FILE_CREATE_UNCONFIRMED', message: resolved.message } }
    const { resource, workspace } = resolved
    if (['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'path', 'logicalDirectory'].some(key => resource[key as keyof FileReadResource] !== params.expectedResource[key as keyof FileReadResource])) throw new AgentMuxError('The original File mapping changed. Read that exact target before deciding another create.', 'FILE_RESOURCE_MISMATCH')
    try {
      return { resource, result: await this.ports.files.write(workspace, { path: resource.path, content: params.content, expectedRevision: null }, context) }
    } catch (error) { return { resource, result: { status: 'unknown', code: 'FILE_CREATE_UNCONFIRMED', message: error instanceof Error ? error.message : String(error) } } }
  }
  private async resolve(params: FileReadParams): Promise<{ resource: FileReadResource; workspace: WorkspaceRecord } | { message: string }> {
    const unknown = (message: string) => ({ message })
    let catalog: AgentMuxSpaceCatalog | null
    try { catalog = await this.ports.catalog() } catch (error) { return unknown(error instanceof Error ? error.message : String(error)) }
    if (!catalog) return unknown('The original Zone observation is unavailable. Keep the original file reference and retry discovery.')
    const zones = catalog.zones.filter(zone => zone.zoneId === params.zoneId)
    const zone = zones[0]
    if (zones.length !== 1 || !zone || zone.kind === 'unknown' || zone.hostId === null || zone.directoryPath === null) {
      return unknown('The exact original Zone resource is unconfirmed. Keep the original file reference and retry discovery.')
    }
    if (params.spaceId && !catalog.bindings.some(binding => binding.zoneId === zone.zoneId && binding.spaceId === params.spaceId)) {
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
}
