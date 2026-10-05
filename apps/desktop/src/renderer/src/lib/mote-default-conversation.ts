import { groupIds } from '@agentmux/layout'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { spatialCatalog, type SpatialWorkbench } from './space-agent-control'
import { sessionPresentationById } from './session-presentation'
import type { ScratchTopicSnapshot } from '../../../shared/contracts'
import { scratchTopicIdentityPath } from '../../../shared/scratch-topics'
import { directoryIdentity } from '../../../shared/space-addresses'
import { sameWorkbenchProjectionSelection } from './workbench-projection'
import type { MoteDefaultConversation } from '../../../shared/mote-quick-mode'

type State = SpatialWorkbench
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
/** Reuses the original catalog on only the selected Tab, layout and Agent identity. */
export function moteDefaultCatalog(state: State, topic: ScratchTopicSnapshot, conversation: MoteDefaultConversation): AgentMuxSpaceCatalog {
  const tab = state.tabs[conversation.tabId], layout = state.layouts[conversation.displayWorkspaceId]
  const region = tab?.regions[conversation.regionId]
  const agent = region?.kind === 'agent' ? sessionPresentationById(state.sessions).get(region.sessionId) : undefined
  return spatialCatalog({ ...state, tabs: tab ? { [tab.id]: tab } : {},
    layouts: layout ? { [conversation.displayWorkspaceId]: layout } : {}, sessions: agent ? [agent] : [] }, [topic])
}
