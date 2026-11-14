import { useEffect, useRef, useState } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import type { DemandProjection } from '../lib/global-demand-board'
import { useAppStore, retainGoalPlanRequest } from '../store'
import { goalDiscussionRequestKey } from '../lib/goal-discussion-request'
import { goalRequestFirstDestination, useGoalAgentPresentation } from '../lib/goal-discussion-recipient'
import { api } from '../lib/api'
import { applyGoalDelegationResult, beginGoalDelegationRead, refreshGoalDelegations } from '../lib/goal-delegation-work'
import { bindAgentConversationFloatingTarget, readPmoTeamsTopicFloatingState, requestAgentConversationFloatingOpen, setAgentConversationFloatingMessage } from '../lib/pmo-teams-topic-floating'
import { deriveObjectId, mintObjectId } from '@agentmux/core/object-id'
import { GoalAgentPicker, type GoalRelationSave } from './GoalAgentPicker'
import { agentSessionPresentationIndex } from '../lib/session-presentation'
import { goalSupervisorHostWitnesses } from '@agentmux/demand/relations'

type Goal = DemandProjection
const labels = { prepared: 'Planning request saved', delivered: 'Delivered · waiting for a saved plan', missing: 'Planning request saved · Supervisor unavailable',
  unknown: 'Planning input unconfirmed', stale: 'Original planning request needs attention', planned: 'Plan saved', reported: 'Original request recorded' }

/** The original Host request is delivery truth; the native user document keeps only the person's action reference. */
export function GoalPlanRequest({ demand, onRequest, onChooseSupervisor, pending, busy }: { demand: Goal; onRequest(): void; onChooseSupervisor?: (() => void) | undefined; pending: boolean; busy: boolean }) {
  const split = !demand.plan?.nodes.length
  const retained = useAppStore(state => state.goalDiscussionRequests?.[goalDiscussionRequestKey(demand.id, 'plan')])
  const [choose, setChoose] = useState(false), [issue, setIssue] = useState<string | null>(null), [working, setWorking] = useState(false)
  // Only this picker can know its freshly minted reference has never reached the Host.
  const [unsentSelection, setUnsentSelection] = useState<string | null>(null)
  const flight = useRef(false)
  const requests = (demand.patrols ?? []).filter(item => item.purpose === 'plan')
  const original = requests.find(item => item.operationId === retained?.requestId || item.requestOperationIds?.includes(retained?.requestId ?? '')) ?? requests.at(-1)
  const observed = original && demand.patrolObservations?.find(item => item.operationId === original.operationId)
  const pendingRead = original ? observed?.state !== 'planned' : Boolean(retained)
  const attempt = original?.attempts.at(-1), target = attempt?.target.agentSessionId ?? original?.supervisorAgentSessionId ?? demand.supervisorSessionId
  const supervisorHosts = goalSupervisorHostWitnesses(demand), currentHostId = supervisorHosts.length === 1 ? supervisorHosts[0] : undefined
  const targetHostId = original ? attempt?.target.hostId : currentHostId
  const presentation = useGoalAgentPresentation(target, targetHostId)
  const currentPresentation = useGoalAgentPresentation(demand.supervisorSessionId, currentHostId)
  const firstDestination = goalRequestFirstDestination(demand, original)
  const firstPresentation = useGoalAgentPresentation(firstDestination?.agentSessionId, firstDestination?.hostId)
  const firstHostName = useAppStore(state => firstDestination ? state.config?.hosts.find(host => host.id === firstDestination.hostId)?.label ?? firstDestination.hostId : null)
  const currentRun = useAppStore(state => {
    const matches = (typeof target === 'string' && targetHostId ? agentSessionPresentationIndex(state.sessions).get(target) ?? [] : []).filter(item => item.control.agentSessionId === target &&
      item.control.hostId === targetHostId && item.hostId === targetHostId)
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
    if (onChooseSupervisor) onChooseSupervisor()
    else setChoose(true)
  })
  const canContinue = original && original.supervisorAgentSessionId === demand.supervisorSessionId && !original.attempts.some(item => item.attemptedAt) &&
    currentRun && (!attempt || attempt.target.runId !== currentRun)
  const newRequest = original && observed?.state === 'stale' || retained && !original
  async function sendFirstDestination() {
    if (!original || !firstDestination) return
    const entry = requestAgentConversationFloatingOpen(null, undefined, 'Confirming this planning request’s first Supervisor destination.')
    try {
      const cut = beginGoalDelegationRead()
      const result = await api.demands.delegation('goal.patrol.continue', { goalId: demand.id, patrolOperationId: original.operationId,
        operationId: deriveObjectId('goal-plan-first-destination', JSON.stringify([demand.id, original.operationId, firstDestination.hostId, firstDestination.agentSessionId, firstDestination.runId])), expectedRunId: firstDestination.runId })
      applyGoalDelegationResult(result, cut)
      const target = result.patrols?.find(item => item.operationId === original.operationId)?.attempts.at(-1)?.target
      if (target) bindAgentConversationFloatingTarget(entry, target.agentSessionId, target.hostId)
    } catch (error) {
      const floating = readPmoTeamsTopicFloatingState()
      if (floating?.conversationEntry === entry) setAgentConversationFloatingMessage(floating.agentTarget?.agentSessionId ?? null, error instanceof Error ? error.message : String(error), entry)
      throw error
    }
  }
  const controls = <>
    {!demand.supervisorSessionId ? <>
      <Button type="button" data-goal-plan-request={original ? undefined : true} disabled={working} onClick={chooseSupervisor}>{split ? 'Choose Supervisor to split work' : 'Choose Supervisor to revise plan'}</Button>
    </> : null}
    {demand.supervisorSessionId && typeof demand.supervisorSessionId !== 'string' && !original ? <p className="goals-service" role="status">Supervisor {currentPresentation.name} is retained. Planning requires its original current execution access.</p> : null}
    {typeof demand.supervisorSessionId === 'string' || original ? <div className="goals-inline-actions">
      <Button type="button" data-goal-plan-request disabled={pending || busy || working} onClick={() => { setUnsentSelection(null); onRequest() }}>
        {pending ? `Preparing request to ${presentation.name ?? 'Supervisor'}…` : original ? `Check request to ${presentation.name ?? 'original Supervisor'}`
          : retained && retained.requestId !== unsentSelection ? `Check request to ${currentPresentation.name ?? 'Supervisor'}` : `Ask ${currentPresentation.name ?? 'Supervisor'} to ${split ? 'split work' : 'revise plan'}`}
      </Button>
      {newRequest && typeof demand.supervisorSessionId === 'string' ? <Button type="button" disabled={working || pending} onClick={() => void run(async () => {
        await useAppStore.getState().requestDemandPmoTask(demand.id, 'plan', { newRequest: true })
      })}>New request to {currentPresentation.name ?? 'current Supervisor'}</Button> : null}
      {typeof target === 'string' ? <Button type="button" onClick={() => requestAgentConversationFloatingOpen(targetHostId ? target : null,
        targetHostId, targetHostId === undefined ? 'The original Supervisor destination is unconfirmed. Check the retained request to read its destination.' : undefined)}>
        Open {presentation.name ?? 'Supervisor'} conversation</Button> : null}
      {canContinue ? <Button type="button" disabled={working} onClick={() => void run(async () => {
        const cut = beginGoalDelegationRead()
        applyGoalDelegationResult(await api.demands.delegation('goal.patrol.continue', { goalId: demand.id, patrolOperationId: original.operationId,
          operationId: mintObjectId(), expectedRunId: currentRun }), cut)
      })}>Continue original planning request</Button> : null}
    </div> : null}
    {firstDestination ? <div className="goals-inline-actions">
      <Button type="button" disabled={working || pending || busy} onClick={() => void run(sendFirstDestination)}>Send planning request</Button>
      <span className="goals-caption" title={`Host ${firstDestination.hostId} · Session ${firstDestination.agentSessionId} · Run ${firstDestination.runId}`}>First send to {firstPresentation.name ?? 'the current Supervisor'} on {firstHostName}.</span>
    </div> : null}
    {observed ? firstDestination ? <>
      <p className="goals-caption" role="status"><strong>Planning request saved · Not sent yet</strong></p>
      <details><summary>Original request observation</summary><p className="goals-caption">{observed.reason}</p></details>
    </> : <p className="goals-service" role="status"><strong>{labels[observed.state]}</strong><span>{observed.reason}</span></p>
      : original ? <p className="goals-caption" role="status">Planning request saved. Reading its original input receipt…</p>
      : retained ? <p className="goals-caption" role="status">Your planning request is retained. {demand.supervisorSessionId ? 'Check the original request before sending again.' : 'Choose a Supervisor, then explicitly send it.'}</p> : null}
    {issue ? <p className="goals-service" role="status">{issue} Your original request and work are retained.</p> : null}
    {choose ? <GoalAgentPicker demand={demand} role="supervisor" onSave={saveSupervisor} onClose={() => setChoose(false)} /> : null}
  </>
  return <div className="goal-plan__request" data-goal-plan-request-feedback>
    {split ? controls : <details open={Boolean(pendingRead || pending || choose || issue) || undefined}>
      <summary>Plan actions</summary>{controls}
    </details>}
  </div>
}
