import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import { formatDuration } from '@agentmux/client-ui/conversation-time'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { delegationWorkerHostId } from '@agentmux/demand/delegations'
import type { GoalPlanReviewer } from '@agentmux/demand/goal-plan'
import type { DemandRecord } from '../lib/global-demand-board'
import { api } from '../lib/api'
import type { GoalPlanNodeView, GoalPlanReadingTarget, GoalPlanReveal } from './GoalPlanGraph'
import { useWorkbenchNameTooltip } from './WorkbenchNameTooltip'
import { markWindowOverlayDismissal, wasWindowOverlayDismissed } from './WindowOverlayHost'
import { GoalPlanMark, goalPlanRevisionPresentation, goalPlanStateLabel } from './GoalPlanState'

export type GoalTimelineOriginal = { kind: 'start' | 'delegation'; operationId: string }
  | { kind: 'confirmation'; revision: number; at: number }
  | { kind: 'coordination'; key: string }
type TimelineEvent = {
  id: string; at: number; label: string; result: string; actor?: string; participant?: 'user' | 'device'
  reference?: string; note?: string; original?: GoalTimelineOriginal; reviewOperationId?: string
  approval?: ApprovalObservation
}
type ApprovalObservation = NonNullable<DemandRecord['approvalObservations']>[number]
type TimeSpan = { from: number; to: number }
type Row = { id: string; title: string; number?: number; ticket?: true; target?: GoalPlanReadingTarget; original?: GoalTimelineOriginal; events: TimelineEvent[]; active?: TimeSpan; planned?: TimeSpan }
type TimelineSource = Pick<DemandRecord, 'id' | 'alignment' | 'plan' | 'delegations' | 'dispatches' | 'patrols' | 'responsibility' | 'approvalObservations'>
type OpenEvent = { row: Row; event: TimelineEvent; trigger: HTMLButtonElement }
function timelineRowKey(row: Row): string {
  return row.original?.kind === 'delegation' ? `delegation:${row.id}` : row.id
}
const eventTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' })
const unknownActor = 'Unknown author'
const format = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const Disclosure = semanticIconComponent('navigation.disclosure')

function participantIdentity(author: Pick<GoalPlanReviewer, 'kind' | 'id'> | undefined) {
  if (!author || author.kind === 'agent') return undefined
  return { participant: author.kind, actor: `${author.kind === 'user' ? 'User' : 'Device'} ${author.id}` }
}

const approvalDecision = { approved: 'Approved', denied: 'Denied', cancelled: 'Cancelled', recorded: 'Response recorded' }
const approvalDelivery = { saved: 'Response saved', unknown: 'Delivery unconfirmed', 'bytes-accepted': 'Input accepted',
  'hook-written': 'Response written to Provider connection', 'acp-acknowledged': 'Provider acknowledged receipt' }

function OriginalApproval({ approval }: { approval: ApprovalObservation }) {
  const [reading, setReading] = useState<'idle' | 'loading' | 'unavailable' | { delivery: ApprovalObservation['delivery']; nativeCompleted: boolean }>('idle')
  const originalReading = useRef<HTMLDListElement>(null)
  const { attribution, operationId, requestId } = approval, { inputKey } = attribution
  const loaded = typeof reading === 'object' ? reading : undefined
  useLayoutEffect(() => { if (loaded) originalReading.current?.focus() }, [loaded])
  async function read() {
    setReading('loading')
    try {
      const receipt = await api.sessions.inspectInteraction({ kind: 'agent', hostId: 'local', agentSessionId: inputKey.agentSessionId, run: inputKey.expectedRun }, operationId)
      const original = receipt?.goalApproval
      if (!receipt || receipt.operationId !== operationId || receipt.expectedRequest.id !== requestId || receipt.run.runId !== inputKey.expectedRun.runId ||
          !original || original.goalId !== attribution.goalId || original.dispatchOperationId !== attribution.dispatchOperationId ||
          original.inputKey.agentSessionId !== inputKey.agentSessionId || original.inputKey.submissionId !== inputKey.submissionId ||
          original.inputKey.attemptId !== inputKey.attemptId || original.inputKey.expectedRun.runId !== inputKey.expectedRun.runId ||
          original.at !== attribution.at || original.actor.kind !== attribution.actor.kind || original.actor.id !== attribution.actor.id) {
        setReading('unavailable')
        return
      }
      setReading({ delivery: receipt.delivery, nativeCompleted: Boolean(receipt.nativeCompleted) })
    } catch { setReading('unavailable') }
  }
  return <>
    <dl ref={originalReading} tabIndex={loaded ? -1 : undefined} aria-label={loaded ? 'Original permission receipt' : undefined}>
      {loaded ? <>
        <div><dt>Permission request</dt><dd><code>{requestId}</code></dd></div>
        <div><dt>Goal Start</dt><dd><code>{attribution.dispatchOperationId}</code></dd></div>
      </> : null}
      <div><dt>Delivery</dt><dd>{approvalDelivery[loaded?.delivery ?? approval.delivery]}</dd></div>
      {(loaded?.nativeCompleted ?? approval.nativeCompleted) ? <div><dt>Provider</dt><dd>Native completion observed</dd></div> : null}
    </dl>
    {reading === 'unavailable' ? <p className="goals-service" role="status">The original permission receipt is unavailable.</p> : null}
    {loaded ? null : <Button type="button" disabled={reading === 'loading'} onClick={() => void read()}>{reading === 'loading' ? 'Reading original response…' : 'Open original response'}</Button>}
  </>
}

/** The current proposal and its retained confirmation notices hold the original confirmation, independent of the requester. */
function goalParticipationEvents(demand: TimelineSource): TimelineEvent[] {
  const confirmations = new Map<number, TimelineEvent>()
  function addConfirmation(alignment: TimelineSource['alignment'], source?: { key: string; operationId: string }) {
    if (!alignment || alignment.confirmedAt === null || alignment.confirmedBy?.kind === 'agent') return
    const { revision, confirmedAt, confirmedBy } = alignment
    const id = `confirmation:${revision}`
    confirmations.set(revision, { id, at: confirmedAt, label: 'Goal confirmed', result: `Proposal revision ${revision} confirmed`,
      ...participantIdentity(confirmedBy), ...(source ? { original: { kind: 'coordination', key: source.key }, reference: source.operationId }
        : { original: { kind: 'confirmation', revision, at: confirmedAt } }) })
  }
  const requests: TimelineEvent[] = []
  for (const request of demand.patrols ?? []) {
    const key = `patrol:${request.operationId}`, original = { kind: 'coordination' as const, key }
    if (request.purpose === 'confirmation' && request.alignment && request.alignment.revision !== demand.alignment?.revision && !confirmations.has(request.alignment.revision))
      addConfirmation(request.alignment, { key, operationId: request.operationId })
    const author = participantIdentity(request.requestedBy)
    if (!author) continue
    requests.push({ id: key, at: request.requestedAt, label: request.purpose === 'confirmation' ? 'Continuation requested'
      : request.purpose === 'plan' ? 'Plan requested' : 'Inspection requested',
      result: 'Original request recorded', ...author, reference: request.operationId, original })
  }
  addConfirmation(demand.alignment)
  return [...confirmations.values(), ...requests]
}

/** Receipt times are events. Only an exact, confirmed activity observation can supply a live span. */
export function goalExecutionRows(demand: TimelineSource): Row[] {
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
    rows.set(timelineRowKey(row), row)
  }
  for (const review of demand.plan?.reviews ?? []) {
    const row = rows.get(`delegation:${review.delegationOperationId}`)
    const author = participantIdentity(review.reviewer) ?? { actor: [review.reviewer.id, review.reviewer.hostId].filter(Boolean).join(' · ') }
    if (row?.target?.nodeId === review.nodeId) row.events.push({ id: `review:${review.operationId}`, at: review.reviewedAt,
      label: review.verdict === 'pass' ? 'Review passed' : 'Changes requested', result: review.check.result || (review.verdict === 'pass' ? 'Passed' : 'Changes requested'),
      ...author, reference: review.operationId,
      note: review.note, reviewOperationId: review.operationId })
  }
  const goalEvents = goalParticipationEvents(demand)
  const approvals = new Map<string, ApprovalObservation[]>()
  for (const approval of demand.approvalObservations ?? []) {
    const { goalId, dispatchOperationId } = approval.attribution
    if (goalId !== demand.id) continue
    const group = approvals.get(dispatchOperationId) ?? []
    group.push(approval)
    approvals.set(dispatchOperationId, group)
  }
  for (const revision of demand.plan?.history ?? []) {
    const author = participantIdentity(revision.author)
    if (!author) continue
    const key = `plan:${revision.operationId}`, change = revision.change
    const event: TimelineEvent = { id: key, at: revision.revisedAt, result: `Plan revision ${revision.revision} saved`,
      ...goalPlanRevisionPresentation(revision), ...author, reference: revision.operationId, original: { kind: 'coordination', key } }
    const title = change && nodes.get(change.nodeId)
    if (!change || !title) {
      goalEvents.push(event)
      continue
    }
    const id = `node:${change.nodeId}`
    const row = rows.get(id) ?? { id, title, ticket: true as const, target: { nodeId: change.nodeId }, events: [] }
    row.events.push(event)
    rows.set(id, row)
  }
  for (const [nodeId, title] of nodes) {
    const id = `node:${nodeId}`
    if (!counts.has(nodeId) && !rows.has(id)) rows.set(id, { id, title, target: { nodeId }, events: [] })
  }
  for (const start of demand.dispatches ?? []) {
    if (start.execution !== 'finite') continue
    const rejected = start.stage === 'rejected'
    const at = start.stage === 'requested' ? start.request.requestedAt : rejected ? start.requestedAt : start.request?.requestedAt ?? start.preparedAt
    const author = participantIdentity(start.request?.requestedBy)
    const events: TimelineEvent[] = [{ id: 'request', at, label: rejected ? 'Request refused' : author ? 'Task requested' : 'Request saved',
      result: rejected ? 'Original request rejected' : 'Original request retained', ...author, reference: start.operationId }]
    const receipt = start.receipt
    if (receipt) events.push({ id: 'receipt', at: receipt.kind === 'core-input' ? receipt.observedAt : receipt.createdAt,
      label: 'Original input recorded', result: receipt.kind === 'core-input'
        ? receipt.outcome === 'terminal-confirmed' ? 'Terminal input confirmed' : 'Input admitted' : 'Core prompt saved',
      reference: receipt.kind === 'core-input' ? receipt.inputKey.submissionId : receipt.itemId })
    if (receipt?.kind === 'core-input') for (const approval of approvals.get(start.operationId) ?? []) {
      const { attribution } = approval, key = attribution.inputKey
      if (key.agentSessionId !== receipt.inputKey.agentSessionId || key.expectedRun.runId !== receipt.inputKey.expectedRun.runId ||
          key.submissionId !== receipt.inputKey.submissionId || key.attemptId !== undefined) continue
      events.push({ id: `approval:${approval.operationId}`, at: attribution.at, label: 'Linked permission response',
        result: approvalDecision[approval.decision], ...participantIdentity(attribution.actor),
        note: 'Explicitly linked to this Start. Provider causality is unknown.', reference: approval.operationId, approval })
    }
    rows.set(`start:${start.operationId}`, { id: `start:${start.operationId}`, title: 'One-time task',
      original: { kind: 'start', operationId: start.operationId }, events })
  }
  const order = new Map([...nodes.keys()].map((id, index) => [id, index]))
  const sorted = [...rows.values()].sort((a, b) =>
    (order.get(a.target?.nodeId ?? '') ?? order.size) - (order.get(b.target?.nodeId ?? '') ?? order.size) ||
    (a.target?.attemptId ? 1 : 0) - (b.target?.attemptId ? 1 : 0))
  return goalEvents.length ? [{ id: 'goal-participation', title: 'Goal participation', events: goalEvents }, ...sorted] : sorted
}

function TimelineEventButton({ event, open, detailsId, style, onOpen }: {
  event: TimelineEvent; open: boolean; detailsId: string; style?: CSSProperties | undefined; onOpen: (trigger: HTMLButtonElement) => void
}) {
  const preview = useWorkbenchNameTooltip(event.label, [eventTime.format(event.at), event.actor || unknownActor, event.result,
    event.approval && approvalDelivery[event.approval.delivery]].filter(Boolean).join(' · '), open,
    { placement: 'top', pointerPassThrough: true })
  return <><button type="button" className={style ? 'goal-execution-time__point' : 'goal-execution-time__receipt'}
    {...preview.props} data-goal-time-event={event.label} data-goal-time-event-id={event.id}
    data-goal-time-participant={event.participant} style={style}
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
    // Nine percent of the minimum plot width leaves room for a 24px hit target.
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
  onOpenRecord: (target: GoalTimelineOriginal, restoreFocus: () => void) => boolean
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
      open={openEvent !== null && timelineRowKey(openEvent.row) === timelineRowKey(row) && openEvent.event.id === event.id}
      onOpen={trigger => { setSourceUnavailable(false); setOpenEvent({ row, event, trigger }) }} />
  }
  function restoreEvent({ row, event, trigger }: OpenEvent) {
    const key = timelineRowKey(row)
    const originalRow = timeline.current?.dataset.goalTimeRowKey === key ? timeline.current
      : timeline.current?.querySelector<HTMLElement>(`[data-goal-time-row-key="${CSS.escape(key)}"]`)
    const point = originalRow?.querySelector<HTMLElement>(`[data-goal-time-event-id="${CSS.escape(event.id)}"]`)
    const focus = trigger.isConnected ? trigger : point ?? originalRow?.querySelector<HTMLElement>('[data-goal-time-open]') ?? originalRow ?? timeline.current
    focus?.focus()
  }
  function closeEvent() {
    if (openEvent) restoreEvent(openEvent)
    setOpenEvent(null)
  }
  const recorded = useMemo(() => goalExecutionRows(demand), [demand.id, demand.alignment, demand.plan, demand.delegations, demand.dispatches, demand.patrols, demand.responsibility, demand.approvalObservations])
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
  const currentRow = openEvent ? rows.find(row => timelineRowKey(row) === timelineRowKey(openEvent.row)) : undefined
  const currentEvent = currentRow?.events.find(event => event.id === openEvent?.event.id)
  const eventDetail = openEvent && (() => {
    const { row, event, trigger } = openEvent
    const reading = currentEvent ?? event
    const target = currentRow?.target
    const original = reading.original ?? currentRow?.original
    const restoreFocus = () => restoreEvent(openEvent)
    function openOriginal() {
      if (target && !reading.original) {
        onSelect({ target: { ...target, ...(event.reviewOperationId ? { reviewOperationId: event.reviewOperationId } : {}) }, trigger, restoreFocus })
      } else if (!original || !onOpenRecord(original, restoreFocus)) {
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
      {currentEvent?.approval ? <OriginalApproval key={currentEvent.id} approval={currentEvent.approval} />
        : currentEvent && (target || original) ? <Button type="button" onClick={openOriginal}>
        {reading.original?.kind === 'confirmation' ? 'Open original proposal' : reading.original ? 'Open original record'
          : event.reviewOperationId ? 'Open original review' : target?.attemptId ? 'Open original attempt' : target ? 'Open Ticket' : 'Open original record'}
      </Button> : null}
    </section>
  })()
  const onlyRow = rows.length === 1 ? rows[0] : undefined
  if (wholeGoal && onlyRow?.id !== 'goal-participation' && onlyRow?.events.length && !onlyRow.target && !onlyRow.active && !onlyRow.planned) {
    return <section ref={timeline} tabIndex={-1} className="goal-execution-time" aria-label="Execution timeline" data-goal-execution-time>
      <h3>Execution timeline</h3>
      {demand.approvalObservationIssue ? <p className="goals-service" role="status">{demand.approvalObservationIssue}</p> : null}
      <div className="goal-execution-time__receipt-group" data-goal-time-row={onlyRow.id} data-goal-time-row-key={timelineRowKey(onlyRow)} tabIndex={-1}>
        <strong>{onlyRow.title}</strong>
        <ul className="goal-execution-time__receipts">{onlyRow.events.map(event => <li key={event.id}>{eventButton(onlyRow, event)}</li>)}</ul>
      </div>
      {eventDetail}
    </section>
  }
  if (onlyRow?.target && !onlyRow.events.length && !onlyRow.active && !onlyRow.planned) {
    const { target } = onlyRow
    const active = selected?.nodeId === target.nodeId && selected.attemptId === target.attemptId && selected.wholeGoal === target.wholeGoal
    return <section ref={timeline} tabIndex={-1} className="goal-execution-time goal-execution-time--empty" aria-label="Execution timeline" data-goal-execution-time data-goal-time-row={onlyRow.id} data-goal-time-row-key={timelineRowKey(onlyRow)}>
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
    <h3>Execution timeline{rows.some(row => row.events.some(event => event.participant)) ?
      <span className="goal-execution-time__participation-key">User or device</span> : null}</h3>
    {demand.approvalObservationIssue ? <p className="goals-service" role="status">{demand.approvalObservationIssue}</p> : null}
    <div className="goal-execution-time__scroll"><div className="goal-execution-time__rows" data-timed={hasTimes || undefined}>
      <div className="goal-execution-time__row goal-execution-time__axis"><span>Task and attempt</span>
        <div>{hasTimes ? ticks.map(at => <time key={at} dateTime={new Date(at).toISOString()} title={format.format(at)}>{tickFormat.format(at)}</time>)
          : <span className="goal-execution-time__unrecorded">No schedule or execution times</span>}</div></div>
      {rows.map(row => {
        const { target, active: activity } = row
        const active = target && selected?.nodeId === target.nodeId && selected.attemptId === target.attemptId && selected.wholeGoal === target.wholeGoal
        const item = target && byId.get(target.nodeId)
        const previous = Boolean(target?.attemptId && item?.delegation?.operationId !== target.attemptId)
        const state = row.ticket ? 'Ticket' : previous ? 'Previous attempt' : item ? goalPlanStateLabel(item) : undefined
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
        return <div className={`goal-execution-time__row${target ? ' goal-execution-time__row--action' : ''}`} key={timelineRowKey(row)}
          data-goal-time-row={row.id} data-goal-time-row-key={timelineRowKey(row)} data-selected={active || undefined} tabIndex={-1}>
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
