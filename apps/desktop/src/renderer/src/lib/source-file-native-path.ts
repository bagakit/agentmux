import { scratchTopicIdFromDirectoryName, scratchWorkspaceFilePath, type ScratchTopicSnapshot } from '@agentmux/host/mote-model'
import { isScratchWorkspaceId, type WorkspaceRecord } from '../../../shared/contracts'
import type { SourceFileReadLocation } from '../../../shared/source-files'
import { joinWorkspacePath } from './workspace-paths'

export function sourceFilePhysicalPath(source: Pick<SourceFileReadLocation, 'target' | 'resource'> & { query: { path: string } },
  workspace: WorkspaceRecord | null | undefined, topics: readonly ScratchTopicSnapshot[] | null): string | null {
  const { resource, target } = source, path = source.query.path
  const virtualTopic = resource.hostId === 'local' && isScratchWorkspaceId(resource.workspaceId) && resource.zonePath === resource.workspacePath &&
    scratchTopicIdFromDirectoryName(path.split('/', 1)[0]!)
  if (!virtualTopic) {
    if (!path || path === '.') return resource.zonePath
    // The Files protocol uses '/' between components. A POSIX filename may contain a literal backslash.
    if (resource.zonePath.startsWith('/')) return resource.zonePath.replace(/\/+$/, '') + '/' + path
    return joinWorkspacePath(resource.zonePath, path)
  }
  if (target.hostId !== 'local' || !workspace || workspace.hostId !== resource.hostId ||
      workspace.id !== resource.workspaceId || workspace.path !== resource.workspacePath) return null
  return scratchWorkspaceFilePath(workspace, topics, path)
}
