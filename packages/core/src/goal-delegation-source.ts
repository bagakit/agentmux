import type { AgentMuxMessageApplication } from './agent-message-envelope.js'
import type { DurableAgentMuxMessage } from './agent-global-message-queue.js'
import { AgentMuxError } from './errors.js'
import { parseDemandDelegationReportInput, parseGoalPlanPredecessors, type GoalPlanPredecessor, type DemandDelegation, type DemandDelegationReportInput } from '@agentmux/demand/delegations'
import { parseAlignmentProposal, type DemandCriterion } from '@agentmux/demand/goals'

export type GoalDelegationSourceData = {
  goalId: string
  delegationOperationId: string
  alignmentRevision: number
  criteria: DemandCriterion[]
  planNodeId?: string
  predecessors?: GoalPlanPredecessor[]
}
function record(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key)) || required.some(key => !Object.hasOwn(value, key)))
    throw new AgentMuxError('The original Goal application payload is invalid.', 'CONTROL_PROTOCOL_ERROR')
  return value as Record<string, unknown>
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value)) throw new AgentMuxError('The original Goal application identity is invalid.', 'CONTROL_PROTOCOL_ERROR')
  return value
}

/** Explicit application bytes, signed by Core together with the original request envelope. */
export function goalDelegationApplication(goalId: string, saved: Pick<DemandDelegation, 'operationId' | 'alignmentRevision' | 'capturedCriteria' | 'planNodeId' | 'predecessors'>): AgentMuxMessageApplication {
  return { schema: 'agentmux.goal-delegation.v1', data: { goalId, delegationOperationId: saved.operationId,
    alignmentRevision: saved.alignmentRevision, criteria: saved.capturedCriteria, ...(saved.planNodeId ? { planNodeId: saved.planNodeId } : {}),
    ...(saved.predecessors ? { predecessors: saved.predecessors } : {}) } }
}

/** Reads only the strict application protocol. Human body text never grants report authority. */
export function readGoalDelegationSource(message: DurableAgentMuxMessage): GoalDelegationSourceData {
  const application = message.envelope.application
  if (application?.schema !== 'agentmux.goal-delegation.v1') throw new AgentMuxError('The original source has no authenticated Goal delegation application. Keep the source; do not infer it from display text.', 'CONTROL_PROTOCOL_ERROR')
  const p = record(application.data, ['goalId', 'delegationOperationId', 'alignmentRevision', 'criteria'], ['planNodeId', 'predecessors'])
  if (typeof p.alignmentRevision !== 'number' || !Number.isSafeInteger(p.alignmentRevision) || p.alignmentRevision < 1)
    throw new AgentMuxError('The original delegated proposal revision is invalid.', 'CONTROL_PROTOCOL_ERROR')
  let criteria: DemandCriterion[]
  try { criteria = parseAlignmentProposal({ summary: 'Delegated standards', criteria: p.criteria, openQuestions: [] }).criteria }
  catch (error) { throw new AgentMuxError(error instanceof Error ? error.message : String(error), 'CONTROL_PROTOCOL_ERROR') }
  if (!criteria.length) throw new AgentMuxError('The original Goal delegation has no standards to report.', 'CONTROL_PROTOCOL_ERROR')
  return { goalId: id(p.goalId), delegationOperationId: id(p.delegationOperationId), alignmentRevision: p.alignmentRevision, criteria,
    ...(p.planNodeId === undefined ? {} : { planNodeId: id(p.planNodeId) }),
    ...(p.predecessors === undefined ? {} : { predecessors: parseGoalPlanPredecessors(p.predecessors) }) }
}

export function assertGoalSourceReport(data: GoalDelegationSourceData, report: DemandDelegationReportInput): void {
  if (report.grounding.alignmentRevision !== data.alignmentRevision || report.grounding.checks.length !== data.criteria.length ||
      data.criteria.some(criterion => !report.grounding.checks.some(check => check.criterionId === criterion.id)))
    throw new AgentMuxError('The report must retain the original proposal and every delegated criterion.', 'CONTROL_REQUEST_CONFLICT')
}

export function goalReportApplication(goalId: string, operationId: string, report: DemandDelegationReportInput): AgentMuxMessageApplication {
  return { schema: 'agentmux.goal-report.v1', data: { goalId, delegationOperationId: operationId,
    report: { operationId: report.operationId, replyMessageId: report.replyMessageId, authorAgentSessionId: report.authorAgentSessionId, grounding: report.grounding } } }
}

/** Stable wire encoding remains distinct from display text and human result acceptance. */
export function goalDelegationReportBody(goalId: string, operationId: string, report: DemandDelegationReportInput): string {
  return JSON.stringify({ schema: 'agentmux.goal-report.v1', ...goalReportApplication(goalId, operationId, report).data as object })
}

export function readGoalReportApplication(message: Pick<DurableAgentMuxMessage, 'envelope'>, goalId: string, operationId: string): DemandDelegationReportInput {
  if (message.envelope.application?.schema !== 'agentmux.goal-report.v1') throw new AgentMuxError('The signed reply has no original Goal report application.', 'CONTROL_PROTOCOL_ERROR')
  const data = record(message.envelope.application.data, ['goalId', 'delegationOperationId', 'report'])
  if (data.goalId !== goalId || data.delegationOperationId !== operationId) throw new AgentMuxError('The signed report names another original Goal or delegation.', 'CONTROL_PROTOCOL_ERROR')
  return parseDemandDelegationReportInput(data.report)
}
