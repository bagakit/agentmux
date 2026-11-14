import { GoalContinuationControl } from './GoalContinuationControl'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { memo, useCallback, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import type { DemandProjection } from '../lib/global-demand-board'
import type { GoalAgentRole } from '../lib/goal-agent-selection'
import { createFirstPromptSelector } from '../lib/session-presentation'
import { createGoalTeamSelector, goalTeamIdentities, type GoalTeamActor } from '../lib/goal-team'
import { useCollaborationIdentities } from '../lib/use-collaboration-identities'
import { agentContextForSession } from '../lib/focus-context'
import { agentDisplayName, topicIdForSession, workspaceForSession } from '../lib/workbench-tabs'
import { scratchTopicsForConfig } from '../lib/scratch-topic-snapshots'
import { AgentTopologySummary } from './AgentTopologySummary'
import { GoalAgentPicker, type GoalRelationSave } from './GoalAgentPicker'
import { FocusContextCardBody } from './FocusContextCardBody'
import { GoalTeamReference, goalTeamSourceLabels } from './GoalTeamReference'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import '../styles/goal-team.css'

const ThemeActionChooseAssigneeIcon = semanticIconComponent('action.choose-assignee')
const ThemeObjectAgentIcon = semanticIconComponent('object.agent')
const roleNames = { supervisor: 'Supervisor', assignees: 'Executor', related: 'Related' }


/** The full Agent directory and topology mount only in their explicit editors. */
export function GoalExecution({ demand, onUpdate }: { demand: DemandProjection; onUpdate: GoalRelationSave }) {
  const active = useWorkbenchPresentationActive()
  const [role, setRole] = useState<GoalAgentRole | null>(null), [arrangementOpen, setArrangementOpen] = useState(false)
  const [issue, setIssue] = useState<string | null>(null)
  const refs = useMemo(() => goalTeamIdentities(demand), [demand.id, demand.participations, demand.dispatches, demand.delegations,
    demand.progressUpdates, demand.plan, demand.creationOrigin, demand.supervisorSessionId])
  const membership = JSON.stringify([demand.supervisorSessionId, demand.assigneeSessionIds, demand.sessionIds, demand.participations])
  const select = useMemo(() => createGoalTeamSelector(demand, refs), [membership, refs])
  const team = useAppStore(select)
  const known = useMemo(() => new Map(team.actors.map(actor => [actor.key, refs.agents.get(actor.key)!])), [team.actors, refs])
  const hosts = useAppStore(state => state.config?.hosts)
  const owner = useMemo(() => ({ goalId: demand.id, hosts }), [demand.id, hosts])
  const { reads, retry } = useCollaborationIdentities(refs.agents, refs.wanted, known, active, owner)
  const creationDrafts = useAppStore(useShallow(state => Object.values(state.goalAgentCreationDrafts).filter(draft => draft.goalId === demand.id)))
  async function recommend(id: string) {
    setIssue(null)
    try { if (!await onUpdate({ assigneeSessionIds: [...new Set([...demand.assigneeSessionIds ?? [], id])], supervisorSessionId: id }, demand.updatedAt)) setIssue('Supervisor is not saved. The original selection and Agent remain available.') }
    catch (error) { setIssue(error instanceof Error ? error.message : String(error)) }
  }
  return <section className="goal-collaboration goal-team" aria-label="Goal collaboration">
    <header className="goal-team__heading"><h2>Team</h2><details className="goal-team__edit"><summary>Edit relationships</summary><div className="goal-team__editors">
      <button type="button" className="small-button" onClick={() => setRole('supervisor')} aria-label="Choose Goal Supervisor">Supervisor</button>
      <button type="button" className="small-button" onClick={() => setRole('assignees')} aria-label="Choose Goal assignees"><ThemeActionChooseAssigneeIcon size={12} />Executors</button>
      <button type="button" className="small-button" onClick={() => setRole('related')} aria-label="Choose related Goal sessions">Related</button>
    </div></details></header>
    <div className="goal-team__actors">{team.groups.map(group => <div className="goal-team__group" key={group.id} data-goal-team-reference={group.id}>
      {group.actors.map(actor => <GoalTeamActorCard key={actor.key} actor={actor} onRecommend={recommend} />)}
      {group.identities.filter(identity => !group.actors.some(actor => actor.key === JSON.stringify([identity.subject.hostId, identity.subject.agentSessionId]))).map(identity => {
        const key = JSON.stringify([identity.subject.hostId, identity.subject.agentSessionId])
        return <GoalTeamReference key={key} identity={identity} read={reads.get(key)} roles={identity.currentSupervisor ? ['supervisor'] : []} onRetry={() => retry(key)} />
      })}
      {!group.identities.length ? <div className="goal-team__unresolved" data-goal-team-unconfirmed={group.id}>
        <span aria-hidden="true"><ThemeObjectAgentIcon size={18} /></span><div><strong>Agent reference</strong><span>The original Host is not confirmed.</span>
          <details className="goal-team__identity-details"><summary>Reference details</summary><code>{group.id}</code></details></div>
      </div> : null}
      {group.unconfirmedRoles.length ? <div className="goal-team__unqualified-roles">
        <span>{group.unconfirmedRoles.map(role => <span key={role} data-goal-team-role={role} data-role-host="unconfirmed">{roleNames[role]} </span>)} · Host not confirmed</span>
        <button type="button" className="small-button" onClick={() => setRole(group.unconfirmedRoles[0]!)}>Review relationship</button>
      </div> : null}
    </div>)}</div>
    {!team.groups.length ? <p className="goals-caption">No Agents assigned yet. Use Edit relationships to choose them.</p> : null}
    {!demand.supervisorSessionId && demand.creationOrigin?.supervisorDefaultPending ? <p className="goals-condition">The original requester is not yet confirmed. You can choose a Supervisor explicitly.</p> : null}
    {creationDrafts.map(draft => <p key={draft.operationId} className="goals-service" role="status">Original Agent creation retained.<button type="button" className="small-button" onClick={() => setRole(draft.role)}>Check creation and relationship</button></p>)}
    {issue ? <p className="goals-service" role="status">{issue}</p> : null}
    <GoalContinuationControl demand={demand} active={active} onChooseSupervisor={() => setRole('supervisor')} />
    {demand.sessionIds.length ? <details className="goals-topology" onToggle={event => { if (event.target === event.currentTarget) setArrangementOpen(event.currentTarget.open) }}><summary>Arrangement</summary>{arrangementOpen ? <GoalArrangement sessionIds={team.groups.filter(group => group.roles.includes('related')).flatMap(group => group.actors.map(actor => actor.session.id))} /> : null}</details> : null}
    {role ? <GoalAgentPicker key={`${demand.id}:${role}`} demand={demand} role={role} onSave={onUpdate} onClose={() => setRole(null)} /> : null}
  </section>
}
const GoalTeamActorCard = memo(function GoalTeamActorCard({ actor, onRecommend }: { actor: GoalTeamActor; onRecommend(id: string): Promise<void> }) {
  const { session } = actor
  const name = useAppStore(state => state.agentNames[session.id])
  const firstPrompt = useAppStore(useMemo(() => createFirstPromptSelector(session.id), [session.id]))
  const scope = useAppStore(useShallow(state => ({ config: state.config, topics: state.scratchTopicSnapshots })))
  const selectSession = useAppStore(state => state.selectSession)
  const context = useMemo(() => {
    const topics = scratchTopicsForConfig(scope.config, scope.topics), workspace = workspaceForSession(scope.config, session, topics)
    return { ...agentContextForSession(session, undefined, name, workspace, topicIdForSession(scope.config, session, topics)),
      name: agentDisplayName({ userName: name, firstPrompt, fallbackLabel: session.label, providerLabel: session.providerId }), recap: undefined }
  }, [session, name, firstPrompt, scope])
  const open = useCallback(() => { selectSession(session.id) }, [selectSession, session.id])
  return <div className="goal-team__actor" data-goal-team-actor={actor.key}>
    <div className="goal-team__roles">{actor.roles.length ? actor.roles.map(role => <span key={role} data-goal-team-role={role}>{roleNames[role]}</span>) : goalTeamSourceLabels(actor.identity).map(label => <span key={label}>{label}</span>)}</div>
    <FocusContextCardBody context={context} selected={false} onSelect={open} />
    <p className="goal-team__context">{context.workspaceName} · {session.control.hostId}</p>
    {actor.recommended ? <button type="button" className="small-button goal-team__recommend" aria-label={`Assign ${context.name} as Supervisor`} onClick={() => void onRecommend(session.control.agentSessionId)}>Assign as Supervisor</button> : null}
  </div>
})
function GoalArrangement({ sessionIds }: { sessionIds: string[] }) {
  const config = useAppStore(state => state.config), tabs = useAppStore(state => state.tabs), sessions = useAppStore(state => state.sessions)
  return <AgentTopologySummary sessionIds={sessionIds} sessions={sessions} tabs={tabs} config={config} />
}
