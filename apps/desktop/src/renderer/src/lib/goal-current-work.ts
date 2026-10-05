import type { DemandDispatch } from '@agentmux/demand'
import type { DemandRecord } from './global-demand-board'

type Goal = Pick<DemandRecord, 'id' | 'title' | 'status'> & { dispatches?: readonly DemandDispatch[] }
export type CurrentGoalFact = {
  goalId: string
  title: string
  confirmed: boolean
  pending: 'prepared' | 'submitted' | 'unknown' | null
  operationIds: readonly string[]
}
export type CurrentDemandFact = { state: 'current' | 'ambiguous' | 'unconfirmed'; goals: readonly CurrentGoalFact[] }
let previousGoals: Readonly<Record<string, Goal>> | undefined
let previousIndex: ReadonlyMap<string, CurrentDemandFact> = new Map()
export const currentDemandKey = (hostId: string, agentSessionId: string) => JSON.stringify([hostId, agentSessionId])

/** Rebuild on Demand changes only; retain per-target facts when unrelated fields change. */
export function currentDemandIndex(goals: Readonly<Record<string, Goal>>): ReadonlyMap<string, CurrentDemandFact> {
  if (goals === previousGoals) return previousIndex
  const entries = new Map<string, Map<string, CurrentGoalFact>>()
  for (const goal of Object.values(goals)) {
    if (goal.status === 'done' || goal.status === 'cancelled') continue
    for (const dispatch of goal.dispatches ?? []) {
      const key = currentDemandKey(dispatch.hostId, dispatch.agentSessionId), target = entries.get(key) ?? new Map<string, CurrentGoalFact>()
      const original = target.get(goal.id), confirmed = dispatch.stage === 'confirmed' && dispatch.receipt?.kind === 'core-prompt' &&
        dispatch.receipt.itemId === `prompt:${dispatch.operationId}` && Number.isSafeInteger(dispatch.receipt.createdAt) && dispatch.receipt.createdAt > 0
      const phase = confirmed ? null : dispatch.stage === 'prepared' ? 'prepared' : dispatch.stage === 'submitted' ? 'submitted' : 'unknown'
      const pending = original?.pending === 'unknown' || phase === 'unknown' ? 'unknown'
        : original?.pending === 'submitted' || phase === 'submitted' ? 'submitted' : original?.pending === 'prepared' || phase === 'prepared' ? 'prepared' : null
      target.set(goal.id, { goalId: goal.id, title: goal.title, confirmed: original?.confirmed === true || confirmed, pending,
        operationIds: [...original?.operationIds ?? [], dispatch.operationId].sort() })
      entries.set(key, target)
    }
  }
  const next = new Map<string, CurrentDemandFact>()
  for (const [key, grouped] of entries) {
    const facts = [...grouped.values()].sort((left, right) => left.goalId.localeCompare(right.goalId))
    const state = facts.some(fact => fact.pending !== null) ? 'unconfirmed' : facts.length > 1 ? 'ambiguous' : 'current'
    const fact: CurrentDemandFact = { state, goals: facts }, retained = previousIndex.get(key)
    next.set(key, retained && JSON.stringify(retained) === JSON.stringify(fact) ? retained : fact)
  }
  previousGoals = goals; previousIndex = next
  return next
}
