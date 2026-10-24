import { AgentMuxError, rpcControlResult, type GoalParticipationOwner, type AgentMuxRpcCallContext, type AgentMuxAgentSession } from '@agentmux/core'
import type { Demand, DemandParticipationSource, DemandStore } from '@agentmux/demand'
import { goalPmoOperation } from './goal-pmo-origin.js'
import type { GoalExecutionClient } from './goal-runtime.js'
import { projectHostGoal } from './goal-projection.js'

/** Only the existing Core creation/input receipt confirms original Goal provenance. */
export function createGoalParticipationOwner(options: {
  demands: DemandStore
  client(hostId: string): GoalExecutionClient
  discussion?(goal: Demand, hostId: string, sessionId: string): Promise<boolean>
  source(hostId: string, sessionId: string, workspacePath: string): Promise<DemandParticipationSource>
  activeContinuation(goalId: string): Promise<boolean>
}): GoalParticipationOwner {
  const authorize = async (context: AgentMuxRpcCallContext, hostId: string, sessionId: string, goal: Demand, created: AgentMuxAgentSession, messageSource?: { sessionId: string; runId: string }) => {
    context.signal?.throwIfAborted(); await context.assertCurrent?.()
    if (context.caller) {
      const caller = await options.client(hostId).authorizeAgentCaller(context.caller.capability, context.caller.agentSessionId)
      if (caller.agentSessionId !== context.caller.agentSessionId) throw new AgentMuxError('The original Goal caller changed.', 'CONTROL_PERMISSION_DENIED')
      if (messageSource && (messageSource.sessionId !== caller.agentSessionId || messageSource.runId !== caller.run.runId))
        throw new AgentMuxError('The authenticated caller is not the original message sender and Run.', 'CONTROL_PERMISSION_DENIED')
      if (context.caller.agentSessionId !== sessionId) {
        const creator = created.creation?.createdBy
        const originalCreator = goal.discussionIntent?.callerAgentSessionId === caller.agentSessionId && creator?.owner.kind === 'local' && creator.agentSessionId === caller.agentSessionId && creator.run.runId === caller.run.runId
        const originalMessage = messageSource?.sessionId === caller.agentSessionId && await options.discussion?.(goal, hostId, sessionId)
        if (!originalMessage && (goal.discussionOperationId !== created.creation?.createOperationId || !originalCreator))
          throw new AgentMuxError('The authenticated caller has no exact original Goal discussion creation or authored input provenance. Original participation and Agent input are retained.', 'CONTROL_PERMISSION_DENIED')
      }
    } else if (!context.principal || !['user','device'].includes(context.principal.kind)) throw new AgentMuxError('Goal participation requires its original person, device or authenticated Agent.', 'CONTROL_PERMISSION_DENIED')
  }
  return { async confirm(input, context) {
    context.signal?.throwIfAborted(); await context.assertCurrent?.()
    const goal = await options.demands.get(input.goalId)
    if (!goal || input.creationOperationId !== undefined && goal.creationOrigin?.operationId !== input.creationOperationId) throw new AgentMuxError('The exact original Goal creation is unconfirmed. Retain its input operation and existing Agent.', 'CONTROL_REQUEST_CONFLICT')
    const originalClient = options.client(input.hostId)
    const created = await originalClient.inspectAgentCreation(input.agentSessionId)
    if (created.agentSessionId !== input.agentSessionId || created.kind === 'retired-agent') throw new AgentMuxError('The original Goal participation Session is unavailable. Its identity and input operation are retained.', 'CONTROL_UNAVAILABLE')
    let messageSource: { sessionId: string; runId: string } | undefined
    if (input.creationOperationId !== undefined && input.operationId !== await goalPmoOperation({ goalId: goal.id, creationOperationId: input.creationOperationId }, input.evidence === 'creation-input' ? 'create' : 'discussion'))
      throw new AgentMuxError('The original Goal source operation belongs to another request. No input was sent.', 'CONTROL_REQUEST_CONFLICT')
    if (input.evidence === 'creation-input') {
      const creation = created.creation
      if (creation?.createOperationId !== input.operationId || creation.initialPrompt !== 'confirmed' || creation.createdRun?.runId !== input.expectedRun.runId ||
          creation.initialInputKey && (creation.initialInputKey.agentSessionId !== input.agentSessionId || creation.initialInputKey.expectedRun.runId !== input.expectedRun.runId))
        throw new AgentMuxError('The original Core creation input and its original Run remain unconfirmed. Retain that operation; no Agent or input was created.', 'CONTROL_UNAVAILABLE')
    } else {
      const message = input.evidence === 'message-input'
        ? await originalClient.readMessage({ operationId: input.operationId, ...(context.caller ? { caller: context.caller } : {}) }) : undefined
      if (input.evidence === 'message-input' && !message) throw new AgentMuxError('The original message operation is unconfirmed. Its Goal and request remain retained.', 'CONTROL_UNAVAILABLE')
      const inputId = message?.envelope.messageId ?? input.operationId
      const receipt = await originalClient.inspectAgentPromptSubmission(input.evidence === 'message-input'
        ? { kind: 'message', agentSessionId: input.agentSessionId, expectedRun: input.expectedRun, messageId: inputId }
        : { kind: 'prompt', agentSessionId: input.agentSessionId, expectedRun: input.expectedRun, submissionId: input.operationId })
      const admission = receipt?.admission, key = admission?.inputKey
      const originalKey = key?.kind === (input.evidence === 'message-input' ? 'message' : 'prompt') && key.agentSessionId === input.agentSessionId && key.expectedRun.runId === input.expectedRun.runId &&
        (key.kind === 'message' ? key.messageId : key.submissionId) === inputId
      if (receipt?.agentSessionId !== input.agentSessionId || receipt.run.runId !== input.expectedRun.runId || admission?.submissionId !== inputId || !admission.acknowledged ||
          !originalKey || admission.intent?.run.runId !== input.expectedRun.runId)
        throw new AgentMuxError('The original Core prompt input receipt is unconfirmed. Retain the same Goal and input operation; no message was repeated.', 'CONTROL_UNAVAILABLE')
      if (input.evidence === 'message-input') {
        if (!await options.discussion?.(goal, input.hostId, input.agentSessionId))
          throw new AgentMuxError('The message recipient has no exact original Goal discussion role. The message, Goal and existing Agent remain retained.', 'CONTROL_UNAVAILABLE')
        const envelope = message?.envelope
        if (envelope?.sender.kind !== 'agent-session' || envelope.senderSessionId !== admission.intent.message?.authorAgentSessionId || envelope.sender.agentSessionId !== envelope.senderSessionId ||
            !envelope.senderRunId || envelope.recipientSessionId !== input.agentSessionId || envelope.recipient.kind !== 'agent-session' || envelope.recipient.agentSessionId !== input.agentSessionId ||
            envelope.recipientRunId !== input.expectedRun.runId || envelope.operationId !== input.operationId || envelope.messageId !== inputId)
          throw new AgentMuxError('The original Core message envelope and acknowledged input refer to different participants or operations.', 'CONTROL_PERMISSION_DENIED')
        messageSource = { sessionId: envelope.senderSessionId, runId: envelope.senderRunId }
      }
    }
    await authorize(context, input.hostId, input.agentSessionId, goal, created, messageSource)
    const source = await options.source(input.hostId, input.agentSessionId, created.workspacePath)
    const allowSupervisorDefault = !await options.activeContinuation(goal.id)
    await authorize(context, input.hostId, input.agentSessionId, goal, created, messageSource)
    if (options.client(input.hostId) !== originalClient) throw new AgentMuxError('The original participation Host changed before commit. Its source operation is retained.', 'RUNTIME_OWNER_CHANGED')
    const saved = input.creationOperationId === undefined
      ? await options.demands.recordParticipation(goal.id, source, { operationId: input.operationId, expectedUpdatedAt: goal.updatedAt })
      : await options.demands.resolveCreationOrigin(goal.id, { creationOperationId: input.creationOperationId, source, sourceOperationId: input.operationId }, { expectedUpdatedAt: goal.updatedAt, allowSupervisorDefault })
    return { goal: rpcControlResult('goal.inspect', { operation: 'demand.show', demand: projectHostGoal(saved.demand), goalContinuations: [] }).goal as import('@agentmux/core').AgentMuxRpcGoal,
      operationId: input.operationId, diskDurability: 'confirmed' }
  } }
}
