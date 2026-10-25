import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
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
const EditIcon = semanticIconComponent('action.edit')
const BackIcon = semanticIconComponent('navigation.back')

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
  const [editor, setEditor] = useState<'new' | 'progress' | null>(null)
  const createButton = useRef<HTMLButtonElement>(null)
  const editButton = useRef<HTMLButtonElement>(null)
  const editorHeading = useRef<HTMLHeadingElement>(null)
  const typeName = useId()
  function openEditor(mode: 'new' | 'progress') {
    setCreationKind(mode === 'progress' ? 'progress' : 'schedule')
    setEditor(mode)
  }
  useEffect(() => {
    if (editor) { editorHeading.current?.focus({ preventScroll: true }); editorHeading.current?.scrollIntoView?.({ block: 'nearest' }) }
  }, [editor])
  function back() {
    setEditor(null)
    requestAnimationFrame(() => {
      const button = editor === 'progress' && editButton.current ? editButton.current : createButton.current
      button?.focus({ preventScroll: true })
    })
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
    <div className="automation-overview" data-automation-view="overview" hidden={unified && editor !== null}>
      {presented ? <>
        <header className="calendar-schedules__heading"><h3>{unified ? 'Your automations' : 'Arrangements'}</h3>
          {unified ? <button type="button" ref={createButton} className="automation-button automation-button--primary" onClick={() => openEditor('new')}><CreateIcon size={14} aria-hidden="true" />New automation</button>
            : <span>{source.observed ? source.records.length + ' saved' : 'Unconfirmed'}</span>}
        </header>
        {source.error ? <div className="calendar-schedules__notice" role="status"><p>{source.error} Last confirmed arrangements and manual input remain available.</p><button type="button" className="small-button" onClick={source.refresh}>Retry arrangements</button></div> : null}
        {progress ? <div className="automation-progress-row">{progress}
          {progressConfigured ? <button type="button" ref={editButton} className="automation-button automation-progress-edit" aria-label="Edit continuous progress" onClick={() => openEditor('progress')}><EditIcon size={13} aria-hidden="true" />Edit</button> : null}
        </div> : null}
        {source.records.length ? renderArrangements()
          : source.observed ? <p className="continuous-progress-control__help automation-empty">{unified ? 'Schedule a message for this Agent, or keep finished work moving.' : 'No saved arrangements for this Agent.'}</p> : !source.error ? <p className="continuous-progress-control__help">Reading arrangements…</p> : null}
      </> : null}
    </div>
    {unified ? <div className="automation-editor" data-automation-view="editor" hidden={editor === null}>
      <header className="automation-editor__heading"><button type="button" className="automation-button automation-editor__back" aria-label="Back to automations" onClick={back}><BackIcon size={14} aria-hidden="true" /><span>All automations</span></button>
        <h3 ref={editorHeading} tabIndex={-1}>{editor === 'progress' ? 'Edit continuous progress' : 'New automation'}</h3>
      </header>
      <div className="automation-create__body">
        <fieldset className="automation-choice" aria-label="Automation type" hidden={editor === 'progress'}>
          <legend>Action</legend>
          <label><input type="radio" name={typeName} value="schedule" checked={creationKind === 'schedule'} onChange={() => setCreationKind('schedule')} /><span>Send a message</span></label>
          <label><input type="radio" name={typeName} value="progress" checked={creationKind === 'progress'} onChange={() => setCreationKind('progress')} /><span>{progressConfigured ? 'Continue work · Edit' : 'Continue work'}</span></label>
        </fieldset>
        <p className="continuous-progress-control__help">{creationKind === 'schedule' ? 'Sent to this Agent when due and input is available.' : 'Continue after completed work. Busy checks are skipped.'}</p>
        <div hidden={creationKind !== 'schedule'}><ScheduleCreateForm key={draftKey} draftKey={draftKey} target={target} onReceipt={source.accept} records={source.records}
          initialMessage={initialMessage} initialMessageContext={initialMessageContext} onMessageChange={onMessageChange} embedded /></div>
        <div hidden={creationKind !== 'progress'}>{progressForm}</div>
      </div>
    </div> : <ScheduleCreateForm key={draftKey} draftKey={draftKey} target={target} onReceipt={source.accept} records={source.records}
      initialMessage={initialMessage} initialMessageContext={initialMessageContext} onMessageChange={onMessageChange} />}
  </section>
}
