import { renderAmuxProtocol } from '@agentmux/core/amux-protocol'
import type { Demand } from '@agentmux/demand/types'
import { currentGoalGrounding } from '@agentmux/demand/goal-grounding'
import { goalPlanReviewState } from '@agentmux/demand/goals'
import { currentGoalWorkStatus } from '@agentmux/demand/responsibility'
import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import type { ContinuousProgressTaskSource } from '@agentmux/core'
import { delegationWorkerHostId } from '@agentmux/demand/delegations'
import { projectGoalPlan, type GoalPlanProjection } from '@agentmux/demand/goal-plan'

const execute = promisify(execFile)
export function validateContinuousProgressTaskSource(value: unknown): asserts value is ContinuousProgressTaskSource {
  if (!value || typeof value !== 'object') throw new Error('Choose an exact task source root, Feature ID and public script.')
  const source = value as ContinuousProgressTaskSource
  if (source.kind === 'goal') {
    if (Object.keys(source).some(key => !['kind', 'goalId', 'alignmentRevision'].includes(key)) || !source.goalId?.trim() || !Number.isSafeInteger(source.alignmentRevision) || source.alignmentRevision < 1) throw new Error('Choose an exact Goal and confirmed alignment revision.')
    return
  }
  if (!['root', 'ownerId', 'readerPath'].every(key => typeof source[key as keyof typeof source] === 'string' && String(source[key as keyof typeof source]).trim()) ||
      !isAbsolute(source.root) || !isAbsolute(source.readerPath)) throw new Error('Task source root and public script must be explicit absolute paths; Feature ID must be nonempty.')
}

/** Read one explicit public owner receipt. The Tracker validates canonical state and computes its frontier. */
export async function readContinuousProgressTaskSource(source: ContinuousProgressTaskSource, signal: AbortSignal, readGoal?: GoalProgressReader): Promise<{ action: 'continue' | 'pause' | 'stop'; reason: string }> {
  validateContinuousProgressTaskSource(source)
  if (source.kind === 'goal') {
    if (!readGoal) throw new Error('The original Goal owner is unavailable; manual input remains available.')
    const goal = await readGoal(source.goalId)
    signal.throwIfAborted()
    return decideGoalProgressSource(source, goal)
  }
  const { stdout } = await execute('/bin/bash', [source.readerPath, 'get-owner-receipt', '--root', source.root, '--feature', source.ownerId, '--json'],
    { signal, timeout: 10_000, maxBuffer: 256 * 1024, encoding: 'utf8', cwd: source.root })
  const receipt: unknown = JSON.parse(stdout)
  if (!receipt || typeof receipt !== 'object') throw new Error('Task source returned an invalid owner receipt.')
  const value = receipt as Record<string, unknown>
  const states = ['proposal', 'ready', 'in_progress', 'blocked', 'replanning', 'done', 'archived', 'discarded', 'transferred']
  if (value.schema !== 'bagakit.execution-owner-receipt.v2' || value.owner_kind !== 'feature_tracker' || value.owner_id !== source.ownerId ||
      typeof value.semantic_revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.semantic_revision) ||
      !states.includes(value.lifecycle_status as string) || !['continue', 'blocked', 'complete', 'superseded', 'unavailable'].includes(value.continuation as string) ||
      !Array.isArray(value.active_item_ids) || !value.active_item_ids.every(id => typeof id === 'string' && id.length > 0) ||
      !Array.isArray(value.blockers) || !value.blockers.every(blocker => blocker && typeof blocker === 'object' && typeof blocker.class === 'string' && typeof blocker.reason === 'string') ||
      !(value.replacement_ref === null || typeof value.replacement_ref === 'string')) throw new Error('Task source identity, version or lifecycle is unconfirmed.')
  const prefix = `Feature ${source.ownerId}: `
  if (value.lifecycle_status === 'archived' && value.continuation === 'complete') return { action: 'stop', reason: prefix + 'business complete (archived).' }
  if (value.lifecycle_status === 'done' || value.blockers.some(blocker => blocker.class === 'closeout_required')) return { action: 'pause', reason: prefix + 'tasks are done; Feature closeout is still required.' }
  if (value.lifecycle_status === 'discarded' || value.lifecycle_status === 'transferred') return { action: 'stop', reason: prefix + `${value.lifecycle_status}; not business success.${value.replacement_ref ? ` Replacement: ${value.replacement_ref}` : ''}` }
  if (value.continuation === 'continue' && ['ready', 'in_progress'].includes(value.lifecycle_status as string)) {
    return { action: 'continue', reason: prefix + `${value.lifecycle_status}; source checked.` }
  }
  if (value.continuation === 'blocked') return { action: 'pause', reason: prefix + value.blockers.map(blocker => `${blocker.class}: ${blocker.reason}`).join('; ') }
  throw new Error('Task source lifecycle is unconfirmed; manual input remains available.')
}

export type GoalProgressRecord = Pick<Demand, 'id' | 'title' | 'description' | 'status' | 'sessionIds' | 'assigneeSessionIds' | 'supervisorSessionId' |
  'alignment' | 'plan' | 'delegations' | 'dispatches' | 'progressUpdates' | 'patrols' | 'grounding' | 'acceptedGroundingSource'>
export type GoalProgressReader = (goalId: string) => Promise<GoalProgressRecord | null>
export type GoalProgressDecision = { action: 'continue' | 'pause' | 'stop'; reason: string; continuation?: string }

/** Main interprets the original Goal snapshot; this does not live in Core's scheduler. */
export function decideGoalProgressSource(source: Extract<ContinuousProgressTaskSource, { kind: 'goal' }>, goal: GoalProgressRecord | null | undefined): GoalProgressDecision {
  if (!goal || goal.id !== source.goalId) return { action: 'pause', reason: 'The original Goal is unavailable; its loop and Agent are retained.' }
  const prefix = `Goal ${source.goalId}: `
  if (goal.status === 'done' || goal.status === 'cancelled') return { action: 'stop', reason: prefix + goal.status + '; the Agent Run is kept.' }
  if (goal.status === 'blocked') return { action: 'pause', reason: prefix + 'blocked; review the original Goal.' }
  if (goal.alignment?.revision !== source.alignmentRevision || goal.alignment.confirmedAt === null) return { action: 'pause', reason: prefix + 'the original confirmed scope changed. Stop this loop before explicitly starting the new scope.' }
  if (goal.plan) {
    const projection = projectGoalPlan(goal.plan, goal.delegations ?? [], goal.alignment.criteria, undefined, goal.alignment.revision)
    return decideGoalPlanProgress(prefix, goal, projection, source)
  }
  return { action: 'continue', reason: prefix + `confirmed scope r${source.alignmentRevision}; source checked.` }
}

/**
 * Monitoring follows the plan: keep going while any node has work, including nodes whose facts
 * are unknown (the Supervisor reconciles them from the original receipt); pause only when the
 * human must accept results or the plan needs a revision to move.
 */
function decideGoalPlanProgress(prefix: string, goal: GoalProgressRecord, projection: GoalPlanProjection, source: Extract<ContinuousProgressTaskSource, { kind: 'goal' }>): GoalProgressDecision {
  const named = (states: readonly string[]) => projection.nodes.filter(item => states.includes(item.state)).map(item => item.node.id)
  const open = { ready: named(['ready']), changes: named(['changes']), working: named(['working']), review: named(['review']), unknown: named(['unknown']) }
  const parts = Object.entries(open).filter(([, ids]) => ids.length).map(([state, ids]) => `${state}: ${ids.join(', ')}`)
  const progress = `plan r${projection.revision} ${projection.done}/${projection.total} done`
  if (parts.length) return { action: 'continue', reason: `${prefix}${progress}; ${parts.join('; ')}.${open.unknown.length ? ' Reconcile unknown nodes from their original delegation receipts before acting on them.' : ''}`,
    continuation: goalPlanContinuation(source, projection) }
  if (projection.total > 0 && projection.done === projection.total) {
    const status = currentGoalWorkStatus(goal, projection)
    if (status === 'in_progress') return { action: 'continue', reason: `${prefix}${progress}; independent execution still needs attention. Inspect its original responsibility.` }
    const state = goalPlanReviewState(status, goal.alignment, currentGoalGrounding(goal, projection))
    const reason = state === 'awaiting-acceptance' ? 'Waiting for a person to accept the Goal results.'
      : state === 'accepted' ? 'The current results have been accepted.'
      : state === 'awaiting-report' ? 'Awaiting a Goal result report.' : 'The Goal result still needs evidence review.'
    return { action: 'pause', reason: `${prefix}${progress}; ${reason}` }
  }
  return { action: 'pause', reason: `${prefix}${progress}; remaining nodes wait on cancelled dependencies (${named(['waiting']).join(', ')}). Revise the plan to move them.` }
}

/** Freeze identifiers from the same owner snapshot that qualified this occurrence. Node bodies stay in goal plan. */
function goalPlanContinuation(source: Extract<ContinuousProgressTaskSource, { kind: 'goal' }>, projection: GoalPlanProjection): string {
  const nodes = projection.nodes.filter(item => ['ready', 'working', 'review', 'changes', 'unknown'].includes(item.state)).map(item => {
    const attempt = item.delegation
    const deliveryHash = attempt?.report?.delivery?.hash
    const next = item.state === 'review' && attempt && deliveryHash
      ? { kind: 'review', delegationOperationId: attempt.operationId, deliveryHash }
      : item.state === 'ready' && item.node.executor && item.predecessors
        ? { kind: 'dispatch', executor: item.node.executor, predecessors: item.predecessors }
        : item.state === 'unknown' ? { kind: 'reconcile', reasons: item.unknown } : null
    return { id: item.node.id, state: item.state, executor: item.node.executor, unknown: item.unknown, next,
      attempt: attempt ? { delegationOperationId: attempt.operationId, sourceMessageId: attempt.sourceMessageId,
        threadId: attempt.threadId, workerHostId: delegationWorkerHostId(attempt), workerAgentSessionId: attempt.workerAgentSessionId } : null }
  })
  return renderAmuxProtocol('goal-task', 'continuation', {
    goal: source.goalId,
    revision: String(source.alignmentRevision),
    original: JSON.stringify({ schema: 'agentmux.goal-plan-continuation.v1', goalId: source.goalId,
      alignmentRevision: source.alignmentRevision, planRevision: projection.revision, nodes })
  })
}
