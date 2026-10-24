import type { AgentMuxControlRequest, AgentMuxControlResult } from '@agentmux/core/control'
import { primaryMoteExecutorChoice } from './primary-mote-executor'
import type { AppState } from '../store'
import { requestAgentConversationFloatingOpen, readPmoTeamsTopicFloatingState } from './pmo-teams-topic-floating'

type Request = Extract<AgentMuxControlRequest, { operation: 'demand.patrol-all' }>
type Result = Extract<AgentMuxControlResult, { operation: 'demand.patrol-all' }>

/** Desktop owns only presentation of the original Host patrol receipt. */
export async function executeGlobalGoalPatrol(ports: {
  get(): AppState
  execute(request: Request): Promise<AgentMuxControlResult>
}, request: Request): Promise<Result> {
  const before = readPmoTeamsTopicFloatingState()
  const known = new Set(ports.get().sessions.map(session => session.id))
  const executorId = request.executorId ?? primaryMoteExecutorChoice(ports.get()).executorId
  const result = await ports.execute({ ...request, ...(executorId ? { executorId } : {}) })
  if (result.operation !== 'demand.patrol-all') throw new Error('The original Host returned another patrol operation. Its request remains retained.')
  if (result.agent && result.to && readPmoTeamsTopicFloatingState() === before) {
    const to = result.to
    requestAgentConversationFloatingOpen(result.agent.agentSessionId, result.agent.hostId,
      '全局 Demand 巡查 · 检查全部目标并汇总建议；实际工作状态以原 Agent 为准。',
      to.displayWorkspaceId && to.groupId ? { displayWorkspaceId: to.displayWorkspaceId, groupId: to.groupId, tabId: to.tabId, regionId: to.regionId } : undefined)
    if (!known.has(result.agent.agentSessionId)) ports.get().setViewMode(result.agent.agentSessionId, 'activity', { focus: false })
  }
  return result
}
