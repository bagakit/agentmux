import type { SessionSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import type { ConversationSenderDetails } from './conversation-speaker'
import type { DemandRecord } from './global-demand-board'
import { projectWorkspaces, workspaceProjectId } from './workspace-projects'

/** An explicit detail read over the existing Store snapshot and exact identity. */
export function currentConversationSenderDetails(sessionId: string, snapshot: {
  sessions: readonly SessionSnapshot[]
  workspaces: readonly WorkspaceRecord[]
  agentNames: Readonly<Record<string, string>>
  demands: Readonly<Record<string, DemandRecord>>
}): ConversationSenderDetails | undefined {
  const sender = snapshot.sessions.find((session) => session.id === sessionId)
  if (!sender || sender.kind !== 'agent') return undefined
  const workspace = snapshot.workspaces.find((item) =>
    item.hostId === sender.hostId && item.path === sender.workspacePath)
  const project = workspace ? projectWorkspaces(snapshot.workspaces).find((item) =>
    item.id === workspaceProjectId(workspace)) : undefined
  return {
    sessionId: sender.id,
    label: snapshot.agentNames[sender.id] ?? sender.label,
    providerId: sender.providerId,
    createdAt: sender.createdAt,
    ...(project ? { project: {
      workspaceId: project.preferredWorkspaceId,
      name: project.name,
      path: project.repoPath,
      ...(workspace?.branch ? { branch: workspace.branch } : {})
    } } : {}),
    goals: Object.values(snapshot.demands).filter((goal) => goal.sessionIds.includes(sender.id))
      .map((goal) => ({ id: goal.id, title: goal.title }))
  }
}
