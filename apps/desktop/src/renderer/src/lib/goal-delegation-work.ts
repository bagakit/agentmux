import { useEffect } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { GoalDelegationResult } from '@agentmux/core/goal-delegation'
import { api } from './api'
import { useAppStore } from '../store'
import type { DemandRecord } from './global-demand-board'
import { createGoalDelegationEvents } from './goal-delegation-events'

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
    return { demands: { ...state.demands, [result.goalId]: { ...retained, delegations: result.delegations,
      delegationReadCut: { goalUpdatedAt: result.goalUpdatedAt, request },
      delegationObservations: result.observations ?? [], ...(result.grounding ? { grounding: result.grounding } : {}) } } }
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
  const references = JSON.stringify((goal.delegations ?? []).map(item => [item.hostId, item.operationId,
    item.sourceMessageId, item.workerRunId, item.report?.replyMessageId, item.collection?.operationId]))
  useEffect(() => {
    if (!active || !goal.delegations?.length) return
    const changed = () => { void refreshGoalDelegations(goal.id) }
    const release = observe(goal.id, goal.delegations, changed)
    changed()
    return release
  }, [active, goal.id, references])
}
