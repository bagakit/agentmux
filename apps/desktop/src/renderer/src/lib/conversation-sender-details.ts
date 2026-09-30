import type { AgentTimelineSnapshot, SessionSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import type { ConversationSenderDetails } from './conversation-speaker'
import type { DemandRecord } from './global-demand-board'
import { agentDisplayName, firstPromptFromTimeline } from './workbench-tabs'
import { projectWorkspaces, workspaceProjectId } from './workspace-projects'
import { sessionPresentationById } from './session-presentation'

type SpeakerSnapshot = {
  sessions: readonly SessionSnapshot[]
  workspaces: readonly WorkspaceRecord[]
  agentNames: Readonly<Record<string, string>>
  timelines?: Readonly<Record<string, AgentTimelineSnapshot>> | undefined
}

/** Cheap current identity only. Complete sender details and goals remain an explicit disclosure read. */
export function currentConversationSpeakerMetadata(sessionId: string, snapshot: SpeakerSnapshot):
  Omit<ConversationSenderDetails, 'goals'> | undefined {
  const sender = sessionPresentationById(snapshot.sessions).get(sessionId)
  if (!sender || sender.kind !== 'agent') return undefined
  const workspace = snapshot.workspaces.find((item) =>
    item.hostId === sender.hostId && item.path === sender.workspacePath)
  const project = workspace ? projectWorkspaces(snapshot.workspaces).find((item) =>
    item.id === workspaceProjectId(workspace)) : undefined
  return {
    sessionId: sender.id,
    label: agentDisplayName({ userName: snapshot.agentNames[sender.id],
      firstPrompt: firstPromptFromTimeline(snapshot.timelines?.[sender.id]),
      fallbackLabel: sender.label, providerLabel: sender.providerId }),
    providerId: sender.providerId,
    createdAt: sender.createdAt,
    ...(project ? { project: {
      workspaceId: project.preferredWorkspaceId,
      name: project.name,
      path: project.repoPath,
      ...(workspace?.branch ? { branch: workspace.branch } : {})
    } } : {})
  }
}

/** An explicit detail read over the existing Store snapshot and exact identity. */
export function currentConversationSenderDetails(sessionId: string,
  snapshot: SpeakerSnapshot & { demands: Readonly<Record<string, DemandRecord>> }): ConversationSenderDetails | undefined {
  const metadata = currentConversationSpeakerMetadata(sessionId, snapshot)
  if (!metadata) return undefined
  return { ...metadata, goals: Object.values(snapshot.demands).filter((goal) => goal.sessionIds.includes(sessionId))
    .map((goal) => ({ id: goal.id, title: goal.title })) }
}
