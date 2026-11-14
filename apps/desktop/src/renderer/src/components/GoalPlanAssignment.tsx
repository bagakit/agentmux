import { useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@agentmux/client-ui/components/Button'
import { mintObjectId } from '@agentmux/core/object-id'
import type { GoalPlan, GoalPlanExecutor } from '@agentmux/demand/goal-plan'
import { goalAgentPresentation } from '../lib/goal-agent-selection'
import { agentDisplayName } from '../lib/workbench-tabs'
import { firstPromptFromTimeline } from '@agentmux/client-ui/display-name'
import type { SessionSnapshot } from '../../../shared/contracts'
import type { NodeAssignmentDraft, NodeAssignmentRequest } from '../lib/goal-edit-drafts'
import { applyGoalDelegationResult, beginGoalDelegationRead } from '../lib/goal-delegation-work'
import type { DemandProjection } from '../lib/global-demand-board'
import { api } from '../lib/api'
import { checkpointAgentOperations, setAuthoredWorkbench, useAppStore } from '../store'
import type { GoalPlanNodeView } from './GoalPlanGraph'
import { SelectionField } from './SelectionField'
import '../styles/goal-plan-assignment.css'

const executorKey = (executor: GoalPlanExecutor) => JSON.stringify([executor.hostId, executor.agentSessionId])

function matchesReceipt(plan: GoalPlan | undefined, request: NodeAssignmentRequest) {
  return plan?.history.some(entry => {
    const change = entry.change
    return entry.operationId === request.operationId && entry.revision === request.expectedRevision + 1 &&
      entry.author.kind === 'user' && change?.nodeId === request.nodeId && change.assignment.kind === request.assignment.kind &&
      (request.assignment.kind !== 'assign' || change.assignment.kind === 'assign' &&
        executorKey(change.assignment.executor) === executorKey(request.assignment.executor))
  })
}

/** Only the addressed node's authored choice and original operation belong in the user document. */
function saveDraft(goalId: string, key: string, next: NodeAssignmentDraft | undefined, expectedOperation?: string) {
  setAuthoredWorkbench(state => {
    const edits = state.goalEditDrafts[goalId] ?? {}, current = edits.assignments?.[key]
    if (expectedOperation !== current?.request?.operationId) return state
    const assignments = { ...edits.assignments }, goalEditDrafts = { ...state.goalEditDrafts }
    if (next) assignments[key] = next
    else delete assignments[key]
    const { assignments: _old, ...other } = edits
    if (Object.keys(assignments).length) goalEditDrafts[goalId] = { ...other, assignments }
    else if (Object.keys(other).length) goalEditDrafts[goalId] = other
    else delete goalEditDrafts[goalId]
    return { goalEditDrafts }
  })
}

function AgentChoice({ choice, onChoice, onAssign }: { choice?: NodeAssignmentDraft['choice'];
  onChoice(executor: GoalPlanExecutor): void; onAssign(): void }) {
  const state = useAppStore(useShallow(state => ({ sessions: state.sessions, agentNames: state.agentNames, timelines: state.timelines })))
  // The assignment itself addresses a Host and Session. Equal SIDs at different Hosts are distinct choices.
  const sessionsByExecutor = new Map<string, Extract<SessionSnapshot, { kind: 'agent' }>[]>()
  for (const session of state.sessions) {
    if (session.kind !== 'agent' || session.hostId !== session.control.hostId) continue
    const key = executorKey(session.control), group = sessionsByExecutor.get(key)
    if (group) group.push(session)
    else sessionsByExecutor.set(key, [session])
  }
  const existing = [...sessionsByExecutor].map(([value, group]) => {
    const { hostId, agentSessionId } = group[0]!.control, session = goalAgentPresentation(group, agentSessionId)
    const label = session ? agentDisplayName({ userName: state.agentNames[session.id], firstPrompt: firstPromptFromTimeline(state.timelines[session.id]),
      fallbackLabel: session.label, providerLabel: session.providerId }) : agentSessionId
    return { value, label, description: `${hostId} · ${agentSessionId}`, executor: { hostId, agentSessionId } }
  }).sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value))
  const selected = choice ? executorKey(choice.executor) : ''
  return <div className="goal-node-assignment__choice">
    <SelectionField label="Agent for this node" value={selected} missingOptionLabel={choice?.executor.agentSessionId}
      options={[{ value: '', label: 'Choose an agent…', disabled: true }, ...existing]} onValueChange={id => {
        const option = existing.find(row => row.value === id)
        if (option) onChoice(option.executor)
      }} />
    <Button type="button" disabled={!existing.some(option => option.value === selected)} onClick={onAssign}>Assign</Button>
    {!existing.length ? <small>No Agent sessions are available to select.</small> : null}
  </div>
}

export function GoalPlanAssignment({ demand, item }: { demand: DemandProjection; item: GoalPlanNodeView }) {
  const { address, plan } = demand, node = item.node
  const key = JSON.stringify([address?.runtimeId, address?.namespace, node.id])
  const draft = useAppStore(state => state.goalEditDrafts[demand.id]?.assignments?.[key])
  const request = draft?.request
  const [choosing, setChoosing] = useState(Boolean(draft?.choice))
  const [notice, setNotice] = useState(''), [readRevision, setReadRevision] = useState<number>()
  const [pending, setPending] = useState(false), inFlight = useRef(false)
  const ready = item.state === 'ready' && !item.delegation && demand.status !== 'done' && demand.status !== 'cancelled'
  if (!plan || !request && !draft?.choice && !ready && !node.claimOpen) return null
  if (!address) return <p className="goals-caption">Node assignment needs the original Goal address.</p>
  const { runtimeId, namespace } = address, expectedOwner = { runtimeId, namespace }
  if (request && (request.goalId !== demand.id || request.nodeId !== node.id || request.expectedOwner?.runtimeId !== runtimeId || request.expectedOwner.namespace !== namespace))
    return <p className="goals-service" role="status">The saved request belongs to a different Goal or node. Its original operation is retained.</p>
  const revision = plan.revision

  async function observe(original: NodeAssignmentRequest, mode: 'submit' | 'check' | 'retry') {
    if (inFlight.current) return
    inFlight.current = true; setPending(true); setNotice(''); setReadRevision(undefined)
    const cut = beginGoalDelegationRead()
    try {
      if (mode !== 'check') {
        // This object also distinguishes overlapping attempts after a detail remount.
        // A late local failure can release only the fresh attempt that still owns the draft.
        const prepared = { ...draft, request: original }
        saveDraft(demand.id, key, prepared, mode === 'retry' ? original.operationId : undefined)
        const currentDraft = () => useAppStore.getState().goalEditDrafts[demand.id]?.assignments?.[key]
        if (currentDraft() !== prepared) return
        try { await checkpointAgentOperations() }
        catch (cause) {
          if (currentDraft() !== prepared) return
          if (mode === 'submit')
            saveDraft(demand.id, key, prepared.choice ? { choice: prepared.choice } : undefined, original.operationId)
          const issue = cause instanceof Error ? cause.message : String(cause)
          throw new Error(mode === 'submit' ? `Assignment was not sent. ${issue}` : `Retry was not sent. Check the original request. ${issue}`, { cause })
        }
        if (currentDraft() !== prepared) return
      }
      const result = mode === 'check'
        ? await api.demands.delegation('goal.plan', { goalId: original.goalId, expectedOwner: original.expectedOwner })
        : await api.demands.delegation('goal.plan.assignment', original)
      if (result.goalId !== original.goalId || !result.plan) throw new Error('The original plan receipt is unavailable.')
      const current = useAppStore.getState().demands[original.goalId]
      if (current?.address?.runtimeId === original.expectedOwner.runtimeId && current.address.namespace === original.expectedOwner.namespace)
        applyGoalDelegationResult(result, cut)
      if (matchesReceipt(result.plan, original)) {
        saveDraft(demand.id, key, undefined, original.operationId)
        setChoosing(false)
        setNotice(original.assignment.kind === 'open' ? 'Opened for claims.' : original.assignment.kind === 'close' ? 'Claims closed.' : 'Agent assigned. Awaiting dispatch.')
      } else {
        // A different operation consuming this revision rules out a future commit of the frozen request.
        setReadRevision(mode === 'check' ? result.plan.revision : undefined)
        setNotice('The original assignment is unconfirmed in the saved plan.')
      }
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { inFlight.current = false; setPending(false) }
  }

  function submit(assignment: NodeAssignmentRequest['assignment'], expectedRevision = revision) {
    if (inFlight.current || useAppStore.getState().goalEditDrafts[demand.id]?.assignments?.[key]?.request) return
    const original = { goalId: demand.id, expectedOwner, nodeId: node.id, operationId: mintObjectId(), expectedRevision, assignment }
    void observe(original, 'submit')
  }
  return <section className="goal-node-assignment" aria-label="Node assignment" aria-busy={pending}>
    <h4>Assignment</h4>
    {request ? <>
      <p className="goals-caption">Revision {request.expectedRevision} · {request.assignment.kind === 'assign'
        ? `Assign to ${request.assignment.executor.agentSessionId} on ${request.assignment.executor.hostId}`
        : request.assignment.kind === 'open' ? 'Open for claims' : 'Close claims'}</p>
      <div className="goal-node-assignment__actions">
        <Button type="button" disabled={pending} onClick={() => void observe(request, 'check')}>Check original request</Button>
        {readRevision === request.expectedRevision ? <Button type="button" disabled={pending} onClick={() => void observe(request, 'retry')}>Retry original request</Button> : null}
        {readRevision !== undefined && readRevision > request.expectedRevision ? <Button type="button" disabled={pending} onClick={() => {
          saveDraft(demand.id, key, draft?.choice ? { choice: { ...draft.choice, revision: readRevision } } : undefined, request.operationId)
          setReadRevision(undefined); setNotice('')
        }}>Use revision {readRevision}</Button> : null}
      </div>
      <details><summary>Operation details</summary><code>{request.operationId}</code></details>
    </> : <>
      <div className="goal-node-assignment__actions">
        {node.claimOpen ? <Button type="button" onClick={() => submit({ kind: 'close' })}>Close claims</Button>
          : ready && !node.executor ? <Button type="button" onClick={() => submit({ kind: 'open' })}>Open for claims</Button> : null}
        {ready && !choosing ? <Button type="button" onClick={() => setChoosing(true)}>{node.executor ? 'Reassign agent…' : 'Assign agent…'}</Button> : null}
      </div>
      {ready && choosing ? <AgentChoice choice={draft?.choice} onChoice={executor => saveDraft(demand.id, key, { choice: { executor, revision } })}
        onAssign={() => { if (draft?.choice) submit({ kind: 'assign', executor: draft.choice.executor }, draft.choice.revision) }} /> : null}
    </>}
    {notice || pending ? <p role="status" className="goals-caption">{pending ? 'Checking the original plan…' : notice}</p> : null}
  </section>
}
