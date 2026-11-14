import { AgentMuxError, type FolderSpaceResource } from '@agentmux/core'
import { readOriginalMoteConfiguration } from './mote-resources.js'
import { SCRATCH_WORKSPACE_ID } from './mote-topic-model.js'

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
/** Read one already registered resource; this is neither a configuration writer nor a disk scan. */
export function createHostFolderSpaceResource(configurationPath: string) {
  return async (workspaceId: string): Promise<FolderSpaceResource> => {
    const raw = await readOriginalMoteConfiguration(configurationPath)
    if (!object(raw) || !Array.isArray(raw.workspaces)) throw new AgentMuxError(
      'The original Workspace configuration is unreadable. Existing Spaces and Agents are retained.', 'SPACE_RESOURCE_UNAVAILABLE')
    const candidates = raw.workspaces.filter(value => object(value) && value.id === workspaceId)
    const item = candidates.length === 1 ? candidates[0] : undefined
    if (!object(item) || workspaceId === SCRATCH_WORKSPACE_ID || item.closeout !== undefined ||
        !['id', 'hostId', 'path', 'name'].every(key => typeof item[key] === 'string' && item[key] !== '') ||
        item.repoPath !== undefined && typeof item.repoPath !== 'string' || item.branch !== undefined && typeof item.branch !== 'string') {
      throw new AgentMuxError('Choose one exact registered Folder Workspace on its original Host. No replacement directory or configuration was created.', 'SPACE_RESOURCE_UNKNOWN')
    }
    return { id: item.id as string, hostId: item.hostId as string, path: item.path as string, name: item.name as string,
      ...(typeof item.repoPath === 'string' ? { repoPath: item.repoPath } : {}), ...(typeof item.branch === 'string' ? { branch: item.branch } : {}),
      ...(typeof item.kind === 'string' ? { kind: item.kind } : {}) }
  }
}
