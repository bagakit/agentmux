import { useEffect, useRef, useState } from 'react'
import type { DemandProjection } from '../lib/global-demand-board'
import { useAppStore, retainGoalPlanRequest } from '../store'
import { goalDiscussionRequestKey } from '../lib/goal-discussion-request'
import { useGoalAgentPresentation } from '../lib/goal-discussion-recipient'
import { api } from '../lib/api'
import { applyGoalDelegationResult, beginGoalDelegationRead, refreshGoalDelegations } from '../lib/goal-delegation-work'
import { requestAgentConversationFloatingOpen } from '../lib/pmo-teams-topic-floating'
import { mintObjectId } from '@agentmux/core/object-id'
import { GoalAgentPicker, type GoalRelationSave } from './GoalAgentPicker'
import { agentSessionPresentationIndex } from '../lib/session-presentation'

type Goal = DemandProjection
const labels = { prepared: 'Planning request saved', delivered: 'Delivered · waiting for a saved plan', missing: 'Planning request saved · Supervisor unavailable',
  unknown: 'Planning input unconfirmed', stale: 'Original planning request needs attention', planned: 'Plan saved', reported: 'Original request recorded' }

/** The original Host request is delivery truth; the native user document keeps only the person's action reference. */
export function GoalPlanRequest({ demand, onRequest, pending, busy }: { demand: Goal; onRequest(): void; pending: boolean; busy: boolean }) {
  const retained = useAppStore(state => state.goalDiscussionRequests?.[goalDiscussionRequestKey(demand.id, 'plan')])
  const [choose, setChoose] = useState(false), [issue, setIssue] = useState<string | null>(null), [working, setWorking] = useState(false)
  // Only this picker can know its freshly minted reference has never reached the Host.
  const [unsentSelection, setUnsentSelection] = useState<string | null>(null)
  const flight = useRef(false)
  const requests = (demand.patrols ?? []).filter(item => item.purpose === 'plan')
  const original = requests.find(item => item.operationId === retained?.requestId || item.requestOperationIds?.includes(retained?.requestId ?? '')) ?? requests.at(-1)
  const observed = original && demand.patrolObservations?.find(item => item.operationId === original.operationId)
  const attempt = original?.attempts.at(-1), target = original?.supervisorAgentSessionId ?? demand.supervisorSessionId
  const presentation = useGoalAgentPresentation(original && !attempt ? null : target, attempt?.target.hostId)
  const currentPresentation = useGoalAgentPresentation(demand.supervisorSessionId)
  const currentRun = useAppStore(state => {
    const matches = (target ? agentSessionPresentationIndex(state.sessions).get(target) ?? [] : []).filter(item => item.control.agentSessionId === target &&
      (!attempt || item.control.hostId === attempt.target.hostId))
    return matches.length === 1 && matches[0]?.kind === 'agent' ? matches[0].control.run.runId : null
  })
  useEffect(() => {
    if (!original) return
    void refreshGoalDelegations(demand.id)
    return api.demands.onChanged(ids => { if (ids.includes(demand.id)) void refreshGoalDelegations(demand.id) })
  }, [demand.id, original?.operationId])
  async function run(action: () => Promise<unknown>) {
    if (flight.current) return
    flight.current = true; setWorking(true); setIssue(null)
    try { await action() } catch (error) { setIssue(error instanceof Error ? error.message : String(error)) }
    finally { flight.current = false; setWorking(false) }
  }
  const saveSupervisor: GoalRelationSave = async (patch, expectedUpdatedAt) => {
    await useAppStore.getState().updateDemand(demand.id, patch, undefined, expectedUpdatedAt)
    return true
  }
  const chooseSupervisor = () => void run(async () => {
    const key = goalDiscussionRequestKey(demand.id, 'plan'), previous = useAppStore.getState().goalDiscussionRequests[key]
    await retainGoalPlanRequest(demand.id)
    if (!previous) setUnsentSelection(useAppStore.getState().goalDiscussionRequests[key]!.requestId)
    setChoose(true)
  })
  const canContinue = original && original.supervisorAgentSessionId === demand.supervisorSessionId && !original.attempts.some(item => item.attemptedAt) &&
    currentRun && (!attempt || attempt.target.runId !== currentRun)
  const newRequest = original && observed?.state === 'stale' || retained && !original
  return <div className="goal-plan__request" data-goal-plan-request-feedback>
    {!demand.supervisorSessionId ? <>
      <p className="goals-muted">Choose a Supervisor to make this plan.</p>
      <button type="button" className="small-button" data-goal-plan-request={original ? undefined : true} disabled={working} onClick={chooseSupervisor}>Choose Supervisor to plan</button>
    </> : null}
    {demand.supervisorSessionId || original ? <div className="goals-inline-actions">
      <button type="button" className="small-button" data-goal-plan-request disabled={pending || busy || working} onClick={() => { setUnsentSelection(null); onRequest() }}>
        {pending ? `Preparing request to ${presentation.name ?? 'Supervisor'}…` : original ? `Check request to ${presentation.name ?? 'original Supervisor'}`
          : retained && retained.requestId !== unsentSelection ? `Check request to ${currentPresentation.name ?? 'Supervisor'}` : `Ask ${currentPresentation.name ?? 'Supervisor'} to plan`}
      </button>
      {newRequest && demand.supervisorSessionId ? <button type="button" className="small-button" disabled={working || pending} onClick={() => void run(async () => {
        await useAppStore.getState().requestDemandPmoTask(demand.id, 'plan', { newRequest: true })
      })}>New request to {currentPresentation.name ?? 'current Supervisor'}</button> : null}
      {target ? <button type="button" className="small-button" onClick={() => requestAgentConversationFloatingOpen(original ? attempt?.target.agentSessionId ?? null : target,
        original ? attempt?.target.hostId : presentation.hostId ?? undefined, original && !attempt ? 'The original Supervisor destination is unconfirmed. Check the retained request to read its destination.' : undefined)}>
        Open {presentation.name ?? 'Supervisor'} conversation</button> : null}
      {canContinue ? <button type="button" className="small-button" disabled={working} onClick={() => void run(async () => {
        const cut = beginGoalDelegationRead()
        applyGoalDelegationResult(await api.demands.delegation('goal.patrol.continue', { goalId: demand.id, patrolOperationId: original.operationId,
          operationId: mintObjectId(), expectedRunId: currentRun }), cut)
      })}>Continue original planning request</button> : null}
    </div> : null}
    {observed ? <p className="goals-service" role="status"><strong>{labels[observed.state]}</strong><span>{observed.reason}</span></p>
      : original ? <p className="goals-caption" role="status">Planning request saved. Reading its original input receipt…</p>
      : retained ? <p className="goals-caption" role="status">Your planning request is retained. {demand.supervisorSessionId ? 'Check the original request before sending again.' : 'Choose a Supervisor, then explicitly send it.'}</p> : null}
    {issue ? <p className="goals-service" role="status">{issue} Your original request and work are retained.</p> : null}
    {choose ? <GoalAgentPicker demand={demand} role="supervisor" onSave={saveSupervisor} onClose={() => setChoose(false)} /> : null}
  </div>
}
