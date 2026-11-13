import { AgentMuxError } from '@agentmux/core'
import { assertGoalSourceReport, goalDelegationReportBody, goalReportApplication, readGoalDelegationSource,
  type GoalDelegationAuthority, type GoalDelegationParamsMap, type GoalReportSubmissionResult } from '@agentmux/core/goal-delegation'
import type { AgentMuxRpcCallContext } from '@agentmux/core'
import type { GoalDelegationCorePort } from './goal-delegation-owner.js'

/** The worker's own inbox and outbox are sufficient. This path never reads or writes a Goal store. */
export async function submitGoalSourceReport(core: GoalDelegationCorePort, request: GoalDelegationParamsMap['goal.report'],
  context: AgentMuxRpcCallContext, authority: GoalDelegationAuthority): Promise<GoalReportSubmissionResult> {
  if (authority.actor.kind !== 'agent' || !authority.hostId || !authority.runId || !request.sourceMessageId)
    throw new AgentMuxError('A source report requires its authenticated original worker and current Run.', 'CONTROL_PERMISSION_DENIED')
  const source = (await core.call(authority.hostId, 'message.read', { hostId: authority.hostId, messageId: request.sourceMessageId }, context)).message
  if (!source) throw new AgentMuxError('The original delegation source is unavailable in this worker inbox. Keep its identity and report.', 'CONTROL_UNAVAILABLE')
  const envelope = source.envelope, data = readGoalDelegationSource(source)
  // A same-SID outbox at another Runtime is not this worker's received source.
  if (!source.provenance || authority.runtimeId !== envelope.recipientRuntimeId || source.transport?.state !== 'received' || source.deliveryMode === 'outbox' ||
      envelope.recipient.kind !== 'agent-session' || envelope.recipientSessionId !== authority.actor.id || envelope.recipient.agentSessionId !== authority.actor.id ||
      envelope.recipientRunId !== authority.runId || envelope.sender.kind !== 'agent-session' || envelope.senderSessionId !== envelope.sender.agentSessionId ||
      envelope.senderRuntimeId !== source.provenance.source.runtimeId || envelope.recipientRuntimeId !== source.provenance.target.runtimeId ||
      envelope.messageId !== request.sourceMessageId || envelope.operationId !== data.delegationOperationId || envelope.replyTo !== null ||
      data.goalId !== request.goalId || data.delegationOperationId !== request.operationId || request.report.authorAgentSessionId !== authority.actor.id)
    throw new AgentMuxError('The original received source, worker, Run or Goal does not match this report. Original messages and healthy input remain available.', 'CONTROL_PERMISSION_DENIED')
  assertGoalSourceReport(data, request.report)
  context.signal?.throwIfAborted(); await context.assertCurrent?.()
  const submission = await core.call(authority.hostId, 'agent.send', { target: { kind: 'reply', sourceMessageId: envelope.messageId },
    operationId: request.report.operationId, messageId: request.report.replyMessageId, threadId: envelope.threadId,
    correlationId: envelope.messageId, replyTo: envelope.messageId, text: goalDelegationReportBody(data.goalId, data.delegationOperationId, request.report),
    application: goalReportApplication(data.goalId, data.delegationOperationId, request.report) }, context)
  const reply = submission.envelope
  if (reply.senderRuntimeId !== envelope.recipientRuntimeId || reply.recipientRuntimeId !== envelope.senderRuntimeId ||
      reply.senderSessionId !== envelope.recipientSessionId || reply.senderRunId !== envelope.recipientRunId ||
      reply.recipientSessionId !== envelope.senderSessionId || reply.recipientRunId !== envelope.senderRunId ||
      reply.threadId !== envelope.threadId || !submission.provenance)
    throw new AgentMuxError('The original report submission receipt does not match its signed source. Inspect this same outbox operation; no Goal update was attested.', 'CONTROL_PROTOCOL_ERROR')
  return { kind: 'report-submission', goalId: data.goalId, delegationOperationId: data.delegationOperationId,
    sourceMessageId: envelope.messageId, submission }
}
