import { demandAgentReferenceKey, type DemandSpaceMemberReference } from '@agentmux/demand/relations'
import type { DemandRecord } from './global-demand-board'
import type { SessionSnapshot } from '../../../shared/contracts'
import { agentSessionPresentationIndex } from './session-presentation'
import { goalAgentPresentation, type GoalAgentRole } from './goal-agent-selection'
import { goalSupervisorHostWitnesses, projectDemandRelations, type GoalRelationRoleKind } from '@agentmux/demand/relations'
import { collaborationSubjectKey, type CollaborationAgent } from './agent-collaboration'

export type GoalTeamIdentity = { subject: { hostId: string; agentSessionId: string }; roles: readonly (GoalRelationRoleKind | 'planned-executor')[]; currentSupervisor?: true }
/** Accurate recorded sources are not inferred from bare assignments or live namesakes. */
export function goalTeamIdentities(goal: DemandRecord) {
  const identities = new Map<string, GoalTeamIdentity>()
  const add = (subject: GoalTeamIdentity['subject'], roles: GoalTeamIdentity['roles']) => {
    const key = collaborationSubjectKey(subject), previous = identities.get(key)
    identities.set(key, { subject, roles: [...new Set([...previous?.roles ?? [], ...roles])] })
  }
  for (const [key, relations] of projectDemandRelations([goal]).qualified) {
    const [hostId, agentSessionId] = JSON.parse(key) as [string, string]
    add({ hostId, agentSessionId }, relations.flatMap(relation => relation.roles.map(role => role.kind)))
  }
  for (const node of goal.plan?.nodes ?? []) if (node.executor) add(node.executor, ['planned-executor'])
  const supervisorHosts = goalSupervisorHostWitnesses(goal)
  if (typeof goal.supervisorSessionId === 'string' && supervisorHosts.length === 1) {
    const subject = { hostId: supervisorHosts[0]!, agentSessionId: goal.supervisorSessionId }, key = collaborationSubjectKey(subject)
    add(subject, ['supervisor']); identities.set(key, { ...identities.get(key)!, currentSupervisor: true })
  }
  const agents = new Map<string, CollaborationAgent>([...identities].map(([key, { subject }]) => [key, { id: key, subject, sessionId: subject.agentSessionId }]))
  return { identities, agents, wanted: new Set(identities.keys()) }
}

type Agent = Extract<SessionSnapshot, { kind: 'agent' }>
export type GoalTeamActor = { key: string; session: Agent; identity: GoalTeamIdentity; roles: readonly GoalAgentRole[]; recommended: boolean }
export type GoalTeamGroup = { id: string; legacySessionId?: string; reference?: DemandSpaceMemberReference; roles: readonly GoalAgentRole[]; identities: readonly GoalTeamIdentity[]; actors: readonly GoalTeamActor[]; unconfirmedRoles: readonly GoalAgentRole[] }
type Team = { groups: readonly GoalTeamGroup[]; actors: readonly GoalTeamActor[] }
const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((item, i) => item === b[i])

/** Read only this Goal's original references through the shared inventory index.
 * A bare reference never selects the first Host or synthesizes an Actor. */
export function createGoalTeamSelector(goal: DemandRecord, references = goalTeamIdentities(goal)) {
  const roles = new Map<string, { reference: string | DemandSpaceMemberReference; roles: GoalAgentRole[] }>()
  for (const [role, ids] of [['supervisor', goal.supervisorSessionId ? [goal.supervisorSessionId] : []],
    ['assignees', goal.assigneeSessionIds ?? []], ['related', goal.sessionIds]] as const) {
    for (const reference of ids) { const key = demandAgentReferenceKey(reference), previous = roles.get(key); roles.set(key, { reference, roles: [...new Set([...previous?.roles ?? [], role])] }) }
  }
  let held: Team = { groups: [], actors: [] }
  let sessions: readonly SessionSnapshot[] | undefined
  return (state: { sessions: readonly SessionSnapshot[] }): Team => {
    if (sessions === state.sessions) return held
    sessions = state.sessions
    const index = agentSessionPresentationIndex(state.sessions)
    const groups = new Map<string, { id: string; legacySessionId?: string; reference?: DemandSpaceMemberReference; roles: GoalAgentRole[]; identities: GoalTeamIdentity[] }>()
    for (const identity of references.identities.values()) {
      const legacySessionId = identity.subject.agentSessionId, id = demandAgentReferenceKey(legacySessionId), group = groups.get(id) ?? { id, legacySessionId, roles: [], identities: [] }
      group.identities.push(identity); groups.set(id, group)
    }
    for (const [key, { reference, roles: assigned }] of roles) {
      if (typeof reference !== 'string') { groups.set(key, { id: key, reference, roles: assigned, identities: [] }); continue }
      const originalId = reference
      // A retained presentation alias may join an already qualified original
      // subject; the alias itself supplies no new Host or write authority.
      const presentation = goalAgentPresentation(index.get(originalId) ?? [], originalId)
      const canonical = presentation && references.identities.has(collaborationSubjectKey(presentation.control)) ? presentation.control.agentSessionId : originalId
      const groupKey = demandAgentReferenceKey(canonical), group = groups.get(groupKey) ?? { id: groupKey, legacySessionId: canonical, roles: [], identities: [] }
      group.roles = [...new Set([...group.roles, ...assigned])]; groups.set(groupKey, group)
    }
    const oldActors = new Map(held.actors.map(actor => [actor.key, actor])), oldGroups = new Map(held.groups.map(group => [group.id, group]))
    let recommendations = 0
    const rank = (group: { roles: readonly GoalAgentRole[] }) => group.roles.includes('supervisor') ? 0 : group.roles.includes('assignees') ? 1 : 2
    const nextGroups = [...groups.values()].sort((a, b) => rank(a) - rank(b)).map(group => {
      const unconfirmedRoles = group.roles.filter(role => role !== 'supervisor' || !group.identities.some(identity => identity.currentSupervisor))
      const actors = group.identities.flatMap(identity => {
        const { subject } = identity, candidates = (index.get(subject.agentSessionId) ?? []).filter(session => session.control.hostId === subject.hostId)
        const session = goalAgentPresentation(candidates, subject.agentSessionId)
        if (!session) return []
        const key = collaborationSubjectKey(subject), assigned: GoalAgentRole[] = identity.currentSupervisor && group.roles.includes('supervisor') ? ['supervisor'] : []
        const recommended = !goal.supervisorSessionId && recommendations < 3 &&
          Boolean(goalAgentPresentation(index.get(subject.agentSessionId) ?? [], subject.agentSessionId))
        if (recommended) recommendations++
        const old = oldActors.get(key)
        return [old?.session === session && old.identity === identity && old.recommended === recommended && same(old.roles, assigned)
          ? old : { key, session, identity, roles: assigned, recommended }]
      })
      const old = oldGroups.get(group.id)
      return old && same(old.unconfirmedRoles, unconfirmedRoles) && same(old.roles, group.roles) && same(old.identities, group.identities) && same(old.actors, actors)
        ? old : { ...group, actors, unconfirmedRoles }
    })
    if (!same(held.groups, nextGroups)) held = { groups: nextGroups, actors: nextGroups.flatMap(group => group.actors) }
    return held
  }
}
