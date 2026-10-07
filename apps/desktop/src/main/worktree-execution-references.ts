import type { AgentMuxClient } from '@agentmux/core'
import type { WorkspaceRecord } from '../shared/contracts.js'
import { workspaceLocationKey } from './workspace-location.js'

/** Read authoritative identities and processes, never the Hosted bootstrap cache. */
export async function worktreeExecutionReferences(workspace: WorkspaceRecord,
  client: Pick<AgentMuxClient, 'readAgentSessions' | 'runtimeProjection'>): Promise<string[]> {
  const [sessions, projection] = await Promise.all([client.readAgentSessions(), client.runtimeProjection()])
  const root = workspaceLocationKey(workspace.hostId, workspace.path)
  const inside = (path: string) => {
    const key = workspaceLocationKey(workspace.hostId, path)
    return key === root || key.startsWith(root + '/')
  }
  return [...new Set([
    ...sessions.filter(session => inside(session.workspacePath)).map(session => session.agentSessionId),
    ...projection.subjects.filter(subject => inside(subject.workspacePath)).map(subject => subject.kind === 'agent'
      ? subject.agentSession.agentSessionId : subject.run.runId)
  ])]
}
