import { AgentMuxError, type AgentTimelineItem } from '@agentmux/core'
import type { DemandDispatch, DemandStore } from '@agentmux/demand'
import type { AgentSessionControl } from '../shared/contracts.js'
import type { GoalDispatchReference } from '../shared/goal-dispatch.js'
import type { RuntimeController } from './runtime-controller.js'

/** The original Core side effect is the only input receipt accepted by the business owner. */
function receiptFor(dispatch: DemandDispatch, items: AgentTimelineItem[]): DemandDispatch['receipt'] {
  const matches = items.filter(item => item.agentSessionId === dispatch.agentSessionId && item.id === `prompt:${dispatch.operationId}` &&
    item.kind === 'user_message' && item.status === 'complete' && item.content === dispatch.prompt)
  return matches.length === 1 ? { kind: 'core-prompt', itemId: matches[0]!.id, createdAt: matches[0]!.createdAt } : undefined
}

export class GoalDispatchInputOwner {
  constructor(private readonly demands: DemandStore, private readonly runtime: RuntimeController) {}

  async original(reference: GoalDispatchReference): Promise<DemandDispatch> {
    const original = await this.demands.inspectDispatch(reference.goalId, reference.operationId)
    if (!original) throw new AgentMuxError('The exact original Goal Start is not prepared. Keep the Agent and inspect that operation.', 'CONTROL_REQUEST_CONFLICT')
    return original
  }

  async reconcile(reference: GoalDispatchReference) {
    const original = await this.original(reference)
    if (original.stage === 'confirmed') return this.demands.recordDispatchPhase(reference.goalId, reference.operationId, { stage: 'confirmed', receipt: original.receipt! })
    const timeline = await this.runtime.sessionTimeline({ hostId: original.hostId, agentSessionId: original.agentSessionId })
    const receipt = timeline.agentSessionId === original.agentSessionId ? receiptFor(original, timeline.items) : undefined
    if (!receipt) throw new AgentMuxError('The original Goal input remains unconfirmed. Inspect the same operation; the saved intent and manual input are retained.', 'CONTROL_UNAVAILABLE')
    return this.demands.recordDispatchPhase(reference.goalId, reference.operationId, { stage: 'confirmed', receipt })
  }

  async submit(reference: GoalDispatchReference, session: AgentSessionControl, operationId: string, prompt: string, submit: () => Promise<void>, continuation?: { goalId: string; loopId: string }): Promise<void> {
    const original = await this.original(reference)
    if ((original.execution === 'continue') !== Boolean(continuation) || continuation && (continuation.goalId !== reference.goalId || continuation.loopId !== original.loopId))
      throw new AgentMuxError('The original Goal continuation input owner changed.', 'CONTROL_REQUEST_CONFLICT')
    if (reference.operationId !== operationId || original.hostId !== session.hostId || original.agentSessionId !== session.agentSessionId || original.prompt !== prompt)
      throw new AgentMuxError('The frozen Goal Start target or input changed. Keep the original operation and manual input.', 'CONTROL_REQUEST_CONFLICT')
    if (original.stage === 'confirmed') { await this.reconcile(reference); return }
    // Before a retry, recover an original durable Core receipt. An observation failure does
    // not take away manual input; this one business operation retains its unknown stage.
    if (original.stage !== 'prepared') {
      try { await this.reconcile(reference); return }
      catch (error) { if (!(error instanceof AgentMuxError) || error.code !== 'CONTROL_UNAVAILABLE') throw error }
    }
    if (original.runId !== session.run.runId) throw new AgentMuxError('The original Goal Start belongs to another Run. Inspect it without resending.', 'CONTROL_REQUEST_CONFLICT')
    await this.demands.recordDispatchPhase(reference.goalId, reference.operationId, { stage: 'submitted' })
    try {
      await submit()
      await this.reconcile(reference)
    } catch (error) {
      await this.demands.recordDispatchPhase(reference.goalId, reference.operationId, { stage: 'unknown', issue: error instanceof Error ? error.message : String(error) }).catch(failure => { console.warn('Original Goal dispatch stage is unconfirmed; inspect the same operation without sending again.', failure) })
      throw error
    }
  }
}
