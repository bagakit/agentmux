import { parseMoteDefaultConversation } from '@agentmux/core/mote-preferences'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { sessionPresentationById } from './session-presentation'
import { useAppStore } from '../store'
import type { ScratchTopicSnapshot } from '../../../shared/contracts'
import { scratchTopicKind, scratchTopicsForWorkspace } from './scratch-topic-snapshots'
import { scratchTopicIdentityPath } from '../../../shared/scratch-topics'
import { directoryIdentity, homeZoneId } from '../../../shared/space-addresses'
import type { WorkbenchProjectionSelection } from './workbench-projection'
import { sameMoteDefaultConversation, type MoteDefaultConversation } from '../../../shared/mote-quick-mode'
import { resolveMoteDefaultConversation, moteDefaultCatalog } from './mote-default-conversation'
export { resolveMoteDefaultConversation, moteDefaultCatalog } from './mote-default-conversation'

type State = Pick<ReturnType<typeof useAppStore.getState>, 'config' | 'scratchTopicSnapshots' | 'tabs' | 'layouts' | 'sessions' | 'spaceZoneBindings' | 'spatialRequests' | 'topicCategories'>
export function moteDefaultExecutor(state: Pick<State, 'config' | 'scratchTopicSnapshots'>, workspaceId: string, topicId: string | undefined): string | undefined {
  const workspace = state.config?.workspaces.find(item => item.id === workspaceId)
  const topic = topicId ? scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspace)?.find(item => item.id === topicId) : undefined
  return topic?.quickMode?.status === 'saved' ? topic.quickMode.defaults.executorId : undefined
}
export function motePinnedTab(conversation: MoteDefaultConversation | undefined, workspaceId: string, groupId: string, tabId: string): boolean {
  return Boolean(conversation && conversation.displayWorkspaceId === workspaceId && conversation.groupId === groupId && conversation.tabId === tabId)
}
export function moteTabOrder(tabIds: readonly string[], conversation: MoteDefaultConversation | undefined, workspaceId: string, groupId: string): readonly string[] {
  const id = conversation?.tabId
  return id && motePinnedTab(conversation, workspaceId, groupId, id) && tabIds.includes(id) ? [id, ...tabIds.filter(tabId => tabId !== id)] : tabIds
}
export function moteConversationChoices(state: State, topic: ScratchTopicSnapshot, workspaceId: string, catalog: AgentMuxSpaceCatalog): MoteDefaultConversation[] {
  const workspace = state.config?.workspaces.find(item => item.id === workspaceId)
  if (!workspace) return []
  const spaceId = directoryIdentity(workspace.hostId, scratchTopicIdentityPath(workspace, topic))
  return catalog.locations.flatMap(location => {
    const region = state.tabs[location.tabId]?.regions[location.regionId]
    const agent = catalog.regions.find(item => item.tabId === location.tabId && item.regionId === location.regionId)
    const session = region?.kind === 'agent' ? sessionPresentationById(state.sessions).get(region.sessionId) : undefined
    if (session?.control.kind !== 'agent' || !agent?.execution?.hostId || agent.agentSessionId !== (region?.kind === 'agent' ? region.sessionId : null) || location.spaceId !== spaceId || location.workspaceId !== workspaceId || region?.kind !== 'agent') return []
    const choice = { hostId: session.control.hostId, sessionId: session.control.agentSessionId, displayWorkspaceId: location.displayWorkspaceId,
      groupId: location.groupId, tabId: location.tabId, regionId: location.regionId }
    return resolveMoteDefaultConversation(state, { ...topic, quickMode: { status: 'saved', defaults: { conversation: choice }, version: '' } }, workspaceId, catalog).conversation ? [choice] : []
  })
}
export const moteConversationReference = (conversation: MoteDefaultConversation): WorkbenchProjectionSelection => ({
  displayWorkspaceId: conversation.displayWorkspaceId, groupId: conversation.groupId, tabId: conversation.tabId, regionId: conversation.regionId
})

export function useMoteDefaultConversation(topic: ScratchTopicSnapshot | undefined, workspaceId: string, active: boolean) {
  const raw = topic?.quickMode?.status === 'saved' ? topic.quickMode.defaults.conversation : undefined
  const facts = useAppStore(useShallow(state => active && raw ? {
    tab: state.tabs[raw.tabId], layout: state.layouts[raw.displayWorkspaceId], config: state.config,
    binding: state.spaceZoneBindings[state.tabs[raw.tabId]?.space?.zoneId ?? homeZoneId(directoryIdentity(state.config?.workspaces.find(item => item.id === workspaceId)?.hostId ?? '', scratchTopicIdentityPath(state.config?.workspaces.find(item => item.id === workspaceId) ?? { path: '' }, topic!)))],
    session: (() => { const region = state.tabs[raw.tabId]?.regions[raw.regionId]; const session = region?.kind === 'agent' ? sessionPresentationById(state.sessions).get(region.sessionId) : undefined; return session ? JSON.stringify([session.hostId, session.control.hostId, session.control.kind === 'agent' ? session.control.agentSessionId : null]) : null })()
  } : null))
  const held = useRef<{ topic: string | undefined; value: ReturnType<typeof resolveMoteDefaultConversation> }>({ topic: undefined, value: {} })
  return useMemo(() => {
    if (!active && held.current.topic === topic?.id) return held.current.value
    const state = useAppStore.getState()
    const value = !topic ? {} : raw ? resolveMoteDefaultConversation(state, topic, workspaceId, moteDefaultCatalog(state, topic, raw))
      : topic.quickMode?.status === 'unconfirmed' ? { issue: topic.quickMode.message } : {}
    held.current = { topic: topic?.id, value }
    return value
  }, [active, topic, workspaceId, facts, raw])
}

export function moteDefaultConversation(state: State, topic: ScratchTopicSnapshot, workspaceId: string) {
  const raw = topic.quickMode?.status === 'saved' ? topic.quickMode.defaults.conversation : undefined
  return raw ? resolveMoteDefaultConversation(state, topic, workspaceId, moteDefaultCatalog(state, topic, raw))
    : topic.quickMode?.status === 'unconfirmed' ? { issue: topic.quickMode.message } : {}
}

export function moteConversationLabel(state: Pick<State, 'tabs' | 'sessions'>, conversation: MoteDefaultConversation): string | undefined {
  const region = state.tabs[conversation.tabId]?.regions[conversation.regionId]
  const session = region?.kind === 'agent' ? sessionPresentationById(state.sessions).get(region.sessionId) : undefined
  return session?.control.kind === 'agent' && session.control.agentSessionId === conversation.sessionId && session.control.hostId === conversation.hostId ? session.label : undefined
}

export type MoteRecentAgent = MoteDefaultConversation & { presentationSessionId: string }
/** Validate presentation storage without consulting today's possibly unavailable catalog. */
export function restoredRecentMoteAgents(value: unknown): Record<string, MoteRecentAgent> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([id, raw]) => {
    if (!id.trim() || !raw || typeof raw !== 'object' || Array.isArray(raw)) return []
    try {
      const { presentationSessionId, ...tuple } = raw as Record<string, unknown>
      const conversation = parseMoteDefaultConversation(tuple)
      return typeof presentationSessionId === 'string' && presentationSessionId.trim() === presentationSessionId && presentationSessionId.length > 0
        ? [[id, { ...conversation, presentationSessionId }]] : []
    } catch { return [] }
  }))
}

/** Only a confirmed explicit Agent visit may replace this Mote's navigation bookmark. */
export function recentMoteAgentsAfterVisit(state: State & { recentMoteAgents: Record<string, MoteRecentAgent> },
  reference: WorkbenchProjectionSelection): Record<string, MoteRecentAgent> {
  const tab = state.tabs[reference.tabId], workspace = state.config?.workspaces.find(item => item.id === tab?.workspaceId)
  const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspace)
  const topic = topics?.find(item => item.id === tab?.topicId)
  const region = tab?.regions[reference.regionId]
  const session = region?.kind === 'agent' ? sessionPresentationById(state.sessions).get(region.sessionId) : undefined
  if (!workspace || !topic || scratchTopicKind(topic.id, topics) !== 'mote' || session?.control.kind !== 'agent') return state.recentMoteAgents
  const conversation = { ...reference, hostId: session.control.hostId, sessionId: session.control.agentSessionId, presentationSessionId: session.id }
  const confirmed = resolveMoteDefaultConversation(state, { ...topic, quickMode: { status: 'saved',
    defaults: { conversation }, version: '' } }, workspace.id, moteDefaultCatalog(state, topic, conversation))
  if (!confirmed.conversation || confirmed.issue || (sameMoteDefaultConversation(state.recentMoteAgents[topic.id], conversation) && state.recentMoteAgents[topic.id]?.presentationSessionId === conversation.presentationSessionId)) return state.recentMoteAgents
  return { ...state.recentMoteAgents, [topic.id]: conversation }
}
