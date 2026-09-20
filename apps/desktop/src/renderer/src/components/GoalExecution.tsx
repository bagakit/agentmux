import { ArrowUpRight } from 'lucide-react'
import { useState } from 'react'
import { useAppStore } from '../store'
import type { DemandProjection } from '../lib/global-demand-board'
import { AgentTopologySummary } from './AgentTopologySummary'
import { StatusDot } from './StatusDot'

/** The all-Session picker and topology are explicit, expanded consumers only. */
export function GoalExecution({ demand, onUpdate }: { demand: DemandProjection; onUpdate: (patch: Parameters<ReturnType<typeof useAppStore.getState>['updateDemand']>[1]) => void }) {
  const sessions = useAppStore((state) => state.sessions)
  const selectSession = useAppStore((state) => state.selectSession)
  const [sessionToAdd, setSessionToAdd] = useState('')
  const [arrangementOpen, setArrangementOpen] = useState(false)
  const linked = sessions.filter((session) => demand.sessionIds.includes(session.id))
  return <>
    {demand.sessionIds.length && !linked.length ? <p className="goals-service">Linked Sessions are not yet available. Their identities are retained while recovery continues.</p> : null}
    {linked.map((session) => <div className="goals-execution__row" key={session.id}><StatusDot status={session.status} /><span className="goals-execution__name">{session.label}</span><button type="button" className="goals-button" onClick={() => selectSession(session.id)}><ArrowUpRight size={13} />Open in Space</button><button type="button" className="goals-button" aria-label={`Unlink ${session.label}`} onClick={() => onUpdate({ sessionIds: demand.sessionIds.filter((id) => id !== session.id) })}>Unlink</button></div>)}
    <div className="goals-execution__link"><select aria-label="Add Session to goal" value={sessionToAdd} onChange={(event) => setSessionToAdd(event.target.value)}><option value="">Link an existing Session…</option>{sessions.filter((session) => !demand.sessionIds.includes(session.id)).map((session) => <option key={session.id} value={session.id}>{session.label}</option>)}</select><button type="button" className="goals-button" disabled={!sessionToAdd} onClick={() => { onUpdate({ sessionIds: [...demand.sessionIds, sessionToAdd] }); setSessionToAdd('') }}>Link</button></div>
    {demand.sessionIds.length ? <details className="goals-topology" onToggle={(event) => { if (event.target === event.currentTarget) setArrangementOpen(event.currentTarget.open) }}><summary>Arrangement</summary>{arrangementOpen ? <GoalArrangement demand={demand} sessions={sessions} /> : null}</details> : null}
  </>
}
function GoalArrangement({ demand, sessions }: { demand: DemandProjection; sessions: ReturnType<typeof useAppStore.getState>['sessions'] }) {
  const config = useAppStore((state) => state.config)
  const tabs = useAppStore((state) => state.tabs)
  return <AgentTopologySummary sessionIds={demand.sessionIds} sessions={sessions} tabs={tabs} config={config} />
}
