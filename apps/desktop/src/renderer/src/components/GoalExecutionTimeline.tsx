import { useMemo } from 'react'
import { formatDuration } from '@agentmux/client-ui/conversation-time'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { delegationWorkerHostId } from '@agentmux/demand/delegations'
import type { DemandRecord } from '../lib/global-demand-board'
import type { GoalPlanNodeView, GoalPlanReadingTarget } from './GoalPlanGraph'
import { GoalPlanMark, goalPlanStateLabel } from './GoalPlanState'

type Event = { id: string; at: number; label: string }
type TimeSpan = { from: number; to: number }
type Row = { id: string; title: string; number?: number; target?: GoalPlanReadingTarget; events: Event[]; active?: TimeSpan; planned?: TimeSpan }
const format = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const Disclosure = semanticIconComponent('navigation.disclosure')

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
  const order = new Map([...nodes.keys()].map((id, index) => [id, index]))
  return [...rows.values()].sort((a, b) => (order.get(a.target?.nodeId ?? '') ?? order.size) - (order.get(b.target?.nodeId ?? '') ?? order.size))
}

export function GoalExecutionTimeline({ demand, nodes, selected, onSelect }: { demand: DemandRecord; nodes: readonly GoalPlanNodeView[]; selected: GoalPlanReadingTarget | null;
  onSelect: (target: GoalPlanReadingTarget, trigger: HTMLButtonElement) => void }) {
  const recorded = useMemo(() => goalExecutionRows(demand), [demand.plan, demand.delegations, demand.dispatches, demand.responsibility])
  const wholeGoal = nodes.find(item => item.wholeGoal)
  const rows: Row[] = wholeGoal && !recorded.length ? [{ id: `node:${wholeGoal.node.id}`, title: wholeGoal.node.title,
    target: { nodeId: wholeGoal.node.id, wholeGoal: true }, events: [] }] : [...recorded]
  const { plannedStartAt, targetAt } = demand
  if (plannedStartAt != null || targetAt != null) {
    const schedule: Row = { id: 'goal-schedule', title: 'Goal schedule', events: [] }
    if (plannedStartAt != null && targetAt != null && plannedStartAt <= targetAt) schedule.planned = { from: plannedStartAt, to: targetAt }
    else {
      if (plannedStartAt != null) schedule.events.push({ id: 'planned-start', at: plannedStartAt, label: 'Planned start' })
      if (targetAt != null) schedule.events.push({ id: 'planned-finish', at: targetAt, label: 'Target date' })
    }
    rows.unshift(schedule)
  }
  const onlyRow = rows.length === 1 ? rows[0] : undefined
  if (wholeGoal && onlyRow?.events.length && !onlyRow.target && !onlyRow.active && !onlyRow.planned) {
    return <section className="goal-execution-time" aria-label="Execution timeline" data-goal-execution-time>
      <h3>Execution timeline</h3>
      <div className="goal-execution-time__receipt-group" data-goal-time-row={onlyRow.id}>
        <strong>{onlyRow.title}</strong>
        <ul className="goal-execution-time__receipts">{onlyRow.events.map(event => <li key={event.id}>
          <span>{event.label}</span><time dateTime={new Date(event.at).toISOString()}>{format.format(event.at)}</time>
        </li>)}</ul>
      </div>
    </section>
  }
  if (onlyRow?.target && !onlyRow.events.length && !onlyRow.active && !onlyRow.planned) {
    const { target } = onlyRow
    const active = selected?.nodeId === target.nodeId && selected.attemptId === target.attemptId && selected.wholeGoal === target.wholeGoal
    return <section className="goal-execution-time goal-execution-time--empty" aria-label="Execution timeline" data-goal-execution-time data-goal-time-row={onlyRow.id}>
      <h3>Execution timeline</h3>
      <span>No times recorded</span>
      <button type="button" aria-label={`Read ${onlyRow.title}`} aria-pressed={active} onClick={event => onSelect(target, event.currentTarget)}>View task</button>
    </section>
  }
  const byId = new Map(nodes.map(item => [item.node.id, item]))
  let start = Infinity, end = -Infinity
  for (const row of rows) {
    for (const event of row.events) { start = Math.min(start, event.at); end = Math.max(end, event.at) }
    const interval = row.active ?? row.planned
    if (interval) { start = Math.min(start, interval.from); end = Math.max(end, interval.to) }
  }
  const hasTimes = Number.isFinite(start), span = end - start
  const ticks = !hasTimes ? [] : span < 60_000 ? [start] : span < 240_000 ? [start, end]
    : [start, start + span / 3, start + span * 2 / 3, end]
  const tickFormat = hasTimes && new Date(start).toDateString() === new Date(end).toDateString() ? clock : format
  const offset = (at: number) => (at - start) / Math.max(1, end - start) * 100
  return <section className="goal-execution-time" aria-label="Execution timeline" data-goal-execution-time>
    <h3>Execution timeline</h3>
    <div className="goal-execution-time__scroll"><div className="goal-execution-time__rows" data-timed={hasTimes || undefined}>
      <div className="goal-execution-time__row goal-execution-time__axis"><span>Task and attempt</span>
        <div>{hasTimes ? ticks.map(at => <time key={at} dateTime={new Date(at).toISOString()} title={format.format(at)}>{tickFormat.format(at)}</time>)
          : <span className="goal-execution-time__unrecorded">No schedule or execution times</span>}</div></div>
      {rows.map(row => {
        const { target, active: activity } = row
        const active = target && selected?.nodeId === target.nodeId && selected.attemptId === target.attemptId && selected.wholeGoal === target.wholeGoal
        const item = target && byId.get(target.nodeId)
        const previous = Boolean(target?.attemptId && item?.delegation?.operationId !== target.attemptId)
        const state = previous ? 'Previous attempt' : item ? goalPlanStateLabel(item) : undefined
        const attempt = row.number && row.number > 1 ? `Attempt ${row.number}` : undefined
        const duration = activity && formatDuration(activity.to - activity.from)
        const activityDetails = activity && `Observed activity · ${duration} · ${format.format(activity.from)} – ${format.format(activity.to)}`
        const times = [
          ...row.events.map(event => `${event.label}, ${format.format(event.at)}`),
          ...(activityDetails ? [activityDetails] : []),
          ...(row.planned ? [`Planned, ${format.format(row.planned.from)} – ${format.format(row.planned.to)}`] : [])
        ]
        const content = <>
          <span className="goal-execution-time__task" title={activityDetails}>{item && !previous ? <GoalPlanMark item={item} /> : null}
            <span><strong>{row.title}</strong>{target ? <Disclosure className="goal-execution-time__open" size={11} aria-hidden="true" /> : null}
              {state || attempt ? <small>{[state, attempt].filter(Boolean).join(' · ')}</small> : null}
              {duration ? <small className="goal-execution-time__activity-focus" aria-hidden="true">{duration} observed</small> : null}</span>
          </span>
          {times.length ? <span className="goal-execution-time__track" role={target ? undefined : 'img'} aria-label={target ? undefined : times.join(' · ')} aria-hidden={target ? true : undefined}>
            {ticks.slice(1, -1).map(at => <span className="goal-execution-time__guide" key={at} style={{ left: `${offset(at)}%` }} aria-hidden="true" />)}
            {activity ? <span className="goal-execution-time__live" data-goal-observed-activity style={{ left: `${offset(activity.from)}%`, width: `${offset(activity.to) - offset(activity.from)}%` }}
              title={activityDetails}><span className="goal-execution-time__bar-summary">{duration} observed</span></span> : null}
            {row.planned ? <span className="goal-execution-time__planned" data-goal-planned-period style={{ left: `${offset(row.planned.from)}%`, width: `${offset(row.planned.to) - offset(row.planned.from)}%` }}
              title={`Planned · ${format.format(row.planned.from)} – ${format.format(row.planned.to)}`}>Planned</span> : null}
            {row.events.map(event => <span className="goal-execution-time__point" key={event.id} data-goal-time-event={event.label} style={{ left: `${offset(event.at)}%` }}
              title={`${event.label} · ${format.format(event.at)}`} />)}
          </span> : <span className="goal-execution-time__track goal-execution-time__track--empty">No attempt recorded</span>}
        </>
        return target ? <button type="button" className="goal-execution-time__row goal-execution-time__row--action" key={row.id}
          data-goal-time-row={row.id} data-selected={active || undefined} aria-pressed={Boolean(active)}
          aria-label={[`Read ${row.title}`, state, attempt, ...times].filter(Boolean).join(' · ')}
          onClick={event => onSelect(target, event.currentTarget)}>{content}</button>
          : <div className="goal-execution-time__row" key={row.id} data-goal-time-row={row.id}>{content}</div>
      })}
    </div></div>
  </section>
}
