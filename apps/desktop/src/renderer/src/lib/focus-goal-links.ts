import { demandRelationKey, projectDemandRelations, type GoalRelationRole, type GoalRelation, type DemandRelations } from '@agentmux/demand/relations'
import type { SessionSnapshot } from '../../../shared/contracts'
import type { DemandRecord } from './global-demand-board'

export type FocusGoalLink = Pick<GoalRelation, 'goalId' | 'title' | 'status'> & {
  confirmedRoles: readonly GoalRelationRole[]
  unconfirmedRoles: readonly GoalRelationRole[]
}
export type FocusGoalLinks = { items: readonly FocusGoalLink[]; confirmedCount: number }
export const focusGoalCardKey = (hostId: string, presentationId: string) => JSON.stringify([hostId, presentationId])
const EMPTY_ROLES: readonly GoalRelationRole[] = []
function merge(confirmed: readonly GoalRelation[] = [], unconfirmed: readonly GoalRelation[] = []): FocusGoalLinks {
  const goals = new Map<string, FocusGoalLink>()
  for (const { roles, ...goal } of confirmed) goals.set(goal.goalId, { ...goal, confirmedRoles: roles, unconfirmedRoles: EMPTY_ROLES })
  for (const { roles, ...goal } of unconfirmed) {
    const held = goals.get(goal.goalId)
    goals.set(goal.goalId, held ? { ...held, unconfirmedRoles: roles } : { ...goal, confirmedRoles: EMPTY_ROLES, unconfirmedRoles: roles })
  }
  return { items: [...goals.values()], confirmedCount: confirmed.length }
}
type Index = { groups: Map<string, Map<string, GoalRelation>>; rows: Map<string, readonly GoalRelation[]> }
function replace(index: Index, goalId: string, before: DemandRelations['qualified'] | undefined, after: DemandRelations['qualified'] | undefined, affected: Set<string>) {
  for (const key of new Set([...before?.keys() ?? [], ...after?.keys() ?? []])) {
    const group = index.groups.get(key) ?? new Map<string, GoalRelation>(), next = after?.get(key)?.[0]
    if (next) group.set(goalId, next); else group.delete(goalId)
    if (group.size) { index.groups.set(key, group); index.rows.set(key, [...group.values()]) }
    else { index.groups.delete(key); index.rows.delete(key) }
    affected.add(key)
  }
}

/** Disposable derived indexes over original immutable facts. No reads, observation or persisted state.
 * Control Host/canonical SID select relations; presentation aliases only select the consuming card. */
export function createFocusGoalLinksSelector() {
  let previousGoals: Readonly<Record<string, DemandRecord>> | undefined, previousSessions: readonly SessionSnapshot[] | undefined
  let subjects: readonly string[] = []
  const contributions = new Map<string, { goal: DemandRecord; value: DemandRelations }>()
  const qualified: Index = { groups: new Map(), rows: new Map() }, unqualified: Index = { groups: new Map(), rows: new Map() }
  let identities = new Map<string, { hostId: string; agentSessionId: string }>()
  let qualifiedCards = new Map<string, Set<string>>(), unqualifiedCards = new Map<string, Set<string>>()
  let result: ReadonlyMap<string, FocusGoalLinks> = new Map()
  return (input: { demands: Readonly<Record<string, DemandRecord>>; sessions: readonly SessionSnapshot[] }, active = true) => {
    if (!active) return result
    const affectedQualified = new Set<string>(), affectedBare = new Set<string>()
    if (input.demands !== previousGoals) {
      // The original record snapshot names no changed IDs: compare object identities once,
      // then project only changed Goals and replace only their affected original subjects.
      for (const id of new Set([...contributions.keys(), ...Object.keys(input.demands)])) {
        const old = contributions.get(id), goal = input.demands[id]
        if (old?.goal === goal) continue
        const value = goal ? projectDemandRelations([goal]) : undefined
        replace(qualified, id, old?.value.qualified, value?.qualified, affectedQualified)
        replace(unqualified, id, old?.value.unqualified, value?.unqualified, affectedBare)
        if (goal && value) contributions.set(id, { goal, value }); else contributions.delete(id)
      }
      previousGoals = input.demands
    }
    let identityChanged = false
    if (input.sessions !== previousSessions) {
      const agents = input.sessions.filter(session => session.kind === 'agent')
      const next = agents.map(session => JSON.stringify([session.hostId, session.id, session.control.hostId, session.control.agentSessionId]))
      identityChanged = next.length !== subjects.length || next.some((value, index) => value !== subjects[index])
      if (identityChanged) {
        identities = new Map(agents.map(session => [focusGoalCardKey(session.hostId, session.id), session.control]))
        qualifiedCards = new Map(); unqualifiedCards = new Map()
        for (const [id, subject] of identities) {
          const key = demandRelationKey(subject.hostId, subject.agentSessionId), exact = qualifiedCards.get(key) ?? new Set<string>(), bare = unqualifiedCards.get(subject.agentSessionId) ?? new Set<string>()
          exact.add(id); bare.add(id); qualifiedCards.set(key, exact); unqualifiedCards.set(subject.agentSessionId, bare)
        }
        subjects = next
      }
      previousSessions = input.sessions
    }
    const affected = identityChanged ? new Set(identities.keys()) : new Set([...affectedQualified].flatMap(key => [...qualifiedCards.get(key) ?? []])
      .concat([...affectedBare].flatMap(key => [...unqualifiedCards.get(key) ?? []])))
    if (!identityChanged && !affected.size) return result
    const next = identityChanged ? new Map<string, FocusGoalLinks>() : new Map(result)
    for (const id of affected) {
      const subject = identities.get(id)!, exact = qualified.rows.get(demandRelationKey(subject.hostId, subject.agentSessionId)), bare = unqualified.rows.get(subject.agentSessionId)
      if (exact?.length || bare?.length) next.set(id, merge(exact, bare)); else next.delete(id)
    }
    result = next; return result
  }
}
