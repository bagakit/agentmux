import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { DateTime } from 'luxon'
import type { ContinuousProgressLoop, ContinuousProgressTarget } from '@agentmux/core/continuous-progress-scheduler'
import { projectScheduleOccurrences } from '@agentmux/core/schedule-calendar'
import { automationCalendarTimezone, resolveAutomationPreferences } from '../../../shared/automation-preferences'
import type { SessionSnapshot } from '../../../shared/contracts'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { confirmedMoteReference } from '../lib/mote-materials-actions'
import { executionFocusPresentation } from '../lib/focus-tab-projection'
import { workbenchSelectionCatalog } from '../lib/desktop-focus-navigation'
import { agentSessionPresentationIndex, sessionPresentationById } from '../lib/session-presentation'
import { useScheduleClock } from '../lib/schedule-clock'
import { useScheduleRecords, type ScheduleQuery } from '../lib/schedule-controller'
import { useAppStore } from '../store'
import { SurfaceModeSwitch } from './SurfaceModeSwitch'
import { ScheduleArrangementRow } from './ScheduleArrangementRow'
import { ScheduleCreateForm } from './ScheduleCreateForm'
import '../styles/mote-calendar.css'

/** Exact directory facts only. A logical path or scratch container never grants scope. */
export function moteScheduleQueries(scope: MoteWorkfaceScope): ScheduleQuery[] {
  if (scope.issue || scope.topic.readError) return []
  const paths = scope.topic.confirmedDirectoryPaths ?? (scope.topic.physicalDirectoryPath ? [scope.topic.physicalDirectoryPath] : [])
  return [...new Set(paths)].sort().map(workspacePath => ({ scope: { hostId: scope.workspace.hostId, workspacePath } }))
}
function matchesTarget(session: SessionSnapshot | undefined, target: ContinuousProgressTarget) {
  return session?.kind === 'agent' && session.control.kind === 'agent' && session.hostId === target.hostId &&
    session.control.hostId === target.hostId && session.providerId === target.providerId && session.workspacePath === target.workspacePath &&
    session.control.agentSessionId === target.agentSessionId
}

export function MoteCalendar({ scope, reference, active }: {
  scope: MoteWorkfaceScope; reference?: WorkbenchProjectionSelection | null | undefined; active: boolean
}) {
  const queries = moteScheduleQueries(scope)
  const retained = useRef(queries)
  if (queries.length) retained.current = queries
  const source = useScheduleRecords(queries.length ? queries : retained.current, active && queries.length > 0)
  const now = useScheduleClock(active)
  const [timezone] = useState(() => automationCalendarTimezone(resolveAutomationPreferences(useAppStore.getState().config?.automation)))
  const [mode, setMode] = useState<'upcoming' | 'month'>('upcoming')
  const [selected, setSelected] = useState(() => DateTime.now().setZone(timezone).toISODate()!)
  const [month, setMonth] = useState(() => DateTime.now().setZone(timezone).startOf('month').toISODate()!)
  const [showEnded, setShowEnded] = useState(false), [navigationIssue, setNavigationIssue] = useState<string>()
  const grid = useRef<HTMLDivElement>(null), focusFrame = useRef<number | undefined>(undefined)
  const visible = useRef(active); visible.current = active
  useEffect(() => () => { if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current) }, [])
  // Only changed spatial/Session inputs recompute this derived view. Hidden views
  // retain their last labels without walking the catalog on unrelated Store updates.
  const queryKey = JSON.stringify(queries)
  const related = useAppStore(useMemo(() => {
    let previous: readonly unknown[] | undefined
    let result: { target?: ContinuousProgressTarget; labels: (string | undefined)[] } = { labels: [] }
    return (state: ReturnType<typeof useAppStore.getState>) => {
      if (!active) return result
      const facts = [state.config, state.sessions, state.tabs, state.layouts, state.spaceZoneBindings,
        state.scratchTopicSnapshots, state.workbenchSpaceSelection, state.activeWorkspaceId, state.topicCategories, state.projectGroups]
      if (previous && facts.every((fact, index) => fact === previous![index])) return result
      previous = facts
      const confirmed = confirmedMoteReference(state, scope, { reference })
      const region = confirmed ? state.tabs[confirmed.tabId]?.regions[confirmed.regionId] : undefined
      const current = region?.kind === 'agent' ? sessionPresentationById(state.sessions).get(region.sessionId) : undefined
      const target = current?.kind === 'agent' && current.control.kind === 'agent' && current.control.hostId === current.hostId && queries.some(query =>
        query.scope?.hostId === current.hostId && query.scope.workspacePath === current.workspacePath)
        ? { hostId: current.control.hostId, workspacePath: current.workspacePath, agentSessionId: current.control.agentSessionId, providerId: current.providerId } : undefined
      const index = agentSessionPresentationIndex(state.sessions)
      result = { ...(target ? { target } : {}), labels: source.records.map(record => {
        const candidates = index.get(record.agentSessionId)?.filter(session => matchesTarget(session, record)) ?? []
        return candidates.length === 1 ? candidates[0]!.label : undefined
      }) }
      return result
    }
  }, [active, scope, reference, queryKey, source.records]))
  const { target, labels } = related
  function openDiscussion(record: ContinuousProgressLoop) {
    const state = useAppStore.getState()
    const candidates = agentSessionPresentationIndex(state.sessions).get(record.agentSessionId)?.filter(session => matchesTarget(session, record)) ?? []
    if (candidates.length !== 1) { setNavigationIssue('The original discussion is not confirmed in this workface. Its arrangement and identity are kept.'); return }
    const sessionId = candidates[0]!.id
    const original = reference ? state.tabs[reference.tabId]?.regions[reference.regionId] : undefined
    const located = executionFocusPresentation({ sessionId, history: [],
      ...(reference && original?.kind === 'agent' && original.sessionId === sessionId ? { reference } : {}) },
      state.tabs, workbenchSelectionCatalog(state), () => {})
    const location = located.projection?.selection[0]
    if (!location || !state.selectMainRegion(location, state.workbenchSpaceSelection)) {
      setNavigationIssue(located.issue ?? 'The original discussion could not be focused. Its arrangement is kept.'); return
    }
    state.setMainSurface('workbench'); setNavigationIssue(undefined)
  }
  const records = useMemo(() => source.records.filter(record => showEnded || record.status !== 'stopped'), [source.records, showEnded])
  const ended = source.records.filter(record => record.status === 'stopped').length
  const byId = useMemo(() => new Map(source.records.map((record, index) => [record.loopId, { record, discussion: labels[index] }])), [source.records, labels])
  const start = DateTime.fromISO(month, { zone: timezone }).startOf('month')
  const gridStart = start.minus({ days: start.weekday - 1 })
  const cellCount = Math.ceil((start.weekday - 1 + start.daysInMonth!) / 7) * 7
  const windowFrom = gridStart.toMillis(), windowTo = gridStart.plus({ days: cellCount }).toMillis()
  const minute = Math.floor(now / 60000)
  const occurrences = useMemo(() => active && mode === 'month'
    ? projectScheduleOccurrences(records, { from: windowFrom, to: windowTo }, minute * 60000) : [],
  [active, mode, records, windowFrom, windowTo, minute])
  const days = useMemo(() => {
    const result = new Map<string, typeof occurrences>()
    for (const item of occurrences) {
      const day = DateTime.fromMillis(item.at, { zone: timezone }).toISODate()!
      result.set(day, [...result.get(day) ?? [], item])
    }
    return result
  }, [occurrences, timezone])
  function chooseDate(date: DateTime, focus = false) {
    const key = date.toISODate()!
    setSelected(key); setMonth(date.startOf('month').toISODate()!)
    if (focus) {
      if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current)
      focusFrame.current = requestAnimationFrame(() => { if (visible.current) grid.current?.querySelector<HTMLButtonElement>('[data-mote-date="' + key + '"]')?.focus() })
    }
  }
  function dateKey(event: KeyboardEvent<HTMLButtonElement>, date: DateTime) {
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key]
    const next = delta !== undefined ? date.plus({ days: delta }) : event.key === 'Home' ? date.minus({ days: date.weekday - 1 })
      : event.key === 'End' ? date.plus({ days: 7 - date.weekday }) : event.key === 'PageUp' ? date.minus({ months: 1 }) : event.key === 'PageDown' ? date.plus({ months: 1 }) : null
    if (next) { event.preventDefault(); chooseDate(next, true) }
  }
  const row = (record: ContinuousProgressLoop, occurrence?: (typeof occurrences)[number]) => <ScheduleArrangementRow
    key={record.loopId + ':' + (occurrence?.at ?? '')} schedule={record} occurrence={occurrence} timezone={timezone} now={now}
    onReceipt={source.accept} discussion={byId.get(record.loopId)?.discussion || 'Original discussion unconfirmed'} onOpenDiscussion={openDiscussion} />
  const ordered = [...records].sort((a, b) => a.nextCheckAt - b.nextCheckAt || a.loopId.localeCompare(b.loopId))
  const today = DateTime.fromMillis(now, { zone: timezone }).toISODate()!
  const dayItems = days.get(selected) ?? []
  return <div className="mote-calendar calendar-schedules mote-details__content" role="tabpanel" aria-label="Mote calendar">
    <header className="mote-calendar__heading"><div><h3>Arrangements</h3><p>Reminders, countdowns and recurring work</p></div><span>{source.observed ? source.records.length + ' saved' : 'Unconfirmed'}</span></header>
    <SurfaceModeSwitch value={mode} active={active} ariaLabel="Calendar view" options={[{ value: 'upcoming', label: 'Upcoming' }, { value: 'month', label: 'Month' }]} onChange={setMode} />
    <p className="mote-calendar__zone">Times shown in {timezone}</p>
    {!queries.length || source.error ? <div className="calendar-schedules__notice" role="status"><p>{!queries.length ? scope.issue ?? scope.topic.readError ?? 'Mote directory scope is unconfirmed.' : source.error} Last confirmed arrangements are kept.</p>{queries.length ? <button type="button" className="small-button" onClick={source.refresh}>Retry arrangements</button> : null}</div> : null}
    {navigationIssue ? <p role="status" className="calendar-schedules__notice">{navigationIssue}</p> : null}
    {mode === 'upcoming' ? <>
      {ordered.length ? <ol className="calendar-schedules__list" aria-label="Upcoming arrangements">{ordered.map(record => row(record))}</ol>
        : source.observed ? <div className="mote-calendar__empty"><strong>{ended ? 'No upcoming arrangements' : 'Time for a first arrangement'}</strong><p>{ended ? 'Ended arrangements are available below.' : 'Save a reminder or countdown for a Mote discussion. It will appear here.'}</p></div>
          : <p className="continuous-progress-control__help">{source.error || !queries.length ? 'Arrangements have not been confirmed.' : 'Reading arrangements…'}</p>}
    </> : <>
      <div className="mote-calendar__navigation"><button type="button" className="small-button" aria-label="Previous month" onClick={() => chooseDate(start.minus({ months: 1 }))}>‹</button><h4>{start.toFormat('LLLL yyyy')}</h4><button type="button" className="small-button" aria-label="Next month" onClick={() => chooseDate(start.plus({ months: 1 }))}>›</button><button type="button" className="small-button" onClick={() => chooseDate(DateTime.fromMillis(now, { zone: timezone }))}>Today</button></div>
      <div ref={grid} className="mote-calendar__grid" role="group" aria-label={start.toFormat('LLLL yyyy') + ' dates'}>
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((label, index) => <span className="mote-calendar__weekday" aria-hidden="true" key={index}>{label}</span>)}
        {Array.from({ length: cellCount }, (_, index) => {
          const date = gridStart.plus({ days: index }), key = date.toISODate()!, count = days.get(key)?.length ?? 0
          return <button type="button" key={key} data-mote-date={key} data-outside-month={date.month !== start.month} data-today={key === today}
            aria-label={date.toFormat('cccc, LLLL d, yyyy') + ', ' + count + ' arrangements'} aria-pressed={selected === key} tabIndex={selected === key ? 0 : -1}
            onClick={() => chooseDate(date)} onKeyDown={event => dateKey(event, date)}><span>{date.day}</span><small>{count || '\u00a0'}</small></button>
        })}
      </div>
      <section className="mote-calendar__day" aria-label="Selected day arrangements"><h4>{DateTime.fromISO(selected, { zone: timezone }).toFormat('cccc, LLLL d')}</h4>
        {dayItems.length ? <ol className="calendar-schedules__list">{dayItems.map(item => { const saved = byId.get(item.scheduleId); return saved ? row(saved.record, item) : null })}</ol> : <p className="continuous-progress-control__help">{source.observed ? 'No saved arrangements for this day.' : 'Arrangements for this day are unconfirmed.'}</p>}
        <p className="mote-calendar__legend">Planned times are estimates. Input accepted is the latest planned occurrence accepted by the Host; completed work is shown in its discussion.</p>
      </section>
    </>}
    {ended ? <label className="mote-calendar__ended"><input type="checkbox" checked={showEnded} onChange={event => setShowEnded(event.target.checked)} />Show ended ({ended})</label> : null}
    <ScheduleCreateForm draftKey={'mote-schedule-create:' + JSON.stringify([scope.workspace.hostId, scope.workspace.id, scope.workspace.path, scope.topic.id])}
      target={target} onReceipt={source.accept} records={source.records} initialDate={selected} defaultKind="once" />
  </div>
}
