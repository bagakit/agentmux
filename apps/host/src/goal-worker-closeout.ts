import { AgentMuxError, type AgentMuxClient, type AgentMuxRpcCallContext, type AgentMuxSpatialStateStore } from '@agentmux/core'
import { clearTimeout, setTimeout } from 'node:timers'
import type { GoalCloseout, GoalCloseoutResult, GoalDelegationAuthority } from '@agentmux/core/goal-delegation'
import { runBoundDemandDispatch, type Demand, type DemandStore } from '@agentmux/demand'
import { delegationWorkerHostId, type DemandDelegation, type GoalCloseoutContext } from '@agentmux/demand/delegations'
import { hostGoalPlan } from './goal-projection.js'
import { isGoalSupervisor } from './goal-supervisor-identity.js'
import type { GoalRuntimePort } from './goal-runtime.js'

type Retained = Extract<GoalCloseoutResult, { state: 'retained' }>
type DesktopOccupation = GoalCloseoutContext['desktopInput']
const closeoutObservationBudgetMs = 250

async function withinObservationBudget<T>(work: () => Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work(), new Promise<undefined>(resolve => {
      timer = setTimeout(resolve, closeoutObservationBudgetMs)
    })])
  } finally {
    clearTimeout(timer)
  }
}

function capturedCloseout(attempt: DemandDelegation | undefined, input: GoalCloseout) {
  return attempt?.closeoutObservations?.find(item => item.operationId === input.operationId && item.runId === input.runId)?.observations
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
  runtime: Pick<GoalRuntimePort, 'resolveGoalAgent'>
  spatial?: AgentMuxSpatialStateStore
  desktopOccupation?(agentSessionId: string, runId: string, context: AgentMuxRpcCallContext,
    closeout?: { action: 'admit' | 'reconcile'; operationId: string }): Promise<DesktopOccupation>
}) {
  return async (input: GoalCloseout, context: AgentMuxRpcCallContext, authority: GoalDelegationAuthority): Promise<GoalCloseoutResult> => {
    const retain = (reason: Retained['reason']): Retained => ({ ...input, state: 'retained', reason })
    const caller = context.caller
    const self = authority.actor.id === input.agentSessionId
    if (authority.actor.kind !== 'agent' || authority.hostId !== 'local' || !authority.runtimeId || !authority.runId || !caller)
      throw new AgentMuxError('Closeout requires the original local worker or its current local Supervisor.', 'CONTROL_PERMISSION_DENIED')
    const client = options.client()
    const run = { runId: input.runId }
    // The Host checks occupation for this authorized action; draft contents stay at Desktop.
    const desktopContext: AgentMuxRpcCallContext = { transport: 'unix', ...(context.signal ? { signal: context.signal } : {}) }
    const sourceRuns = [input.runId]
    const goal = await options.demands.get(input.goalId)
    const supervisor = goal?.supervisorSessionId
    const supervisorId = typeof supervisor === 'string' ? supervisor : supervisor?.execution.agentSessionId
    if (!self || input.inspect || supervisorId === authority.actor.id) {
      const attempt = goal?.delegations?.find(item => item.operationId === input.attempt)
      const authorized = goal && (supervisor && typeof supervisor !== 'string'
        ? supervisor.execution.agentSessionId === authority.actor.id && supervisor.execution.runtimeId === authority.runtimeId
        : await isGoalSupervisor(goal, authority, options.runtime))
      if (!goal || !authorized || !attempt || attempt.workerAgentSessionId !== input.agentSessionId ||
          delegationWorkerHostId(attempt) !== 'local' ||
          attempt.runtimeIdentity && attempt.runtimeIdentity.workerRuntimeId !== authority.runtimeId)
        throw new AgentMuxError('Closeout requires the current Supervisor and the exact Goal delegation worker.', 'CONTROL_PERMISSION_DENIED')
      const stopIdentity = { agentSessionId: input.agentSessionId, expectedRun: run, operationId: input.operationId }
      let observations = capturedCloseout(attempt, input)
      let observationIssue = observations ? undefined : 'No original pre-Stop observation was recorded for this operation.'
      const observation = () => ({ ...(observations ? { observations } : {}), ...(observationIssue ? { observationIssue } : {}) })
      let error: { code: string; message: string } | undefined
      if (!input.inspect) {
        if (!observations) {
          try {
            const original = await withinObservationBudget(() => client.inspectAgentStop(stopIdentity))
            if (original?.phase === 'not-requested') {
              const sample: GoalCloseoutContext = {
                capturedAt: Date.now(), sourceMessageId: attempt.sourceMessageId, ticketId: attempt.planNodeId ?? null,
                reportReplyMessageId: attempt.report?.replyMessageId ?? null, collectionOperationId: attempt.collection?.operationId ?? null,
                handoff: attempt.collection ? 'collected' : attempt.report ? 'reported' : 'unreported',
                ticketState: attempt.planNodeId ? hostGoalPlan(goal).planState?.nodes.find(node => node.id === attempt.planNodeId)?.state ?? null : null,
                otherGoalWork: null, coreInput: 'unknown', desktopInput: 'unknown',
              }
              const otherRuns = input.runId === attempt.workerRunId ? sourceRuns : [input.runId, attempt.workerRunId]
              await withinObservationBudget(() => Promise.allSettled([
                options.demands.list().then(goals => { sample.otherGoalWork = otherGoalWork(goals, input, otherRuns, authority.runtimeId) }),
                client.readAgentCloseoutInput(input.agentSessionId, run, attempt.sourceMessageId).then(result => { sample.coreInput = result.state }),
                options.desktopOccupation?.(input.agentSessionId, input.runId, desktopContext)?.then(state => { sample.desktopInput = state }),
              ]))
              // Promise callbacks that finish after the sampling window cannot change this receipt.
              const frozen = { ...sample, capturedAt: Date.now() }
              const saved = await withinObservationBudget(() => options.demands.freezeCloseoutObservation(input.goalId, input.attempt,
                { operationId: input.operationId, runId: input.runId, observations: frozen }))
              observations = capturedCloseout(saved?.demand.delegations?.find(item => item.operationId === input.attempt), input)
              observationIssue = observations ? undefined : 'The original pre-Stop observation save is unconfirmed.'
            }
          } catch {
            observationIssue = 'The original pre-Stop observation could not be confirmed.'
          }
        }
        context.signal?.throwIfAborted()
        await context.assertCurrent?.()
        try {
          const receipt = await client.stopAgent(input.agentSessionId, run, { operationId: input.operationId })
          if (receipt.operationId !== input.operationId)
            return { ...input, state: 'stopped', receipt, observationIssue: 'Core returned a different original Stop operation. Inspect that operation for its observations.' }
          return { ...input, state: 'stopped', receipt, ...observation() }
        } catch (failure) {
          error = { code: failure instanceof AgentMuxError ? failure.code : 'AGENT_STOP_FAILED',
            message: failure instanceof Error ? failure.message : String(failure) }
        }
      }
      try {
        const stop = await client.inspectAgentStop(stopIdentity)
        return { ...input, state: 'observed', stop,
          ...(stop.operationIdMatched === false && stop.phase !== 'not-requested'
            ? { observationIssue: 'Core reports a different original Stop operation.' } : observation()),
          ...(stop.phase === 'retired' && stop.operationIdMatched || !error ? {} : { error }) }
      } catch (failure) {
        return { ...input, state: 'unknown', ...observation(), error: error ?? {
          code: failure instanceof AgentMuxError ? failure.code : 'CONTROL_UNAVAILABLE',
          message: failure instanceof Error ? failure.message : String(failure) } }
      }
    }
    if (authority.runId !== input.runId)
      throw new AgentMuxError('A worker can close only its own original Run.', 'CONTROL_PERMISSION_DENIED')
    const inspect = (goals: readonly Demand[]) => {
      const goal = goals.find(item => item.id === input.goalId)
      const attempt = goal?.delegations?.find(item => item.operationId === input.attempt)
      const current = goal && attempt?.planNodeId
        ? hostGoalPlan(goal).planState?.nodes.find(node => node.id === attempt.planNodeId)
        : undefined
      if (!goal || !attempt?.planNodeId || !current || current.attempt?.delegationOperationId !== attempt.operationId ||
          (current.state !== 'done' && current.state !== 'review') || attempt.workerRunId !== input.runId ||
          attempt.workerAgentSessionId !== input.agentSessionId || delegationWorkerHostId(attempt) !== 'local' ||
          !attempt.report?.delivery || attempt.report.delivery.authorRuntimeId !== authority.runtimeId ||
          !attempt.collection || attempt.collection.replyMessageId !== attempt.report.replyMessageId ||
          attempt.collection.collector.kind !== 'agent' || attempt.collection.collector.id !== goal.supervisorSessionId ||
          goal.alignment?.revision !== attempt.alignmentRevision)
        return { reason: 'handoff' as const }
      if (otherGoalWork(goals, input, sourceRuns, authority.runtimeId)) return { reason: 'other-work' as const }
      return { attempt }
    }
    let core, collectionOperationId: string | undefined
    try {
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
