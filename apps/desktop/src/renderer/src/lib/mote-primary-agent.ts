import type { WorkspaceRecord } from '../../../shared/contracts'
import { scratchTopicLogicalPath } from '@agentmux/host/mote-model'
import { useAppStore } from '../store'
import { scratchTopicKind, scratchTopicsForWorkspace } from './scratch-topic-snapshots'
import { moteConversationChoices } from './mote-quick-preferences'
import { spatialCatalog } from './space-agent-control'
import { readMoteQuickDefaults, saveMoteQuickDefaults, MoteQuickSaveError } from './mote-quick-mode'
import { openMoteMaterialAt } from './mote-materials-actions'
import type { MoteWorkfaceScope } from './mote-workface'
import type { WorkbenchProjectionSelection } from './workbench-projection'
import { DEFAULT_MOTE_PRESENCE, parseMotePreferencesSaveParams, type MoteQuickPreferencesSaveParams } from '@agentmux/core/mote-preferences'
import { checkpointLauncherState, useLauncherState } from './launcher-state'

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
  const saved = await readMoteQuickDefaults(scope, false)
  if (saved.issue) throw new Error(saved.issue)
  // Another explicit choice wins. Never replace it with the last launch to finish.
  if (saved.defaults.conversation) return
  const controller = new AbortController()
  const retention: { original?: { key: string; input: MoteQuickPreferencesSaveParams; createdDraft: string | null } } = {}
  let confirmed = false
  const retain = async (raw: MoteQuickPreferencesSaveParams) => {
    const input = parseMotePreferencesSaveParams(raw) as MoteQuickPreferencesSaveParams
    const key = 'mote-quick:' + JSON.stringify(input.target)
    for (const phase of ['not-dispatched', 'may-have-dispatched'] as const) {
      const current = useLauncherState.getState().drafts[key]?.moteQuick
      if (current?.pending && JSON.stringify(current.pending.input) !== JSON.stringify(input) ||
        phase === 'may-have-dispatched' && current?.pending?.input.operationId !== input.operationId)
        throw new Error('The original Mote settings request changed. Check it in Profile; the created Agent and input are kept.')
      const draft = current ?? { draft: input.values, minutes: String((input.values.presence ?? DEFAULT_MOTE_PRESENCE).intervalMs / 60000),
        rolloverKind: input.values.conversationRollover?.kind ?? 'keep-current',
        rolloverMinutes: input.values.conversationRollover?.kind === 'idle' ? String(input.values.conversationRollover.idleMs / 60000) : '' }
      retention.original ??= { key, input, createdDraft: current ? null : JSON.stringify(draft) }
      if (!useLauncherState.getState().setMoteQuickDraft(key, { ...draft, pending: { input, phase } }))
        throw new Error('The original Main setup request could not be retained. The created Agent and input are kept.')
      await checkpointLauncherState()
      if (JSON.stringify(useLauncherState.getState().drafts[key]?.moteQuick?.pending?.input) !== JSON.stringify(input))
        throw new Error('The original Main setup request changed before dispatch. The created Agent and later settings are kept.')
    }
  }
  try {
    await saveMoteQuickDefaults(scope, { ...saved.defaults, conversation }, saved,
      async path => (await openMoteMaterialAt(scope, path, reference, reference, controller.signal))?.reference,
      () => {
        const current = useAppStore.getState().config?.workspaces.find(item => item.id === scope.workspace.id)
        return current?.hostId === scope.workspace.hostId && current.path === scope.workspace.path
      }, reference, undefined, retain)
    confirmed = true
  } catch (cause) {
    confirmed = cause instanceof MoteQuickSaveError && cause.confirmed !== null
    throw cause
  } finally {
    // Only the original writer's known outcome settles this request. Later input is separate.
    const original = retention.original, current = original && useLauncherState.getState().drafts[original.key]?.moteQuick
    if (original && !saved.pending && current?.pending?.input.operationId === original.input.operationId) {
      const { pending: _pending, ...draft } = current
      useLauncherState.getState().setMoteQuickDraft(original.key, confirmed && original.createdDraft === JSON.stringify(draft) ? undefined : draft)
      await checkpointLauncherState()
    }
  }
}
