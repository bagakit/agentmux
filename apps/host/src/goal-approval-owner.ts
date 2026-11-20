import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError, type AgentInputCallContext, type AgentMuxClient, type AgentMuxRpcParams,
  type GoalApprovalAuthority } from '@agentmux/core'
import type { AgentMuxDemand } from '@agentmux/core/control'
import { runBoundDemandDispatch, type Demand, type DemandDispatch, type DemandStore } from '@agentmux/demand'

function originalStart(start: DemandDispatch | null, runtimeId: string | undefined) {
  if (!start || !runtimeId || !runBoundDemandDispatch(start) || !('target' in start) || start.stage !== 'confirmed' ||
      start.target.execution.runtimeId !== runtimeId || start.receipt?.kind !== 'core-input') return undefined
  return start.receipt.inputKey
}

export function createGoalApprovalOwner(options: {
  demands: DemandStore
  runtimeId(): string | undefined
  client(): AgentMuxClient
  changed(goalId: string): void
}) {
  return {
    async respond(input: AgentMuxRpcParams<'agent.interaction.respond'>, actor: GoalApprovalAuthority['actor'], context: AgentInputCallContext) {
      const { goalApproval, ...response } = input
      const selection = goalApproval!
      const start = await options.demands.inspectDispatch(selection.goalId, selection.dispatchOperationId)
      const inputKey = originalStart(start, options.runtimeId())
      if (!inputKey || inputKey.agentSessionId !== response.agentSessionId || inputKey.expectedRun.runId !== response.expectedRun?.runId)
        throw new AgentMuxError('Choose an original confirmed local Start for this permission’s exact Session and Run. The permission remains available.', 'GOAL_APPROVAL_SOURCE_UNCONFIRMED')
      try {
        return await options.client().respondAgentInteraction({ ...response, authorHuman: true }, { ...context, goalApproval: { ...selection, inputKey, actor } })
      } finally {
        // Even a lost answer receipt may have changed the original Core record. A
        // Goal watch notification only invalidates its read, without claiming delivery.
        void Promise.resolve().then(() => options.changed(selection.goalId)).catch(error =>
          console.warn('Original Goal permission invalidation is unconfirmed.', error))
      }
    },

    async read(goal: Demand): Promise<Pick<AgentMuxDemand, 'approvalObservations' | 'approvalObservationIssue'>> {
      const runtimeId = options.runtimeId()
      const starts = new Map((goal.dispatches ?? []).flatMap(start => {
        const inputKey = originalStart(start, runtimeId)
        return inputKey ? [[start.operationId, inputKey] as const] : []
      }))
      if (!starts.size) return {}
      const sessions = new Set([...starts.values()].map(key => key.agentSessionId))
      const reads = await Promise.allSettled([...sessions].map(id => options.client().listAgentGoalApprovals(id, goal.id)))
      const approvalObservations = reads.flatMap(read => read.status === 'fulfilled' ? read.value.filter(({ attribution }) =>
        isDeepStrictEqual(starts.get(attribution.dispatchOperationId), attribution.inputKey)) : [])
      return { approvalObservations, ...(reads.some(read => read.status === 'rejected') ? {
        approvalObservationIssue: 'Some original permission responses could not be read. Refresh the Goal to check their saved records.'
      } : {}) }
    }
  }
}
