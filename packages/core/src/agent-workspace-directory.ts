import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { AgentMuxAgentWorkspaceLocator } from './host-environment.js'

export type AgentWorkspaceDirectoryLocation = {
  agentWorkspace: AgentMuxAgentWorkspaceLocator
  markerPath: string
}

/** Pure execution-Core projection. Locating never proves existence or performs filesystem IO. */
export function locateAgentWorkspaceDirectory(input: {
  storePath: string
  runtimeId: string
  agentSessionId: string
}): AgentWorkspaceDirectoryLocation {
  const stateDirectory = dirname(input.storePath)
  const leaf = createHash('sha256').update(input.agentSessionId, 'utf8').digest('hex')
  return {
    agentWorkspace: {
      runtimeId: input.runtimeId,
      agentSessionId: input.agentSessionId,
      workspacePath: join(stateDirectory, 'agent-workspaces', leaf)
    },
    markerPath: join(stateDirectory, 'agent-workspace-identities', leaf + '.json')
  }
}
