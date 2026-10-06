import { GoalContinuationControl } from './GoalContinuationControl'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import type { DemandProjection } from '../lib/global-demand-board'
import { goalAgentRows, type GoalAgentRole } from '../lib/goal-agent-selection'
import { agentSessionPresentationIndex } from '../lib/session-presentation'
import { firstPromptFromTimeline } from '../lib/workbench-tabs'
import { AgentTopologySummary } from './AgentTopologySummary'
import { GoalAgentFace, GoalAgentPicker, type GoalRelationSave } from './GoalAgentPicker'
import { GoalDelegationWork } from './GoalDelegationWork'

const ThemeActionOpenExternalIcon = semanticIconComponent('action.open-external')
const ThemeObjectTeamIcon = semanticIconComponent('object.team')
const ThemeActionChooseAssigneeIcon = semanticIconComponent('action.choose-assignee')


/** The full Agent directory and topology mount only in their explicit editors. */
export function GoalExecution({ demand, onUpdate }: { demand: DemandProjection; onUpdate: GoalRelationSave }) {
  const [role, setRole] = useState<GoalAgentRole | null>(null), [arrangementOpen, setArrangementOpen] = useState(false)
  const [issue, setIssue] = useState<string | null>(null)
  const ids = useMemo(() => [...new Set([...demand.sessionIds, ...demand.assigneeSessionIds ?? [], ...demand.participations?.map(source => source.agentSessionId) ?? []])], [demand.sessionIds, demand.assigneeSessionIds, demand.participations])
  const facts = useAppStore(useShallow(state => {
    const index = agentSessionPresentationIndex(state.sessions)
    return [state.config, state.scratchTopicSnapshots, ...ids.flatMap(id => [id, state.agentNames[id], ...(index.get(id) ?? []).flatMap(session => [session.id, session.label, session.providerId, session.executorId, session.workspacePath, session.hostId, session.status.state, Boolean(session.pendingInteraction), state.agentNames[session.id], firstPromptFromTimeline(state.timelines[session.id])])])]
  }))
  const rows = useMemo(() => {
    const state = useAppStore.getState(), index = agentSessionPresentationIndex(state.sessions)
    return goalAgentRows({ ...state, sessions: [...new Set(ids.flatMap(id => index.get(id) ?? []))] }, demand, ids)
  }, [facts, demand, ids])
  const selectSession = useAppStore(state => state.selectSession)
  const assignees = rows.filter(row => (demand.assigneeSessionIds ?? []).includes(row.id))
  const related = rows.filter(row => demand.sessionIds.includes(row.id))
  const supervisor = rows.find(row => row.id === demand.supervisorSessionId)
  const recommended = rows.filter(row => row.selectable && row.id !== demand.supervisorSessionId && (row.related || demand.participations?.some(source => source.agentSessionId === row.id))).slice(0, 3)
  const creationDrafts = useAppStore(useShallow(state => Object.values(state.goalAgentCreationDrafts).filter(draft => draft.goalId === demand.id)))
  async function recommend(id: string) {
    setIssue(null)
    try { if (!await onUpdate({ assigneeSessionIds: [...new Set([...demand.assigneeSessionIds ?? [], id])], supervisorSessionId: id }, demand.updatedAt)) setIssue('Supervisor is not saved. The original selection and Agent remain available.') }
    catch (error) { setIssue(error instanceof Error ? error.message : String(error)) }
  }
  const members = (items: typeof rows, empty: string) => items.length ? items.map(row => <button key={row.id} type="button" className="goal-collaboration__member" disabled={!row.session} title={`${row.name} · ${row.status}\n${row.id}`} onClick={() => { if (row.session) selectSession(row.session.id) }}><GoalAgentFace row={row} /><span>{row.name}<small>{row.status}</small></span>{row.session ? <ThemeActionOpenExternalIcon size={11} /> : null}</button>) : <span className="goals-caption">{empty}</span>
  const hasOriginalWork = Boolean(demand.delegations?.length || demand.dispatches?.some(start => start.execution === 'finite'))
  return <section className="goal-collaboration" aria-label="Goal collaboration">
    <div className="goals-section-heading"><h2><ThemeObjectTeamIcon size={15} />Collaboration</h2><span className="goals-caption">Selection does not start execution</span></div>
    <GoalDelegationWork demand={demand} />
    <details className="goal-collaboration__relationships" open={!hasOriginalWork || !demand.supervisorSessionId}>
      <summary>People and related sessions <span className="goals-caption" title={supervisor?.name ?? demand.supervisorSessionId ?? 'Not selected'}>Supervisor · {supervisor?.name ?? demand.supervisorSessionId ?? 'Not selected'}</span></summary>
    <div className="goal-collaboration__line"><strong>Assignees</strong><div>{members(assignees, 'No assignees yet')}</div><button type="button" className="goals-button" onClick={() => setRole('assignees')} aria-label="Choose Goal assignees"><ThemeActionChooseAssigneeIcon size={12} />Choose</button></div>
    <div className="goal-collaboration__line"><strong>Related</strong><div>{members(related, 'No related sessions')}</div><button type="button" className="goals-button" onClick={() => setRole('related')} aria-label="Choose related Goal sessions">Edit</button></div>
    <div className="goal-collaboration__line"><strong>Supervisor</strong><div>{supervisor ? members([supervisor], '') : <span className="goals-caption">Not selected</span>}</div><button type="button" className="goals-button" onClick={() => setRole('supervisor')} aria-label="Choose Goal Supervisor">Choose</button></div>
    {!supervisor && recommended.length ? <div className="goal-collaboration__recommendations"><span className="goals-caption">Recommended</span>{recommended.map(row => <button key={row.id} type="button" className="goals-button" aria-label={`Assign ${row.name} as Supervisor`} title={row.id} onClick={() => void recommend(row.id)}><GoalAgentFace row={row} /><span>{row.name}</span><span className="goal-collaboration__assign">Assign</span></button>)}</div> : null}
    {!supervisor && demand.creationOrigin?.supervisorDefaultPending ? <p className="goals-condition">The original requester is not yet confirmed. You can choose a Supervisor explicitly.</p> : null}
    {creationDrafts.map(draft => <p key={draft.operationId} className="goals-service" role="status">Original Agent creation retained.<button type="button" className="goals-button" onClick={() => setRole(draft.role)}>Check creation and relationship</button></p>)}
    {issue ? <p className="goals-service" role="status">{issue}</p> : null}
    </details>
    <GoalContinuationControl demand={demand} onChooseSupervisor={() => setRole('supervisor')} />
    {demand.sessionIds.length ? <details className="goals-topology" onToggle={event => { if (event.target === event.currentTarget) setArrangementOpen(event.currentTarget.open) }}><summary>Arrangement</summary>{arrangementOpen ? <GoalArrangement sessionIds={related.map(row => row.session?.id ?? row.id)} /> : null}</details> : null}
    {role ? <GoalAgentPicker key={`${demand.id}:${role}`} demand={demand} role={role} onSave={onUpdate} onClose={() => setRole(null)} /> : null}
  </section>
}
function GoalArrangement({ sessionIds }: { sessionIds: string[] }) {
  const config = useAppStore(state => state.config), tabs = useAppStore(state => state.tabs), sessions = useAppStore(state => state.sessions)
  return <AgentTopologySummary sessionIds={sessionIds} sessions={sessions} tabs={tabs} config={config} />
}
