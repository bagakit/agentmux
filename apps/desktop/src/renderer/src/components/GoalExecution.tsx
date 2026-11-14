import { GoalContinuationControl } from './GoalContinuationControl'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { memo, useCallback, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import type { DemandProjection } from '../lib/global-demand-board'
import type { GoalAgentRole } from '../lib/goal-agent-selection'
import { agentSessionPresentationIndex, createFirstPromptSelector } from '../lib/session-presentation'
import { createGoalTeamSelector, goalTeamIdentities, type GoalTeamActor } from '../lib/goal-team'
import { goalAgentPresentation } from '../lib/goal-agent-selection'
import { useCollaborationIdentities } from '../lib/use-collaboration-identities'
import { agentContextForSession } from '../lib/focus-context'
import { agentDisplayName, topicIdForSession, workspaceForSession } from '../lib/workbench-tabs'
import { scratchTopicsForConfig } from '../lib/scratch-topic-snapshots'
import { AgentTopologySummary } from './AgentTopologySummary'
import { GoalAgentPicker, type GoalRelationSave } from './GoalAgentPicker'
import { FocusContextCardBody } from './FocusContextCardBody'
import '../styles/goal-team.css'

const ThemeActionChooseAssigneeIcon = semanticIconComponent('action.choose-assignee')
const roleNames = { supervisor: 'Supervisor', assignees: 'Executor', related: 'Related' }


/** The full Agent directory and topology mount only in their explicit editors. */
export function GoalExecution({ demand, onUpdate }: { demand: DemandProjection; onUpdate: GoalRelationSave }) {
  const [role, setRole] = useState<GoalAgentRole | null>(null), [arrangementOpen, setArrangementOpen] = useState(false)
  const [issue, setIssue] = useState<string | null>(null)
  const membership = JSON.stringify([demand.supervisorSessionId, demand.assigneeSessionIds, demand.sessionIds, demand.participations])
  const select = useMemo(() => createGoalTeamSelector(demand), [membership])
  const team = useAppStore(select)
  const creationDrafts = useAppStore(useShallow(state => Object.values(state.goalAgentCreationDrafts).filter(draft => draft.goalId === demand.id)))
  async function recommend(id: string) {
    setIssue(null)
    try { if (!await onUpdate({ assigneeSessionIds: [...new Set([...demand.assigneeSessionIds ?? [], id])], supervisorSessionId: id }, demand.updatedAt)) setIssue('Supervisor is not saved. The original selection and Agent remain available.') }
    catch (error) { setIssue(error instanceof Error ? error.message : String(error)) }
  }
  return <section className="goal-collaboration goal-team" aria-label="Goal collaboration">
    <header className="goal-team__heading"><h2>Team</h2><div className="goal-team__editors">
      <button type="button" className="small-button" onClick={() => setRole('supervisor')} aria-label="Choose Goal Supervisor">Supervisor</button>
      <button type="button" className="small-button" onClick={() => setRole('assignees')} aria-label="Choose Goal assignees"><ThemeActionChooseAssigneeIcon size={12} />Executors</button>
      <button type="button" className="small-button" onClick={() => setRole('related')} aria-label="Choose related Goal sessions">Related</button>
    </div></header>
    <div className="goal-team__actors">{team.actors.map(actor => <GoalTeamActorCard key={actor.key} actor={actor} onRecommend={recommend} />)}</div>
    {!team.actors.length && !team.references.length ? <p className="goals-caption">No Agents assigned yet. Choose a Supervisor or add execution Agents.</p> : null}
    {team.references.map(reference => <div key={reference.id} className="goals-service goal-team__reference" role="status" data-goal-team-unconfirmed={reference.id}>
      <strong>Unconfirmed reference · {reference.roles.map(role => roleNames[role]).join(' · ')}</strong><code>{reference.id}</code><span>{reference.reason}</span>
      <button type="button" className="small-button" onClick={() => setRole(reference.roles[0]!)}>Review relationship</button>
    </div>)}
    <GoalTeamIdentityReadings demand={demand} />
    {!demand.supervisorSessionId && demand.creationOrigin?.supervisorDefaultPending ? <p className="goals-condition">The original requester is not yet confirmed. You can choose a Supervisor explicitly.</p> : null}
    {creationDrafts.map(draft => <p key={draft.operationId} className="goals-service" role="status">Original Agent creation retained.<button type="button" className="small-button" onClick={() => setRole(draft.role)}>Check creation and relationship</button></p>)}
    {issue ? <p className="goals-service" role="status">{issue}</p> : null}
    <GoalContinuationControl demand={demand} onChooseSupervisor={() => setRole('supervisor')} />
    {demand.sessionIds.length ? <details className="goals-topology" onToggle={event => { if (event.target === event.currentTarget) setArrangementOpen(event.currentTarget.open) }}><summary>Arrangement</summary>{arrangementOpen ? <GoalArrangement sessionIds={team.actors.filter(actor => actor.roles.includes('related')).map(actor => actor.session.id)} /> : null}</details> : null}
    {role ? <GoalAgentPicker key={`${demand.id}:${role}`} demand={demand} role={role} onSave={onUpdate} onClose={() => setRole(null)} /> : null}
  </section>
}
/** A disposable view of this Goal's exact sources; never another Session registry. */
function GoalTeamIdentityReadings({ demand }: { demand: DemandProjection }) {
  const refs = useMemo(() => goalTeamIdentities(demand), [demand.id, demand.participations, demand.dispatches, demand.delegations,
    demand.progressUpdates, demand.plan, demand.creationOrigin, demand.supervisorSessionId])
  const knownIds = useAppStore(useShallow(state => {
    const index = agentSessionPresentationIndex(state.sessions)
    return [...refs.identities].flatMap(([key, { subject }]) => goalAgentPresentation((index.get(subject.agentSessionId) ?? [])
      .filter(session => session.control.hostId === subject.hostId), subject.agentSessionId) ? [key] : [])
  }))
  const known = useMemo(() => new Map(knownIds.map(id => [id, refs.agents.get(id)!])), [knownIds, refs])
  const hosts = useAppStore(state => state.config?.hosts)
  const owner = useMemo(() => ({ goalId: demand.id, hosts }), [demand.id, hosts])
  const { reads, retry } = useCollaborationIdentities(refs.agents, refs.wanted, known, true, owner)
  return <>{[...refs.identities].filter(([key]) => !known.has(key)).map(([key, { subject, roles }]) => {
    const read = reads.get(key), source = read?.source
    return <div key={key} className="goals-service goal-team__reference" data-goal-team-identity={key}>
      <strong>{source ? source.state === 'deleted' ? 'Original record deleted' : source.state === 'retired' ? 'Retired original Session' : 'Retained original Session' : read?.loading ? 'Reading original identity' : 'Original identity not yet confirmed'}</strong>
      <code>{subject.agentSessionId} · {subject.hostId}</code><span>{roles.join(' · ')}</span>
      {source?.history ? <span>{source.history.executorId} · {source.history.providerId} · {source.history.workspacePath}</span> : null}
      {source && source.state !== 'deleted' ? <span>Current Run is not observed here. The original relationship is retained.</span> : null}
      {read?.issue ? <span role="status">{read.issue}</span> : null}
      {read?.issue ? <button type="button" className="small-button" onClick={() => retry(key)}>Read original identity again</button> : null}
    </div>
  })}</>
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
    <div className="goal-team__roles">{actor.roles.map(role => <span key={role} data-goal-team-role={role}>{roleNames[role]}</span>)}{!actor.roles.length ? <span>Participated in this Goal</span> : null}</div>
    <FocusContextCardBody context={context} selected={false} onSelect={open} />
    <p className="goal-team__context">{context.workspaceName} · {session.control.hostId}</p>
    {actor.recommended ? <button type="button" className="small-button goal-team__recommend" aria-label={`Assign ${context.name} as Supervisor`} onClick={() => void onRecommend(session.control.agentSessionId)}>Assign as Supervisor</button> : null}
  </div>
})
function GoalArrangement({ sessionIds }: { sessionIds: string[] }) {
  const config = useAppStore(state => state.config), tabs = useAppStore(state => state.tabs), sessions = useAppStore(state => state.sessions)
  return <AgentTopologySummary sessionIds={sessionIds} sessions={sessions} tabs={tabs} config={config} />
}
