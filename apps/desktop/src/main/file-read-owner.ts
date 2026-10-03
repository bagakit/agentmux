import { AgentMuxError, parseFileReadParams, type AgentMuxRpcFilesOwner, type FileReadParams, type FileReadResource, type FileReadResult } from '@agentmux/core'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { WorkspaceRecord } from '../shared/contracts'
import { zoneFileResource } from '../shared/zone-file-resource'
import type { WorkspaceFiles } from './workspace-files'

/** Resolve once from original spatial/resource facts, then delegate to original Files. */
export class FileReadOwner implements AgentMuxRpcFilesOwner {
  constructor(private readonly ports: {
    catalog(): Promise<AgentMuxSpaceCatalog | null>
    workspace(id: string): WorkspaceRecord | undefined
    files: Pick<WorkspaceFiles, 'read'>
  }) {}
  async read(input: FileReadParams): Promise<FileReadResult> {
    const params = parseFileReadParams(input)
    let resource: FileReadResource | null = null
    const unknown = (message: string): FileReadResult => ({ resource, result: { status: 'unknown', code: 'FILE_READ_UNCONFIRMED', message } })
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
    const mapped = zoneFileResource(workspace, zone, params.path)
    resource = { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path,
      zoneId: zone.zoneId, zonePath: mapped.directoryPath, path: mapped.path }
    try { return { resource, result: await this.ports.files.read({ ...workspace }, mapped.path) } }
    catch (error) { return unknown(error instanceof Error ? error.message : String(error)) }
  }
}
