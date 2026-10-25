import { mintObjectId } from '@agentmux/core/object-id'
import type { ContinuousProgressLoop } from '@agentmux/core/continuous-progress-scheduler'
import type { ScheduleOccurrence } from '@agentmux/core/schedule-calendar'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useScheduleOperation } from '../lib/schedule-controller'
import { ScheduleOperationNotice } from './ScheduleOperationNotice'

const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
export function scheduleRuleLabel(schedule: ContinuousProgressLoop): string {
  if (schedule.everyMs !== undefined) return 'Every ' + schedule.everyMs / 60000 + ' minutes'
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
export function ScheduleArrangementRow({ schedule, occurrence, timezone, now, onReceipt, discussion, onOpenDiscussion, quickActions = false }: {
  schedule: ContinuousProgressLoop; occurrence?: ScheduleOccurrence | undefined; timezone: string; now: number
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
  const at = occurrence?.at ?? schedule.nextCheckAt
  const date = formats.short.format(at)
  const phase = occurrence?.kind === 'projected' ? 'Planned' : occurrence?.kind === 'last-accepted' ? 'Input accepted' : scheduleStateLabel(schedule, now)
  const remaining = Math.ceil((schedule.nextCheckAt - now) / 1000)
  const relative = remaining <= 0 ? 'Due' : remaining < 60 ? remaining + 's left' : remaining < 3600 ? Math.ceil(remaining / 60) + 'm left' : Math.ceil(remaining / 3600) + 'h left'
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
  return <li className="schedule-arrangement" data-compact={quickActions || undefined} data-schedule-id={schedule.loopId} data-occurrence-kind={occurrence?.kind ?? 'next-due'}>
    <div className="schedule-arrangement__overview">
      {quickActions ? <p className="schedule-arrangement__message">{schedule.prompt.split('\n')[0]}</p> : null}
      <div className="schedule-arrangement__when"><time dateTime={new Date(at).toISOString()}>{date}</time><span className={quickActions ? 'automation-state' : undefined} data-state={schedule.lastOutcome === 'unknown' ? 'unconfirmed' : schedule.status}>{phase}</span></div>
      {!quickActions ? <p className="schedule-arrangement__message">{schedule.prompt.split('\n')[0]}</p> : null}
      <div className="schedule-arrangement__caption"><span>{schedule.calendar || schedule.everyMs !== undefined ? scheduleRuleLabel(schedule) : 'Countdown' + (schedule.status === 'active' && schedule.lastOutcome !== 'unknown' ? ' · ' + relative : '')}</span>
        {discussion ? <span>{discussion}</span> : null}</div>
      {quickActions && schedule.status !== 'stopped' ? <button type="button" className="automation-button schedule-arrangement__toggle" disabled={operation.busy || !!operation.pending || schedule.revision === undefined} onClick={() => mutate(schedule.status === 'active' ? 'pause' : 'resume')}>{schedule.status === 'active' ? 'Pause' : 'Resume'}</button> : null}
    </div>
    <details className="schedule-arrangement__details">
      <summary>Details and controls</summary>
      {quickActions || schedule.prompt.includes('\n') ? <p className="calendar-schedules__context">{schedule.prompt}</p> : null}
      <p>{scheduleRuleLabel(schedule)}</p>
      <p>{schedule.status === 'active' ? 'Next due' : 'Original due'} · <time dateTime={new Date(schedule.nextCheckAt).toISOString()}>{formats.full.format(schedule.nextCheckAt)}</time></p>
      {occurrence?.kind === 'projected' ? <p>This is a planned occurrence. No input or work is confirmed for it.</p> : null}
      {occurrence?.kind === 'last-accepted' ? <p>The Host accepted this planned occurrence. It does not confirm completed work; only the latest accepted occurrence is retained.</p> : null}
      {schedule.checkIn ? <><p>Quiet follow-up · {schedule.checkIn.quiet.start}–{schedule.checkIn.quiet.end} quiet · at least {schedule.checkIn.silenceMs / 3600000}h silence · {schedule.checkIn.minIntervalMs / 3600000}h between attempts · {schedule.checkIn.dailyBudget} per local day</p>
        {schedule.checkInState?.unanswered ? <p>{schedule.lastOutcome === 'sent' ? 'Waiting for your next confirmed reply.' : 'Previous follow-up is unconfirmed. Reconcile its original operation.'}</p> : null}
        {schedule.checkInState?.budgetDate ? <p>{schedule.checkInState.budgetUsed} attempt used on {schedule.checkInState.budgetDate}.</p> : null}</> : null}
      {schedule.lastDecision ? <p className="calendar-schedules__notice">{schedule.lastDecision}</p> : null}
      <div className="calendar-schedules__actions">
        <button type="button" className="small-button" onClick={() => void inspectSaved()}>Check original arrangement</button>
        {onOpenDiscussion ? <button type="button" className="small-button" onClick={() => onOpenDiscussion(schedule)}>Open original discussion</button> : null}
        {schedule.status !== 'stopped' ? <>
          {!quickActions ? <button type="button" className="small-button" disabled={operation.busy || !!operation.pending || schedule.revision === undefined}
            onClick={() => mutate(schedule.status === 'active' ? 'pause' : 'resume')}>{schedule.status === 'active' ? 'Pause arrangement' : 'Resume arrangement'}</button> : null}
          <button type="button" className="small-button" disabled={operation.busy || !!operation.pending || schedule.revision === undefined} onClick={() => mutate('cancel')}>Cancel arrangement</button>
        </> : null}
      </div>
      {inspection ? <p role="status">{inspection}</p> : null}
      <dl className="schedule-arrangement__identity"><dt>Arrangement</dt><dd>{schedule.loopId}</dd><dt>Original Agent</dt><dd>{schedule.agentSessionId}</dd></dl>
    </details>
    <ScheduleOperationNotice operation={operation} />
  </li>
}
