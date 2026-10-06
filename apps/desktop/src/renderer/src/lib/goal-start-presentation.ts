import type { DemandDispatch, GoalStartObservation } from '@agentmux/demand'
import type { DemandRecord } from './global-demand-board'

export type GoalStartRow = {
  start: DemandDispatch
  observation?: GoalStartObservation
  state: 'review' | 'continuation' | 'working' | 'unknown'
  next: string
  issue?: string
}

/** A Goal result has no implicit worker association. Original Start and Core input stay distinct. */
export function goalStartRows(goal: Pick<DemandRecord, 'dispatches' | 'startObservations' | 'delegationObservationIssue'>): GoalStartRow[] {
  const observed = new Map(goal.startObservations?.map(item => [item.operationId, item]))
  return (goal.dispatches ?? []).filter(start => start.execution === 'finite').map(start => {
    const observation = observed.get(start.operationId)
    const issue = goal.delegationObservationIssue ?? observation?.unknown ?? observation?.input.reason
    const row = { start, ...(observation ? { observation } : {}), ...(issue ? { issue } : {}) }
    const run = observation?.originalRun?.runId === start.runId ? observation.originalRun : undefined
    if (observation?.goalResult?.changedSinceStart === true)
      return { ...row, state: 'review', next: 'Goal results need review · Start association unknown' }
    if (run?.state === 'exited' || run?.state === 'interrupted')
      return { ...row, state: 'continuation', next: run.state === 'exited' ? 'Agent ended · Check Goal results or continue' : 'Interrupted · Continue the original Agent' }
    if (run?.state === 'running' && observation?.input.state === 'confirmed')
      return { ...row, state: 'working', next: 'Original Start received · Awaiting Goal results' }
    return { ...row, state: 'unknown', next: 'Start observation unknown · Check original input' }
  })
}

export function goalStartNextStep(goal: Parameters<typeof goalStartRows>[0]): string | null {
  const rows = goalStartRows(goal)
  for (const state of ['review', 'continuation', 'unknown', 'working'] as const) {
    const row = rows.find(item => item.state === state)
    if (row) return row.next
  }
  return null
}
