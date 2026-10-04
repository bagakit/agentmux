import type { AgentTimelineSnapshot, AppConfig, SessionSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import type { ConversationSenderDetails, ConversationSpeaker, DescribeSpeaker } from '@agentmux/client-ui/conversation-speaker'
import type { DemandRecord } from './global-demand-board'
import { agentDisplayName, firstPromptFromTimeline, topicIdForSession, workspaceForSession } from './workbench-tabs'
import { projectWorkspaces, workspaceProjectId } from './workspace-projects'
import { sessionPresentationById } from './session-presentation'
import { scratchTopicKind, scratchTopicsForConfig, scratchTopicsForWorkspace, type ScratchTopicsSnapshot } from './scratch-topic-snapshots'
import { topicSpaceIconTarget, type SpaceIconOverrides } from './space-object-appearance'
import type { MoteConversationIdentity } from './mote-conversation-identity'

/** Desktop appearance stays outside the shared UI's speaker identity contract. */
export type FocusDescribeSpeaker = (speaker: ConversationSpeaker) => ReturnType<DescribeSpeaker> & { mote?: MoteConversationIdentity }

type SpeakerSnapshot = {
  sessions: readonly SessionSnapshot[]
  workspaces: readonly WorkspaceRecord[]
  agentNames: Readonly<Record<string, string>>
  timelines?: Readonly<Record<string, AgentTimelineSnapshot>> | undefined
  config?: AppConfig | null
  scratchTopicSnapshots?: Readonly<Record<string, ScratchTopicsSnapshot>>
  spaceObjectIcons?: Readonly<SpaceIconOverrides>
}

/** Cheap current identity only. Complete sender details and goals remain an explicit disclosure read. */
export function currentConversationSpeakerMetadata(sessionId: string, snapshot: SpeakerSnapshot):
  (Omit<ConversationSenderDetails, 'goals'> & { mote?: MoteConversationIdentity }) | undefined {
  const sender = sessionPresentationById(snapshot.sessions).get(sessionId)
  if (!sender || sender.kind !== 'agent') return undefined
  const workspace = snapshot.workspaces.find((item) =>
    item.hostId === sender.hostId && item.path === sender.workspacePath)
  const project = workspace ? projectWorkspaces(snapshot.workspaces).find((item) =>
    item.id === workspaceProjectId(workspace)) : undefined
  const sourceTopics = scratchTopicsForConfig(snapshot.config, snapshot.scratchTopicSnapshots)
  const sourceWorkspace = workspaceForSession(snapshot.config ?? null, sender, sourceTopics)
  const topicId = topicIdForSession(snapshot.config ?? null, sender, sourceTopics)
  const topics = snapshot.scratchTopicSnapshots ? scratchTopicsForWorkspace(snapshot.scratchTopicSnapshots, sourceWorkspace) : null
  const topic = topicId ? topics?.find(item => item.id === topicId) : undefined
  const target = sourceWorkspace && topicId && topic && !topic.readError && scratchTopicKind(topicId, topics) === 'mote'
    ? topicSpaceIconTarget(sourceWorkspace, topic) : undefined
  const mote = target && sourceWorkspace && topic ? { workspaceId: sourceWorkspace.id, topicId: topic.id,
    objectKey: target.key, name: topic.title, icon: snapshot.spaceObjectIcons?.[target.key] ?? null } : undefined
  return {
    sessionId: sender.id,
    label: agentDisplayName({ userName: snapshot.agentNames[sender.id],
      firstPrompt: firstPromptFromTimeline(snapshot.timelines?.[sender.id]),
      fallbackLabel: sender.label, providerLabel: sender.providerId }),
    providerId: sender.providerId,
    createdAt: sender.createdAt,
    ...(mote ? { mote } : {}),
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
