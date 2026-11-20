import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import { formatDuration } from '@agentmux/client-ui/conversation-time'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { delegationWorkerHostId } from '@agentmux/demand/delegations'
import type { DemandRecord } from '../lib/global-demand-board'
import type { GoalPlanNodeView, GoalPlanReadingTarget, GoalPlanReveal } from './GoalPlanGraph'
import { useWorkbenchNameTooltip } from './WorkbenchNameTooltip'
import { markWindowOverlayDismissal, wasWindowOverlayDismissed } from './WindowOverlayHost'
import { GoalPlanMark, goalPlanStateLabel } from './GoalPlanState'

type TimelineEvent = { id: string; at: number; label: string; result: string; actor?: string; reference?: string; note?: string; reviewOperationId?: string }
type TimeSpan = { from: number; to: number }
type OriginalWork = { kind: 'start' | 'delegation'; operationId: string }
type Row = { id: string; title: string; number?: number; target?: GoalPlanReadingTarget; original?: OriginalWork; events: TimelineEvent[]; active?: TimeSpan; planned?: TimeSpan }
type OpenEvent = { row: Row; event: TimelineEvent; trigger: HTMLButtonElement }
const eventTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' })
const unknownActor = 'Unknown author'
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
    const row: Row = { id: attempt.operationId, title: nodeId ? nodes.get(nodeId)! : 'Delegated work',
      original: { kind: 'delegation', operationId: attempt.operationId },
      events: [{ id: 'prepare', at: attempt.preparedAt, label: 'Delegation prepared', result: 'Preparation recorded',
        actor: attempt.ownerAgentSessionId + ' · ' + attempt.hostId, reference: attempt.operationId }] }
    if (nodeId) {
      row.number = (counts.get(nodeId) ?? 0) + 1
      counts.set(nodeId, row.number)
      row.target = { nodeId, attemptId: attempt.operationId }
    }
    if (attempt.linkedAt !== undefined) row.events.push({ id: 'link', at: attempt.linkedAt, label: 'Original dispatch linked',
      result: 'Original dispatch association verified', reference: attempt.sourceMessageId })
    if (attempt.report) row.events.push({ id: 'report', at: attempt.report.submittedAt, label: 'Report recorded',
      result: 'Worker report saved', actor: attempt.report.authorAgentSessionId + ' · ' + delegationWorkerHostId(attempt),
      reference: attempt.report.replyMessageId, note: attempt.report.grounding.summary })
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
    if (row?.target?.nodeId === review.nodeId) row.events.push({ id: `review:${review.operationId}`, at: review.reviewedAt,
      label: review.verdict === 'pass' ? 'Review passed' : 'Changes requested', result: review.check.result || (review.verdict === 'pass' ? 'Passed' : 'Changes requested'),
      actor: [review.reviewer.id, review.reviewer.hostId].filter(Boolean).join(' · '), reference: review.operationId,
      note: review.note, reviewOperationId: review.operationId })
  }
  for (const [nodeId, title] of nodes) if (!counts.has(nodeId)) rows.set(`node:${nodeId}`, { id: `node:${nodeId}`, title, target: { nodeId }, events: [] })
  for (const start of demand.dispatches ?? []) {
    if (start.execution !== 'finite') continue
    const rejected = start.stage === 'rejected'
    const at = start.stage === 'requested' ? start.request.requestedAt : rejected ? start.requestedAt : start.preparedAt
    const events: TimelineEvent[] = [{ id: 'request', at, label: rejected ? 'Request refused' : 'Request saved',
      result: rejected ? 'Original request rejected' : 'Original request retained', reference: start.operationId }]
    const receipt = start.receipt
    if (receipt) events.push({ id: 'receipt', at: receipt.kind === 'core-input' ? receipt.observedAt : receipt.createdAt,
      label: 'Original input recorded', result: receipt.kind === 'core-input'
        ? receipt.outcome === 'terminal-confirmed' ? 'Terminal input confirmed' : 'Input admitted' : 'Core prompt saved',
      reference: receipt.kind === 'core-input' ? receipt.inputKey.submissionId : receipt.itemId })
    rows.set(`start:${start.operationId}`, { id: `start:${start.operationId}`, title: 'One-time task',
      original: { kind: 'start', operationId: start.operationId }, events })
  }
  const order = new Map([...nodes.keys()].map((id, index) => [id, index]))
  return [...rows.values()].sort((a, b) => (order.get(a.target?.nodeId ?? '') ?? order.size) - (order.get(b.target?.nodeId ?? '') ?? order.size))
}

function TimelineEventButton({ event, open, detailsId, style, onOpen }: {
  event: TimelineEvent; open: boolean; detailsId: string; style?: CSSProperties | undefined; onOpen: (trigger: HTMLButtonElement) => void
}) {
  const preview = useWorkbenchNameTooltip(event.label, `${eventTime.format(event.at)} · ${event.actor || unknownActor} · ${event.result}`, open,
    { placement: 'top', pointerPassThrough: true })
  return <><button type="button" className={style ? 'goal-execution-time__point' : 'goal-execution-time__receipt'}
    {...preview.props} data-goal-time-event={event.label} data-goal-time-event-id={event.id} style={style}
    aria-label={style ? event.label : undefined} aria-expanded={open} aria-controls={open ? detailsId : undefined}
    onKeyDown={e => { if (e.key === 'Escape' && wasWindowOverlayDismissed(e.nativeEvent)) e.stopPropagation() }}
    onClick={e => { preview.cancelHover(); onOpen(e.currentTarget) }}>
    {style ? null : <><span>{event.label}</span><time dateTime={new Date(event.at).toISOString()}>{format.format(event.at)}</time></>}
  </button>{preview.content}</>
}

/** Place colliding points on separate lanes without changing their time coordinates. */
function timelinePoints(events: TimelineEvent[], offset: (at: number) => number) {
  const lastPosition: number[] = []
  const points = [...events].sort((left, right) => left.at - right.at).map(event => {
    const position = offset(event.at)
    // The narrowest plot is over 285px. Nine percent leaves room for a 24px hit target.
    const free = lastPosition.findIndex(last => position - last >= 9)
    const lane = free === -1 ? lastPosition.length : free
    lastPosition[lane] = position
    return { event, position, lane }
  })
  return { points, lanes: Math.max(1, lastPosition.length) }
}

export function GoalExecutionTimeline({ demand, nodes, selected, onSelect, onOpenRecord }: {
  demand: DemandRecord; nodes: readonly GoalPlanNodeView[]; selected: GoalPlanReadingTarget | null
  onSelect: (selection: GoalPlanReveal) => void
  onOpenRecord: (target: OriginalWork) => boolean
}) {
  const timeline = useRef<HTMLElement>(null), detail = useRef<HTMLHeadingElement>(null)
  const detailsId = useId()
  const [openEvent, setOpenEvent] = useState<OpenEvent | null>(null)
  const [sourceUnavailable, setSourceUnavailable] = useState(false)
  useLayoutEffect(() => {
    if (openEvent) detail.current?.focus()
  }, [openEvent])

  function eventButton(row: Row, event: TimelineEvent, style?: CSSProperties) {
    return <TimelineEventButton key={event.id} event={event} style={style} detailsId={detailsId}
      open={openEvent?.row.id === row.id && openEvent.event.id === event.id}
      onOpen={trigger => { setSourceUnavailable(false); setOpenEvent({ row, event, trigger }) }} />
  }
  function restoreEvent({ row, event, trigger }: OpenEvent) {
    const originalRow = timeline.current?.querySelector<HTMLElement>(`[data-goal-time-row="${CSS.escape(row.id)}"]`)
    const point = originalRow?.querySelector<HTMLElement>(`[data-goal-time-event-id="${CSS.escape(event.id)}"]`)
    const focus = trigger.isConnected ? trigger : point ?? originalRow?.querySelector<HTMLElement>('[data-goal-time-open]') ?? originalRow ?? timeline.current
    focus?.focus()
  }
  function closeEvent() {
    if (openEvent) restoreEvent(openEvent)
    setOpenEvent(null)
  }
  const recorded = useMemo(() => goalExecutionRows(demand), [demand.plan, demand.delegations, demand.dispatches, demand.responsibility])
  const wholeGoal = nodes.find(item => item.wholeGoal)
  const rows: Row[] = wholeGoal && !recorded.length ? [{ id: `node:${wholeGoal.node.id}`, title: wholeGoal.node.title,
    target: { nodeId: wholeGoal.node.id, wholeGoal: true }, events: [] }] : [...recorded]
  const { plannedStartAt, targetAt } = demand
  if (plannedStartAt != null || targetAt != null) {
    const schedule: Row = { id: 'goal-schedule', title: 'Goal schedule', events: [] }
    if (plannedStartAt != null && targetAt != null && plannedStartAt <= targetAt) schedule.planned = { from: plannedStartAt, to: targetAt }
    else {
      if (plannedStartAt != null) schedule.events.push({ id: 'planned-start', at: plannedStartAt, label: 'Planned start', result: 'Saved planned start' })
      if (targetAt != null) schedule.events.push({ id: 'planned-finish', at: targetAt, label: 'Target date', result: 'Saved target date' })
    }
    rows.unshift(schedule)
  }
  const currentRow = rows.find(row => row.id === openEvent?.row.id)
  const currentEvent = currentRow?.events.find(event => event.id === openEvent?.event.id)
  const eventDetail = openEvent && (() => {
    const { row, event, trigger } = openEvent
    const reading = currentEvent ?? event
    const target = currentRow?.target
    const original = currentRow?.original
    const restoreFocus = () => restoreEvent(openEvent)
    function openOriginal() {
      if (target) {
        onSelect({ target: { ...target, ...(event.reviewOperationId ? { reviewOperationId: event.reviewOperationId } : {}) }, trigger, restoreFocus })
      } else if (!original || !onOpenRecord(original)) {
        setSourceUnavailable(true)
        return
      }
      setOpenEvent(null)
    }
    return <section className="goal-execution-time__detail" id={detailsId} aria-labelledby={detailsId + '-title'} onKeyDown={e => {
      if (e.key === 'Escape' && !e.nativeEvent.isComposing && !e.defaultPrevented && !wasWindowOverlayDismissed(e.nativeEvent)) {
        markWindowOverlayDismissal(e.nativeEvent)
        e.stopPropagation()
        closeEvent()
      }
    }}>
      <div className="goal-execution-time__detail-heading"><div><h4 ref={detail} id={detailsId + '-title'} tabIndex={-1}>{reading.label}</h4>
          <span>{row.title}</span></div>
        <Button type="button" onClick={closeEvent}>Close</Button></div>
      <dl><div><dt>Time</dt><dd><time dateTime={new Date(reading.at).toISOString()}>{eventTime.format(reading.at)}</time></dd></div>
        <div><dt>Author</dt><dd>{reading.actor || unknownActor}</dd></div>
        <div><dt>Result</dt><dd>{reading.result}</dd></div>
        {reading.reference ? <div><dt>Reference</dt><dd><code>{reading.reference}</code></dd></div> : null}</dl>
      {reading.note ? <p>{reading.note}</p> : null}
      {!currentEvent || sourceUnavailable ? <p className="goals-service" role="status">The original event source is unavailable.</p> : null}
      {currentEvent && (target || original) ? <Button type="button" onClick={openOriginal}>
        {event.reviewOperationId ? 'Open original review' : target?.attemptId ? 'Open original attempt' : target ? 'Open Ticket' : 'Open original record'}
      </Button> : null}
    </section>
  })()
  const onlyRow = rows.length === 1 ? rows[0] : undefined
  if (wholeGoal && onlyRow?.events.length && !onlyRow.target && !onlyRow.active && !onlyRow.planned) {
    return <section ref={timeline} tabIndex={-1} className="goal-execution-time" aria-label="Execution timeline" data-goal-execution-time>
      <h3>Execution timeline</h3>
      <div className="goal-execution-time__receipt-group" data-goal-time-row={onlyRow.id} tabIndex={-1}>
        <strong>{onlyRow.title}</strong>
        <ul className="goal-execution-time__receipts">{onlyRow.events.map(event => <li key={event.id}>{eventButton(onlyRow, event)}</li>)}</ul>
      </div>
      {eventDetail}
    </section>
  }
  if (onlyRow?.target && !onlyRow.events.length && !onlyRow.active && !onlyRow.planned) {
    const { target } = onlyRow
    const active = selected?.nodeId === target.nodeId && selected.attemptId === target.attemptId && selected.wholeGoal === target.wholeGoal
    return <section ref={timeline} tabIndex={-1} className="goal-execution-time goal-execution-time--empty" aria-label="Execution timeline" data-goal-execution-time data-goal-time-row={onlyRow.id}>
      <h3>Execution timeline</h3>
      <span>No times recorded</span>
      <button type="button" data-goal-time-open aria-label={`Read ${onlyRow.title}`} aria-pressed={active} onClick={event => onSelect({ target, trigger: event.currentTarget })}>View task</button>
      {eventDetail}
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
  return <section ref={timeline} tabIndex={-1} className="goal-execution-time" aria-label="Execution timeline" data-goal-execution-time>
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
        const marker = <>
          {item && !previous ? <GoalPlanMark item={item} /> : null}
          <span><strong>{row.title}</strong>{target ? <Disclosure className="goal-execution-time__open" size={11} aria-hidden="true" /> : null}
            {state || attempt ? <small>{[state, attempt].filter(Boolean).join(' · ')}</small> : null}
            {duration ? <small className="goal-execution-time__activity-focus" aria-hidden="true">{duration} observed</small> : null}</span>
        </>
        const { points, lanes } = timelinePoints(row.events, offset)
        const title = [`Read ${row.title}`, state, attempt, activityDetails].filter(Boolean).join(' · ')
        function selectRow(trigger: HTMLButtonElement) { if (target) onSelect({ target, trigger }) }
        return <div className={`goal-execution-time__row${target ? ' goal-execution-time__row--action' : ''}`} key={row.id}
          data-goal-time-row={row.id} data-selected={active || undefined} tabIndex={-1}>
          {target ? <button className="goal-execution-time__task" type="button" data-goal-time-open aria-pressed={Boolean(active)}
            aria-label={title} title={activityDetails} onClick={e => selectRow(e.currentTarget)}>{marker}</button>
            : <div className="goal-execution-time__task">{marker}</div>}
          {row.events.length || activity || row.planned ? <div className="goal-execution-time__track" style={{ '--goal-event-lanes': lanes } as CSSProperties}>
            {ticks.slice(1, -1).map(at => <span className="goal-execution-time__guide" key={at} style={{ left: `${offset(at)}%` }} aria-hidden="true" />)}
            {target ? <button className="goal-execution-time__track-open" type="button" tabIndex={-1} aria-label={title}
              onClick={e => {
                const rowButton = e.currentTarget.parentElement?.parentElement?.querySelector<HTMLButtonElement>('[data-goal-time-open]')
                if (rowButton) selectRow(rowButton)
              }}>
              {activity ? <span className="goal-execution-time__live" data-goal-observed-activity style={{ left: `${offset(activity.from)}%`, width: `${offset(activity.to) - offset(activity.from)}%` }}
                title={activityDetails}><span className="goal-execution-time__bar-summary">{duration} observed</span></span> : null}
            </button> : null}
            {row.planned ? <span className="goal-execution-time__planned" data-goal-planned-period style={{ left: `${offset(row.planned.from)}%`, width: `${offset(row.planned.to) - offset(row.planned.from)}%` }}
              role="img" aria-label={`Planned · ${format.format(row.planned.from)} – ${format.format(row.planned.to)}`}
              title={`Planned · ${format.format(row.planned.from)} – ${format.format(row.planned.to)}`}>Planned</span> : null}
            {points.map(({ event, position, lane }) => eventButton(row, event, { left: `${position}%`, '--goal-event-lane': lane } as CSSProperties))}
          </div> : <span className="goal-execution-time__track goal-execution-time__track--empty">No attempt recorded</span>}
        </div>
      })}
    </div></div>
    {eventDetail}
  </section>
}
