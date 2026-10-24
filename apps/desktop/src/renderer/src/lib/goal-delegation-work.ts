import { useEffect } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { GoalDelegationResult } from '@agentmux/core/goal-delegation'
import { api } from './api'
import { useAppStore } from '../store'
import type { DemandRecord } from './global-demand-board'
import { createGoalDelegationEvents } from './goal-delegation-events'
import { updateCurrentDemandIndex } from './goal-current-work'

const observe = createGoalDelegationEvents({ sessions: listener => api.sessions.onEvent(listener), demands: listener => api.demands.onChanged(listener) })
const flights = new Map<string, { reread: boolean; promise: Promise<void> }>()
let requestSequence = 0
export function beginGoalDelegationRead(): number { return ++requestSequence }

export function applyGoalDelegationResult(result: GoalDelegationResult, request = beginGoalDelegationRead()): void {
  useAppStore.setState(state => {
    const original = state.demands[result.goalId]
    if (!original) return state
    const retainedCut = original.delegationReadCut
    if (result.goalUpdatedAt < Math.max(original.updatedAt, retainedCut?.goalUpdatedAt ?? 0) ||
      result.goalUpdatedAt === retainedCut?.goalUpdatedAt && request < retainedCut.request) return state
    const { delegationObservationIssue: _issue, ...retained } = original
    const demands = { ...state.demands, [result.goalId]: { ...retained, ...(result.goalState ? result.goalState : {}), updatedAt: Math.max(original.updatedAt, result.goalUpdatedAt), delegations: result.delegations,
      delegationReadCut: { goalUpdatedAt: result.goalUpdatedAt, request },
      delegationObservations: result.observations ?? [], ...(result.dispatches ? { dispatches: result.dispatches } : {}),
      ...(result.progressUpdates ? { progressUpdates: result.progressUpdates } : {}),
      ...(result.patrols ? { patrols: result.patrols } : {}), ...(result.patrolObservations ? { patrolObservations: result.patrolObservations } : {}), ...(result.responsibility ? { responsibility: result.responsibility } : {}),
      ...(result.startObservations ? { startObservations: result.startObservations } : {}), ...(result.grounding ? { grounding: result.grounding } : {}) } }
    updateCurrentDemandIndex(state.demands, demands, [result.goalId])
    return { demands }
  })
}

/** Shared reads coalesce visible consumers; a change during a read requests one fresh cut. */
export function refreshGoalDelegations(goalId: string): Promise<void> {
  const current = flights.get(goalId)
  if (current) { current.reread = true; return current.promise }
  const flight = { reread: false, promise: Promise.resolve() }
  flight.promise = Promise.resolve().then(async () => {
    do {
      flight.reread = false
      const request = beginGoalDelegationRead()
      try { applyGoalDelegationResult(await api.demands.delegation('goal.delegations', { goalId }), request) }
      catch (error) {
        useAppStore.setState(state => {
          const original = state.demands[goalId]
          if (original?.delegationReadCut && request < original.delegationReadCut.request) return state
          return original ? { demands: { ...state.demands, [goalId]: { ...original, delegationObservationIssue: presentError(error),
            delegationReadCut: { goalUpdatedAt: Math.max(original.updatedAt, original.delegationReadCut?.goalUpdatedAt ?? 0), request } } } } : state
        })
      }
    } while (flight.reread)
  }).finally(() => { if (flights.get(goalId) === flight) flights.delete(goalId) })
  flights.set(goalId, flight)
  return flight.promise
}

export function useGoalDelegationObservation(goal: DemandRecord, active = true): void {
  const references = JSON.stringify([(goal.delegations ?? []).map(item => [item.hostId, item.operationId,
    item.sourceMessageId, item.workerRunId, item.report?.replyMessageId, item.collection?.operationId]),
    (goal.dispatches ?? []).filter(start => start.execution === 'finite').map(start => [start.hostId, start.operationId, start.runId])])
  useEffect(() => {
    if (!active || !goal.delegations?.length && !goal.dispatches?.some(start => start.execution === 'finite')) return
    const changed = () => { void refreshGoalDelegations(goal.id) }
    const release = observe(goal.id, goal.delegations ?? [], changed, goal.dispatches ?? [])
    changed()
    return release
  }, [active, goal.id, references])
}

/** App-lifetime domain consumer. Closing a detail or Region does not stop responsibility reads. */
export function initializeGoalResponsibilityObservation(invalidated?: (goalIds: readonly string[]) => void): () => void {
  let active = true
  const factReads = new Map<string, { reread: boolean; promise: Promise<void> }>()
  const refresh = (id: string) => {
    const current = factReads.get(id)
    if (current) { current.reread = true; return }
    const flight = { reread: false, promise: Promise.resolve() }
    flight.promise = Promise.resolve().then(async () => {
      do {
        flight.reread = false
        try { await useAppStore.getState().refreshDemand(id) }
        catch (error) { if (active && (error as { code?: string })?.code !== 'GOAL_OWNER_NOT_FOUND') useAppStore.getState().reportError(error) }
      } while (active && flight.reread)
    }).finally(() => { if (factReads.get(id) === flight) factReads.delete(id) })
    factReads.set(id, flight)
  }
  const changed = (goalIds: readonly string[], snapshot: boolean) => {
    const ids = [...new Set(snapshot ? [...goalIds, ...Object.keys(useAppStore.getState().demands)] : goalIds)]
    invalidated?.(ids)
    for (const id of ids) refresh(id)
  }
  const releaseChanges = api.demands.onChanged(changed)
  const releaseIssue = api.demands.onObservationIssue(message => { if (message) useAppStore.getState().reportError(message) })
  changed(Object.keys(useAppStore.getState().demands), false)
  return () => { active = false; releaseChanges(); releaseIssue() }
}

/** Startup supplies its actual original ids once; subsequent invalidations already name affected Goals. */
export function refreshKnownGoalResponsibilities(goalIds: readonly string[]): void {
  const goals = useAppStore.getState().demands
  for (const id of goalIds) {
    const goal = goals[id]
    if (goal && goal.status !== 'done' && goal.status !== 'cancelled' && (goal.delegations?.length || goal.dispatches?.some(item => item.execution === 'finite')))
      void refreshGoalDelegations(id)
  }
}
