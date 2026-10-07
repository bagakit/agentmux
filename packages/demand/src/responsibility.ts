import type { Demand } from './demand-types.js'

/** Business responsibility references original execution; it never owns Runtime state. */
export type DemandExecutionReference = {
  kind: 'start' | 'delegation'
  operationId: string
  hostId: string
  agentSessionId: string
  runId: string
}
export type DemandResponsibilityBasis = {
  stateEnteredAt: number | null
  activityRevision: number | null
  inputSubmissionId: string | null
}
export type DemandProgressInput = {
  operationId: string
  execution: DemandExecutionReference
  expectedScope: string
  phase: 'executing' | 'waiting-external' | 'blocked' | 'review' | 'handed-off'
  summary: string
  evidence: string[]
  nextAction: string
  waiting?: { reference: string; resumeWhen: string }
  groundingSubmissionId?: string
  handoffExecution?: DemandExecutionReference
}
export type DemandProgress = DemandProgressInput & {
  author: { kind: 'agent' | 'user' | 'device'; id: string }
  reportingRunId: string | null
  recordedAt: number
  basis: DemandResponsibilityBasis
  /** Worker declarations remain a manager review until explicitly acknowledged. */
  managerVerified: boolean
  reviewForHuman?: boolean
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)))
    throw new Error('Responsibility has invalid or unknown fields')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('Responsibility requires an exact nonempty value')
  return value
}
function nullableTime(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('Responsibility time or revision is invalid')
  return value
}
export function parseDemandExecutionReference(value: unknown): DemandExecutionReference {
  const p = object(value, ['kind', 'operationId', 'hostId', 'agentSessionId', 'runId'])
  if (p.kind !== 'start' && p.kind !== 'delegation') throw new Error('Responsibility requires its original execution kind')
  return { kind: p.kind, operationId: text(p.operationId), hostId: text(p.hostId), agentSessionId: text(p.agentSessionId), runId: text(p.runId) }
}
export function parseDemandResponsibilityBasis(value: unknown): DemandResponsibilityBasis {
  const p = object(value, ['stateEnteredAt', 'activityRevision', 'inputSubmissionId'])
  if (p.activityRevision !== null && (typeof p.activityRevision !== 'number' || !Number.isSafeInteger(p.activityRevision) || p.activityRevision < 0)) throw new Error('Responsibility activity revision is invalid')
  return { stateEnteredAt: nullableTime(p.stateEnteredAt), activityRevision: p.activityRevision as number | null,
    inputSubmissionId: p.inputSubmissionId === null ? null : text(p.inputSubmissionId) }
}
const inputKeys = ['operationId', 'execution', 'expectedScope', 'phase', 'summary', 'evidence', 'nextAction', 'waiting', 'groundingSubmissionId', 'handoffExecution']
export function parseDemandProgressInput(value: unknown): DemandProgressInput {
  const p = object(value, inputKeys)
  if (!['executing', 'waiting-external', 'blocked', 'review', 'handed-off'].includes(String(p.phase))) throw new Error('Responsibility phase is invalid')
  if (!Array.isArray(p.evidence)) throw new Error('Responsibility evidence must be an array')
  const waiting = p.waiting === undefined ? undefined : (() => {
    const w = object(p.waiting, ['reference', 'resumeWhen'])
    return { reference: text(w.reference), resumeWhen: text(w.resumeWhen) }
  })()
  if ((p.phase === 'waiting-external') !== Boolean(waiting)) throw new Error('External waiting requires its original condition and resume action')
  if ((p.phase === 'handed-off') !== (p.handoffExecution !== undefined)) throw new Error('Handoff requires its original accepted target execution')
  if (p.phase !== 'review' && p.groundingSubmissionId !== undefined) throw new Error('Only a reviewed result can associate grounding')
  return { operationId: text(p.operationId), execution: parseDemandExecutionReference(p.execution), expectedScope: text(p.expectedScope),
    phase: p.phase as DemandProgressInput['phase'], summary: text(p.summary), evidence: p.evidence.map(text), nextAction: text(p.nextAction),
    ...(waiting ? { waiting } : {}), ...(p.groundingSubmissionId === undefined ? {} : { groundingSubmissionId: text(p.groundingSubmissionId) }),
    ...(p.handoffExecution === undefined ? {} : { handoffExecution: parseDemandExecutionReference(p.handoffExecution) }) }
}
export function parseDemandProgress(value: unknown): DemandProgress {
  const p = object(value, [...inputKeys, 'author', 'reportingRunId', 'recordedAt', 'basis', 'managerVerified', 'reviewForHuman'])
  const input = parseDemandProgressInput(Object.fromEntries(inputKeys.filter(key => p[key] !== undefined).map(key => [key, p[key]])))
  const author = object(p.author, ['kind', 'id'])
  if (!['agent', 'user', 'device'].includes(String(author.kind)) || typeof p.managerVerified !== 'boolean') throw new Error('Responsibility author is invalid')
  if (p.reviewForHuman !== undefined && typeof p.reviewForHuman !== 'boolean') throw new Error('Review responsibility is invalid')
  const recordedAt = nullableTime(p.recordedAt)
  if (recordedAt === null) throw new Error('Responsibility declaration requires its original recording time')
  return { ...input, author: { kind: author.kind as DemandProgress['author']['kind'], id: text(author.id) },
    reportingRunId: p.reportingRunId === null ? null : text(p.reportingRunId), recordedAt,
    basis: parseDemandResponsibilityBasis(p.basis), managerVerified: p.managerVerified, ...(p.reviewForHuman === undefined ? {} : { reviewForHuman: p.reviewForHuman as boolean }) }
}
export function parseDemandProgressUpdates(value: unknown): DemandProgress[] {
  if (!Array.isArray(value)) throw new Error('Responsibility updates must be an array')
  const updates = value.map(parseDemandProgress)
  if (new Set(updates.map(item => item.operationId)).size !== updates.length) throw new Error('Duplicate responsibility operation')
  return updates
}
export function demandExecutionReferences(goal: Pick<Demand, 'dispatches' | 'delegations'>): DemandExecutionReference[] {
  return [
    ...(goal.dispatches ?? []).filter(item => item.execution === 'finite').map(item => ({ kind: 'start' as const,
      operationId: item.operationId, hostId: item.hostId, agentSessionId: item.agentSessionId, runId: item.runId })),
    ...(goal.delegations ?? []).map(item => ({ kind: 'delegation' as const, operationId: item.operationId,
      hostId: item.hostId, agentSessionId: item.workerAgentSessionId, runId: item.workerRunId }))
  ]
}
export function sameDemandExecution(left: DemandExecutionReference, right: DemandExecutionReference): boolean {
  return left.kind === right.kind && left.operationId === right.operationId && left.hostId === right.hostId &&
    left.agentSessionId === right.agentSessionId && left.runId === right.runId
}
export const demandExecutionKey = (reference: DemandExecutionReference) => JSON.stringify([reference.kind, reference.operationId, reference.hostId, reference.agentSessionId, reference.runId])
export function latestDemandProgress(goal: Pick<Demand, 'progressUpdates'>): Map<string, DemandProgress> {
  const latest = new Map<string, DemandProgress>()
  for (const update of goal.progressUpdates ?? []) latest.set(demandExecutionKey(update.execution), update)
  return latest
}
export function demandProgressBusinessCurrent(goal: Pick<Demand, 'alignment' | 'supervisorSessionId'>, update: DemandProgress): boolean {
  let scope: { alignment?: number | null }
  try { scope = JSON.parse(update.expectedScope) } catch { return false }
  return scope.alignment === (goal.alignment?.revision ?? null) &&
    (update.author.kind !== 'agent' || !update.managerVerified || update.author.id === goal.supervisorSessionId)
}
/** Derived accepted handoff endpoints. A cycle or absent target preserves an unresolved responsibility. */
export function demandHandoffDestinations(goal: Pick<Demand, 'dispatches' | 'delegations' | 'progressUpdates' | 'alignment' | 'supervisorSessionId'>,
  latest = latestDemandProgress(goal)): Map<string, DemandExecutionReference | null> {
  const refs = new Map(demandExecutionReferences(goal).map(ref => [demandExecutionKey(ref), ref]))
  const destinations = new Map<string, DemandExecutionReference | null>()
  for (const start of refs.values()) {
    const path: string[] = [], visited = new Set<string>()
    let current: DemandExecutionReference | null = start
    while (current) {
      const key = demandExecutionKey(current)
      if (destinations.has(key)) { current = destinations.get(key)!; break }
      if (visited.has(key) || !refs.has(key)) { current = null; break }
      visited.add(key); path.push(key)
      const update = latest.get(key)
      if (!update?.managerVerified || update.phase !== 'handed-off' || !demandProgressBusinessCurrent(goal, update)) break
      current = update.handoffExecution ?? null
    }
    for (const key of path) destinations.set(key, current)
  }
  return destinations
}
/** Unrelated activity and record timestamps do not invalidate a scoped business inspection. */
export function demandResponsibilityScope(goal: Pick<Demand, 'id' | 'status' | 'supervisorSessionId' | 'alignment' | 'grounding' | 'dispatches' | 'delegations' | 'progressUpdates'>): string {
  return JSON.stringify({ id: goal.id, status: goal.status, supervisor: goal.supervisorSessionId,
    alignment: goal.alignment?.revision ?? null, confirmedAt: goal.alignment?.confirmedAt ?? null, grounding: goal.grounding?.submissionId ?? null, acceptedAt: goal.grounding?.acceptedAt ?? null,
    starts: (goal.dispatches ?? []).filter(item => item.execution === 'finite').map(item => [item.operationId, item.hostId, item.agentSessionId, item.runId, item.stage, item.receipt ?? null]),
    delegations: (goal.delegations ?? []).map(item => [item.operationId, item.hostId, item.workerAgentSessionId, item.workerRunId, item.linkedAt ?? null, item.report?.operationId ?? null, item.collection?.operationId ?? null]),
    progress: (goal.progressUpdates ?? []).map(item => item.operationId) })
}
