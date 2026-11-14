import { demandAgentReferenceKey, mergeDemandAgentReferences } from '@agentmux/demand/relations'
import type { DemandDispatch } from '@agentmux/demand'
import type { GoalInspectionAccess } from '@agentmux/core/goal-agent-reference'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { mintObjectId } from '@agentmux/core/object-id'
import { clearGoalFiniteStartIntent, retainGoalFiniteStartIntent, useAppStore } from '../store'
import { api } from '../lib/api'
import type { DemandRecord } from '../lib/global-demand-board'
import { goalFiniteStartAccess, goalFiniteStartInspection, goalFiniteStartSubmission, readGoalFiniteStartIntent, type GoalFiniteStartIntent } from '../lib/goal-finite-start'
import { goalAgentRows, goalAgentRowReference } from '../lib/goal-agent-selection'
import { agentSessionPresentationIndex } from '../lib/session-presentation'
import { firstPromptFromTimeline } from '@agentmux/client-ui/display-name'
import { GoalAgentFace, GoalAgentPicker } from './GoalAgentPicker'
import { GoalRelationAccessFields } from './GoalRelationAccessFields'

/** An explicit one-time task. The existing Start owner retains all input and execution facts. */
type GoalFiniteStartProps = { demand: DemandRecord; primary?: boolean; embedded?: boolean; conclusion?: string | undefined; active?: boolean }
export function GoalFiniteStartControl(props: GoalFiniteStartProps) {
  return <GoalFiniteStartWorkface key={props.demand.id} {...props} />
}
function GoalFiniteStartWorkface({ demand, primary = false, embedded = false, conclusion, active = true }: GoalFiniteStartProps) {
  const ids = useMemo(() => mergeDemandAgentReferences(demand.assigneeSessionIds ?? []), [demand.assigneeSessionIds])
  const hasLegacy = ids.some(id => typeof id === 'string')
  const facts = useAppStore(useShallow(state => {
    const index = hasLegacy ? agentSessionPresentationIndex(state.sessions) : undefined
    return [state.config, state.scratchTopicSnapshots, ...ids.flatMap(id => typeof id !== 'string' ? [demandAgentReferenceKey(id)] : [id, state.agentNames[id], ...(index?.get(id) ?? []).flatMap(session => [session.id, session.label, session.providerId, session.executorId, session.workspacePath, session.hostId, session.status.state, Boolean(session.pendingInteraction), state.agentNames[session.id], firstPromptFromTimeline(state.timelines[session.id])])])]
  }))
  const rawIntent = useAppStore(s => s.goalFiniteStartIntents[demand.id])
  const intent = useMemo(() => readGoalFiniteStartIntent(rawIntent, demand.id), [rawIntent, demand.id])
  const rows = useMemo(() => {
    const state = useAppStore.getState(), index = hasLegacy ? agentSessionPresentationIndex(state.sessions) : undefined
    return goalAgentRows({ ...state, sessions: [...new Set(ids.flatMap(id => typeof id === 'string' ? index?.get(id) ?? [] : []))] }, demand, ids).filter(row => ids.some(ref => demandAgentReferenceKey(ref) === demandAgentReferenceKey(goalAgentRowReference(row))))
  }, [facts, demand, ids, hasLegacy])
  const [selected, setSelected] = useState<string | null>(null), [picker, setPicker] = useState(false)
  const [busyScope, setBusyScope] = useState<string | null>(null), [message, setMessage] = useState<string | null>(null)
  const flight = useRef<{ scope: string; token: symbol } | null>(null)
  const target = rows.find(row => row.id === (selected ?? (rows.length === 1 ? rows[0]!.id : null)))
  const pending = intent ?? demand.dispatches?.find(item => item.execution === 'finite' && item.stage !== 'confirmed')
  const originalDispatch = intent && demand.dispatches?.find(item => item.operationId === intent.operationId)
  const attempted = intent?.phase === 'may-have-dispatched' || Boolean(originalDispatch)
  const originalMember = intent ? intent.agentReference : pending && 'target' in pending ? pending.target : undefined
  const chosen = target && goalAgentRowReference(target)
  const member = originalMember ?? (!pending && typeof chosen !== 'string' ? chosen : undefined)
  const access = intent?.agentReference ? goalFiniteStartAccess(intent) : undefined
  const inputScope = JSON.stringify([demand.id, intent?.operationId, intent?.agentReference ? demandAgentReferenceKey(intent.agentReference) : intent?.sessionId, access])
  const scope = useRef(inputScope); scope.current = inputScope
  const busy = busyScope === inputScope
  const hasOriginalTask = Boolean(demand.dispatches?.some(item => item.execution === 'finite' && item.stage === 'confirmed'))
  async function inspect(operationId: string, originalIntent = intent, expected: unknown = rawIntent) {
    const goalId = demand.id, reference = { goalId, operationId }
    let original: DemandDispatch | null | undefined
    if (originalIntent?.agentReference && originalIntent.operationId === operationId) {
      const result = await useAppStore.getState().executeControl(goalFiniteStartInspection(goalId, operationId, goalFiniteStartAccess(originalIntent)))
      if (result.operation !== 'demand.show') throw Error('The original Goal Start observation belongs to another operation. Its input is retained.')
      if (result.demand?.id !== goalId) throw Error('This observation does not identify the original Goal. Its private input and Agent are retained.')
      original = result.demand?.dispatches?.find(item => item.operationId === operationId)
    } else if (demand.dispatches?.some(item => item.operationId === operationId && 'target' in item)) {
      setMessage('Choose current project or independent Coordinator access to check this original Start. Its input has not been resent.'); return
    } else {
      original = await api.demands.inspectDispatch(reference)
      if (original && original.stage !== 'confirmed') {
        const receipt = await api.demands.reconcileDispatch(reference)
        original = receipt.demand.dispatches?.find(item => item.operationId === operationId) ?? original
      }
    }
    await useAppStore.getState().refreshDemand(goalId)
    if (originalIntent?.agentReference && original && (!('target' in original) || demandAgentReferenceKey(original.target) !== demandAgentReferenceKey(originalIntent.agentReference)))
      throw Error('This original Goal record names another Source member. The private input and Agent are retained.')
    if (original?.stage === 'confirmed') {
      await clearGoalFiniteStartIntent(goalId, operationId, expected)
      if (scope.current === inputScope) setMessage('Task delivered. Follow its original work record below.')
    } else if (scope.current === inputScope) setMessage(original ? 'Delivery is unconfirmed. Inspect this request in the original Agent’s input queue.' : 'The original Start record is not yet observed. Its outcome remains unknown; keep checking the same request.')
  }
  async function run(action: () => Promise<void>) {
    if (flight.current?.scope === inputScope) return
    const token = Symbol(); flight.current = { scope: inputScope, token }; setBusyScope(inputScope)
    try { await action() }
    catch (error) { if (scope.current === inputScope) setMessage(error instanceof Error ? error.message : String(error)) }
    finally { if (flight.current?.token === token) { flight.current = null; setBusyScope(null) } }
  }
  useEffect(() => { setSelected(null); setMessage(null); setPicker(false) }, [demand.id])
  useEffect(() => { if (active && intent?.phase === 'may-have-dispatched') void run(() => inspect(intent.operationId)) }, [active, demand.id, intent?.operationId])
  async function start() {
    if (rawIntent !== undefined && !intent) { setMessage('Original Start input is retained but cannot be read. It has not been replaced or submitted again.'); return }
    if (!intent && target?.reference && typeof target.reference !== 'string') { setMessage('This Source-qualified Start needs its original current execution access. The selected relation and existing Agent are retained.'); return }
    const reference = target && goalAgentRowReference(target)
    const saved: GoalFiniteStartIntent | undefined = intent ?? (typeof reference === 'string' ? { goalId: demand.id, operationId: mintObjectId(), sessionId: reference, expectedUpdatedAt: demand.updatedAt, phase: 'not-attempted' } : undefined)
    if (!saved) return
    if (attempted) { await inspect(saved.operationId); return }
    if (saved.agentReference && saved.expectedUpdatedAt !== demand.updatedAt) { setMessage('The Goal changed after this task selection. Review it and choose the current Goal version before submitting.'); return }
    if (saved.agentReference && !goalFiniteStartAccess(saved).source) { setMessage('Choose current project access before submitting this task. Your selection is retained.'); return }
    if (saved.agentReference && saved.agentReference.source.admission.kind === 'association' && !goalFiniteStartAccess(saved).coordinator) { setMessage('Choose independent current Coordinator access for this original association. Project membership does not grant input access.'); return }
    let persistence = await retainGoalFiniteStartIntent(saved, rawIntent)
    if (!persistence.clientStateWritten) { setMessage('The task has not been submitted. Its selection is retained; restore workface saving before submitting.'); return }
    const dispatching = { ...saved, phase: 'may-have-dispatched' as const }
    persistence = await retainGoalFiniteStartIntent(dispatching, saved)
    if (!persistence.clientStateWritten) { await retainGoalFiniteStartIntent(saved, dispatching); setMessage('The request has not been submitted: saving its operation is unconfirmed. Restore saving before submitting.'); return }
    try {
      await useAppStore.getState().executeControl(goalFiniteStartSubmission(saved))
      await inspect(saved.operationId, dispatching, dispatching)
    } catch (error) {
      const failure = error as { controlFailure?: { disposition?: string } }
      if (failure.controlFailure?.disposition === 'not_applied') {
        if (saved.agentReference) {
          const state = useAppStore.getState(), latestRaw = state.goalFiniteStartIntents[saved.goalId]
          const latest = readGoalFiniteStartIntent(latestRaw, saved.goalId)
          if (latest?.agentReference && latest.operationId === saved.operationId &&
              demandAgentReferenceKey(latest.agentReference) === demandAgentReferenceKey(saved.agentReference) &&
              JSON.stringify(latest.access) === JSON.stringify(saved.access) && latest.expectedUpdatedAt === saved.expectedUpdatedAt &&
              !state.demands[saved.goalId]?.dispatches?.some(item => item.operationId === saved.operationId))
            await retainGoalFiniteStartIntent({ ...latest, phase: 'not-attempted' }, latestRaw)
        }
        else await clearGoalFiniteStartIntent(saved.goalId, saved.operationId, dispatching)
        await useAppStore.getState().refreshDemand(saved.goalId)
      }
      throw error
    }
  }
  async function selectAccess(value: GoalInspectionAccess) {
    if (!member || rawIntent !== undefined && !intent) return
    const next: GoalFiniteStartIntent = intent?.agentReference ? { ...intent, accessDraft: value }
      : { goalId: demand.id, operationId: pending?.operationId ?? mintObjectId(), agentReference: member, access: value,
        expectedUpdatedAt: demand.updatedAt, phase: pending ? 'may-have-dispatched' : 'not-attempted' }
    try {
      const saved = await retainGoalFiniteStartIntent(next, rawIntent)
      setMessage(saved.clientStateWritten ? null : 'This access selection is retained in this view; saving it is unconfirmed. The original operation and Agent are retained.')
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
  }
  async function resumeOriginal() {
    if (!intent?.agentReference || !attempted) return
    if (useAppStore.getState().goalFiniteStartIntents[demand.id] !== rawIntent) { setMessage('The original Start input changed. Your newer private input is retained; review it before continuing.'); return }
    if (!goalFiniteStartAccess(intent).source) { setMessage('Choose current project access before continuing this original Start. Independent Coordinator access remains available for Check.'); return }
    if (intent.agentReference.source.admission.kind === 'association' && !goalFiniteStartAccess(intent).coordinator) { setMessage('Choose independent current Coordinator access for this original association. Project membership does not grant input access.'); return }
    await useAppStore.getState().executeControl(goalFiniteStartSubmission(intent, undefined, true))
    await inspect(intent.operationId)
  }
  async function updateVersion() {
    if (!intent?.agentReference || attempted) return
    const saved = await retainGoalFiniteStartIntent({ ...intent, expectedUpdatedAt: demand.updatedAt }, rawIntent)
    setMessage(saved.clientStateWritten ? null : 'The current version is selected in this view; saving it is unconfirmed. This task has not been submitted.')
  }
  async function discardUnsent() {
    if (!intent || attempted) return
    const result = await clearGoalFiniteStartIntent(demand.id, intent.operationId, rawIntent)
    setMessage(!result.cleared ? 'Your newer private input is retained.' : result.save.clientStateWritten ? null : 'The unsent selection was removed from this view; saving its removal is unconfirmed. Its original durable input may return after restart.')
  }
  const connections = member && !(rawIntent !== undefined && !intent) ? <GoalRelationAccessFields purpose="input" reference={member} hosts={useAppStore.getState().config?.hosts ?? []}
    access={access} original={Boolean(pending && (!intent || attempted))} disabled={false} onChange={value => void selectAccess(value)} /> : null
  const newTask = <>{rows.length > 1 && !target ? <p className="goals-caption">Choose who receives this task.</p> : null}<div className="goal-finite-start__recipients" role="radiogroup" aria-label="Agent for this task">{rows.map(row => <label className="goal-collaboration__member" key={row.id} data-selected={target?.id === row.id}><input type="radio" name={`goal-task-recipient-${demand.id}`} checked={target?.id === row.id} onChange={() => setSelected(row.id)} /><GoalAgentFace row={row} /><span>{row.name}<small>{row.context}</small></span></label>)}</div>{connections}
    <div className="goals-inline-actions"><button type="button" className={primary && !hasOriginalTask ? 'primary-button' : 'small-button'} disabled={busy || rows.length > 0 && !target} onClick={() => { if (!rows.length) setPicker(true); else void run(start) }}>{busy ? 'Submitting…' : target ? `Start with ${target.name}` : rows.length ? 'Choose an Agent for this task' : 'Choose execution Agent'}</button>
      {rows.length ? <button type="button" className="small-button" onClick={() => setPicker(true)}>Manage assignees</button> : null}</div></>
  return <section className="goal-finite-start" data-goal-finite-start={demand.id} aria-label="One-time Goal execution">
    {!embedded ? <div className="goals-section-heading"><h2>{hasOriginalTask ? 'Task execution' : 'Execute task'}</h2><span className="goals-caption">One-time task</span></div> : null}
    {pending ? connections : null}
    {intent?.agentReference && !attempted && intent.expectedUpdatedAt !== demand.updatedAt ? <p className="goals-service" role="status">The Goal changed after this task selection. Review its current content.<button className="small-button" type="button" disabled={busy} onClick={() => void run(updateVersion)}>Use current Goal version for this task</button></p> : null}
    {rawIntent !== undefined && !intent ? <p className="goals-service" role="status">Original Start input is retained but cannot be read. It has not been replaced or submitted again. The Agent and its original work record are retained.</p> : pending ? <div className="goals-inline-actions"><span className="goals-caption" data-goal-current-conclusion={conclusion ? true : undefined} data-goal-current-source={conclusion ? 'start' : undefined}>{conclusion ?? 'Original request retained'}</span><button className={primary ? 'primary-button' : 'small-button'} type="button" disabled={busy} onClick={() => void run(() => intent && !attempted ? start() : inspect(pending.operationId))}>{busy ? 'Checking…' : intent && !attempted ? 'Submit retained task' : 'Inspect original Start'}</button>{intent?.agentReference && attempted ? <button className="small-button" type="button" disabled={busy} onClick={() => void run(resumeOriginal)}>Continue original Start</button> : intent && !attempted ? <button className="small-button" type="button" disabled={busy} onClick={() => void run(discardUnsent)}>Discard unsent selection</button> : null}</div>
      : hasOriginalTask ? <>{!embedded ? <a className="small-button" href={`#goal-work-${demand.id}`}>View original work</a> : null}<details className="goal-finite-start__another"><summary>Start another one-time task</summary>{newTask}</details></> : newTask}
    {message ? <p className="goals-service" role="status">{message}</p> : null}
    {picker ? <GoalAgentPicker demand={demand} role="assignees" onSave={async (patch, expectedUpdatedAt, relationAccess) => { await useAppStore.getState().updateDemand(demand.id, patch, undefined, expectedUpdatedAt, relationAccess); return true }} onClose={() => setPicker(false)} /> : null}
  </section>
}
