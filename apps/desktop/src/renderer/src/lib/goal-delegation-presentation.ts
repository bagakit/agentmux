import type { DemandRecord } from './global-demand-board'

export type GoalDelegationRow = {
  delegation: NonNullable<DemandRecord['delegations']>[number]
  state: 'report' | 'collected' | 'accepted' | 'exited' | 'question' | 'working' | 'unknown'
  next: string
  issue?: string
  replyMessageId?: string
  report?: import('@agentmux/demand').DemandDelegationReportInput
  attention?: NonNullable<DemandRecord['delegationObservations']>[number]['attention']
}

/** Reading projection only; no display label authorizes input, recovery or acceptance. */
export function goalDelegationRows(goal: Pick<DemandRecord, 'delegations' | 'delegationObservations' | 'delegationObservationIssue' | 'grounding'>): GoalDelegationRow[] {
  const observations = new Map(goal.delegationObservations?.map(item => [item.operationId, item]))
  return (goal.delegations ?? []).map(delegation => {
    const observation = observations.get(delegation.operationId)
    const report = delegation.report ?? observation?.recoverableReport
    const issue = goal.delegationObservationIssue ?? observation?.unknown ?? (!report && !delegation.linkedAt
      ? 'The original dispatch association is unconfirmed. The task and Agent are retained.'
      : observation && !observation.communication && !report ? 'Original communication has not been observed; report availability is unknown.' : undefined)
    const original = { delegation, ...(issue ? { issue } : {}), ...(report ? { report } : {}),
      ...(observation?.attention ? { attention: observation.attention } : {}) }
    if (delegation.collection) {
      const accepted = goal.grounding?.acceptedAt != null && goal.grounding.submissionId === delegation.collection.groundingSubmissionId
      return { ...original, state: accepted ? 'accepted' : 'collected', next: accepted ? 'Result accepted' : 'Collected · Awaiting your review',
        replyMessageId: delegation.collection.replyMessageId }
    }
    if (report) return { ...original, state: 'report', next: 'Report ready to collect', replyMessageId: report.replyMessageId }
    if (!delegation.linkedAt) return { ...original, state: 'unknown', next: 'Delegation observation unknown' }
    const replies = new Set((observation?.communication?.replies ?? []).filter(reply =>
      reply.envelope.sender.kind === 'agent-session' && reply.envelope.sender.agentSessionId === delegation.ownerAgentSessionId &&
      reply.envelope.senderSessionId === delegation.ownerAgentSessionId && reply.envelope.recipientSessionId === delegation.workerAgentSessionId &&
      reply.envelope.threadId === delegation.threadId).map(reply => reply.envelope.replyTo))
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
  const rows = goalDelegationRows(goal)
  for (const state of ['report', 'question', 'exited', 'collected', 'unknown', 'working'] as const) {
    const row = rows.find(item => item.state === state)
    if (row) return row.next
  }
  return null
}
