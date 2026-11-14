import type { AgentMuxSpatialStateStore } from '@agentmux/core'
import { createHostWorkspaceResources, type HostWorkspaceResources } from './workspace-resources.js'
/** The same original resource reader is used by discovery, Files and configured Folder registration. */
export function createHostFolderSpaceResource(configurationPath: string, resources?: HostWorkspaceResources, spatial?: Pick<AgentMuxSpatialStateStore, 'read'>) {
  return (resources ?? createHostWorkspaceResources(configurationPath, spatial)).folder
}
