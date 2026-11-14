import type { DemandRecord } from './global-demand-board'
import type { SessionSnapshot } from '../../../shared/contracts'
import { agentSessionPresentationIndex } from './session-presentation'
import { goalAgentPresentation, type GoalAgentRole } from './goal-agent-selection'

type Agent = Extract<SessionSnapshot, { kind: 'agent' }>
export type GoalTeamActor = { key: string; session: Agent; roles: GoalAgentRole[]; recommended: boolean }
export type GoalTeamReference = { id: string; roles: GoalAgentRole[]; reason: string }
type Team = { actors: GoalTeamActor[]; references: GoalTeamReference[] }
type Membership = Pick<DemandRecord, 'supervisorSessionId' | 'assigneeSessionIds' | 'sessionIds' | 'participations'>
const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((item, i) => item === b[i])
const actorKey = (session: Agent) => JSON.stringify([session.control.hostId, session.control.agentSessionId])

/** Read only this Goal's original references through the shared inventory index.
 * A bare reference never selects the first Host or synthesizes an Actor. */
export function createGoalTeamSelector(goal: Membership) {
  const roles = new Map<string, GoalAgentRole[]>()
  for (const [role, ids] of [['supervisor', goal.supervisorSessionId ? [goal.supervisorSessionId] : []],
    ['assignees', goal.assigneeSessionIds ?? []], ['related', goal.sessionIds]] as const) {
    for (const id of ids) roles.set(id, [...new Set([...roles.get(id) ?? [], role])])
  }
  let held: Team = { actors: [], references: [] }
  let sessions: readonly SessionSnapshot[] | undefined
  return (state: { sessions: readonly SessionSnapshot[] }): Team => {
    if (sessions === state.sessions) return held
    sessions = state.sessions
    const index = agentSessionPresentationIndex(state.sessions)
    const actors = new Map<string, GoalTeamActor>(), references: GoalTeamReference[] = []
    const matches = (id: string) => (index.get(id) ?? []).filter(session => session.control.agentSessionId === id || session.id === id)
    for (const [id, assigned] of roles) {
      const candidates = matches(id)
      const session = goalAgentPresentation(candidates, id)
      if (!session) {
        const hosts = [...new Set(candidates.map(session => session.control.hostId))]
        const reason = candidates.some(session => session.hostId !== session.control.hostId)
          ? 'The presentation Host does not match its original Agent owner. Review the retained relationship.'
          : candidates.length ? `More than one original Host or Run matches${hosts.length ? ` · Hosts ${hosts.join(', ')}` : ''}. Review this relationship without choosing a first Host.`
            : 'The original Agent identity is not currently confirmed. Its reference and work are retained.'
        references.push({ id, roles: assigned, reason })
        continue
      }
      const key = actorKey(session), previous = actors.get(key)
      actors.set(key, { key, session, roles: [...new Set([...previous?.roles ?? [], ...assigned])], recommended: false })
    }
    if (!goal.supervisorSessionId) {
      // Keep the existing bounded recommendations, using exact original participation
      // and only an unambiguous canonical identity the original role picker can save.
      const candidates = [...actors.values()].filter(actor => actor.roles.includes('related')).map(actor => actor.key)
      for (const source of goal.participations ?? []) {
        const found = matches(source.agentSessionId)
        const session = goalAgentPresentation(found, source.agentSessionId)
        if (!session || session.control.hostId !== source.hostId) continue
        const key = actorKey(session)
        if (!actors.has(key)) actors.set(key, { key, session, roles: [], recommended: false })
        if (!candidates.includes(key)) candidates.push(key)
      }
      const recommended = new Set(candidates.slice(0, 3))
      for (const [key, actor] of actors) {
        if (!actor.roles.length && !recommended.has(key)) actors.delete(key)
        else actor.recommended = recommended.has(key)
      }
    }
    const oldActors = new Map(held.actors.map(actor => [actor.key, actor]))
    const oldReferences = new Map(held.references.map(reference => [reference.id, reference]))
    const nextActors = [...actors.values()].map(actor => {
      const subject = actor.session.control
      const presentations = (index.get(subject.agentSessionId) ?? []).filter(session => session.control.hostId === subject.hostId &&
        session.control.agentSessionId === subject.agentSessionId && session.control.run.runId === subject.run.runId)
      actor.session = goalAgentPresentation(presentations, subject.agentSessionId) ?? actor.session
      const old = oldActors.get(actor.key)
      return old?.session === actor.session && old.recommended === actor.recommended && same(old.roles, actor.roles) ? old : actor
    })
    const nextReferences = references.map(reference => {
      const old = oldReferences.get(reference.id)
      return old?.reason === reference.reason && same(old.roles, reference.roles) ? old : reference
    })
    if (!same(held.actors, nextActors) || !same(held.references, nextReferences)) held = { actors: nextActors, references: nextReferences }
    return held
  }
}
