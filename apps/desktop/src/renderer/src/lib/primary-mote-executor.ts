import { scratchTopicsForConfig } from './scratch-topic-snapshots'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import type { useAppStore } from '../store'
import { createPmoTeamsTopicTargetSelector } from './pmo-teams-topic-floating'
import { sessionPresentationById } from './session-presentation'
import { topicIdForSession } from './workbench-tabs'
import { executorsForHost } from './executors'
import type { ScratchTopicSnapshot } from '../../../shared/contracts'
import { useLauncherState } from './launcher-state'

const selectPrimaryTab = createPmoTeamsTopicTargetSelector({ open: false, preview: false, targetTopicId: PMO_TEAMS_TOPIC_ID })
type PrimaryMoteState = Pick<ReturnType<typeof useAppStore.getState>, 'config' | 'tabs' | 'layouts' | 'agentFocus' | 'sessions' | 'executorDetections'> & Partial<Pick<ReturnType<typeof useAppStore.getState>, 'scratchTopicSnapshots' | 'hostExecutorInventories'>>
let knownTabs: PrimaryMoteState['tabs'] | undefined, hasBot = false
export function primaryMoteHasBot(state: Pick<PrimaryMoteState, 'tabs'>): boolean {
  if (state.tabs !== knownTabs) {
    knownTabs = state.tabs
    hasBot = Object.values(state.tabs).some(tab => tab.workspaceId === SCRATCH_WORKSPACE_ID && tab.topicId === PMO_TEAMS_TOPIC_ID &&
      Object.values(tab.regions).some(region => region.kind === 'agent'))
  }
  return hasBot
}

export type PrimaryMoteExecutorChoice = { executorId?: string; issue?: string }

/** New-chat configuration belongs to the exact Mote file, independently of existing bots. */
export function primaryMoteExecutorChoice(state: PrimaryMoteState, savedExecutorId = useLauncherState.getState().executors[SCRATCH_WORKSPACE_ID], prepared?: ScratchTopicSnapshot): PrimaryMoteExecutorChoice {
  const workspace = state.config?.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID)
  if (!workspace) return {}
  const topic = prepared?.id === PMO_TEAMS_TOPIC_ID ? prepared : scratchTopicsForConfig(state.config, state.scratchTopicSnapshots)?.find(item => item.id === PMO_TEAMS_TOPIC_ID)
  if (topic?.quickMode?.status === 'unconfirmed') return { issue: topic.quickMode.message }
  const moteExecutorId = topic?.quickMode?.status === 'saved' ? topic.quickMode.defaults.executorId : undefined
  if (moteExecutorId || !primaryMoteHasBot(state)) {
    const choices = executorsForHost(state.config, workspace.hostId, state.executorDetections, state.hostExecutorInventories?.[workspace.hostId])
      .filter(executor => executor.detection?.state !== 'missing').sort((a, b) => Number(b.detection?.state === 'ready') - Number(a.detection?.state === 'ready'))
    if (moteExecutorId) {
      const executor = choices.find(item => item.id === moteExecutorId)
      return executor ? { executorId: executor.id } : { issue: `Mote new-chat Agent ${moteExecutorId} is unavailable or unconfirmed on Host ${workspace.hostId}. The saved configuration is kept.` }
    }
    // A genuinely new primary Mote uses the original launcher's explicit preference/default.
    // A retained Agent Region, even without a Session snapshot, never enters this branch.
    const preference = savedExecutorId
    const executorId = preference ? choices.find(executor => executor.id === preference)?.id : choices.find(executor => executor.id === 'codex')?.id ?? choices[0]?.id
    return executorId ? { executorId } : {}
  }
  const tabId = selectPrimaryTab(state)
  const tab = tabId ? state.tabs[tabId] : undefined
  if (tab?.workspaceId !== SCRATCH_WORKSPACE_ID || tab.topicId !== PMO_TEAMS_TOPIC_ID) return {}
  const region = tab.regions[tab.layout.activeRegionId]
  if (region?.kind !== 'agent') return {}
  const session = sessionPresentationById(state.sessions).get(region.sessionId)
  if (session?.kind !== 'agent' || topicIdForSession(state.config, session, scratchTopicsForConfig(state.config, state.scratchTopicSnapshots)) !== PMO_TEAMS_TOPIC_ID) return {}
  const executor = state.config?.executors[session.executorId]
  return executor?.providerId === session.providerId ? { executorId: session.executorId } : {}
}

/** Primitive projection for existing action selectors. */
export function primaryMoteExecutorId(state: PrimaryMoteState, savedExecutorId = useLauncherState.getState().executors[SCRATCH_WORKSPACE_ID]): string | undefined {
  return primaryMoteExecutorChoice(state, savedExecutorId).executorId
}
