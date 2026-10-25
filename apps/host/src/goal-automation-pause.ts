import { AgentMuxError, type AgentMuxRpcCallContext } from '@agentmux/core'
import type { AgentAutomationOwner, AgentAutomationTarget, AgentAutomationPauseReceipt, AgentAutomationPauseInspection } from '@agentmux/core/agent-automation'
import type { ContinuousProgressLoopManager } from './continuous-progress-loop-manager.js'
import type { GoalAgentControl, GoalExecutionClient } from './goal-runtime.js'

/** Original cancel-only receipts live for this owner instance; no draft or eligibility state. */
export function createGoalAutomationPause(options: {
  ownerInstanceId(): string
  client: GoalExecutionClient
  progress: ContinuousProgressLoopManager
  cancel(control: GoalAgentControl): void
}): AgentAutomationOwner {
  const operations = new Map<string, { target: AgentAutomationTarget; result: Promise<AgentAutomationPauseInspection>; receipt: AgentAutomationPauseReceipt }>()
  const same = (a: AgentAutomationTarget, b: AgentAutomationTarget) => a.agentSessionId === b.agentSessionId && a.expectedRun.runId === b.expectedRun.runId && a.ownerInstanceId === b.ownerInstanceId
  const observation = (target: AgentAutomationTarget, receipt: AgentAutomationPauseReceipt | null): AgentAutomationPauseInspection => ({ target, receipt, retention: 'owner-instance' })
  const authorize = async (context: AgentMuxRpcCallContext) => {
    if (context.caller || !context.principal || !['user', 'device'].includes(context.principal.kind)) throw new AgentMuxError('Only the original person or device can pause automatic input. This action grants no input authority and stops no Agent.', 'CONTROL_PERMISSION_DENIED')
    context.signal?.throwIfAborted(); await context.assertCurrent?.()
  }
  return {
    async inspect(input, context) {
      await authorize(context)
      if (input.ownerInstanceId !== options.ownerInstanceId()) return observation(input, null)
      const original = operations.get(input.operationId)
      if (original && !same(original.target, input)) throw new AgentMuxError('The original automatic pause operation belongs to another target.', 'CONTROL_REQUEST_CONFLICT')
      return observation(input, original ? structuredClone(original.receipt) : null)
    },
    async pause(input, context) {
      await authorize(context)
      if (input.ownerInstanceId !== options.ownerInstanceId()) throw new AgentMuxError('The original automatic pause belongs to a different owner instance. Inspect that operation; no later owner was controlled.', 'RUNTIME_OWNER_CHANGED')
      const prior = operations.get(input.operationId)
      if (prior) {
        if (!same(prior.target, input)) throw new AgentMuxError('The original automatic pause operation changed its target.', 'CONTROL_REQUEST_CONFLICT')
        return await prior.result
      }
      const receipt: AgentAutomationPauseReceipt = { ...input, status: 'unknown', pausedLoopIds: [], disabledIntentIds: [], issues: [] }
      const result = Promise.resolve().then(async () => {
        const assertTargetSync = () => {
          const session = options.client.agentSession(input.agentSessionId)
          if (input.ownerInstanceId !== options.ownerInstanceId() || session.agentSessionId !== input.agentSessionId || session.run.runId !== input.expectedRun.runId)
            throw new AgentMuxError('The exact original automatic pause target changed. Its operation and healthy manual input are retained.', 'STALE_AGENT_SESSION')
        }
        const assertTarget = async () => {
          await authorize(context)
          const session = await options.client.readAgentSession(input.agentSessionId)
          if (input.ownerInstanceId !== options.ownerInstanceId() || !session || session.agentSessionId !== input.agentSessionId || session.run.runId !== input.expectedRun.runId)
            throw new AgentMuxError('Automatic pause requires the exact original Session, Run and owner. Manual input and healthy Agents remain available.', 'STALE_AGENT_SESSION')
        }
        await assertTarget()
        assertTargetSync()
        try { await options.progress.start() } catch (error) { receipt.issues.push({ stage: 'original-progress-owner', message: error instanceof Error ? error.message : String(error) }) }
        await assertTarget()
        assertTargetSync()
        const target = { hostId: 'local', agentSessionId: input.agentSessionId }
        options.cancel({ kind: 'agent', ...target, run: input.expectedRun })
        options.progress.cancelTarget(target)
        const originalContext = { ...context, assertCurrent: assertTarget }
        const loops = options.progress.list(target).filter(loop => loop.status !== 'stopped')
        const intents: string[] = []
        let afterIntentId: string | undefined
        do {
          await authorize(context)
          const page = await options.client.listAgentFuturePromptIntents(input.agentSessionId, { ...(afterIntentId ? { afterIntentId } : {}), limit: 16 })
          intents.push(...page.intents.filter(value => value.intent.active).map(value => value.intentId))
          afterIntentId = page.nextIntentId ?? undefined
        } while (afterIntentId)
        const effects = await Promise.allSettled([
          ...loops.map(async loop => { await options.progress.pause(loop.loopId, 'Paused for your explicit input intent. Resume the original arrangement explicitly.', originalContext,
            { prepare: assertTarget, assertCurrent: assertTargetSync }); receipt.pausedLoopIds.push(loop.loopId) }),
          ...intents.map(async intentId => {
            const original = await options.client.readAgentFuturePromptIntent(input.agentSessionId, intentId)
            if (!original?.active) return
            await authorize(context)
            await options.client.saveAgentFuturePromptIntent({ agentSessionId: input.agentSessionId, intentId, operationId: original.operationId, expectedRun: input.expectedRun,
              prompt: original.message.userContent ?? '', ...(original.message.systemContext === undefined ? {} : { agentMuxNote: original.message.systemContext }), active: false })
            receipt.disabledIntentIds.push(intentId)
          })
        ])
        for (const effect of effects) if (effect.status === 'rejected') receipt.issues.push({ stage: 'pause-original-automatic-input', message: effect.reason instanceof Error ? effect.reason.message : String(effect.reason) })
        receipt.status = receipt.issues.length ? 'unknown' : 'confirmed'
        return observation(input, structuredClone(receipt))
      }).catch(error => {
        receipt.issues.push({ stage: 'pause-original-automatic-input', message: error instanceof Error ? error.message : String(error) })
        throw error
      })
      operations.set(input.operationId, { target: input, result, receipt })
      return await result
    }
  }
}
