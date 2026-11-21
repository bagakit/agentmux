import { mintObjectId } from '@agentmux/core/object-id'
import type { ContinuousProgressLoop } from '@agentmux/core/continuous-progress-scheduler'
import type { MoteWorkPublication } from '@agentmux/core/schedule-rpc'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import { MoteAssignmentButton } from '@agentmux/client-ui/components/MoteAssignment'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { api } from '../lib/api'
import { useScheduleOperation } from '../lib/schedule-controller'
import { ScheduleOperationNotice } from './ScheduleOperationNotice'
import { describeContinuousProgressDecision } from './ContinuousProgressPanel'

const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const HeartbeatIcon = semanticIconComponent('object.heartbeat')
const ScheduleIcon = semanticIconComponent('object.schedule')
export function scheduleRuleLabel(schedule: Pick<ContinuousProgressLoop, 'everyMs' | 'calendar' | 'afterMs'>): string {
  if (schedule.everyMs !== undefined) return schedule.everyMs === 60000 ? 'Every minute' : 'Every ' + schedule.everyMs / 60000 + ' minutes'
  if (!schedule.calendar) return 'One-shot countdown'
  const rule = schedule.calendar
  const cadence = rule.kind === 'once' ? rule.date : rule.kind === 'daily' ? 'Every day' : rule.kind === 'weekly'
    ? 'Every ' + weekdays[rule.weekday! - 1] : rule.kind === 'monthly' ? 'Every month, day ' + rule.day : 'Every year, ' + rule.month + '/' + rule.day
  return cadence + ' at ' + rule.time + ' · ' + rule.timezone
}
export function scheduleStateLabel(schedule: ContinuousProgressLoop, now: number): string {
  return schedule.lastOutcome === 'unknown' ? 'Delivery unconfirmed' : schedule.status === 'stopped' ? 'Ended'
    : schedule.status === 'paused' ? 'Paused' : schedule.nextCheckAt <= now ? 'Due' : 'Active'
}
export function scheduleDisplayTitle(schedule: ContinuousProgressLoop): string {
  return schedule.prompt.trim().split('\n')[0]!
}
export function scheduleCalendarLabel(schedule: ContinuousProgressLoop, heartbeat = false): string {
  if (heartbeat) return 'Mote heartbeat'
  const headline = scheduleDisplayTitle(schedule)
  return headline.match(/^(.{2,16}?)(?:：|:\s)/u)?.[1]?.trim() || headline
}
export function MotePublishedAssignment({ schedule, publication = schedule.lastMotePublication }: {
  schedule: ContinuousProgressLoop; publication?: MoteWorkPublication
}) {
  const work = schedule.moteWork
  if (!work || !publication) return null
  const address = { conversationId: publication.conversationId, messageId: publication.messageId, read: api.moteGroup.call }
  return <MoteAssignmentButton target={work.kind === 'direct'
    ? { kind: 'direct', mote: work.mote, ...address } : { kind: 'group', ...address }} />
}
export function ScheduleArrangementRow({ schedule, timezone, now, onReceipt, discussion, onOpenDiscussion, quickActions = false, calendarSummary = false, heartbeat = false }: {
  schedule: ContinuousProgressLoop; timezone: string; now: number; calendarSummary?: boolean; heartbeat?: boolean
  onReceipt(schedule: ContinuousProgressLoop): void; discussion?: string | undefined
  onOpenDiscussion?: (schedule: ContinuousProgressLoop) => void
  quickActions?: boolean
}) {
  const operation = useScheduleOperation('schedule-operation:' + JSON.stringify([schedule.hostId, schedule.loopId]), onReceipt)
  const [inspection, setInspection] = useState<string>()
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const formats = useMemo(() => ({
    short: new Intl.DateTimeFormat(undefined, { timeZone: timezone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    full: new Intl.DateTimeFormat(undefined, { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' })
  }), [timezone])
  const at = schedule.nextCheckAt
  const work = schedule.moteWork
  const date = formats.short.format(at)
  const phase = scheduleStateLabel(schedule, now)
  const nextLabel = phase === 'Active' ? 'Next planned' : phase === 'Due' ? 'Due since' : 'Original due'
  const Icon = heartbeat ? HeartbeatIcon : ScheduleIcon
  const remaining = Math.ceil((schedule.nextCheckAt - now) / 1000)
  const relative = remaining <= 0 ? 'Due' : remaining < 60 ? remaining + 's left' : remaining < 3600 ? Math.ceil(remaining / 60) + 'm left' : Math.ceil(remaining / 3600) + 'h left'
  const cadence = schedule.afterMs === undefined ? scheduleRuleLabel(schedule).split(' · ')[0] : 'Countdown' + (phase === 'Active' ? ' · ' + relative : '')
  const mutate = (action: 'pause' | 'resume' | 'cancel') => void operation.perform({ action,
    params: { scheduleId: schedule.loopId, expectedRevision: schedule.revision!, operationId: mintObjectId() } })
  async function inspectSaved() {
    try {
      const result = await api.schedule.inspect({ scheduleId: schedule.loopId })
      if (!alive.current) return
      if (!result.schedule || result.schedule.loopId !== schedule.loopId) { setInspection('The original arrangement is unconfirmed. Its record is kept.'); return }
      onReceipt(result.schedule); setInspection('Original arrangement checked. Input acceptance and completed work are separate.')
    } catch (error) { if (alive.current) setInspection(error instanceof Error ? error.message : String(error)) }
  }
  return <li className="schedule-arrangement" data-compact={quickActions || undefined} data-calendar-summary={calendarSummary || undefined} data-heartbeat={heartbeat || undefined} data-schedule-id={schedule.loopId}>
    <div className="schedule-arrangement__overview">
      {!calendarSummary ? <>
        {quickActions ? <p className="schedule-arrangement__message">{schedule.prompt.split('\n')[0]}</p> : null}
        <div className="schedule-arrangement__when"><time dateTime={new Date(at).toISOString()}>{date}</time><span className={quickActions ? 'automation-state' : undefined} data-state={schedule.lastOutcome === 'unknown' ? 'unconfirmed' : schedule.status}>{phase}</span></div>
        {!quickActions ? <p className="schedule-arrangement__message">{schedule.prompt.split('\n')[0]}</p> : null}
      </> : <div className="schedule-arrangement__heading">
        <span className="schedule-arrangement__mark"><Icon size={14} aria-hidden /></span>
        <p className="schedule-arrangement__message" title={scheduleDisplayTitle(schedule)}>{scheduleCalendarLabel(schedule, heartbeat)}</p>
        <span className="schedule-arrangement__cadence" title={scheduleRuleLabel(schedule)}>{cadence}</span>
      </div>}
      {!calendarSummary ? <div className="schedule-arrangement__caption"><span>{schedule.calendar || schedule.everyMs !== undefined ? scheduleRuleLabel(schedule) : 'Countdown' + (schedule.status === 'active' && schedule.lastOutcome !== 'unknown' ? ' · ' + relative : '')}</span>
        {discussion ? <span>{discussion}</span> : null}</div> : null}
      {calendarSummary ? <>
        {discussion || phase !== 'Active' && phase !== 'Due' ? <div className="schedule-arrangement__calendar-context">
          {discussion ? <span title={discussion}>{discussion}</span> : null}
          {phase !== 'Active' && phase !== 'Due' ? <span className="schedule-arrangement__state">{phase}</span> : null}
        </div> : null}
        <dl className="schedule-arrangement__times">
          <div><dt>{work ? 'Last assignment published' : 'Last input accepted'}</dt><dd>{schedule.lastOccurrenceAt === undefined ? '—' : <time dateTime={new Date(schedule.lastOccurrenceAt).toISOString()}>{formats.short.format(schedule.lastOccurrenceAt)}</time>}</dd></div>
          {schedule.status !== 'stopped' ? <div><dt>{nextLabel}</dt><dd><time dateTime={new Date(at).toISOString()}>{date}</time></dd></div> : null}
        </dl>
      </> : null}
      {quickActions && schedule.status !== 'stopped' ? <button type="button" className="automation-button schedule-arrangement__toggle" disabled={operation.busy || !!operation.pending || schedule.revision === undefined} onClick={() => mutate(schedule.status === 'active' ? 'pause' : 'resume')}>{schedule.status === 'active' ? 'Pause' : 'Resume'}</button> : null}
    </div>
    {work && schedule.lastMotePublication ? <div className="calendar-schedules__actions"><MotePublishedAssignment schedule={schedule} /></div> : null}
    {schedule.lastOutcome === 'skipped' ? <p className="schedule-arrangement__outcome">Last attempt skipped</p> : null}
    <details className="schedule-arrangement__details">
      <summary>Details and controls</summary>
      {calendarSummary || quickActions || schedule.prompt.includes('\n') ? <p className="calendar-schedules__context">{schedule.prompt}</p> : null}
      <p>{scheduleRuleLabel(schedule)}</p>
      {!calendarSummary || schedule.status === 'stopped' ? <p>{schedule.status === 'active' ? 'Next due' : 'Original due'} · <time dateTime={new Date(schedule.nextCheckAt).toISOString()}>{formats.full.format(schedule.nextCheckAt)}</time></p> : null}
      {schedule.checkIn ? <><p>Quiet follow-up · {schedule.checkIn.quiet.start}–{schedule.checkIn.quiet.end} quiet · at least {schedule.checkIn.silenceMs / 3600000}h silence · {schedule.checkIn.minIntervalMs / 3600000}h between attempts · {schedule.checkIn.dailyBudget} per local day</p>
        {schedule.checkInState?.unanswered ? <p>{schedule.lastOutcome === 'sent' ? 'Waiting for your next confirmed reply.' : 'Previous follow-up is unconfirmed. Reconcile its original operation.'}</p> : null}
        {schedule.checkInState?.budgetDate ? <p>{schedule.checkInState.budgetUsed} attempt used on {schedule.checkInState.budgetDate}.</p> : null}</> : null}
      {schedule.lastDecision ? <p className="calendar-schedules__notice">{describeContinuousProgressDecision(schedule.lastDecision)}</p> : null}
      <div className="calendar-schedules__actions">
        <Button type="button" onClick={() => void inspectSaved()}>Check original arrangement</Button>
        {onOpenDiscussion ? <Button type="button" onClick={() => onOpenDiscussion(schedule)}>Open original discussion</Button> : null}
        {schedule.status !== 'stopped' ? <>
          {!quickActions ? <Button type="button" disabled={operation.busy || !!operation.pending || schedule.revision === undefined}
            onClick={() => mutate(schedule.status === 'active' ? 'pause' : 'resume')}>{schedule.status === 'active' ? 'Pause arrangement' : 'Resume arrangement'}</Button> : null}
          <Button type="button" disabled={operation.busy || !!operation.pending || schedule.revision === undefined} onClick={() => mutate('cancel')}>Cancel arrangement</Button>
        </> : null}
      </div>
      {inspection ? <p role="status">{inspection}</p> : null}
      <dl className="schedule-arrangement__identity"><dt>Arrangement</dt><dd>{schedule.loopId}</dd><dt>Original Agent</dt><dd>{schedule.agentSessionId}</dd></dl>
    </details>
    <ScheduleOperationNotice operation={operation} />
  </li>
}
