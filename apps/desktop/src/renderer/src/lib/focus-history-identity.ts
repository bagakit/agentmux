import type { AppConfig, AgentTimelineSnapshot, SessionSnapshot } from '../../../shared/contracts'
import type { AgentFocusHistoryIdentity } from './agent-focus'
import { agentDisplayName, topicIdForSession, workspaceForSession } from './workbench-tabs'
import { firstPromptFromTimeline } from '@agentmux/client-ui/display-name'
import { directoryIdentity } from '../../../shared/space-addresses'

/** Called only when focus is recorded; later project/name edits never rewrite this observation. */
export function observeFocusHistoryIdentity(session: SessionSnapshot, config: AppConfig | null, name?: string, timeline?: AgentTimelineSnapshot, topics?: readonly import('../../../shared/scratch-topics').ScratchTopicSnapshot[] | null): AgentFocusHistoryIdentity {
  const workspace = workspaceForSession(config, session, topics)
  const project = workspace?.repoPath
    ? config?.workspaces.find(item => item.hostId === session.hostId && item.path === workspace.repoPath)
    : workspace
  const topicId = topicIdForSession(config, session, topics)
  return {
    name: agentDisplayName({ userName: name, firstPrompt: firstPromptFromTimeline(timeline), fallbackLabel: session.label, providerLabel: session.providerId ?? 'Terminal' }),
    kind: session.kind, providerId: session.providerId, hostId: session.hostId, workspacePath: session.workspacePath,
    ...(project ? { project: { id: project.id, name: project.name } }
      : workspace?.repoPath ? { project: { id: directoryIdentity(session.hostId, workspace.repoPath), name: workspace.repoPath } } : {}),
    ...(workspace?.branch ? { branch: workspace.branch } : {}),
    ...(topicId ? { topicId } : {})
  }
}
