/** Both mobile Goal readers use the same words for the original owner facts. */
import type { DemandAgentReference } from '@agentmux/demand/relations'
import { goalPlanReviewState } from '@agentmux/demand/goals'
import type { AgentMuxRpcGoal } from '@agentmux/core'
import { compactReferenceId } from '@agentmux/client-ui/display-name'
/** Compact labels are never sent back as object identity. */
export const mobileGoalReferenceLabel = (reference: DemandAgentReference): string => typeof reference === 'string' ? reference
  : `${compactReferenceId(reference.execution.agentSessionId)} @ ${compactReferenceId(reference.execution.runtimeId)}`
export const mobileGoalStatus = { backlog: '待整理', todo: '待开始', in_progress: '进行中', in_review: '待检查', blocked: '受阻', done: '已完成', cancelled: '已取消' }
const reviewLabels = { 'awaiting-report': '待出结果报告', 'awaiting-evidence': '结果待核验', 'awaiting-acceptance': '结果待接受', accepted: '结果已接受' }
export function mobileGoalConclusion(goal: Pick<AgentMuxRpcGoal, 'planState' | 'alignment' | 'grounding' | 'status'>): string {
  if (goal.status === 'cancelled' || goal.status === 'done') return mobileGoalStatus[goal.status]
  const review = goalPlanReviewState(goal.planState, goal.alignment, goal.grounding)
  return review ? reviewLabels[review] : mobileGoalStatus[goal.status]
}
export const mobileGoalOutcome = { met: 'Agent 报告已达成', gap: '仍有差距', unknown: '结果未知' }
