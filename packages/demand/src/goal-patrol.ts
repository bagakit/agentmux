import type { Demand, DemandStatus } from './demand-types.js'
import { parseAlignment, parseGroundingProposal, type DemandAlignment, type DemandGroundingProposal } from './goals.js'
import { demandExecutionReferences, parseDemandExecutionReference, parseDemandProgressInput, sameDemandExecution,
  demandResponsibilityScope, type DemandExecutionReference, type DemandProgressInput } from './responsibility.js'

export type DemandPatrolTarget = { agentSessionId: string; hostId: string; runId: string; providerId: string; workspacePath: string }
export type GoalConfirmationRecipient = Pick<DemandPatrolTarget, 'agentSessionId' | 'hostId'>
type DemandPatrolPurpose = 'plan' | 'confirmation'
export type DemandPatrolAttempt = { operationId: string; actionOperationId: string; intentId: string; target: DemandPatrolTarget; agentMuxNote: string;
  preparedAt: number; attemptedAt?: number; supersededAt?: number }
export type DemandPatrolReportInput = { operationId: string; summary: string; grounding?: DemandGroundingProposal;
  progress: DemandProgressInput[]; status?: Exclude<DemandStatus, 'done' | 'cancelled'>;
  nextOwner: { kind: 'agent' | 'human' | 'external' | 'unassigned'; agentSessionId: string | null; action: string } }
export type DemandPatrolReport = DemandPatrolReportInput & { authorAgentSessionId: string; reportingRunId: string;
  reportedAt: number; applied: boolean; reason: string }
export type DemandPatrol = { purpose?: DemandPatrolPurpose; planRevision?: number; recipientHostId?: string; requestOperationIds?: string[]; operationId: string; expectedScope: string; executions: DemandExecutionReference[]; alignment?: DemandAlignment;
  supervisorAgentSessionId: string | null; context: string; requestedBy: { kind: 'agent' | 'user' | 'device'; id: string };
  requestedAt: number; attempts: DemandPatrolAttempt[]; report?: DemandPatrolReport }
export type DemandPatrolPreparation = Omit<DemandPatrol, 'requestedAt' | 'attempts' | 'report' | 'alignment' | 'purpose' | 'recipientHostId'> & {
  purpose?: 'plan'; attempt?: Omit<DemandPatrolAttempt, 'preparedAt' | 'attemptedAt' | 'supersededAt'>
}

function obj(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new Error('Patrol has invalid or unknown fields')
  return value as Record<string, unknown>
}
function text(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('Patrol requires an exact nonempty value'); return value }
function time(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('Patrol time is invalid'); return value }
export function parseGoalConfirmationRecipient(value: unknown): GoalConfirmationRecipient {
  const p = obj(value, ['agentSessionId', 'hostId'])
  return { agentSessionId: text(p.agentSessionId), hostId: text(p.hostId) }
}
export function parseDemandPatrolTarget(value: unknown): DemandPatrolTarget {
  const p = obj(value, ['agentSessionId', 'hostId', 'runId', 'providerId', 'workspacePath'])
  return { agentSessionId: text(p.agentSessionId), hostId: text(p.hostId), runId: text(p.runId), providerId: text(p.providerId), workspacePath: text(p.workspacePath) }
}
export function parseDemandPatrolAttempt(value: unknown): DemandPatrolAttempt {
  const p = obj(value, ['operationId', 'actionOperationId', 'intentId', 'target', 'agentMuxNote', 'preparedAt', 'attemptedAt', 'supersededAt'])
  return { operationId: text(p.operationId), actionOperationId: text(p.actionOperationId), intentId: text(p.intentId), target: parseDemandPatrolTarget(p.target), agentMuxNote: text(p.agentMuxNote),
    preparedAt: time(p.preparedAt), ...(p.attemptedAt === undefined ? {} : { attemptedAt: time(p.attemptedAt) }), ...(p.supersededAt === undefined ? {} : { supersededAt: time(p.supersededAt) }) }
}
export function parseDemandPatrolReportInput(value: unknown): DemandPatrolReportInput {
  const p = obj(value, ['operationId', 'summary', 'grounding', 'progress', 'status', 'nextOwner'])
  if (!Array.isArray(p.progress)) throw new Error('Patrol progress must name original executions')
  const next = obj(p.nextOwner, ['kind', 'agentSessionId', 'action'])
  if (!['agent', 'human', 'external', 'unassigned'].includes(String(next.kind)) || (next.kind === 'agent') !== (next.agentSessionId !== null)) throw new Error('Patrol next responsibility is invalid')
  if (p.status !== undefined && !['backlog', 'todo', 'in_progress', 'in_review', 'blocked'].includes(String(p.status))) throw new Error('Patrol cannot accept or close a human Goal')
  const progress = p.progress.map(parseDemandProgressInput)
  if (new Set(progress.map(update => update.operationId)).size !== progress.length) throw new Error('Duplicate patrol progress operation')
  return { operationId: text(p.operationId), summary: text(p.summary), ...(p.grounding === undefined ? {} : { grounding: parseGroundingProposal(p.grounding) }), progress,
    ...(p.status === undefined ? {} : { status: p.status as NonNullable<DemandPatrolReportInput['status']> }),
    nextOwner: { kind: next.kind as DemandPatrolReportInput['nextOwner']['kind'], agentSessionId: next.agentSessionId === null ? null : text(next.agentSessionId), action: text(next.action) } }
}
export function parseDemandPatrols(value: unknown): DemandPatrol[] {
  if (!Array.isArray(value)) throw new Error('Goal patrols must be an array')
  const seen = new Set<string>()
  return value.map(value => {
    const p = obj(value, ['purpose', 'planRevision', 'recipientHostId', 'requestOperationIds', 'operationId', 'expectedScope', 'executions', 'alignment', 'supervisorAgentSessionId', 'context', 'requestedBy', 'requestedAt', 'attempts', 'report'])
    if (!Array.isArray(p.executions) || !Array.isArray(p.attempts)) throw new Error('Patrol requires its frozen executions and input attempts')
    if (p.purpose !== undefined && p.purpose !== 'plan' && p.purpose !== 'confirmation' || p.planRevision !== undefined && (!Number.isSafeInteger(p.planRevision) || Number(p.planRevision) < 0 || p.purpose !== 'plan')) throw new Error('Goal request purpose or plan revision is invalid')
    if (p.purpose === 'plan' && (p.planRevision === undefined || p.report !== undefined || p.executions.length)) throw new Error('Planning retains its original plan revision and has no inspection executions or report')
    const alignment = p.alignment === undefined ? undefined : parseAlignment(p.alignment)
    const supervisor = p.supervisorAgentSessionId === null ? null : text(p.supervisorAgentSessionId)
    const recipientHostId = p.purpose === 'confirmation' ? text(p.recipientHostId) : undefined
    if (p.purpose === 'confirmation' ? !supervisor || !alignment?.confirmedAt || p.report !== undefined || p.executions.length
      : p.recipientHostId !== undefined) throw new Error('Goal confirmation notice requires its confirmed revision and original recipient')
    const requestOperationIds = p.requestOperationIds === undefined ? undefined : (() => {
      if (!Array.isArray(p.requestOperationIds) || p.purpose !== 'plan') throw new Error('Planning request aliases must be original operation IDs')
      const ids = p.requestOperationIds.map(text)
      if (new Set(ids).size !== ids.length) throw new Error('Duplicate planning operation alias')
      return ids
    })()
    const requested = obj(p.requestedBy, ['kind', 'id'])
    if (!['agent', 'user', 'device'].includes(String(requested.kind))) throw new Error('Patrol requester is invalid')
    if (p.purpose === 'confirmation' && requested.kind === 'agent') throw new Error('A Goal confirmation notice requires its original person or device')
    const operationId = text(p.operationId)
    if (seen.has(operationId)) throw new Error('Duplicate original patrol'); seen.add(operationId)
    const report = p.report === undefined ? undefined : (() => {
      const r = obj(p.report, ['operationId', 'summary', 'grounding', 'progress', 'status', 'nextOwner', 'authorAgentSessionId', 'reportingRunId', 'reportedAt', 'applied', 'reason'])
      if (typeof r.applied !== 'boolean') throw new Error('Patrol report application is invalid')
      const { authorAgentSessionId, reportingRunId, reportedAt, applied, reason, ...input } = r
      return { ...parseDemandPatrolReportInput(input), authorAgentSessionId: text(authorAgentSessionId), reportingRunId: text(reportingRunId), reportedAt: time(reportedAt), applied, reason: text(reason) }
    })()
    const attempts = p.attempts.map(parseDemandPatrolAttempt)
    if (new Set(attempts.map(a => a.operationId)).size !== attempts.length || attempts.slice(0, -1).some(a => !a.supersededAt || a.attemptedAt)) throw new Error('Patrol input history is invalid')
    if (recipientHostId && attempts.some(entry => entry.target.hostId !== recipientHostId || entry.target.agentSessionId !== supervisor))
      throw new Error('The confirmation input must use its original recipient')
    return { ...(p.purpose === 'plan' ? { purpose: 'plan' as const, planRevision: p.planRevision as number, ...(requestOperationIds ? { requestOperationIds } : {}) }
      : recipientHostId ? { purpose: 'confirmation' as const, recipientHostId } : {}), operationId, expectedScope: text(p.expectedScope),
      executions: p.executions.map(parseDemandExecutionReference), ...(alignment ? { alignment } : {}),
      supervisorAgentSessionId: supervisor, context: text(p.context),
      requestedBy: { kind: requested.kind as DemandPatrol['requestedBy']['kind'], id: text(requested.id) }, requestedAt: time(p.requestedAt), attempts, ...(report ? { report } : {}) }
  })
}
export function assertPatrolExecutions(goal: Pick<Demand, 'dispatches' | 'delegations'>, patrol: Pick<DemandPatrol, 'executions'>): void {
  const refs = demandExecutionReferences(goal)
  if (!patrol.executions.length || patrol.executions.some(ref => !refs.some(original => sameDemandExecution(original, ref))) ||
    new Set(patrol.executions.map(ref => JSON.stringify([ref.kind, ref.operationId]))).size !== patrol.executions.length) throw new Error('Patrol must retain original executions from this Goal')
}

/** Planning depends on its original proposal/manager, never unrelated execution history. */
export function demandPatrolScope(goal: Parameters<typeof demandResponsibilityScope>[0] & Pick<Demand, 'plan'>, purpose?: DemandPatrolPurpose): string {
  if (purpose === 'confirmation') return JSON.stringify([goal.id, goal.supervisorSessionId, goal.alignment?.revision, goal.alignment?.confirmedAt])
  return purpose === 'plan' ? JSON.stringify({ purpose: 'plan', goalId: goal.id, supervisor: goal.supervisorSessionId,
    alignmentRevision: goal.alignment?.revision ?? null, planRevision: goal.plan?.revision ?? 0 }) : demandResponsibilityScope(goal)
}
export function currentGoalConfirmationNotice(goal: Pick<Demand, 'patrols' | 'alignment'>): DemandPatrol | undefined {
  const { alignment } = goal
  return alignment?.confirmedAt == null ? undefined : goal.patrols?.find(item => item.purpose === 'confirmation' &&
    item.alignment?.revision === alignment.revision && item.alignment.confirmedAt === alignment.confirmedAt)
}
export function completedGoalPlanRequest(goal: Demand, request: DemandPatrol): number | null {
  return request.purpose === 'plan' && goal.plan && goal.plan.revision > request.planRevision! ? goal.plan.revision : null
}
