import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { executorDetectionKey, type useAppStore } from '../store'
import { createPmoTeamsTopicTargetSelector } from './pmo-teams-topic-floating'
import { sessionPresentationById } from './session-presentation'
import { topicIdForSession } from './workbench-tabs'
import { configuredExecutors } from './executors'
import { currentExecutorDetection } from './executor-detection'
import { useLauncherState } from './launcher-state'

const selectPrimaryTab = createPmoTeamsTopicTargetSelector({ open: false, preview: false, targetTopicId: PMO_TEAMS_TOPIC_ID })
type PrimaryMoteState = Pick<ReturnType<typeof useAppStore.getState>, 'config' | 'tabs' | 'layouts' | 'agentFocus' | 'sessions' | 'executorDetections'>
let knownTabs: PrimaryMoteState['tabs'] | undefined, hasBot = false
export function primaryMoteHasBot(state: Pick<PrimaryMoteState, 'tabs'>): boolean {
  if (state.tabs !== knownTabs) {
    knownTabs = state.tabs
    hasBot = Object.values(state.tabs).some(tab => tab.workspaceId === SCRATCH_WORKSPACE_ID && tab.topicId === PMO_TEAMS_TOPIC_ID &&
      Object.values(tab.regions).some(region => region.kind === 'agent'))
  }
  return hasBot
}

/** The original primary target's active Region proves a bot; list order and display names do not. */
export function primaryMoteExecutorId(state: PrimaryMoteState, savedExecutorId = useLauncherState.getState().executors[SCRATCH_WORKSPACE_ID]): string | undefined {
  if (!primaryMoteHasBot(state)) {
    // A genuinely new primary Mote uses the original launcher's explicit preference/default.
    // A retained Agent Region, even without a Session snapshot, never enters this branch.
    const workspace = state.config?.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID)
    if (!workspace) return undefined
    const host = state.config?.hosts.find(item => item.id === workspace.hostId)
    const choices = configuredExecutors(state.config).map(executor => ({ ...executor,
      detection: currentExecutorDetection(state.executorDetections[executorDetectionKey(workspace.hostId, executor.id)], executor.id, executor, host)
    })).filter(executor => executor.detection?.state !== 'missing').sort((a, b) => Number(b.detection?.state === 'ready') - Number(a.detection?.state === 'ready'))
    const preference = savedExecutorId
    return preference ? choices.find(executor => executor.id === preference)?.id : choices.find(executor => executor.id === 'codex')?.id ?? choices[0]?.id
  }
  const tabId = selectPrimaryTab(state)
  const tab = tabId ? state.tabs[tabId] : undefined
  if (tab?.workspaceId !== SCRATCH_WORKSPACE_ID || tab.topicId !== PMO_TEAMS_TOPIC_ID) return undefined
  const region = tab.regions[tab.layout.activeRegionId]
  if (region?.kind !== 'agent') return undefined
  const session = sessionPresentationById(state.sessions).get(region.sessionId)
  if (session?.kind !== 'agent' || topicIdForSession(state.config, session) !== PMO_TEAMS_TOPIC_ID) return undefined
  const executor = state.config?.executors[session.executorId]
  return executor?.providerId === session.providerId ? session.executorId : undefined
}
