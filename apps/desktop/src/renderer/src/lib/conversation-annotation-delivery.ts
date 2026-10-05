import type { ConversationAnnotation } from '@agentmux/client-ui/components/ConversationMessage'
import type { AgentMuxSpaceControlRequest } from '@agentmux/core/control'
import type { OpenHttpLinkOrigin } from './open-destination'
import { currentConversationSpeakerMetadata } from './conversation-sender-details'
import { scratchTopicKind, scratchTopicsForConfig } from './scratch-topic-snapshots'
import { topicIdForSession, workspaceForSession } from './workbench-tabs'
import { workspaceProjectId } from './workspace-projects'
import { sessionPresentationById } from './session-presentation'
import { spatialCatalog } from './space-agent-control'
import { useAppStore } from '../store'

export function formatConversationAnnotation(annotation: ConversationAnnotation, sourceSessionId: string): string {
  return `Source Agent Session: ${JSON.stringify(sourceSessionId)}\nRegarding message ${JSON.stringify(annotation.messageId)}:\n> ${annotation.quote.replace(/\n/gu, '\n> ')}\n\n批注： ${annotation.note.trim()}`
}

type Snapshot = Pick<ReturnType<typeof useAppStore.getState>, 'config' | 'sessions' | 'agentNames' | 'timelines' | 'scratchTopicSnapshots' | 'spaceObjectIcons'>
export type AnnotationRecipient = { id: string; name: string; group: 'project' | 'mote' | 'other';
  current: boolean; metadata: ReturnType<typeof currentConversationSpeakerMetadata> }

/** Execution ownership determines recommendations; the displayed Tab never changes it. */
export function annotationRecipients(snapshot: Snapshot, sessionId: string) {
  const sessions = sessionPresentationById(snapshot.sessions)
  const current = sessions.get(sessionId)
  const topics = scratchTopicsForConfig(snapshot.config, snapshot.scratchTopicSnapshots)
  const workspace = current?.kind === 'agent' ? workspaceForSession(snapshot.config, current, topics) : undefined
  const projectId = workspace ? workspaceProjectId(workspace) : null
  const recipients: AnnotationRecipient[] = []
  const facts = { ...snapshot, workspaces: snapshot.config?.workspaces ?? [] }
  for (const session of sessions.values()) {
    if (session.kind !== 'agent') continue
    const owner = workspaceForSession(snapshot.config, session, topics)
    const topicId = topicIdForSession(snapshot.config, session, topics)
    const isMote = topicId !== null && scratchTopicKind(topicId, topics) === 'mote'
    const metadata = currentConversationSpeakerMetadata(session.id, facts)
    recipients.push({ id: session.id, name: metadata?.label ?? session.label, current: session.id === sessionId, metadata,
      group: isMote ? 'mote' : projectId && owner && workspaceProjectId(owner) === projectId ? 'project' : 'other' })
  }
  if (!recipients.some(item => item.id === sessionId)) recipients.unshift({ id: sessionId, name: sessionId, group: 'other', current: true, metadata: undefined })
  recipients.sort((left, right) => Number(right.current) - Number(left.current) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  return { workspace, recipients }
}

/** One admitted creation intent, routed by exact execution and display identities. */
export function annotationCreationRequest(sessionId: string, origin: OpenHttpLinkOrigin, executorId: string,
  annotation: ConversationAnnotation, requestId: string): Extract<AgentMuxSpaceControlRequest, { operation: 'agent.open' }> {
  const state = useAppStore.getState()
  const { workspace } = annotationRecipients(state, sessionId)
  if (!workspace) throw new Error('原会话的执行项目尚未确认；批注已保留，请确认项目后再新建 Agent。')
  const topics = scratchTopicsForConfig(state.config, state.scratchTopicSnapshots) ?? []
  const catalog = spatialCatalog(state, topics)
  const matches = catalog.locations.filter(item => item.displayWorkspaceId === origin.workspaceId &&
    item.groupId === origin.tabGroupId && item.tabId === origin.tabId && item.regionId === origin.regionId)
  const location = matches[0]
  const region = catalog.regions.find(item => item.tabId === origin.tabId && item.regionId === origin.regionId)
  if (matches.length !== 1 || !location?.zoneId || region?.kind !== 'agent' || region.agentSessionId !== sessionId) {
    throw new Error('原会话的显示位置已改变或尚未确认；批注已保留，不会使用其他位置。')
  }
  return { schemaVersion: 5, requestId, operation: 'agent.open', focus: false,
    destination: { zoneId: location.zoneId, displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId, newTab: true },
    content: { kind: 'new-agent', executorId, executionWorkspaceId: workspace.id, prompt: formatConversationAnnotation(annotation, sessionId) } }
}
