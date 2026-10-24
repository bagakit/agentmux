import '../styles/goal-finite-start.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import { mintObjectId } from '@agentmux/core/object-id'
import { clearGoalFiniteStartIntent, retainGoalFiniteStartIntent, useAppStore } from '../store'
import { api } from '../lib/api'
import type { DemandRecord } from '../lib/global-demand-board'
import type { GoalFiniteStartIntent } from '../lib/goal-finite-start'
import { goalAgentRows } from '../lib/goal-agent-selection'
import { agentSessionPresentationIndex } from '../lib/session-presentation'
import { firstPromptFromTimeline } from '@agentmux/client-ui/display-name'
import { GoalAgentFace, GoalAgentPicker } from './GoalAgentPicker'

/** An explicit one-time task. The existing Start owner retains all input and execution facts. */
export function GoalFiniteStartControl({ demand, primary = false }: { demand: DemandRecord; primary?: boolean }) {
  const ids = useMemo(() => [...new Set(demand.assigneeSessionIds ?? [])], [demand.assigneeSessionIds])
  const facts = useAppStore(useShallow(state => {
    const index = agentSessionPresentationIndex(state.sessions)
    return [state.config, state.scratchTopicSnapshots, ...ids.flatMap(id => [id, state.agentNames[id], ...(index.get(id) ?? []).flatMap(session => [session.id, session.label, session.providerId, session.executorId, session.workspacePath, session.hostId, session.status.state, Boolean(session.pendingInteraction), state.agentNames[session.id], firstPromptFromTimeline(state.timelines[session.id])])])]
  }))
  const intent = useAppStore(s => s.goalFiniteStartIntents[demand.id])
  const rows = useMemo(() => {
    const state = useAppStore.getState(), index = agentSessionPresentationIndex(state.sessions)
    return goalAgentRows({ ...state, sessions: [...new Set(ids.flatMap(id => index.get(id) ?? []))] }, demand, ids).filter(row => ids.includes(row.id))
  }, [facts, demand, ids])
  const [selected, setSelected] = useState<string | null>(null), [picker, setPicker] = useState(false)
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<string | null>(null)
  const flight = useRef(false), scope = useRef(demand.id); scope.current = demand.id
  const target = rows.find(row => row.id === (selected ?? (rows.length === 1 ? rows[0]!.id : null)))
  const pending = intent ?? demand.dispatches?.find(item => item.execution === 'finite' && item.stage !== 'confirmed')
  const hasOriginalTask = Boolean(demand.dispatches?.some(item => item.execution === 'finite' && item.stage === 'confirmed'))
  async function inspect(operationId: string) {
    const goalId = demand.id, reference = { goalId, operationId }
    let original = await api.demands.inspectDispatch(reference)
    if (original && original.stage !== 'confirmed') {
      const receipt = await api.demands.reconcileDispatch(reference)
      original = receipt.demand.dispatches?.find(item => item.operationId === operationId) ?? original
    }
    await useAppStore.getState().refreshDemand(goalId)
    if (original?.stage === 'confirmed') {
      await clearGoalFiniteStartIntent(goalId, operationId)
      if (scope.current === goalId) setMessage('Task delivered. Follow its original work record below.')
    } else if (scope.current === goalId) setMessage(original ? 'Delivery is unconfirmed. Inspect this request in the original Agent’s input queue.' : 'The original Start record is not yet observed. Its outcome remains unknown; keep checking the same request.')
  }
  async function run(action: () => Promise<void>) {
    if (flight.current) return
    flight.current = true; setBusy(true); const goalId = demand.id
    try { await action() }
    catch (error) { if (scope.current === goalId) setMessage(error instanceof Error ? error.message : String(error)) }
    finally { flight.current = false; if (scope.current === goalId) setBusy(false) }
  }
  useEffect(() => { setSelected(null); setMessage(null); setPicker(false) }, [demand.id])
  useEffect(() => { if (intent?.phase === 'may-have-dispatched') void run(() => inspect(intent.operationId)) }, [demand.id, intent?.operationId])
  async function start() {
    const saved: GoalFiniteStartIntent | undefined = intent ?? (target ? { goalId: demand.id, operationId: mintObjectId(), sessionId: target.id, expectedUpdatedAt: demand.updatedAt, phase: 'not-attempted' } : undefined)
    if (!saved) return
    if (saved.phase === 'may-have-dispatched') { await inspect(saved.operationId); return }
    let persistence = await retainGoalFiniteStartIntent(saved)
    if (!persistence.localStorageWritten) { setMessage('The task has not been submitted. Its selection is retained; restore workface saving before submitting.'); return }
    persistence = await retainGoalFiniteStartIntent({ ...saved, phase: 'may-have-dispatched' })
    if (!persistence.localStorageWritten) { await retainGoalFiniteStartIntent(saved); setMessage('The request has not been submitted: saving its operation is unconfirmed. Restore saving before submitting.'); return }
    try {
      await useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: saved.operationId,
        operation: 'demand.start', demandId: saved.goalId, sessionId: saved.sessionId, expectedUpdatedAt: saved.expectedUpdatedAt })
      await inspect(saved.operationId)
    } catch (error) {
      const failure = error as { controlFailure?: { disposition?: string } }
      if (failure.controlFailure?.disposition === 'not_applied') {
        await clearGoalFiniteStartIntent(saved.goalId, saved.operationId)
        await useAppStore.getState().refreshDemand(saved.goalId)
      }
      throw error
    }
  }
  const newTask = <>{rows.length > 1 && !target ? <p className="goals-caption">Choose who receives this task.</p> : null}<div className="goal-finite-start__recipients" role="radiogroup" aria-label="Agent for this task">{rows.map(row => <label className="goal-collaboration__member" key={row.id} data-selected={target?.id === row.id}><input type="radio" name={`goal-task-recipient-${demand.id}`} checked={target?.id === row.id} onChange={() => setSelected(row.id)} /><GoalAgentFace row={row} /><span>{row.name}<small>{row.context}</small></span></label>)}</div>
    <div className="goals-inline-actions"><button type="button" className={`goals-button${primary && !hasOriginalTask ? ' goals-button--primary' : ''}`} disabled={busy || rows.length > 0 && !target} onClick={() => { if (!rows.length) setPicker(true); else void run(start) }}>{busy ? 'Submitting…' : target ? `Start with ${target.name}` : rows.length ? 'Choose an Agent for this task' : 'Choose execution Agent'}</button>
      {rows.length ? <button type="button" className="goals-button" onClick={() => setPicker(true)}>Manage assignees</button> : null}</div></>
  return <section className="goal-finite-start" data-goal-finite-start={demand.id} aria-label="One-time Goal execution">
    <div className="goals-section-heading"><h2>{hasOriginalTask ? 'Task execution' : 'Execute task'}</h2><span className="goals-caption">One-time task</span></div>
    {pending ? <div className="goals-inline-actions"><span className="goals-caption">Original request retained</span><button className="goals-button" type="button" disabled={busy} onClick={() => void run(() => intent?.phase === 'not-attempted' ? start() : inspect(pending.operationId))}>{busy ? 'Checking…' : intent?.phase === 'not-attempted' ? 'Submit retained task' : 'Inspect original Start'}</button></div>
      : hasOriginalTask ? <><a className="goals-button" href={`#goal-work-${demand.id}`}>View original work</a><details className="goal-finite-start__another"><summary>Start another one-time task</summary>{newTask}</details></> : newTask}
    {message ? <p className="goals-service" role="status">{message}</p> : null}
    {picker ? <GoalAgentPicker demand={demand} role="assignees" onSave={async (patch, expectedUpdatedAt) => { await useAppStore.getState().updateDemand(demand.id, patch, undefined, expectedUpdatedAt); return true }} onClose={() => setPicker(false)} /> : null}
  </section>
}
