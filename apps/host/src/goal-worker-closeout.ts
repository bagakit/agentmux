import { AgentMuxError, sessionSemanticResumeSourceRuns, type AgentMuxAgentSession, type AgentMuxClient,
  type AgentMuxRpcCallContext, type AgentMuxSpatialStateStore } from '@agentmux/core'
import type { GoalCloseout, GoalCloseoutResult, GoalDelegationAuthority } from '@agentmux/core/goal-delegation'
import { runBoundDemandDispatch, type Demand, type DemandStore } from '@agentmux/demand'
import { delegationWorkerHostId } from '@agentmux/demand/delegations'
import { goalSupervisorHostWitnesses, goalSupervisorRuntimeWitnesses } from '@agentmux/demand/relations'
import { hostGoalPlan } from './goal-projection.js'

type Retained = Extract<GoalCloseoutResult, { state: 'retained' }>
type DesktopOccupation = 'clear' | 'draft' | 'pending' | 'unknown'

function supervisorOwnsCloseout(goal: Demand, worker: AgentMuxAgentSession, authority: GoalDelegationAuthority): boolean {
  const id = authority.actor.id
  const creator = worker.creation?.createdBy
  if (goal.supervisorSessionId !== id || creator?.owner.kind !== 'local' || creator.agentSessionId !== id) return false
  const runtimes = goalSupervisorRuntimeWitnesses(goal, id)
  if (runtimes.size) return runtimes.size === 1 && runtimes.has(authority.runtimeId!)
  const hosts = goalSupervisorHostWitnesses(goal)
  return hosts.length === 1 && hosts[0] === 'local'
}

function otherGoalWork(goals: readonly Demand[], input: GoalCloseout, sourceRuns: readonly string[], runtimeId: string | undefined): boolean {
  return goals.some(goal => {
    if (goal.status === 'done' || goal.status === 'cancelled') return false
    const matches = (reference: Demand['supervisorSessionId']) => typeof reference === 'string'
      ? reference === input.agentSessionId
      : reference?.execution.runtimeId === runtimeId && reference?.execution.agentSessionId === input.agentSessionId
    if (matches(goal.supervisorSessionId) ||
        goal.id !== input.goalId && goal.assigneeSessionIds.some(matches)) return true
    if (goal.dispatches?.some(start => runBoundDemandDispatch(start) && sourceRuns.includes(start.runId) &&
        ('target' in start ? matches(start.target) : start.hostId === 'local' && start.agentSessionId === input.agentSessionId))) return true
    const own = goal.id === input.goalId ? goal.delegations?.find(attempt => attempt.operationId === input.attempt) : undefined
    if (goal.delegations?.some(attempt => attempt.operationId !== own?.operationId && delegationWorkerHostId(attempt) === 'local' &&
        attempt.workerAgentSessionId === input.agentSessionId && sourceRuns.includes(attempt.workerRunId) && !attempt.collection)) return true
    const assigned = goal.plan?.nodes.filter(node => node.id !== own?.planNodeId &&
      node.executor?.hostId === 'local' && node.executor.agentSessionId === input.agentSessionId)
    if (!assigned?.length) return false
    const { planState } = hostGoalPlan(goal)
    return assigned.some(node => {
      const state = planState?.nodes.find(row => row.id === node.id)?.state
      return state !== 'done' && state !== 'cancelled'
    })
  })
}

export function createGoalWorkerCloseout(options: {
  demands: DemandStore
  client(): AgentMuxClient
  spatial?: AgentMuxSpatialStateStore
  desktopOccupation?(agentSessionId: string, runId: string, context: AgentMuxRpcCallContext,
    closeout?: { action: 'admit' | 'reconcile'; operationId: string }): Promise<DesktopOccupation>
}) {
  return async (input: GoalCloseout, context: AgentMuxRpcCallContext, authority: GoalDelegationAuthority): Promise<GoalCloseoutResult> => {
    const retain = (reason: Retained['reason']): Retained => ({ ...input, state: 'retained', reason })
    const caller = context.caller
    const self = authority.actor.id === input.agentSessionId
    if (authority.actor.kind !== 'agent' || authority.hostId !== 'local' || !authority.runtimeId || !authority.runId || !caller ||
        self && authority.runId !== input.runId)
      throw new AgentMuxError('Closeout requires the original local worker or its current local Supervisor.', 'CONTROL_PERMISSION_DENIED')
    const client = options.client()
    const run = { runId: input.runId }
    // The Host checks occupation for this authorized action; draft contents stay at Desktop.
    const desktopContext: AgentMuxRpcCallContext = { transport: 'unix', ...(context.signal ? { signal: context.signal } : {}) }
    let worker: AgentMuxAgentSession | undefined
    let sourceRuns: readonly string[] = [input.runId]
    const inspect = (goals: readonly Demand[]) => {
      const goal = goals.find(item => item.id === input.goalId)
      const attempt = goal?.delegations?.find(item => item.operationId === input.attempt)
      const current = goal && attempt?.planNodeId
        ? hostGoalPlan(goal).planState?.nodes.find(node => node.id === attempt.planNodeId)
        : undefined
      if (!goal || !attempt?.planNodeId || !current || current.attempt?.delegationOperationId !== attempt.operationId ||
          (current.state !== 'done' && (!self || current.state !== 'review')) || !sourceRuns.includes(attempt.workerRunId) ||
          attempt.workerAgentSessionId !== input.agentSessionId || delegationWorkerHostId(attempt) !== 'local' ||
          !attempt.report?.delivery || attempt.report.delivery.authorRuntimeId !== authority.runtimeId ||
          !attempt.collection || attempt.collection.replyMessageId !== attempt.report.replyMessageId ||
          attempt.collection.collector.kind !== 'agent' || attempt.collection.collector.id !== goal.supervisorSessionId ||
          goal.alignment?.revision !== attempt.alignmentRevision ||
          (!self && (!worker || !supervisorOwnsCloseout(goal, worker, authority))))
        return { reason: 'handoff' as const }
      if (otherGoalWork(goals, input, sourceRuns, authority.runtimeId)) return { reason: 'other-work' as const }
      return { attempt }
    }
    let core, collectionOperationId: string | undefined
    try {
      if (!self) {
        worker = (await client.readAgentSession(input.agentSessionId)) ?? undefined
        if (!worker || worker.run.runId !== input.runId) return retain('unknown')
        // Preserve an explicit user reopen. Only the original startup resume may
        // carry a completed attempt's custody into this new Run.
        if (!worker.reopenedFrom && worker.continuity?.trigger === 'startup')
          sourceRuns = sessionSemanticResumeSourceRuns(worker)
      }
      const first = inspect(await options.demands.list())
      if (first.reason) return retain(first.reason)
      const stop = await client.inspectAgentStop({ agentSessionId: input.agentSessionId, expectedRun: run, operationId: input.operationId })
      if (stop.phase !== 'not-requested') return retain('unknown')
      const originalSpace = await options.spatial?.readForLayout()
      if (!originalSpace) return retain('unknown')
      const regions = originalSpace.graph.regions.filter(region => region.agentSessionId === input.agentSessionId)
      if (regions.some(region => region.kind !== 'agent' || region.runId !== input.runId || region.execution?.hostId !== 'local' ||
          region.execution.runtimeId !== undefined && region.execution.runtimeId !== authority.runtimeId)) return retain('unknown')
      // Detached presentations can retain original Desktop drafts by Session.
      const desktop = await options.desktopOccupation?.(input.agentSessionId, input.runId, desktopContext)
      if (desktop !== 'clear') return retain(desktop ?? 'unknown')
      core = await client.readAgentCloseoutInput(input.agentSessionId, run, first.attempt.sourceMessageId)
      if (core.state !== 'clear') return retain(core.state)
      collectionOperationId = first.attempt.collection?.operationId
      if ((await options.spatial?.readForLayout())?.revision !== originalSpace.revision) return retain('unknown')
    } catch {
      context.signal?.throwIfAborted()
      return retain('unknown')
    }
    context.signal?.throwIfAborted()
    await context.assertCurrent?.()
    const current = await client.authorizeAgentCaller(caller.capability, authority.actor.id)
    if (current.run.runId !== authority.runId) return retain('unknown')
    let refusal: Retained['reason'] | undefined, desktopRequested = false
    try {
      const result = await client.stopAgentIfInputClear(core.proof, input.operationId, async admit => {
        context.signal?.throwIfAborted()
        desktopRequested = true
        // The original Desktop grants this operation in the same event order as editing.
        // Do not hold the Goal or Core journal writer across the Desktop call.
        const desktop = await options.desktopOccupation?.(input.agentSessionId, input.runId, desktopContext, { action: 'admit', operationId: input.operationId })
        if (desktop !== 'clear') {
          refusal = desktop ?? 'unknown'
          throw new AgentMuxError('The original Desktop did not grant this Stop operation.', 'GOAL_CLOSEOUT_DESKTOP_RETAINED')
        }
        return await options.demands.withCurrentDemands(async goals => {
          context.signal?.throwIfAborted()
          const last = inspect(goals)
          refusal = last.reason ?? (last.attempt.collection?.operationId !== collectionOperationId ? 'unknown' : undefined)
          if (refusal) throw new AgentMuxError('The original Goal handoff or other responsibilities changed before admission.', 'GOAL_CLOSEOUT_HANDOFF_CHANGED')
          return await admit()
        })
      })
      return refusal ? retain(refusal) : { ...input, ...result }
    } finally {
      if (desktopRequested) {
        // Reconcile metadata through the Desktop owner even when the reader cancelled.
        // A lost reconciliation leaves the original operation discoverable by Core Stop inspect.
        void options.desktopOccupation?.(input.agentSessionId, input.runId, { transport: 'unix' },
          { action: 'reconcile', operationId: input.operationId }).catch(() => {})
      }
    }
  }
}
