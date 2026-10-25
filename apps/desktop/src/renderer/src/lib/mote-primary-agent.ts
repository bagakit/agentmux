import type { WorkspaceRecord } from '../../../shared/contracts'
import { scratchTopicLogicalPath } from '../../../shared/scratch-topics'
import { useAppStore } from '../store'
import { scratchTopicKind, scratchTopicsForWorkspace } from './scratch-topic-snapshots'
import { moteConversationChoices } from './mote-quick-preferences'
import { spatialCatalog } from './space-agent-control'
import { readMoteQuickDefaults, saveMoteQuickDefaults } from './mote-quick-mode'
import { openMoteMaterialAt } from './mote-materials-actions'
import type { MoteWorkfaceScope } from './mote-workface'
import type { WorkbenchProjectionSelection } from './workbench-projection'

/** Capture only a confirmed empty Mote before an explicit Launcher start. */
export function firstMoteAgentScope(workspace: WorkspaceRecord, topicId: string | undefined): MoteWorkfaceScope | null {
  const state = useAppStore.getState(), topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspace)
  const topic = topics?.find(item => item.id === topicId)
  if (!topic || topic.readError || scratchTopicKind(topic.id, topics) !== 'mote' || topic.quickMode?.status === 'unconfirmed' ||
    topic.quickMode?.status === 'saved' && topic.quickMode.defaults.conversation) return null
  // An unobserved member still exists; lack of a selectable conversation is not emptiness.
  if (Object.values(state.tabs).some(tab => tab.workspaceId === workspace.id && tab.topicId === topic.id &&
    Object.values(tab.regions).some(region => region.kind === 'agent'))) return null
  const rootPath = scratchTopicLogicalPath(workspace, topic)
  if (rootPath === null || moteConversationChoices(state, topic, workspace.id, spatialCatalog(state, [topic])).length) return null
  return { workspace, topic, rootPath }
}

/** Creation already succeeded. This optional preference write never owns its Run or input. */
export async function establishFirstMoteAgent(scope: MoteWorkfaceScope, reference: WorkbenchProjectionSelection,
  agent: { hostId: string; sessionId: string }): Promise<void> {
  const state = useAppStore.getState()
  const conversation = moteConversationChoices(state, scope.topic, scope.workspace.id, spatialCatalog(state, [scope.topic]))
    .find(item => item.hostId === agent.hostId && item.sessionId === agent.sessionId && item.displayWorkspaceId === reference.displayWorkspaceId &&
      item.groupId === reference.groupId && item.tabId === reference.tabId && item.regionId === reference.regionId)
  if (!conversation) throw new Error('The created Agent’s original location is not yet confirmed. Choose the main Agent in Profile; the original Agent and input are kept.')
  const saved = await readMoteQuickDefaults(scope)
  if (saved.issue) throw new Error(saved.issue)
  // Another explicit choice wins. Never replace it with the last launch to finish.
  if (saved.defaults.conversation) return
  const controller = new AbortController()
  await saveMoteQuickDefaults(scope, { ...saved.defaults, conversation }, saved,
    async path => (await openMoteMaterialAt(scope, path, reference, reference, controller.signal))?.reference,
    () => {
      const current = useAppStore.getState().config?.workspaces.find(item => item.id === scope.workspace.id)
      return current?.hostId === scope.workspace.hostId && current.path === scope.workspace.path
    }, reference)
}
