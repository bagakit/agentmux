import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { ContinuousProgressTarget } from '@agentmux/core'
import { useScheduleRecords } from '../lib/schedule-controller'
import { useScheduleClock } from '../lib/schedule-clock'
import { ScheduleArrangementRow } from './ScheduleArrangementRow'
import { ScheduleCreateForm } from './ScheduleCreateForm'
import { useAppStore } from '../store'
import { resolveAutomationPreferences, automationCalendarTimezone } from '../../../shared/automation-preferences'
import '../styles/mote-calendar.css'

export type CalendarScheduleStatus = 'inactive' | 'active' | 'paused' | 'unconfirmed'
const CreateIcon = semanticIconComponent('action.create')

/** Session and sourced-Idea arrangements share the same rows, form and operation owner. */
export function CalendarScheduleControl({ target, onStatusChange, initialMessage, initialMessageContext, onMessageChange, presented = true, unified, progress, progressForm, progressConfigured }: {
  target: ContinuousProgressTarget; onStatusChange?: (status: CalendarScheduleStatus) => void
  initialMessage?: string; initialMessageContext?: string; onMessageChange?: (message: string) => void
  presented?: boolean
  unified?: boolean
  progress?: ReactNode
  progressForm?: ReactNode
  progressConfigured?: boolean
}) {
  const [creationKind, setCreationKind] = useState<'schedule' | 'progress'>('schedule')
  const creation = useRef<HTMLDetailsElement>(null)
  function editProgress() {
    setCreationKind('progress')
    if (creation.current) { creation.current.open = true; creation.current.scrollIntoView?.({ block: 'nearest' }) }
  }
  // Retained hidden forms/status use the last observation without starting another reader.
  const source = useScheduleRecords([{ target }], presented)
  const now = useScheduleClock(presented)
  const draftKey = useMemo(() => 'schedule-create:' + (initialMessageContext ? 'source:' : '') + JSON.stringify(target), [target, !!initialMessageContext])
  const status: CalendarScheduleStatus = source.error || !source.observed || source.records.some(record => record.lastOutcome === 'unknown')
    ? 'unconfirmed' : source.records.some(record => record.status === 'active') ? 'active' : source.records.some(record => record.status === 'paused') ? 'paused' : 'inactive'
  useEffect(() => { onStatusChange?.(status) }, [status, onStatusChange])
  function renderArrangements() {
    const timezone = automationCalendarTimezone(resolveAutomationPreferences(useAppStore.getState().config?.automation))
    return <ol className="calendar-schedules__list">{source.records.map(record =>
      <ScheduleArrangementRow key={record.loopId} schedule={record} timezone={timezone} now={now} onReceipt={source.accept} quickActions={!!unified} />)}</ol>
  }
  return <section className="calendar-schedules" aria-label={unified ? 'Agent automation' : 'Calendar arrangements'} data-schedule-state={status} data-unified={unified || undefined} hidden={!presented}>
    {presented ? <>
      <header className="calendar-schedules__heading"><h3>{unified ? 'Your automations' : 'Arrangements'}</h3><span>{source.observed ? source.records.length + (unified ? ' scheduled' : ' saved') : 'Unconfirmed'}</span></header>
      {source.error ? <div className="calendar-schedules__notice" role="status"><p>{source.error} Last confirmed arrangements and manual input remain available.</p><button type="button" className="small-button" onClick={source.refresh}>Retry arrangements</button></div> : null}
      {progress}
      {progressConfigured ? <button type="button" className="small-button" onClick={editProgress}>Edit continuous progress</button> : null}
      {source.records.length ? renderArrangements()
        : source.observed ? <p className="continuous-progress-control__help">{unified ? 'No scheduled messages for this Agent.' : 'No saved arrangements for this Agent.'}</p> : !source.error ? <p className="continuous-progress-control__help">Reading arrangements…</p> : null}
    </> : null}
    {unified ? <details ref={creation} className="automation-create" onToggle={event => event.stopPropagation()}><summary><CreateIcon size={14} aria-hidden="true" />{creationKind === 'progress' && progressConfigured ? 'Edit continuous progress' : 'New automation'}</summary>
      <div className="automation-create__body">
        <label>What should happen?<select aria-label="Automation type" value={creationKind} onChange={event => setCreationKind(event.target.value as 'schedule' | 'progress')}>
          <option value="schedule">Send a scheduled message</option><option value="progress">{progressConfigured ? 'Edit existing continuous progress' : 'Continue finished work'}</option>
        </select></label>
        <p className="continuous-progress-control__help">{creationKind === 'schedule' ? 'Send to this Agent when the time is due and input is available.' : 'Check for completed work at intervals. Busy checks are skipped.'}</p>
        <div hidden={creationKind !== 'schedule'}><ScheduleCreateForm key={draftKey} draftKey={draftKey} target={target} onReceipt={source.accept} records={source.records}
          initialMessage={initialMessage} initialMessageContext={initialMessageContext} onMessageChange={onMessageChange} embedded /></div>
        <div hidden={creationKind !== 'progress'}>{progressForm}</div>
      </div>
    </details> : <ScheduleCreateForm key={draftKey} draftKey={draftKey} target={target} onReceipt={source.accept} records={source.records}
      initialMessage={initialMessage} initialMessageContext={initialMessageContext} onMessageChange={onMessageChange} />}
  </section>
}
