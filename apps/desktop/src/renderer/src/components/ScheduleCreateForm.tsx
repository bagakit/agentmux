import { mintObjectId } from '@agentmux/core/object-id'
import { useEffect, useId, useRef, useState } from 'react'
import { ComposerTextarea, TextInput } from '@agentmux/client-ui/input'
import { parseAgentScheduleCalendar, parseAgentScheduleAfterMs, parseAgentScheduleEveryMs } from '@agentmux/core/schedule'
import type { ContinuousProgressLoop, ContinuousProgressTarget } from '@agentmux/core/continuous-progress-scheduler'
import { DateTime } from 'luxon'
import { useAppStore } from '../store'
import { useLauncherState } from '../lib/launcher-state'
import { useScheduleOperation } from '../lib/schedule-controller'
import type { ScheduleFormDraft, ScheduleRequest } from '../lib/schedule-draft'
import { resolveAutomationPreferences, automationCalendarTimezone, automationCheckInPolicy } from '../../../shared/automation-preferences'
import { ScheduleOperationNotice } from './ScheduleOperationNotice'

const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const inputFields = ['timing', 'kind', 'timezone', 'time', 'date', 'weekday', 'day', 'month', 'fold', 'delay', 'delayUnit', 'prompt', 'checkIn', 'context'] as const
const targetFields = ['hostId', 'agentSessionId', 'providerId', 'workspacePath'] as const
export function ScheduleCreateForm({ draftKey, target, onReceipt, initialMessage, initialMessageContext, onMessageChange, initialDate, records = [],
  defaultKind = 'daily', openRequest, onShowSaved, embedded = false }: {
  draftKey: string; target?: ContinuousProgressTarget | undefined; onReceipt(record: ContinuousProgressLoop): void
  initialMessage?: string | undefined; initialMessageContext?: string | undefined; onMessageChange?: ((value: string) => void) | undefined
  initialDate?: string; defaultKind?: ScheduleFormDraft['kind']
  records?: readonly ContinuousProgressLoop[]
  openRequest?: { sequence: number; date: string; time?: string } | undefined
  onShowSaved?: ((record: ContinuousProgressLoop) => void) | undefined
  embedded?: boolean
}) {
  const timingName = useId()
  const [fallback] = useState<ScheduleFormDraft>(() => {
    const defaults = resolveAutomationPreferences(useAppStore.getState().config?.automation)
    const timezone = automationCalendarTimezone(defaults)
    return { open: !!initialMessage, timing: embedded ? 'everyMs' : 'calendar', kind: defaultKind,
      timezone, time: [9, 0].map(value => String(value).padStart(2, '0')).join(':'), date: initialDate ?? DateTime.now().setZone(timezone).toISODate()!, weekday: '1', day: '1', month: '1',
      fold: 'earlier', delay: '5', delayUnit: 'minutes', prompt: initialMessage ?? '', checkIn: false, checkInPolicy: automationCheckInPolicy(defaults),
      ...(target ? { target } : {}), ...(initialMessageContext ? { context: initialMessageContext } : {}) }
  })
  const saved = useLauncherState(state => state.drafts[draftKey]?.schedule?.form)
  const form = saved ?? fallback
  const untouched = useRef<ScheduleFormDraft | undefined>(saved ? undefined : fallback)
  const isUntouched = (value: ScheduleFormDraft) => {
    const baseline = untouched.current
    return baseline !== undefined && inputFields.every(key => value[key] === baseline[key]) && targetFields.every(key => value.target?.[key] === baseline.target?.[key])
  }
  const [notice, setNotice] = useState<string>()
  const [savedArrangement, setSavedArrangement] = useState<{ key: string; record: ContinuousProgressLoop }>()
  const update = (patch: Partial<ScheduleFormDraft>) => {
    const held = useLauncherState.getState().drafts[draftKey]?.schedule?.form ?? fallback
    useLauncherState.getState().setScheduleDraft(draftKey, { form: { ...held, ...patch } })
    if (patch.prompt !== undefined) onMessageChange?.(patch.prompt)
  }
  const confirmed = (record: ContinuousProgressLoop, request: ScheduleRequest) => {
    const held = useLauncherState.getState().drafts[draftKey]?.schedule?.form
    if (request.action === 'create' && held && (held.context ? held.prompt + '\n\n' + held.context : held.prompt) === request.params.prompt) {
      const next = { ...held, prompt: '', open: false }
      untouched.current = next
      useLauncherState.getState().setScheduleDraft(draftKey, { form: next })
    }
    if (request.action === 'create') setSavedArrangement({ key: draftKey, record })
  }
  const operation = useScheduleOperation(draftKey, onReceipt, confirmed)
  const locked = operation.busy || !!operation.pending
  const element = useRef<HTMLDetailsElement>(null), handled = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!openRequest || handled.current === openRequest.sequence) return
    handled.current = openRequest.sequence
    const draft = useLauncherState.getState().drafts[draftKey]?.schedule
    const held = draft?.form ?? fallback
    // Date shortcuts can change automatic defaults, never edited timing or an
    // unresolved request. Persisted input remains owned by the original draft.
    const pristine = !draft?.pending && !operation.busy && isUntouched(held)
    const next: ScheduleFormDraft = { ...held, open: true,
      ...(pristine ? { timing: 'calendar', kind: 'once', date: openRequest.date, ...(openRequest.time ? { time: openRequest.time } : {}), target } : {}) }
    if (pristine) untouched.current = next
    useLauncherState.getState().setScheduleDraft(draftKey, { form: next })
    setNotice(pristine ? undefined : 'Your existing arrangement draft is kept. Review its date and time before saving.')
    const frame = requestAnimationFrame(() => { element.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true }); element.current?.scrollIntoView?.({ block: 'nearest' }) })
    return () => cancelAnimationFrame(frame)
  }, [openRequest, draftKey])
  function create() {
    if (locked || !form.prompt.trim()) return
    const exact = form.target ?? target
    if (!exact) { setNotice('Choose an exact Mote discussion before saving. Existing arrangements remain available.'); return }
    if (form.timing === 'calendar' && form.checkIn && records.some(record => record.checkIn && record.status !== 'stopped' &&
      record.hostId === exact.hostId && record.agentSessionId === exact.agentSessionId && record.providerId === exact.providerId && record.workspacePath === exact.workspacePath)) {
      setNotice('A quiet follow-up is already saved for this Agent. Review or cancel that arrangement before saving another.'); return
    }
    try {
      const timing = form.timing === 'everyMs'
        ? { everyMs: parseAgentScheduleEveryMs(Number(form.delay) * 60000) }
        : form.timing === 'afterMs'
        ? { afterMs: parseAgentScheduleAfterMs(Number(form.delay) * ({ seconds: 1000, minutes: 60000, hours: 3600000 }[form.delayUnit])) }
        : { calendar: parseAgentScheduleCalendar({ kind: form.kind, timezone: form.timezone, time: form.time,
          ...(form.kind === 'once' ? { date: form.date } : {}), ...(form.kind === 'weekly' ? { weekday: Number(form.weekday) } : {}),
          ...(form.kind === 'monthly' || form.kind === 'yearly' ? { day: Number(form.day) } : {}),
          ...(form.kind === 'yearly' ? { month: Number(form.month) } : {}),
          policies: { gap: 'skip', fold: form.fold, monthEnd: 'clamp', overdue: 'latest' } }),
          ...(form.checkIn ? { checkIn: form.checkInPolicy } : {}) }
      setNotice(undefined)
      setSavedArrangement(undefined)
      update({ target: exact })
      void operation.perform({ action: 'create', params: { target: exact, ...timing,
        prompt: form.context ? form.prompt + '\n\n' + form.context : form.prompt, operationId: 'schedule-' + mintObjectId() } })
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  }
  return <><details ref={element} className="continuous-progress-control__details schedule-create" data-embedded={embedded || undefined} open={embedded || form.open} onToggle={event => {
    event.stopPropagation()
    if (embedded) return
    if (event.currentTarget.open !== form.open) {
      const fresh = resolveAutomationPreferences(useAppStore.getState().config?.automation)
      const pristine = !form.prompt.trim() && !operation.pending && isUntouched(form)
      const patch = { open: event.currentTarget.open,
        ...(event.currentTarget.open && pristine ? { target,
          timezone: automationCalendarTimezone(fresh), checkIn: false, checkInPolicy: automationCheckInPolicy(fresh),
          ...(initialDate ? { date: initialDate } : {}) } : {}) }
      if (pristine) untouched.current = { ...form, ...patch }
      update(patch)
    }
  }}>
    <summary>{embedded ? 'Scheduled message' : 'New arrangement'}</summary>
    <form className="calendar-schedules__form" onSubmit={event => { event.preventDefault(); create() }}>
      {embedded ? <fieldset className="automation-choice automation-choice--timing" aria-label="Arrangement timing">
        <legend>When</legend>
        {([['everyMs', 'Repeat'], ['calendar', 'Calendar'], ['afterMs', 'Countdown']] as const).map(([value, label]) => <label key={value}>
          <input type="radio" name={timingName} value={value} checked={form.timing === value} disabled={locked} onChange={() => update({ timing: value })} /><span>{label}</span>
        </label>)}
      </fieldset> : <label>Timing<select aria-label="Arrangement timing" value={form.timing} disabled={locked}
        onChange={event => update({ timing: event.target.value as ScheduleFormDraft['timing'] })}>
        <option value="everyMs">Every few minutes</option><option value="calendar">Calendar time</option><option value="afterMs">Countdown</option></select></label>}
      {form.timing === 'everyMs' ? <label className={embedded ? "automation-interval" : undefined}>Every (minutes)<TextInput aria-label="Repeat interval in minutes" type="number" min="1" step="1" value={form.delay} required disabled={locked} onChange={event => update({ delay: event.target.value })} /></label>
        : form.timing === 'afterMs' ? <div className="calendar-schedules__fields">
        <label>After<TextInput aria-label="Countdown duration" type="number" min="0.001" step="any" value={form.delay} required disabled={locked} onChange={event => update({ delay: event.target.value })} /></label>
        <label>Unit<select aria-label="Countdown unit" value={form.delayUnit} disabled={locked} onChange={event => update({ delayUnit: event.target.value as ScheduleFormDraft['delayUnit'] })}>
          <option value="seconds">Seconds</option><option value="minutes">Minutes</option><option value="hours">Hours</option></select></label>
      </div> : <>
        <div className="calendar-schedules__fields">
          <label>Repeat<select aria-label="Arrangement repeat" value={form.kind} disabled={locked} onChange={event => update({ kind: event.target.value as ScheduleFormDraft['kind'] })}>
            <option value="once">Once</option><option value="daily">Every day</option><option value="weekly">Every week</option><option value="monthly">Every month</option><option value="yearly">Every year</option></select></label>
          <label>Local time<TextInput aria-label="Arrangement local time" type="time" value={form.time} required disabled={locked} onChange={event => update({ time: event.target.value })} /></label>
          {form.kind === 'once' ? <label>Date<TextInput aria-label="Arrangement date" type="date" value={form.date} required disabled={locked} onChange={event => update({ date: event.target.value })} /></label> : null}
          {form.kind === 'weekly' ? <label>Weekday<select aria-label="Arrangement weekday" value={form.weekday} disabled={locked} onChange={event => update({ weekday: event.target.value })}>{weekdays.map((day, index) => <option key={day} value={index + 1}>{day}</option>)}</select></label> : null}
          {form.kind === 'monthly' || form.kind === 'yearly' ? <label>Day<TextInput aria-label="Arrangement day" type="number" min="1" max="31" value={form.day} required disabled={locked} onChange={event => update({ day: event.target.value })} /></label> : null}
          {form.kind === 'yearly' ? <label>Month<TextInput aria-label="Arrangement month" type="number" min="1" max="12" value={form.month} required disabled={locked} onChange={event => update({ month: event.target.value })} /></label> : null}
        </div>
        <label className="calendar-schedules__check"><input type="checkbox" checked={form.checkIn} disabled={locked} aria-label="Enable quiet follow-up"
          onChange={event => update({ checkIn: event.target.checked })} />Quiet follow-up (explicit opt-in)</label>
        {form.checkIn ? <p className="continuous-progress-control__help">at least {form.checkInPolicy.silenceMs / 3600000}h silence; {form.checkInPolicy.minIntervalMs / 3600000}h between attempts; {form.checkInPolicy.dailyBudget} attempts per local day. Quiet hours {form.checkInPolicy.quiet.start}–{form.checkInPolicy.quiet.end}.</p> : null}
        <details className="calendar-schedules__rules"><summary>Time rules · {form.timezone}</summary>
          <label>IANA time zone<TextInput aria-label="Arrangement time zone" value={form.timezone} required disabled={locked} onChange={event => update({ timezone: event.target.value })} /></label>
          <label>Repeated DST time<select aria-label="Repeated DST time" value={form.fold} disabled={locked} onChange={event => update({ fold: event.target.value as 'earlier' | 'later' })}><option value="earlier">Earlier occurrence</option><option value="later">Later occurrence</option></select></label>
          <p className="continuous-progress-control__help">Nonexistent DST times are skipped. Short months use their last day. After a delay, only the latest due occurrence is eligible.</p>
        </details>
      </>}
      <label>Message<ComposerTextarea aria-label="Arranged message" rows={3} value={form.prompt} disabled={locked} onValueChange={prompt => update({ prompt })} /></label>
      {form.context ? <details className="calendar-schedules__rules"><summary>Request context</summary><p className="calendar-schedules__context">{form.context}</p></details> : null}
      {!form.target && !target ? <p className="continuous-progress-control__help">Choose an exact discussion to create an arrangement.</p> : null}
      {form.target && !embedded ? <p className="continuous-progress-control__help">Original discussion · {form.target.agentSessionId}</p> : null}
      {target && form.target && JSON.stringify(target) !== JSON.stringify(form.target) ? <button type="button" className="small-button" disabled={locked} onClick={() => update({ target })}>Use selected discussion</button> : null}
      {notice ? <p className="calendar-schedules__notice" role="status">{notice}</p> : null}
      <p className="continuous-progress-control__help automation-runtime-note">The Host must be running.{form.timing === 'afterMs' ? ' Countdown pause does not stop the clock.' : ''}</p>
      <button type="submit" className={embedded ? "automation-button automation-button--primary automation-submit" : "small-button"} disabled={locked || !form.prompt.trim()}>Save arrangement</button>
    </form>
    <ScheduleOperationNotice operation={operation} />
  </details>{savedArrangement?.key === draftKey ? <div className="schedule-create__confirmation" role="status"><span>Arrangement saved.</span>{onShowSaved ? <button type="button" onClick={() => onShowSaved(savedArrangement.record)}>View arrangement</button> : null}</div> : null}</>
}
