import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { AgentMuxDemandActivity } from './control.js'

/** Original append-order anchors; timestamps and titles never identify this cut. */
export type GoalActivityCursor = { goalId: string; throughActivityId: string; beforeActivityId: string }
export type GoalActivityHistoryParams = { goalId: string; limit?: number; cursor?: GoalActivityCursor }
export type GoalActivityHistory = {
  goalId: string; activities: AgentMuxDemandActivity[]; throughActivityId: string | null
  nextCursor: GoalActivityCursor | null; totalCount: number; order: 'newest-first'; diskDurability: 'confirmed'
}
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !/[\0\r\n]/u.test(value)
export function parseGoalActivityHistoryParams(value: unknown): GoalActivityHistoryParams {
  const p = rpcRecord(value, ['goalId', 'limit', 'cursor'])
  if (!id(p.goalId) || p.limit !== undefined && (!Number.isSafeInteger(p.limit) || Number(p.limit) < 1 || Number(p.limit) > 1000))
    throw new AgentMuxError('Goal activity history needs its exact Goal and a limit from 1 to 1000.', 'INVALID_CONTROL_REQUEST')
  if (p.cursor !== undefined) {
    const c = rpcRecord(p.cursor, ['goalId', 'throughActivityId', 'beforeActivityId'])
    if (c.goalId !== p.goalId || !id(c.throughActivityId) || !id(c.beforeActivityId))
      throw new AgentMuxError('Keep the complete original Goal activity cursor.', 'INVALID_CONTROL_REQUEST')
  }
  return structuredClone(p) as GoalActivityHistoryParams
}
/** Pure projection of the original confirmed Demand read. No second event Store. */
export function pageGoalActivity(activities: readonly AgentMuxDemandActivity[], input: GoalActivityHistoryParams): GoalActivityHistory {
  const through = input.cursor ? activities.findIndex(a => a.id === input.cursor!.throughActivityId) : activities.length - 1
  const end = input.cursor ? activities.findIndex(a => a.id === input.cursor!.beforeActivityId) : through + 1
  if (input.cursor && (through < 0 || end < 0 || end > through))
    throw new AgentMuxError('The original Goal activity anchor is unavailable. Keep the original Goal and begin a new history read explicitly.', 'GOAL_ACTIVITY_CURSOR_EXPIRED')
  const from = Math.max(0, end - (input.limit ?? 100)), throughActivityId = activities[through]?.id ?? null
  const items = structuredClone(activities.slice(from, end)).reverse()
  return { goalId: input.goalId, activities: items, throughActivityId,
    nextCursor: from > 0 ? { goalId: input.goalId, throughActivityId: throughActivityId!, beforeActivityId: items.at(-1)!.id } : null,
    totalCount: through + 1, order: 'newest-first', diskDurability: 'confirmed' }
}
export function parseGoalActivityHistoryResult(value: unknown, input: GoalActivityHistoryParams): GoalActivityHistory {
  const p = rpcRecord(value, ['goalId', 'activities', 'throughActivityId', 'nextCursor', 'totalCount', 'order', 'diskDurability'], 'CONTROL_PROTOCOL_ERROR')
  const fail = (): never => { throw new AgentMuxError('The Goal activity page does not match its original scope.', 'CONTROL_PROTOCOL_ERROR') }
  if (p.goalId !== input.goalId || p.order !== 'newest-first' || p.diskDurability !== 'confirmed' || !Array.isArray(p.activities) ||
    p.activities.length > (input.limit ?? 100) || !Number.isSafeInteger(p.totalCount) || Number(p.totalCount) < p.activities.length ||
    (p.totalCount === 0 ? p.throughActivityId !== null : !id(p.throughActivityId)) ||
    input.cursor && p.throughActivityId !== input.cursor.throughActivityId) fail()
  const ids = (p.activities as Array<Record<string, unknown>>).map(a => a.id)
  if (ids.some(value => !id(value)) || new Set(ids).size !== ids.length || input.cursor && ids.includes(input.cursor.beforeActivityId)) fail()
  if (!input.cursor && ids.length && ids[0] !== p.throughActivityId) fail()
  if (p.nextCursor !== null) {
    const c = rpcRecord(p.nextCursor, ['goalId', 'throughActivityId', 'beforeActivityId'], 'CONTROL_PROTOCOL_ERROR')
    if (!ids.length || c.goalId !== input.goalId || c.throughActivityId !== p.throughActivityId || c.beforeActivityId !== ids.at(-1)) fail()
  }
  return structuredClone(p) as GoalActivityHistory
}
