import type { DemandRecord } from './global-demand-board'
import { goalPlanAttemptState } from '@agentmux/demand/goal-plan'

export type GoalDelegationRow = {
  delegation: NonNullable<DemandRecord['delegations']>[number]
  state: 'report' | 'collected' | 'accepted' | 'changes' | 'exited' | 'question' | 'working' | 'unknown'
  next: string
  issue?: string
  replyMessageId?: string
  report?: import('@agentmux/demand').DemandDelegationReportInput
  attention?: NonNullable<DemandRecord['delegationObservations']>[number]['attention']
  workflowReview?: NonNullable<DemandRecord['delegationObservations']>[number]['workflowReview']
  previousAttempt?: true
  closedTicket?: 'done' | 'cancelled'
}

export function isHistoricalGoalDelegation(row: GoalDelegationRow): boolean {
  return Boolean(row.previousAttempt || row.closedTicket)
}

/** Reading projection only; no display label authorizes input, recovery or acceptance. */
export function goalDelegationRows(goal: Pick<DemandRecord, 'delegations' | 'delegationObservations' | 'delegationObservationIssue' | 'grounding' | 'planState'>): GoalDelegationRow[] {
  const observations = new Map(goal.delegationObservations?.map(item => [item.operationId, item]))
  const planNodes = new Map(goal.planState?.nodes.map(item => [item.id, item]))
  return (goal.delegations ?? []).map(delegation => {
    const observation = observations.get(delegation.operationId)
    const report = delegation.report ?? observation?.recoverableReport
    const issue = goal.delegationObservationIssue ?? observation?.unknown ?? (!report && !delegation.linkedAt
      ? 'The original dispatch association is unconfirmed. The task and Agent are retained.'
      : observation && !observation.communication && !report ? 'Original communication has not been observed; report availability is unknown.' : undefined)
    const planNode = delegation.planNodeId ? planNodes.get(delegation.planNodeId) : undefined
    const ticketState = goalPlanAttemptState(planNode, delegation.operationId)
    const original = { delegation, ...(issue ? { issue } : {}), ...(report ? { report } : {}),
      ...(ticketState === 'previous' ? { previousAttempt: true as const } : {}),
      ...(ticketState === 'done' || ticketState === 'cancelled' ? { closedTicket: ticketState } : {}),
      ...(observation?.attention ? { attention: observation.attention } : {}),
      ...(observation?.workflowReview ? { workflowReview: observation.workflowReview } : {}) }
    if (ticketState === 'changes') return { ...original, state: 'changes', next: 'Changes requested · Continue this Ticket', ...(report ? { replyMessageId: report.replyMessageId } : {}) }
    if (delegation.collection) {
      if (ticketState === 'unknown') return { ...original, state: 'unknown', next: 'Ticket state unconfirmed', replyMessageId: delegation.collection.replyMessageId }
      const accepted = goal.grounding?.acceptedAt != null && goal.grounding.submissionId === delegation.collection.groundingSubmissionId
      const review = observation?.workflowReview?.state
      const next = review === 'confirmed' ? 'Collected · Awaiting independent verdict'
        : review === 'prepared' ? 'Collected · Reviewer input pending' : review === 'unknown' ? 'Collected · Reviewer input unconfirmed' : 'Collected · Awaiting your review'
      return { ...original, state: accepted ? 'accepted' : 'collected', next: accepted ? 'Result accepted' : next,
        replyMessageId: delegation.collection.replyMessageId }
    }
    if (report) return { ...original, state: 'report', next: 'Report ready to collect', replyMessageId: report.replyMessageId }
    if (!delegation.linkedAt) return { ...original, state: 'unknown', next: 'Delegation observation unknown' }
    const ownerReplies = (observation?.communication?.replies ?? []).filter(reply =>
      reply.envelope.sender.kind === 'agent-session' && reply.envelope.sender.agentSessionId === delegation.ownerAgentSessionId &&
      reply.envelope.senderSessionId === delegation.ownerAgentSessionId && reply.envelope.recipientSessionId === delegation.workerAgentSessionId &&
      (!delegation.runtimeIdentity || reply.envelope.senderRuntimeId === delegation.runtimeIdentity.ownerRuntimeId &&
        reply.envelope.recipientRuntimeId === delegation.runtimeIdentity.workerRuntimeId) &&
      reply.envelope.threadId === delegation.threadId)
    const replies = new Set(ownerReplies.filter(reply => reply.deliveryMode !== 'outbox' || reply.peerInbox !== undefined).map(reply => reply.envelope.replyTo))
    const preparedReplies = new Set(ownerReplies.filter(reply => reply.deliveryMode === 'outbox' && reply.peerInbox === undefined).map(reply => reply.envelope.replyTo))
    const questions = observation?.communication?.dispatch.originAwaits
      ? [...observation.communication.dispatch.events].reverse().filter(event => event.kind === 'question' || event.kind === 'escalation') : []
    const awaiting = questions.find(event => !replies.has(event.replyMessageId)) ?? questions[0]
    if (observation?.workerRun?.runId === delegation.workerRunId && observation.workerRun.state === 'exited')
      return !observation.communication || issue
        ? { ...original, state: 'unknown', next: 'Agent ended · Check report or continue' }
        : { ...original, state: 'exited', next: 'No report · Continue the original Agent' }
    if (observation?.workerRun?.runId === delegation.workerRunId && observation.workerRun.state === 'interrupted')
      return { ...original, state: 'question', next: 'Interrupted · Continue the original Agent' }
    if (awaiting) {
      const answered = replies.has(awaiting.replyMessageId)
      if (!answered && preparedReplies.has(awaiting.replyMessageId)) return { ...original, state: 'question',
        next: 'Reply prepared · Delivery unconfirmed', replyMessageId: awaiting.replyMessageId }
      return { ...original, state: answered && awaiting.kind === 'question' ? 'working' : 'question',
        next: answered ? awaiting.kind === 'question' ? 'Task owner replied · Awaiting worker' : 'Follow-up sent · Blocker needs verification'
          : awaiting.kind === 'question' ? 'Question needs a reply' : 'Blocked · Needs follow-up', replyMessageId: awaiting.replyMessageId }
    }
    if (!observation?.communication || issue || !observation.workerRun || observation.workerRun.runId !== delegation.workerRunId)
      return { ...original, state: 'unknown', next: 'Delegation observation unknown' }
    return { ...original, state: 'working', next: 'Working · No result report' }
  })
}

/** Pending owner responsibilities precede general Goal proposal text. */
export function goalDelegationNextStep(goal: Parameters<typeof goalDelegationRows>[0]): string | null {
  return goalDelegationNextRow(goal)?.next ?? null
}

/** The same priority as the visible next step, keeping the row state for reading projections. */
export function goalDelegationNextRow(goal: Parameters<typeof goalDelegationRows>[0]): GoalDelegationRow | null {
  const rows = goalDelegationRows(goal).filter(row => !isHistoricalGoalDelegation(row))
  for (const state of ['report', 'question', 'exited', 'collected', 'changes', 'unknown', 'working'] as const) {
    const row = rows.find(item => item.state === state)
    if (row) return row
  }
  return null
}
