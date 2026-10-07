import type { DemandDispatch, DemandDelegation } from '@agentmux/demand'
import type { DemandRecord } from './global-demand-board'

type Goal = Pick<DemandRecord, 'id' | 'title' | 'status' | 'responsibility'> & { dispatches?: readonly DemandDispatch[]; delegations?: readonly DemandDelegation[] }
export type CurrentGoalFact = {
  goalId: string
  title: string
  confirmed: boolean
  pending: 'prepared' | 'submitted' | 'unknown' | null
  operationIds: readonly string[]
  attributionAmbiguous?: boolean
  phase?: import('@agentmux/core/goal-responsibility').GoalResponsibilityPhase
  nextAction?: string
}
export type CurrentDemandFact = { state: 'current' | 'ambiguous' | 'unconfirmed'; goals: readonly CurrentGoalFact[] }
let previousGoals: Readonly<Record<string, Goal>> | undefined
const index = new Map<string, CurrentDemandFact>()
const contributions = new Map<string, { goal: Goal; targets: Map<string, CurrentGoalFact> }>()
const byTarget = new Map<string, Map<string, CurrentGoalFact>>()
export const currentDemandKey = (hostId: string, agentSessionId: string) => JSON.stringify([hostId, agentSessionId])

function project(goal: Goal): Map<string, CurrentGoalFact> {
  const targets = new Map<string, CurrentGoalFact>()
  if (goal.status === 'done' || goal.status === 'cancelled') return targets
  const rows = new Map(goal.responsibility?.executions.map(row => [`${row.execution.kind}:${row.execution.operationId}`, row]))
  const add = (key: string, operationId: string, confirmed: boolean, pending: CurrentGoalFact['pending'], kind: 'start' | 'delegation') => {
    const original = targets.get(key), row = rows.get(`${kind}:${operationId}`)
    const combinedPending = original?.pending === 'unknown' || pending === 'unknown' ? 'unknown'
      : original?.pending === 'submitted' || pending === 'submitted' ? 'submitted' : original?.pending === 'prepared' || pending === 'prepared' ? 'prepared' : null
    targets.set(key, { ...original, goalId: goal.id, title: goal.title, confirmed: original?.confirmed === true || confirmed,
      pending: combinedPending, operationIds: [...original?.operationIds ?? [], operationId].sort(),
      attributionAmbiguous: original?.attributionAmbiguous === true || row?.binding === 'ambiguous',
      ...(row ? { phase: row.phase, nextAction: row.nextOwner.action } : {}) })
  }
  for (const dispatch of goal.dispatches ?? []) {
    const confirmed = dispatch.stage === 'confirmed' && dispatch.receipt?.kind === 'core-prompt' &&
      dispatch.receipt.itemId === `prompt:${dispatch.operationId}` && Number.isSafeInteger(dispatch.receipt.createdAt) && dispatch.receipt.createdAt > 0
    add(currentDemandKey(dispatch.hostId, dispatch.agentSessionId), dispatch.operationId, confirmed,
      confirmed ? null : dispatch.stage === 'prepared' ? 'prepared' : dispatch.stage === 'submitted' ? 'submitted' : 'unknown', 'start')
  }
  for (const delegation of goal.delegations ?? []) {
    const row = rows.get(`delegation:${delegation.operationId}`), confirmed = Boolean(row && row.binding !== 'unconfirmed')
    add(currentDemandKey(delegation.hostId, delegation.workerAgentSessionId), delegation.operationId, confirmed, confirmed ? null : 'unknown', 'delegation')
  }
  return targets
}

function replace(goalId: string, goal: Goal | undefined): void {
  const prior = contributions.get(goalId)
  if (prior?.goal === goal) return
  const next = goal ? project(goal) : new Map<string, CurrentGoalFact>()
  if (goal) contributions.set(goalId, { goal, targets: next }); else contributions.delete(goalId)
  for (const key of new Set([...prior?.targets.keys() ?? [], ...next.keys()])) {
    const group = byTarget.get(key) ?? new Map<string, CurrentGoalFact>()
    const fact = next.get(key)
    if (fact) group.set(goalId, fact); else group.delete(goalId)
    if (!group.size) { byTarget.delete(key); index.delete(key); continue }
    byTarget.set(key, group)
    const facts = [...group.values()].sort((left, right) => left.goalId.localeCompare(right.goalId))
    const state = facts.some(fact => fact.pending !== null) ? 'unconfirmed' : facts.length > 1 || facts.some(fact => fact.attributionAmbiguous) ? 'ambiguous' : 'current'
    const projected: CurrentDemandFact = { state, goals: facts }, retained = index.get(key)
    if (!retained || JSON.stringify(retained) !== JSON.stringify(projected)) index.set(key, projected)
  }
}

/** Initial/business snapshots can change several Goals; unchanged original objects need no projection. */
export function currentDemandIndex(goals: Readonly<Record<string, Goal>>): ReadonlyMap<string, CurrentDemandFact> {
  if (goals !== previousGoals) {
    for (const id of contributions.keys()) if (!goals[id]) replace(id, undefined)
    for (const [id, goal] of Object.entries(goals)) replace(id, goal)
    previousGoals = goals
  }
  return index
}

/** The original producer names its affected Goals; transient observations never scan unrelated work. */
export function updateCurrentDemandIndex(before: Readonly<Record<string, Goal>>, after: Readonly<Record<string, Goal>>, goalIds: readonly string[]): void {
  currentDemandIndex(before)
  for (const id of goalIds) replace(id, after[id])
  previousGoals = after
}
