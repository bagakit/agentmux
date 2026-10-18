import { mintObjectId } from '@agentmux/core/object-id'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type AgentMuxControlRequest, type AgentMuxControlResult } from '@agentmux/core/control'
import { globalGoalPatrolPrompt } from '@agentmux/core/goal-patrol'
import type { Demand } from '@agentmux/demand'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { topicSpatialAddress } from '../../../shared/space-addresses'
import type { AppState } from '../store'
import { primaryMoteExecutorChoice } from './primary-mote-executor'
import { scratchTopicsForWorkspace } from './scratch-topic-snapshots'
import { requestAgentConversationFloatingOpen, readPmoTeamsTopicFloatingState } from './pmo-teams-topic-floating'
import type { WorkbenchProjectionSelection } from './workbench-projection'
import type { SpatialControlOptions } from './space-agent-control'

type State = AppState
type Ports = {
  get(): State
  subscribe(listener: () => void): () => void
  list(): Promise<Demand[]>
  execute(request: AgentMuxControlRequest, options?: SpatialControlOptions): Promise<AgentMuxControlResult>
}

/** One original agent.open owns creation, input and reconciliation for the global discussion. */
export async function executeGlobalGoalPatrol(ports: Ports, request: Extract<AgentMuxControlRequest, { operation: 'demand.patrol-all' }>): Promise<Extract<AgentMuxControlResult, { operation: 'demand.patrol-all' }>> {
  const original = ports.get().spatialRequests[request.requestId]
  let presented = false
  const before = readPmoTeamsTopicFloatingState()
  const show = (to: WorkbenchProjectionSelection | null) => {
    if (presented || readPmoTeamsTopicFloatingState() !== before) return
    const binding = ports.get().spatialRequests[request.requestId]
    if (!binding || binding.purpose !== 'goal-global-patrol') return
    presented = true
    requestAgentConversationFloatingOpen(binding.agentSessionId, binding.executionHostId,
      '全局 Demand 巡查 · 检查全部目标并汇总建议；实际工作状态以原 Agent 为准。', to ?? undefined)
    // Set the new discussion's initial mode before launch can become interactive.
    // The final receipt never overrides a later explicit mode selection.
    if (!original) ports.get().setViewMode(binding.agentSessionId, 'activity', { focus: false })
  }
  if (original) {
    if (original.operation !== 'agent.open' || original.purpose !== 'goal-global-patrol') throw new Error('This operation belongs to another original intent. Keep its identity; no global inspection was created.')
    show(original.target.displayWorkspaceId && original.target.groupId ? { displayWorkspaceId: original.target.displayWorkspaceId,
      groupId: original.target.groupId, tabId: original.tabId, regionId: original.regionId } : null)
    const result = await ports.execute({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: mintObjectId(), operation: 'space.inspect', target: { requestId: request.requestId } })
    if (result.operation !== 'space.inspect' || !result.request?.report) throw new Error('The original global inspection receipt is unconfirmed. Inspect this same operation; no new Tab or input was created.')
    return { ...result.request.report, operation: 'demand.patrol-all' }
  }
  let state = ports.get()
  const scratch = state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
  if (!scratch) throw new Error('The original primary Mote Workspace is unavailable. The inspection has not been dispatched.')
  if (!scratchTopicsForWorkspace(state.scratchTopicSnapshots, scratch)?.some(topic => topic.id === PMO_TEAMS_TOPIC_ID)) await state.refreshScratchTopics(scratch.id)
  state = ports.get()
  const topic = scratchTopicsForWorkspace(state.scratchTopicSnapshots, scratch)?.find(topic => topic.id === PMO_TEAMS_TOPIC_ID)
  if (!topic) throw new Error('The original primary PMO Mote is unconfirmed. Open its existing setup; this inspection has not been dispatched.')
  const address = topicSpatialAddress(state.config, topic, state.spaceZoneBindings, state.topicCategories)
  const choice = primaryMoteExecutorChoice(state, undefined, topic)
  if (!address || !choice.executorId) throw new Error(choice.issue ?? 'The primary Mote source or new-discussion Agent configuration is unconfirmed. No replacement Mote or Agent was selected.')
  let goals: Demand[] = [], inventoryIssue: string | undefined
  try { goals = await ports.list() }
  catch (error) { inventoryIssue = error instanceof Error ? error.message : String(error) }
  const release = ports.subscribe(() => {
    const current = ports.get(), binding = current.spatialRequests[request.requestId]
    if (!binding || binding.purpose !== 'goal-global-patrol') return
    const target = binding.target
    if (target.displayWorkspaceId && target.groupId) show({
      displayWorkspaceId: target.displayWorkspaceId, groupId: target.groupId, tabId: binding.tabId, regionId: binding.regionId })
  })
  try {
    const result = await ports.execute({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: request.requestId,
      operation: 'agent.open', content: { kind: 'new-agent', executorId: choice.executorId, prompt: globalGoalPatrolPrompt(goals.length, inventoryIssue) },
      destination: { ...address, newTab: true }, focus: false, ...(request.caller ? { caller: request.caller } : {}) }, { purpose: 'goal-global-patrol' })
    if (result.operation !== 'agent.open') throw new Error('The global inspection returned another operation. Keep the original request and inspect it.')
    show(result.to)
    return { ...result, operation: 'demand.patrol-all', ...(inventoryIssue ? {
      outcome: result.outcome === 'opened' || result.outcome === 'unchanged' ? 'partial' : result.outcome,
      issues: [...result.issues, { step: 'scope', code: 'GOAL_INVENTORY_UNAVAILABLE', message: 'Original inventory observation is unavailable: ' + inventoryIssue,
        recovery: 'The PMO task and exact new discussion are retained; read the original Goal owner there and report the missing scope.' }]
    } : {}) }
  } finally { release() }
}
