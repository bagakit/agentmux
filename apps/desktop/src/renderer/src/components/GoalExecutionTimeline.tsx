import { useLayoutEffect, useMemo, useRef } from 'react'
import { delegationWorkerHostId } from '@agentmux/demand/delegations'
import type { DemandRecord } from '../lib/global-demand-board'
import type { GoalPlanReadingTarget } from './GoalPlanGraph'

type Event = { id: string; at: number; label: string }
type Row = { id: string; title: string; number?: number; target?: GoalPlanReadingTarget; events: Event[]; active?: { from: number; to: number } }
const format = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** Receipt times are events. Only an exact, confirmed activity observation can supply a live span. */
export function goalExecutionRows(demand: Pick<DemandRecord, 'plan' | 'delegations' | 'dispatches' | 'responsibility'>): Row[] {
  const nodes = new Map((demand.plan?.nodes ?? []).map(node => [node.id, node.title]))
  const live = new Map((demand.responsibility?.executions ?? []).filter(row => row.execution.kind === 'delegation').map(row => [row.execution.operationId, row]))
  const counts = new Map<string, number>()
  const rows = new Map<string, Row>()
  for (const attempt of demand.delegations ?? []) {
    const nodeId = attempt.planNodeId && nodes.has(attempt.planNodeId) ? attempt.planNodeId : undefined
    const row: Row = { id: attempt.operationId, title: nodeId ? nodes.get(nodeId)! : 'Delegated work', events: [{ id: 'prepare', at: attempt.preparedAt, label: 'Delegation prepared' }] }
    if (nodeId) {
      row.number = (counts.get(nodeId) ?? 0) + 1
      counts.set(nodeId, row.number)
      row.target = { nodeId, attemptId: attempt.operationId }
    }
    if (attempt.linkedAt !== undefined) row.events.push({ id: 'link', at: attempt.linkedAt, label: 'Original dispatch linked' })
    if (attempt.report) row.events.push({ id: 'report', at: attempt.report.submittedAt, label: 'Report recorded' })
    const fact = live.get(attempt.operationId), observation = fact?.observation, from = fact?.stateSince, execution = fact?.execution
    if (!attempt.report && attempt.linkedAt !== undefined && from !== undefined && from >= attempt.linkedAt && fact?.binding === 'confirmed' &&
      fact.phase === 'executing' && observation?.semantic === 'active' && !observation.stale && observation.observedAt > from &&
      execution && !('target' in execution) && execution.hostId === delegationWorkerHostId(attempt) &&
      execution.runId === attempt.workerRunId && execution.agentSessionId === attempt.workerAgentSessionId) {
      row.active = { from, to: observation.observedAt }
    }
    rows.set(row.id, row)
  }
  for (const review of demand.plan?.reviews ?? []) {
    const row = rows.get(review.delegationOperationId)
    if (row?.target?.nodeId === review.nodeId) row.events.push({ id: review.operationId, at: review.reviewedAt, label: review.verdict === 'pass' ? 'Review passed' : 'Changes requested' })
  }
  for (const [nodeId, title] of nodes) if (!counts.has(nodeId)) rows.set(`node:${nodeId}`, { id: `node:${nodeId}`, title, target: { nodeId }, events: [] })
  for (const start of demand.dispatches ?? []) {
    if (start.execution !== 'finite') continue
    const at = start.stage === 'requested' ? start.request.requestedAt : start.stage === 'rejected' ? start.requestedAt : start.preparedAt
    const events = [{ id: 'request', at, label: start.stage === 'rejected' ? 'Request refused' : 'Request saved' }]
    if (start.receipt) events.push({ id: 'receipt', at: start.receipt.kind === 'core-input' ? start.receipt.observedAt : start.receipt.createdAt, label: 'Original input recorded' })
    rows.set(`start:${start.operationId}`, { id: `start:${start.operationId}`, title: 'One-time task', events })
  }
  return [...rows.values()]
}

export function GoalExecutionTimeline({ demand, selected, onSelect }: { demand: DemandRecord; selected: GoalPlanReadingTarget | null;
  onSelect: (target: GoalPlanReadingTarget, trigger: HTMLButtonElement) => void }) {
  const timeline = useRef<HTMLDetailsElement>(null)
  const rows = useMemo(() => goalExecutionRows(demand), [demand.plan, demand.delegations, demand.dispatches, demand.responsibility])
  let start = Infinity, end = -Infinity
  for (const row of rows) for (const at of [...row.events.map(event => event.at), ...(row.active ? [row.active.from, row.active.to] : [])]) {
    start = Math.min(start, at); end = Math.max(end, at)
  }
  const hasTimes = Number.isFinite(start)
  useLayoutEffect(() => {
    if (timeline.current) timeline.current.open = (timeline.current.closest('.goals-detail')?.clientWidth ?? 0) >= 960
  }, [hasTimes])
  if (!hasTimes) return null
  const offset = (at: number) => (at - start) / Math.max(1, end - start) * 100
  return <details ref={timeline} className="goal-execution-time" data-goal-execution-time>
    <summary>Execution history</summary>
    <div className="goal-execution-time__scroll"><div className="goal-execution-time__rows">
      <div className="goal-execution-time__row goal-execution-time__axis"><span>Task and attempt</span><div><time>{format.format(start)}</time>{end > start ? <time>{format.format(end)}</time> : null}</div></div>
      {rows.map(row => {
        const { target } = row
        const active = target && selected?.nodeId === target.nodeId && selected.attemptId === target.attemptId
        return <div className="goal-execution-time__row" key={row.id} data-goal-time-row={row.id} data-selected={active || undefined}>
          <div>{target ? <button type="button" aria-pressed={Boolean(active)} onClick={event => onSelect(target, event.currentTarget)}>{row.title}</button> : <strong>{row.title}</strong>}
            {row.number ? <small>Attempt {row.number}</small> : !row.events.length ? <small>No attempt recorded</small> : null}</div>
          <div className="goal-execution-time__track" aria-label={row.events.map(event => `${event.label}, ${format.format(event.at)}`).join(' · ') || 'No attempt recorded'}>
            {row.active ? <span className="goal-execution-time__live" data-goal-observed-activity style={{ left: `${offset(row.active.from)}%`, width: `${offset(row.active.to) - offset(row.active.from)}%` }}
              title={`Observed active through ${format.format(row.active.to)}`} /> : null}
            {row.events.map(event => <span className="goal-execution-time__point" key={event.id} data-goal-time-event={event.label} style={{ left: `${offset(event.at)}%` }}
              title={`${event.label} · ${format.format(event.at)}`} />)}
          </div>
        </div>
      })}
    </div></div>
    <p className="goals-caption">Dots mark saved events. A dashed bar ends at the last confirmed activity observation.</p>
  </details>
}
