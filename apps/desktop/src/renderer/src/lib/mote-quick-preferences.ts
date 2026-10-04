import { groupIds } from '@agentmux/layout'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { spatialCatalog } from './space-agent-control'
import { sessionPresentationById } from './session-presentation'
import { useAppStore } from '../store'
import type { ScratchTopicSnapshot } from '../../../shared/contracts'
import { scratchTopicsForWorkspace } from './scratch-topic-snapshots'
import { scratchTopicIdentityPath } from '../../../shared/scratch-topics'
import { directoryIdentity, homeZoneId } from '../../../shared/space-addresses'
import { sameWorkbenchProjectionSelection, type WorkbenchProjectionSelection } from './workbench-projection'
import type { MoteDefaultConversation } from '../../../shared/mote-quick-mode'

type State = Pick<ReturnType<typeof useAppStore.getState>, 'config' | 'scratchTopicSnapshots' | 'tabs' | 'layouts' | 'sessions' | 'spaceZoneBindings' | 'spatialRequests' | 'topicCategories'>
export function moteDefaultExecutor(state: Pick<State, 'config' | 'scratchTopicSnapshots'>, workspaceId: string, topicId: string | undefined): string | undefined {
  const workspace = state.config?.workspaces.find(item => item.id === workspaceId)
  const topic = topicId ? scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspace)?.find(item => item.id === topicId) : undefined
  return topic?.quickMode?.status === 'saved' ? topic.quickMode.defaults.executorId : undefined
}
/** Preferences authorize one original occurrence only, never a synthesized address or new Run. */
export function resolveMoteDefaultConversation(state: State, topic: ScratchTopicSnapshot, workspaceId: string, catalog: AgentMuxSpaceCatalog): {
  conversation?: MoteDefaultConversation; issue?: string
} {
  const saved = topic.quickMode
  if (saved?.status === 'unconfirmed') return { issue: saved.message }
  const conversation = saved?.status === 'saved' ? saved.defaults.conversation : undefined
  if (!conversation) return {}
  const workspace = state.config?.workspaces.find(item => item.id === workspaceId)
  const tab = state.tabs[conversation.tabId], region = tab?.regions[conversation.regionId]
  const layout = state.layouts[conversation.displayWorkspaceId]
  const group = layout?.groups.find(item => item.id === conversation.groupId && groupIds(layout.root).includes(item.id))
  const spaceId = workspace ? directoryIdentity(workspace.hostId, scratchTopicIdentityPath(workspace, topic)) : null
  const agent = catalog.regions.find(item => item.tabId === conversation.tabId && item.regionId === conversation.regionId)
  const session = region?.kind === 'agent' ? sessionPresentationById(state.sessions).get(region.sessionId) : undefined
  const actualSessionId = session?.control.kind === 'agent' ? session.control.agentSessionId : region?.kind === 'agent' ? region.sessionId : undefined
  if (!workspace || region?.kind !== 'agent' || actualSessionId !== conversation.sessionId || agent?.agentSessionId !== region.sessionId ||
      agent.execution && agent.execution.hostId !== conversation.hostId || session?.control.hostId && session.control.hostId !== conversation.hostId || tab?.workspaceId !== workspaceId ||
      !group?.tabOrder.includes(conversation.tabId) || !catalog.locations.some(location => location.spaceId === spaceId && location.workspaceId === workspaceId && sameWorkbenchProjectionSelection(location, conversation)))
    return { issue: 'The saved default conversation is not confirmed at its original location. Its reference and existing work are kept; choose its exact conversation in Profile or inspect MOTE.md.' }
  return { conversation, ...(!agent?.execution ? { issue: 'The default conversation’s execution Host is unconfirmed. Its original location and saved Host are kept; retry its Agent observation.' } : {}) }
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

/** Reuses the original catalog on only the selected Tab, layout and Agent identity. */
export function moteDefaultCatalog(state: State, topic: ScratchTopicSnapshot, conversation: MoteDefaultConversation): AgentMuxSpaceCatalog {
  const tab = state.tabs[conversation.tabId], layout = state.layouts[conversation.displayWorkspaceId]
  const region = tab?.regions[conversation.regionId]
  const agent = region?.kind === 'agent' ? sessionPresentationById(state.sessions).get(region.sessionId) : undefined
  return spatialCatalog({ ...state, tabs: tab ? { [tab.id]: tab } : {},
    layouts: layout ? { [conversation.displayWorkspaceId]: layout } : {}, sessions: agent ? [agent] : [] }, [topic])
}

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
