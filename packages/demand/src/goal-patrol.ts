import type { Demand, DemandStatus } from './demand-types.js'
import { parseAlignment, parseGroundingProposal, type DemandAlignment, type DemandGroundingProposal } from './goals.js'
import { demandExecutionReferences, parseDemandExecutionReference, parseDemandProgressInput, sameDemandExecution,
  type DemandExecutionReference, type DemandProgressInput } from './responsibility.js'

export type DemandPatrolTarget = { agentSessionId: string; hostId: string; runId: string; providerId: string; workspacePath: string }
export type DemandPatrolAttempt = { operationId: string; actionOperationId: string; intentId: string; target: DemandPatrolTarget; agentMuxNote: string;
  preparedAt: number; attemptedAt?: number; supersededAt?: number }
export type DemandPatrolReportInput = { operationId: string; summary: string; grounding?: DemandGroundingProposal;
  progress: DemandProgressInput[]; status?: Exclude<DemandStatus, 'done' | 'cancelled'>;
  nextOwner: { kind: 'agent' | 'human' | 'external' | 'unassigned'; agentSessionId: string | null; action: string } }
export type DemandPatrolReport = DemandPatrolReportInput & { authorAgentSessionId: string; reportingRunId: string;
  reportedAt: number; applied: boolean; reason: string }
export type DemandPatrol = { operationId: string; expectedScope: string; executions: DemandExecutionReference[]; alignment?: DemandAlignment;
  supervisorAgentSessionId: string | null; context: string; requestedBy: { kind: 'agent' | 'user' | 'device'; id: string };
  requestedAt: number; attempts: DemandPatrolAttempt[]; report?: DemandPatrolReport }
export type DemandPatrolPreparation = Omit<DemandPatrol, 'requestedAt' | 'attempts' | 'report' | 'alignment'> & { attempt?: Omit<DemandPatrolAttempt, 'preparedAt' | 'attemptedAt' | 'supersededAt'> }

function obj(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new Error('Patrol has invalid or unknown fields')
  return value as Record<string, unknown>
}
function text(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('Patrol requires an exact nonempty value'); return value }
function time(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('Patrol time is invalid'); return value }
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
    const p = obj(value, ['operationId', 'expectedScope', 'executions', 'alignment', 'supervisorAgentSessionId', 'context', 'requestedBy', 'requestedAt', 'attempts', 'report'])
    if (!Array.isArray(p.executions) || !Array.isArray(p.attempts)) throw new Error('Patrol requires its frozen executions and input attempts')
    const requested = obj(p.requestedBy, ['kind', 'id'])
    if (!['agent', 'user', 'device'].includes(String(requested.kind))) throw new Error('Patrol requester is invalid')
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
    return { operationId, expectedScope: text(p.expectedScope), executions: p.executions.map(parseDemandExecutionReference), ...(p.alignment === undefined ? {} : { alignment: parseAlignment(p.alignment) }),
      supervisorAgentSessionId: p.supervisorAgentSessionId === null ? null : text(p.supervisorAgentSessionId), context: text(p.context),
      requestedBy: { kind: requested.kind as DemandPatrol['requestedBy']['kind'], id: text(requested.id) }, requestedAt: time(p.requestedAt), attempts, ...(report ? { report } : {}) }
  })
}
export function assertPatrolExecutions(goal: Pick<Demand, 'dispatches' | 'delegations'>, patrol: Pick<DemandPatrol, 'executions'>): void {
  const refs = demandExecutionReferences(goal)
  if (!patrol.executions.length || patrol.executions.some(ref => !refs.some(original => sameDemandExecution(original, ref))) ||
    new Set(patrol.executions.map(ref => JSON.stringify([ref.kind, ref.operationId]))).size !== patrol.executions.length) throw new Error('Patrol must retain original executions from this Goal')
}
