import { demandAgentReferenceKey, mergeDemandAgentReferences } from '@agentmux/demand/relations'
import type { DemandDispatch } from '@agentmux/demand'
import type { GoalInspectionAccess } from '@agentmux/core/goal-agent-reference'
import type { DemandSpaceMemberReference } from '@agentmux/demand/relations'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { mintObjectId } from '@agentmux/core/object-id'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import { Button } from '@agentmux/client-ui/components/Button'
import { clearGoalFiniteStartIntent, retainGoalFiniteStartIntent, useAppStore } from '../store'
import { api } from '../lib/api'
import type { DemandRecord } from '../lib/global-demand-board'
import { goalFiniteStartAccess, goalFiniteStartInspection, goalFiniteStartSubmission, readGoalFiniteStartIntent, type GoalFiniteStartIntent, type GoalFiniteStartInput, type GoalFiniteStartAccessSelection } from '../lib/goal-finite-start'
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
  const savedInput = useMemo(() => readGoalFiniteStartIntent(rawIntent, demand.id), [rawIntent, demand.id])
  const selectionInput = savedInput?.phase === 'selecting-access' ? savedInput : undefined
  const intent = savedInput?.phase === 'selecting-access' ? undefined : savedInput
  const rows = useMemo(() => {
    const state = useAppStore.getState(), index = hasLegacy ? agentSessionPresentationIndex(state.sessions) : undefined
    return goalAgentRows({ ...state, sessions: [...new Set(ids.flatMap(id => typeof id === 'string' ? index?.get(id) ?? [] : []))] }, demand, ids).filter(row => ids.some(ref => demandAgentReferenceKey(ref) === demandAgentReferenceKey(goalAgentRowReference(row))))
  }, [facts, demand, ids, hasLegacy])
  const [selected, setSelected] = useState<string | null>(null), [picker, setPicker] = useState(false)
  const [busyScope, setBusyScope] = useState<string | null>(null), [message, setMessage] = useState<string | null>(null)
  const flight = useRef<{ scope: string; token: symbol } | null>(null)
  const target = rows.find(row => row.id === (selected ?? (rows.length === 1 ? rows[0]!.id : null)))
  const pending = intent ?? demand.dispatches?.find(item => item.execution === 'finite' && item.stage !== 'confirmed' && item.stage !== 'rejected')
  const originalDispatch = intent && demand.dispatches?.find(item => item.operationId === intent.operationId)
  const rejected = originalDispatch?.stage === 'rejected' ? originalDispatch : undefined
  const attempted = intent?.phase === 'may-have-dispatched' || Boolean(originalDispatch)
  const originalMember = intent ? intent.agentReference : pending && 'target' in pending ? pending.target : undefined
  const chosen = target && goalAgentRowReference(target)
  const member = originalMember ?? (!pending && typeof chosen !== 'string' ? chosen : undefined) ?? selectionInput?.agentReference
  const access = intent?.agentReference ? goalFiniteStartAccess(intent) : selectionInput && member && demandAgentReferenceKey(member) === demandAgentReferenceKey(selectionInput.agentReference) ? selectionInput.accessDraft : undefined
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
    } else if (original?.stage === 'requested' && scope.current === inputScope) setMessage('The original task is saved before input preparation. Choose current access and explicitly continue this same operation.')
    else if (original?.stage === 'rejected' && scope.current === inputScope) setMessage('The original business request was rejected. Review the rejection before explicitly preparing a current task.')
    else if (scope.current === inputScope) setMessage(original ? 'Delivery is unconfirmed. Inspect this request in the original Agent’s input queue.' : 'The original Start record is not yet observed. Its outcome remains unknown; keep checking the same request.')
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
    if (rawIntent !== undefined && !savedInput) { setMessage('Original Start input is retained but cannot be read. It has not been replaced or submitted again.'); return }
    if (selectionInput) {
      if (chosen && demandAgentReferenceKey(chosen) !== demandAgentReferenceKey(selectionInput.agentReference)) { setMessage('Choose connections for this selected Agent. The original connection draft is retained.'); return }
      if (selectionInput.accessDraft) await selectAccess(selectionInput.accessDraft)
      else setMessage('Choose the current project and Agent connections before preparing this task.')
      return
    }
    if (!intent && target?.reference && typeof target.reference !== 'string') { setMessage('This Source-qualified Start needs its original current execution access. The selected relation and existing Agent are retained.'); return }
    const reference = target && goalAgentRowReference(target)
    const inputEpoch = !intent && typeof reference === 'string' && target?.session ? await api.sessions.readInputEpoch(target.session.control.hostId) ?? undefined : undefined
    const saved: GoalFiniteStartIntent | undefined = intent ?? (typeof reference === 'string' ? { goalId: demand.id, operationId: mintObjectId(), sessionId: reference, expectedUpdatedAt: demand.updatedAt, phase: 'not-attempted', ...(inputEpoch === undefined ? {} : { inputEpoch }) } : undefined)
    if (!saved) return
    if (attempted) { await inspect(saved.operationId); return }
    if (saved.agentReference && saved.expectedUpdatedAt !== demand.updatedAt) { setMessage('The Goal changed after this task selection. Review it and choose the current Goal version before submitting.'); return }
    if (saved.agentReference && !goalFiniteStartAccess(saved)?.source) { setMessage('Choose current project access before submitting this task. Your selection is retained.'); return }
    if (saved.agentReference && saved.agentReference.source.admission.kind === 'association' && !goalFiniteStartAccess(saved)?.coordinator) { setMessage('Choose independent current Coordinator access for this original association. Project membership does not grant input access.'); return }
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
      if (failure.controlFailure?.disposition === 'not_applied' && !saved.agentReference) {
        await clearGoalFiniteStartIntent(saved.goalId, saved.operationId, dispatching)
        await useAppStore.getState().refreshDemand(saved.goalId)
      }
      // A qualified business OP may already be reserved by another Host. Only
      // its confirmed Domain rejection permits preparing a replacement task.
      throw error
    }
  }
  async function selectAccess(value: GoalInspectionAccess) {
    if (!member || rawIntent !== undefined && !savedInput) return
    try {
      let next: GoalFiniteStartInput
      if (intent?.agentReference) next = { ...intent, accessDraft: value }
      else if (pending) next = { goalId: demand.id, operationId: pending.operationId, agentReference: member, access: value,
        ...(pending.inputEpoch === undefined ? {} : { inputEpoch: pending.inputEpoch }),
        expectedUpdatedAt: 'stage' in pending && pending.stage === 'requested' ? pending.request.goalUpdatedAt : demand.updatedAt, phase: 'may-have-dispatched' }
      else { await prepareSelection(member, value, rawIntent, selectionInput?.expectedUpdatedAt ?? demand.updatedAt); return }
      const saved = await retainGoalFiniteStartIntent(next, rawIntent)
      setMessage(saved.clientStateWritten ? null : 'This access selection is retained in this view; saving it is unconfirmed. The original operation and Agent are retained.')
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
  }
  async function prepareSelection(reference: DemandSpaceMemberReference, value: GoalInspectionAccess | undefined, expected: unknown, expectedUpdatedAt: number) {
    const draft: GoalFiniteStartAccessSelection = { goalId: demand.id, agentReference: reference,
      ...(value === undefined ? {} : { accessDraft: value }), expectedUpdatedAt, phase: 'selecting-access' }
    const retained = await retainGoalFiniteStartIntent(draft, expected)
    if (!retained.clientStateWritten) { setMessage('The connection draft is retained; saving it is unconfirmed. No task was prepared.'); return }
    if (!value?.source || reference.source.admission.kind === 'association' && !value.coordinator) { setMessage('Choose the current project and Agent connections before preparing this task.'); return }
    let inputEpoch: string | undefined, observationIssue: string | undefined
    try {
      const qualified = await api.demands.inputEpoch({ agentReference: reference, access: value })
      if (qualified.runtimeId !== reference.execution.runtimeId) throw Object.assign(new Error('The input state reply belongs to another original Agent Runtime.'), { code: 'RUNTIME_OWNER_MISMATCH' })
      inputEpoch = qualified.inputEpoch === null ? undefined : qualified.inputEpoch
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'RUNTIME_OWNER_MISMATCH') throw error
      observationIssue = `The original Agent input state is unconfirmed. Its owner will decide this pinned request. ${error instanceof Error ? error.message : String(error)}`
    }
    const next: GoalFiniteStartIntent = { goalId: demand.id, agentReference: reference, access: value, expectedUpdatedAt,
      operationId: mintObjectId(), phase: 'not-attempted', ...(inputEpoch === undefined ? {} : { inputEpoch }) }
    const saved = await retainGoalFiniteStartIntent(next, draft)
    setMessage(saved.clientStateWritten ? observationIssue ?? null : 'The task selection is retained here; saving is unconfirmed. No input was submitted.')
  }
  async function prepareCurrentTask() {
    if (!intent?.agentReference || !rejected) return
    const result = await useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: rejected.operationId,
      operation: 'demand.show', demandId: demand.id, dispatchOperationId: rejected.operationId })
    if (result.operation !== 'demand.show' || result.demand?.id !== demand.id) throw Error('The original rejection is not confirmed. Keep this same task and inspect it.')
    const original = result.demand.dispatches?.find(value => value.operationId === rejected.operationId)
    if (original?.stage !== 'rejected' || original.expectedUpdatedAt !== intent.expectedUpdatedAt || demandAgentReferenceKey(original.target) !== demandAgentReferenceKey(intent.agentReference))
      throw Error('The exact original business rejection is not confirmed. No replacement task was prepared.')
    const selectedReference = target && goalAgentRowReference(target)
    if (!selectedReference || !result.demand.assigneeSessionIds?.some(value => demandAgentReferenceKey(value) === demandAgentReferenceKey(selectedReference))) {
      setPicker(true); setMessage('Choose a current assignee before preparing a new task. The original rejection is retained.'); return
    }
    const sameTargetAccess = demandAgentReferenceKey(selectedReference) === demandAgentReferenceKey(original.target) ? goalFiniteStartAccess(intent) : undefined
    if (typeof selectedReference !== 'string') { await prepareSelection(selectedReference, sameTargetAccess, rawIntent, result.demand.updatedAt); return }
    const inputEpoch = target?.session ? await api.sessions.readInputEpoch(target.session.control.hostId) ?? undefined : undefined
    const next: GoalFiniteStartIntent = { goalId: demand.id, operationId: mintObjectId(), expectedUpdatedAt: result.demand.updatedAt,
      phase: 'not-attempted', sessionId: selectedReference, ...(inputEpoch === undefined ? {} : { inputEpoch }) }
    const saved = await retainGoalFiniteStartIntent(next, rawIntent)
    setMessage(saved.clientStateWritten ? 'Current task prepared. Review it and explicitly submit; the original rejection remains in its Goal record.'
      : 'The current task selection is retained here; saving is unconfirmed and no input was submitted.')
  }
  async function resumeOriginal() {
    if (!intent?.agentReference || !attempted || rejected) return
    if (useAppStore.getState().goalFiniteStartIntents[demand.id] !== rawIntent) { setMessage('The original Start input changed. Your newer private input is retained; review it before continuing.'); return }
    if (!goalFiniteStartAccess(intent)?.source) { setMessage('Choose current project access before continuing this original Start. Independent Coordinator access remains available for Check.'); return }
    if (intent.agentReference.source.admission.kind === 'association' && !goalFiniteStartAccess(intent)?.coordinator) { setMessage('Choose independent current Coordinator access for this original association. Project membership does not grant input access.'); return }
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
  const connections = member && !(rawIntent !== undefined && !savedInput) ? <GoalRelationAccessFields purpose="input" reference={member} hosts={useAppStore.getState().config?.hosts ?? []}
    access={access} original={Boolean(pending && (!intent || attempted))} disabled={false} onChange={value => void selectAccess(value)} /> : null
  const recipients = <>{rows.length > 1 && !target ? <p className="goals-caption">Choose who receives this task.</p> : null}<div className="goal-finite-start__recipients" role="radiogroup" aria-label="Agent for this task">{rows.map(row => <label className="goal-collaboration__member" key={row.id} data-selected={target?.id === row.id}><input type="radio" name={`goal-task-recipient-${demand.id}`} checked={target?.id === row.id} onChange={() => setSelected(row.id)} /><GoalAgentFace row={row} /><span>{row.name}<small>{row.context}</small></span></label>)}</div></>
  const newTask = <>{recipients}{connections}
    <div className="goals-inline-actions"><button type="button" className={primary && !hasOriginalTask ? 'primary-button' : 'small-button'} disabled={busy || rows.length > 0 && !target} onClick={() => { if (!rows.length) setPicker(true); else void run(start) }}>{busy ? 'Submitting…' : target ? `Start with ${target.name}` : rows.length ? 'Choose an Agent for this task' : 'Choose execution Agent'}</button>
      {rows.length ? <Button type="button" onClick={() => setPicker(true)}>Manage assignees</Button> : null}</div></>
  return <section className="goal-finite-start" data-goal-finite-start={demand.id} aria-label="One-time Goal execution">
    {!embedded ? <div className="goals-section-heading"><h2>{hasOriginalTask ? 'Task execution' : 'Execute task'}</h2><span className="goals-caption">One-time task</span></div> : null}
    {pending ? connections : null}
    {rejected ? recipients : null}
    {intent?.agentReference && !attempted && intent.expectedUpdatedAt !== demand.updatedAt ? <p className="goals-service" role="status">The Goal changed after this task selection. Review its current content.<Button type="button" disabled={busy} onClick={() => void run(updateVersion)}>Use current Goal version for this task</Button></p> : null}
    {rawIntent !== undefined && !savedInput ? <p className="goals-service" role="status">Original Start input is retained but cannot be read. It has not been replaced or submitted again. The Agent and its original work record are retained.</p> : pending ? <div className="goals-inline-actions"><span className="goals-caption" data-goal-current-conclusion={conclusion ? true : undefined} data-goal-current-source={conclusion ? 'start' : undefined}>{conclusion ?? 'Original request retained'}</span><button className={primary ? 'primary-button' : 'small-button'} type="button" disabled={busy} onClick={() => void run(() => intent && !attempted ? start() : inspect(pending.operationId))}>{busy ? 'Checking…' : intent && !attempted ? 'Submit retained task' : 'Inspect original Start'}</button>{intent?.agentReference && rejected ? <Button type="button" disabled={busy} onClick={() => void run(prepareCurrentTask)}>Prepare current task</Button> : intent?.agentReference && attempted ? <Button type="button" disabled={busy} onClick={() => void run(resumeOriginal)}>Continue original Start</Button> : intent && !attempted ? <Button type="button" disabled={busy} onClick={() => void run(discardUnsent)}>Discard unsent selection</Button> : null}</div>
      : hasOriginalTask ? <>{!embedded ? <a className="small-button" href={`#goal-work-${demand.id}`}>View original work</a> : null}<details className="goal-finite-start__another"><summary>Start another one-time task</summary>{newTask}</details></> : newTask}
    {message ? <p className="goals-service" role="status">{message}</p> : null}
    {picker ? <GoalAgentPicker demand={demand} role="assignees" onSave={async (patch, expectedUpdatedAt, relationAccess) => { await useAppStore.getState().updateDemand(demand.id, patch, undefined, expectedUpdatedAt, relationAccess); return true }} onClose={() => setPicker(false)} /> : null}
  </section>
}
