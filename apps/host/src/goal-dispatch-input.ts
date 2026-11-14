import { AgentMuxError, type AgentInputSubmissionReceipt, type AgentTimelineItem } from '@agentmux/core'
import { runBoundDemandDispatch, type DemandDispatch, type DemandQualifiedDispatchIntent, type DemandQualifiedDispatchReceipt, type DemandStore } from '@agentmux/demand'
import type { GoalAgentControl as AgentSessionControl } from './goal-runtime.js'
import type { GoalDispatchReference } from './goal-runtime.js'
import type { GoalRuntimePort } from './goal-runtime.js'
import type { GoalFiniteInputPort } from './goal-runtime.js'

/** The original Core side effect is the only input receipt accepted by the business owner. */
function receiptFor(dispatch: DemandDispatch, items: AgentTimelineItem[]): DemandDispatch['receipt'] {
  if ('target' in dispatch) return
  const matches = items.filter(item => item.agentSessionId === dispatch.agentSessionId && item.id === `prompt:${dispatch.operationId}` &&
    item.kind === 'user_message' && item.status === 'complete' && item.content === dispatch.prompt)
  return matches.length === 1 ? { kind: 'core-prompt', itemId: matches[0]!.id, createdAt: matches[0]!.createdAt } : undefined
}

/** A key alone is not proof of this Goal's body or source. Read the original
 * canonical claim, without creating or waking a waiting input. */
function qualifiedReceiptFor(input: DemandQualifiedDispatchIntent, value: AgentInputSubmissionReceipt | null): DemandQualifiedDispatchReceipt | undefined {
  if (!value) return
  const key = value.key, ref = value.ref.key
  if (key.kind !== 'prompt' || key.agentSessionId !== input.target.execution.agentSessionId || key.expectedRun.runId !== input.runId ||
      key.submissionId !== input.operationId || key.attemptId !== undefined || ref.kind !== 'prompt' || ref.agentSessionId !== key.agentSessionId ||
      ref.expectedRun.runId !== key.expectedRun.runId || ref.submissionId !== key.submissionId || ref.attemptId !== undefined)
    throw new AgentMuxError('The original Core receipt names another input, Run or source. The Goal request remains retained.', 'CONTROL_REQUEST_CONFLICT')
  if (value.status !== 'admitted' && value.status !== 'terminal-confirmed') return
  const original = value.admission?.admission?.intent, message = original?.message
  if (!original || !message) throw new AgentMuxError('The original Core claim does not expose this input’s frozen content. Keep the original Goal request and inspect its original owner.', 'CONTROL_UNAVAILABLE')
  if (message.userContent !== input.prompt || message.systemContext !== input.agentMuxNote || message.authorHuman === true || message.authorAgentSessionId !== undefined ||
      message.authorExternal !== undefined || message.a2aNotificationId !== undefined || message.questionReply !== undefined ||
      (message.sourceChannel ?? 'api') !== 'api' || original.execution !== 'immediate' || original.admissionIntent?.kind !== 'session-conversation' || original.admissionIntent.inputEpoch !== input.inputEpoch)
    throw new AgentMuxError('This input key belongs to another frozen Goal content or source. No original input was replaced or rejoined.', 'CONTROL_REQUEST_CONFLICT')
  return { kind: 'core-input', inputKey: { kind: 'prompt', agentSessionId: key.agentSessionId, expectedRun: { runId: input.runId }, submissionId: input.operationId },
    outcome: value.status, observedAt: Date.now() }
}

export class GoalDispatchInputOwner {
  constructor(private readonly demands: DemandStore, private readonly runtime: Pick<GoalRuntimePort, 'sessionTimeline'>) {}

  async original(reference: GoalDispatchReference): Promise<DemandDispatch> {
    const original = await this.demands.inspectDispatch(reference.goalId, reference.operationId)
    if (!original) throw new AgentMuxError('The exact original Goal Start is not prepared. Keep the Agent and inspect that operation.', 'CONTROL_REQUEST_CONFLICT')
    return original
  }

  async reconcile(reference: GoalDispatchReference, assertCurrent?: () => Promise<void>) {
    const original = await this.original(reference)
    if (original.stage === 'confirmed') { await assertCurrent?.(); return this.demands.recordDispatchPhase(reference.goalId, reference.operationId, { stage: 'confirmed', receipt: original.receipt! }) }
    if ('target' in original) throw new AgentMuxError('Read this original qualified Goal input using its current Source access. Its request and Agent remain retained.', 'CONTROL_UNAVAILABLE')
    const timeline = await this.runtime.sessionTimeline({ hostId: original.hostId, agentSessionId: original.agentSessionId })
    const receipt = timeline.agentSessionId === original.agentSessionId ? receiptFor(original, timeline.items) : undefined
    if (!receipt) throw new AgentMuxError('The original Goal input remains unconfirmed. Inspect the same operation; the saved intent and manual input are retained.', 'CONTROL_UNAVAILABLE')
    await assertCurrent?.()
    return this.demands.recordDispatchPhase(reference.goalId, reference.operationId, { stage: 'confirmed', receipt })
  }

  async submit(reference: GoalDispatchReference, session: AgentSessionControl, operationId: string, prompt: string, submit: () => Promise<void>, continuation?: { goalId: string; loopId: string }): Promise<void> {
    const original = await this.original(reference)
    if ('target' in original) throw new AgentMuxError('The qualified Goal input cannot use a legacy Session carrier.', 'CONTROL_REQUEST_CONFLICT')
    if ((original.execution === 'continue') !== Boolean(continuation) || continuation && (continuation.goalId !== reference.goalId || continuation.loopId !== original.loopId))
      throw new AgentMuxError('The original Goal continuation input owner changed.', 'CONTROL_REQUEST_CONFLICT')
    if (reference.inputEpoch !== original.inputEpoch || reference.operationId !== operationId || original.hostId !== session.hostId || original.agentSessionId !== session.agentSessionId || original.prompt !== prompt)
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

  async reconcileQualified(reference: GoalDispatchReference, port: Pick<GoalFiniteInputPort, 'inspectOriginal'>, assertCurrent?: () => Promise<void>) {
    const original = await this.original(reference)
    if (!('target' in original)) throw new AgentMuxError('The original Start is a legacy operation. Its original carrier remains available.', 'CONTROL_REQUEST_CONFLICT')
    if (!runBoundDemandDispatch(original)) throw new AgentMuxError('This business request has no prepared input. Inspect it and explicitly continue the original request before reading a Core input key.', 'CONTROL_UNAVAILABLE')
    if (original.stage === 'confirmed') return await this.demands.recordDispatchPhase(reference.goalId, reference.operationId, { stage: 'confirmed', receipt: original.receipt! })
    const receipt = qualifiedReceiptFor(original, await port.inspectOriginal(original))
    if (!receipt) throw new AgentMuxError('This original Goal input is not confirmed by its Core owner. Check it, or explicitly continue this same operation; no input was resent.', 'CONTROL_UNAVAILABLE')
    await assertCurrent?.()
    return await this.demands.recordDispatchPhase(reference.goalId, reference.operationId, { stage: 'confirmed', receipt })
  }

  async submitQualified(reference: GoalDispatchReference, port: GoalFiniteInputPort, resumeOriginal: boolean, assertCurrent?: () => Promise<void>): Promise<void> {
    const original = await this.original(reference)
    if (!('target' in original)) throw new AgentMuxError('The original Start is a legacy operation. Its original carrier remains available.', 'CONTROL_REQUEST_CONFLICT')
    if (!runBoundDemandDispatch(original)) throw new AgentMuxError('This business request has no prepared input. Inspect it and explicitly continue the original request before reading a Core input key.', 'CONTROL_UNAVAILABLE')
    if (original.stage === 'confirmed') return
    if (original.stage !== 'prepared' && !resumeOriginal) { await this.reconcileQualified(reference, port, assertCurrent); return }
    await assertCurrent?.()
    await this.demands.recordDispatchPhase(reference.goalId, reference.operationId, { stage: 'submitted' })
    try {
      // Original controlled intake compares body/note/source/intent under the
      // existing Core key before any exact waiting reference can be rejoined.
      let result = await port.submit(original)
      let receipt = qualifiedReceiptFor(original, result)
      if (!receipt && resumeOriginal) {
        result = await port.rejoinOriginal(original, result.ref)
        receipt = qualifiedReceiptFor(original, result)
      }
      if (!receipt) throw new AgentMuxError('The original Core input is retained but delivery remains unconfirmed. Check this same Goal operation before an explicit continuation.', 'CONTROL_UNAVAILABLE')
      await this.demands.recordDispatchPhase(reference.goalId, reference.operationId, { stage: 'confirmed', receipt })
    } catch (error) {
      await this.demands.recordDispatchPhase(reference.goalId, reference.operationId, { stage: 'unknown', issue: error instanceof Error ? error.message : String(error) }).catch(failure => { console.warn('The original qualified Goal input outcome is unconfirmed; its request remains retained.', failure) })
      throw error
    }
  }
}
