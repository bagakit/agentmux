import { readGoalDiscussionBinding, resolveGoalDiscussionBinding, type GoalDiscussionHandoff, type GoalDiscussionBindingReceipt } from '@agentmux/host/goal-discussion-bindings'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import type { SessionSnapshot } from '../../../shared/contracts'
import type { WorkbenchTab } from './workbench-tabs'
import type { WorkspaceLayout } from '@agentmux/layout'
import { tabGroupForTab } from './workbench-tabs'
import { sessionPresentationById } from './session-presentation'

type SavedState = {
  demandPmoTabIds: Record<string, string>
  tabs: Record<string, WorkbenchTab>
  layouts: Record<string, WorkspaceLayout>
  sessions: readonly SessionSnapshot[]
}
/** A finite saved-source export, never a runtime recipient fallback. */
export async function handoffSavedGoalDiscussions(ports: {
  getState(): SavedState
  handoff(input: GoalDiscussionHandoff): Promise<GoalDiscussionBindingReceipt>
  acknowledged(goalId: string, originalTabId: string, receipt: GoalDiscussionBindingReceipt): void
}, onlyGoalId?: string): Promise<void> {
  const failures: unknown[] = []
  for (const [goalId, tabId] of Object.entries(ports.getState().demandPmoTabIds)) {
    if (onlyGoalId !== undefined && goalId !== onlyGoalId) continue
    try {
      const state = ports.getState()
      if (state.demandPmoTabIds[goalId] !== tabId) continue
      const tab = state.tabs[tabId], layout = state.layouts[SCRATCH_WORKSPACE_ID]
      const candidates = tab ? Object.values(tab.regions).filter(region => region.kind === 'agent' || region.kind === 'launcher') : []
      const region = candidates.length === 1 ? candidates[0] : undefined
      if (!tab || tab.workspaceId !== SCRATCH_WORKSPACE_ID || tab.topicId !== PMO_TEAMS_TOPIC_ID || !layout ||
          tabGroupForTab(layout, tab.id) === null || !region || region.kind !== 'agent' && region.kind !== 'launcher')
        throw new Error('The exact saved Goal discussion workface is unconfirmed. Its original relationship is retained.')
      const session = region.kind === 'agent' ? sessionPresentationById(state.sessions).get(region.sessionId) : undefined
      if (region.kind === 'agent' && (session?.kind !== 'agent' || session.control.kind !== 'agent' || session.hostId !== session.control.hostId))
        throw new Error('The original discussion execution Host and Session are unconfirmed. Its saved relationship is retained.')
      const recipient = session?.kind === 'agent'
        ? { kind: 'agent' as const, hostId: session.control.hostId, agentSessionId: session.control.agentSessionId }
        : { kind: 'launcher' as const }
      const binding: GoalDiscussionHandoff['binding'] = { schema: 'agentmux.goal-discussion-binding.v1', tabId, regionId: region.regionId, recipient }
      const receipt = await ports.handoff({ goalId, binding })
      if (receipt.diskDurability !== 'confirmed' || receipt.key !== 'owned:goal-discussion:' + goalId)
        throw new Error('The original Core discussion binding has no durable producer acknowledgement. Its saved Desktop relationship is retained.')
      const confirmed = readGoalDiscussionBinding(receipt.state.graph, goalId)
      const completedLauncher = binding.recipient.kind === 'launcher' && confirmed?.recipient.kind === 'agent' && confirmed.tabId === binding.tabId && confirmed.regionId === binding.regionId
      if (!completedLauncher && JSON.stringify(confirmed) !== JSON.stringify(binding)) throw new Error('The Core acknowledgement names another discussion. The original Desktop relationship is retained.')
      resolveGoalDiscussionBinding(receipt.state.graph, confirmed!)
      ports.acknowledged(goalId, tabId, receipt)
    } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Some original Goal discussion relationships remain unconfirmed. Their saved sources and healthy workfaces are retained; retry saving after restoring their exact owners.')
}
