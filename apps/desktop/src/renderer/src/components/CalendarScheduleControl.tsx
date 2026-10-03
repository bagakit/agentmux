import { civilClock } from "../lib/civil-clock"
import { useEffect, useRef, useState } from 'react'
import type { ContinuousProgressLoop, ContinuousProgressTarget, ScheduleParamsMap } from '@agentmux/core'
import { parseAgentScheduleCalendar, type AgentScheduleCalendar } from '@agentmux/core/schedule'
import { api } from '../lib/api'
import { ComposerTextarea } from './ComposerTextarea'

export type CalendarScheduleStatus = 'inactive' | 'active' | 'paused' | 'unconfirmed'
type Pending = { action: 'create'; params: ScheduleParamsMap['schedule.create'] } | { action: 'pause' | 'resume' | 'cancel'; params: ScheduleParamsMap['schedule.pause'] }
const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const matches = (schedule: ContinuousProgressLoop, target: ContinuousProgressTarget) => schedule.calendar &&
  schedule.hostId === target.hostId && schedule.agentSessionId === target.agentSessionId && schedule.providerId === target.providerId && schedule.workspacePath === target.workspacePath
const errorMessage = (failure: unknown) => failure instanceof Error ? failure.message : String(failure)
function civilLabel(calendar: AgentScheduleCalendar): string {
  const cadence = calendar.kind === 'once' ? calendar.date : calendar.kind === 'daily' ? 'Every day' : calendar.kind === 'weekly' ? 'Every ' + weekdays[calendar.weekday! - 1] : calendar.kind === 'monthly' ? 'Every month, day ' + calendar.day : 'Every year, ' + calendar.month + '/' + calendar.day
  return cadence + ' at ' + calendar.time + ' · ' + calendar.timezone
}
function dueLabel(schedule: ContinuousProgressLoop): string {
  return new Intl.DateTimeFormat(undefined, { timeZone: schedule.calendar!.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(schedule.nextCheckAt)
}

/** Observes the original Main owner; opening another display never creates a timer or arrangement. */
export function CalendarScheduleControl({ target, onStatusChange }: { target: ContinuousProgressTarget; onStatusChange?: (status: CalendarScheduleStatus) => void }) {
  const [schedules, setSchedules] = useState<ContinuousProgressLoop[]>([])
  const [observed, setObserved] = useState<ContinuousProgressTarget>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<Pending>()
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<AgentScheduleCalendar['kind']>('daily')
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [time, setTime] = useState(civilClock(9, 0))
  const [date, setDate] = useState(() => {
    const local = new Date()
    return [local.getFullYear(), String(local.getMonth() + 1).padStart(2, '0'), String(local.getDate()).padStart(2, '0')].join('-')
  })
  const [weekday, setWeekday] = useState('1'), [day, setDay] = useState('1'), [month, setMonth] = useState('1')
  const [fold, setFold] = useState<'earlier' | 'later'>('earlier')
  const [prompt, setPrompt] = useState('')
  const current = useRef(target); current.current = target
  const locked = useRef(false), updates = useRef(0)
  const accept = (schedule: ContinuousProgressLoop, captured: ContinuousProgressTarget) => {
    if (!matches(schedule, captured)) throw new Error('The Host returned another arrangement target. Your original message is kept.')
    if (current.current !== captured) return
    setSchedules(previous => {
      const existing = previous.find(item => item.loopId === schedule.loopId)
      if (existing && ((existing.revision ?? 0) > (schedule.revision ?? 0) ||
        existing.revision === schedule.revision && (existing.lastTickAt ?? 0) > (schedule.lastTickAt ?? 0))) return previous
      return [...previous.filter(item => item.loopId !== schedule.loopId), schedule]
    })
    setObserved(captured)
  }
  useEffect(() => {
    let alive = true
    locked.current = false; setSchedules([]); setObserved(undefined); setError(undefined); setPending(undefined); setBusy(false); setOpen(false); setPrompt('')
    const before = updates.current
    const dispose = api.schedule.onChanged(schedule => {
      if (!alive || !matches(schedule, target)) return
      updates.current++; accept(schedule, target)
    })
    void api.schedule.list({ target }).then(result => {
      if (!alive || current.current !== target || before !== updates.current) return
      setSchedules(result.schedules.filter(schedule => matches(schedule, target))); setObserved(target)
    }, failure => { if (alive && current.current === target) setError(errorMessage(failure)) })
    return () => { alive = false; dispose() }
  }, [target])
  const visible = observed === target ? schedules : []
  const status: CalendarScheduleStatus = error || observed !== target || visible.some(schedule => schedule.lastOutcome === 'unknown') ? 'unconfirmed' : visible.some(schedule => schedule.status === 'active') ? 'active' : visible.some(schedule => schedule.status === 'paused') ? 'paused' : 'inactive'
  useEffect(() => { onStatusChange?.(status) }, [status, onStatusChange])
  async function perform(request: Pending) {
    if (locked.current) return
    const captured = target; locked.current = true; setBusy(true); setPending(request)
    try {
      const receipt = request.action === 'create' ? await api.schedule.create(request.params) : request.action === 'pause' ? await api.schedule.pause(request.params) : request.action === 'resume' ? await api.schedule.resume(request.params) : await api.schedule.cancel(request.params)
      if (current.current !== captured) return
      accept(receipt.schedule, captured); setError(undefined); setPending(undefined)
      if (request.action === 'create') { setPrompt(''); setOpen(false) }
    } catch (failure) { if (current.current === captured) setError(errorMessage(failure)) }
    finally { if (current.current === captured) { locked.current = false; setBusy(false) } }
  }
  async function inspectOriginal() {
    if (!pending || locked.current) return
    const captured = target, request = pending; locked.current = true; setBusy(true)
    try {
      const result = await api.schedule.inspect({ operationId: request.params.operationId })
      if (current.current !== captured) return
      if (result.schedule) {
        accept(result.schedule, captured)
        const complete = request.action === 'create'
          ? result.schedule.status === 'active' && result.schedule.creationOperationId === request.params.operationId
          : result.schedule.status === (request.action === 'resume' ? 'active' : request.action === 'pause' ? 'paused' : 'stopped') && result.schedule.lastMutation?.operationId === request.params.operationId
        if (complete && result.schedule.lastOutcome !== 'unknown') {
          setError(undefined); setPending(undefined)
          if (request.action === 'create') { setPrompt(''); setOpen(false) }
        } else setError('The original operation is still unconfirmed. The saved arrangement is shown below; retry keeps the same operation.')
      } else { setError('The connected Host did not find the original operation. Your message is still in this form.'); setPending(undefined) }
    } catch (failure) { if (current.current === captured) setError(errorMessage(failure)) }
    finally { if (current.current === captured) { locked.current = false; setBusy(false) } }
  }
  function create() {
    if (locked.current || pending) return
    try {
      const calendar = parseAgentScheduleCalendar({ kind, timezone, time, ...(kind === 'once' ? { date } : {}), ...(kind === 'weekly' ? { weekday: Number(weekday) } : {}), ...(kind === 'monthly' || kind === 'yearly' ? { day: Number(day) } : {}), ...(kind === 'yearly' ? { month: Number(month) } : {}), policies: { gap: 'skip', fold, monthEnd: 'clamp', overdue: 'latest' } })
      void perform({ action: 'create', params: { target, calendar, prompt, operationId: 'schedule-' + crypto.randomUUID() } })
    } catch (failure) { setError(errorMessage(failure)) }
  }
  function mutate(schedule: ContinuousProgressLoop, action: 'pause' | 'resume' | 'cancel') {
    if (schedule.revision === undefined || pending) return
    void perform({ action, params: { scheduleId: schedule.loopId, expectedRevision: schedule.revision, operationId: 'schedule-' + crypto.randomUUID() } })
  }
  return <section className="calendar-schedules" aria-label="Calendar arrangements" data-schedule-state={status}>
    <header className="calendar-schedules__heading"><h3>Arrangements</h3><span>{status === 'unconfirmed' ? 'Unconfirmed' : visible.length + ' saved'}</span></header>
    <p className="continuous-progress-control__help">Messages run while Desktop and the target Host are connected. Closing Desktop keeps saved arrangements and may delay them.</p>
    {error ? <div className="calendar-schedules__notice" role="status"><p>{error}</p><p>Manual messages remain available.</p>{pending ? <div className="calendar-schedules__actions"><button type="button" className="small-button" disabled={busy} onClick={() => void inspectOriginal()}>Check original operation</button><button type="button" className="small-button" disabled={busy} onClick={() => void perform(pending)}>Retry original operation</button></div> : null}</div> : null}
    {visible.length ? <ol className="calendar-schedules__list">{visible.map(schedule => <li key={schedule.loopId} data-schedule-id={schedule.loopId}>
      <div className="calendar-schedules__row"><p className="calendar-schedules__message">{schedule.prompt}</p><span>{schedule.lastOutcome === 'unknown' ? 'Unconfirmed' : schedule.status === 'stopped' ? 'Ended' : schedule.status === 'paused' ? 'Paused' : 'Active'}</span></div>
      <p className="continuous-progress-control__help">{civilLabel(schedule.calendar!)}</p>
      <dl><dt>{schedule.status === 'active' && schedule.lastOutcome !== 'unknown' ? 'Next due' : 'Original due'}</dt><dd><time dateTime={new Date(schedule.nextCheckAt).toISOString()}>{dueLabel(schedule)}</time></dd></dl>
      {schedule.lastDecision ? <p className="calendar-schedules__notice">{schedule.lastDecision}</p> : null}
      {schedule.status !== 'stopped' ? <div className="calendar-schedules__actions"><button type="button" className="small-button" disabled={busy || !!pending} onClick={() => mutate(schedule, schedule.status === 'active' ? 'pause' : 'resume')}>{schedule.status === 'active' ? 'Pause arrangement' : 'Resume arrangement'}</button><button type="button" className="small-button" disabled={busy || !!pending} onClick={() => mutate(schedule, 'cancel')}>Cancel arrangement</button></div> : null}
    </li>)}</ol> : !error && observed === target ? <p className="continuous-progress-control__help">No saved arrangements for this Agent.</p> : null}
    <details className="continuous-progress-control__details" open={open} onToggle={event => { event.stopPropagation(); setOpen(event.currentTarget.open) }}>
      <summary>New arrangement</summary>
      {open ? <form className="calendar-schedules__form" onSubmit={event => { event.preventDefault(); create() }}>
        <div className="calendar-schedules__fields">
          <label>Repeat<select aria-label="Arrangement repeat" value={kind} disabled={busy || !!pending} onChange={event => setKind(event.target.value as AgentScheduleCalendar['kind'])}><option value="once">Once</option><option value="daily">Every day</option><option value="weekly">Every week</option><option value="monthly">Every month</option><option value="yearly">Every year</option></select></label>
          <label>Local time<input aria-label="Arrangement time" type="time" value={time} required disabled={busy || !!pending} onChange={event => setTime(event.target.value)} /></label>
          {kind === 'once' ? <label>Date<input aria-label="Arrangement date" type="date" value={date} required disabled={busy || !!pending} onChange={event => setDate(event.target.value)} /></label> : null}
          {kind === 'weekly' ? <label>Weekday<select aria-label="Arrangement weekday" value={weekday} disabled={busy || !!pending} onChange={event => setWeekday(event.target.value)}>{weekdays.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}</select></label> : null}
          {kind === 'yearly' ? <label>Month<input aria-label="Arrangement month" type="number" min="1" max="12" value={month} required disabled={busy || !!pending} onChange={event => setMonth(event.target.value)} /></label> : null}
          {kind === 'monthly' || kind === 'yearly' ? <label>Day<input aria-label="Arrangement day" type="number" min="1" max="31" value={day} required disabled={busy || !!pending} onChange={event => setDay(event.target.value)} /></label> : null}
        </div>
        <label>IANA time zone<input aria-label="Arrangement time zone" value={timezone} required disabled={busy || !!pending} onChange={event => setTimezone(event.target.value)} /></label>
        <label>Message to Agent<ComposerTextarea value={prompt} onValueChange={setPrompt} disabled={busy || !!pending} placeholder="A question or reminder for this Agent" /></label>
        <details className="calendar-schedules__rules" onToggle={event => event.stopPropagation()}><summary>Time rules</summary><label>Repeated DST time<select aria-label="Repeated DST time" value={fold} disabled={busy || !!pending} onChange={event => setFold(event.target.value as 'earlier' | 'later')}><option value="earlier">Earlier occurrence</option><option value="later">Later occurrence</option></select></label><p className="continuous-progress-control__help">Nonexistent DST times are skipped. Short months use their last day. After a delay, only the latest due occurrence is eligible.</p></details>
        <button type="submit" className="small-button" disabled={busy || !!pending || !prompt.trim()}>Save arrangement</button>
      </form> : null}
    </details>
  </section>
}
