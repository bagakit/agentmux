import { useEffect, useMemo } from 'react'
import type { ContinuousProgressTarget } from '@agentmux/core'
import { useScheduleRecords } from '../lib/schedule-controller'
import { useScheduleClock } from '../lib/schedule-clock'
import { ScheduleArrangementRow } from './ScheduleArrangementRow'
import { ScheduleCreateForm } from './ScheduleCreateForm'
import { useAppStore } from '../store'
import { resolveAutomationPreferences, automationCalendarTimezone } from '../../../shared/automation-preferences'
import '../styles/mote-calendar.css'

export type CalendarScheduleStatus = 'inactive' | 'active' | 'paused' | 'unconfirmed'

/** Session and sourced-Idea arrangements share the same rows, form and operation owner. */
export function CalendarScheduleControl({ target, onStatusChange, initialMessage, initialMessageContext, onMessageChange, presented = true }: {
  target: ContinuousProgressTarget; onStatusChange?: (status: CalendarScheduleStatus) => void
  initialMessage?: string; initialMessageContext?: string; onMessageChange?: (message: string) => void
  presented?: boolean
}) {
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
      <ScheduleArrangementRow key={record.loopId} schedule={record} timezone={timezone} now={now} onReceipt={source.accept} />)}</ol>
  }
  return <section className="calendar-schedules" aria-label="Calendar arrangements" data-schedule-state={status} hidden={!presented}>
    {presented ? <>
      <header className="calendar-schedules__heading"><h3>Arrangements</h3><span>{source.observed ? source.records.length + ' saved' : 'Unconfirmed'}</span></header>
      {source.error ? <div className="calendar-schedules__notice" role="status"><p>{source.error} Last confirmed arrangements and manual input remain available.</p><button type="button" className="small-button" onClick={source.refresh}>Retry arrangements</button></div> : null}
      {source.records.length ? renderArrangements()
        : source.observed ? <p className="continuous-progress-control__help">No saved arrangements for this Agent.</p> : !source.error ? <p className="continuous-progress-control__help">Reading arrangements…</p> : null}
    </> : null}
    <ScheduleCreateForm key={draftKey} draftKey={draftKey} target={target} onReceipt={source.accept} records={source.records}
      initialMessage={initialMessage} initialMessageContext={initialMessageContext} onMessageChange={onMessageChange} />
  </section>
}
