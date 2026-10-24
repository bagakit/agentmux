import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { DateTime } from 'luxon'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { ContinuousProgressLoop, ContinuousProgressTarget } from '@agentmux/core/continuous-progress-scheduler'
import { projectScheduleOccurrences } from '@agentmux/core/schedule-calendar'
import { automationCalendarTimezone, resolveAutomationPreferences } from '../../../shared/automation-preferences'
import type { SessionSnapshot } from '../../../shared/contracts'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { confirmedMoteReference } from '../lib/mote-materials-actions'
import { executionFocusPresentation } from '../lib/focus-tab-projection'
import { spatialCatalog } from '../lib/space-agent-control'
import { scratchTopicsForConfig } from '../lib/scratch-topic-snapshots'
import { agentSessionPresentationIndex, sessionPresentationById } from '../lib/session-presentation'
import { useScheduleClock } from '../lib/schedule-clock'
import { useScheduleRecords, type ScheduleQuery } from '../lib/schedule-controller'
import { useAppStore } from '../store'
import { useSpaceContentPresentation } from '../lib/space-content-presentation'
import { SurfaceModeSwitch } from './SurfaceModeSwitch'
import { ScheduleArrangementRow, scheduleStateLabel } from './ScheduleArrangementRow'
import { ScheduleCreateForm } from './ScheduleCreateForm'
import '../styles/mote-calendar.css'

const ChevronLeft = semanticIconComponent('navigation.back')
const ChevronRight = semanticIconComponent('navigation.forward')
const Plus = semanticIconComponent('action.create')

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

export function MoteCalendar({ scope, reference, active, openRequest }: {
  scope: MoteWorkfaceScope; reference?: WorkbenchProjectionSelection | null | undefined; active: boolean
  openRequest?: { scheduleId: string } | undefined
}) {
  const contentPresentation = useSpaceContentPresentation()
  const queries = moteScheduleQueries(scope)
  const retained = useRef(queries)
  if (queries.length) retained.current = queries
  const source = useScheduleRecords(queries.length ? queries : retained.current, active && queries.length > 0)
  const now = useScheduleClock(active)
  const [timezone] = useState(() => automationCalendarTimezone(resolveAutomationPreferences(useAppStore.getState().config?.automation)))
  const [mode, setMode] = useState<'upcoming' | 'month' | 'week'>('month')
  const [selected, setSelected] = useState(() => DateTime.now().setZone(timezone).toISODate()!)
  const [month, setMonth] = useState(() => DateTime.now().setZone(timezone).startOf('month').toISODate()!)
  const [showEnded, setShowEnded] = useState(false), [navigationIssue, setNavigationIssue] = useState<string>()
  const [createRequest, setCreateRequest] = useState<{ sequence: number; date: string; time?: string }>()
  const [selectedOccurrence, setSelectedOccurrence] = useState<string>()
  const surface = useRef<HTMLDivElement>(null), grid = useRef<HTMLDivElement>(null), agenda = useRef<HTMLElement>(null), focusFrame = useRef<number | undefined>(undefined)
  const weekScroll = useRef<HTMLDivElement>(null), weekViewport = useRef<{ period: number; top: number } | undefined>(undefined)
  const visible = useRef(active); visible.current = active
  useEffect(() => () => { if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current) }, [])
  // Spatial membership and live Session labels have separate inputs. A Session update
  // cannot move this original Region, but can change its target or discussion labels.
  const queryKey = JSON.stringify(queries)
  const related = useAppStore(useMemo(() => {
    let previous: readonly unknown[] | undefined
    let sessions: readonly SessionSnapshot[] | undefined
    let confirmed: WorkbenchProjectionSelection | null = null
    let result: { target?: ContinuousProgressTarget; labels: (string | undefined)[] } = { labels: [] }
    return (state: ReturnType<typeof useAppStore.getState>) => {
      if (!active) return result
      const facts = [state.config, state.tabs, state.layouts, state.spaceZoneBindings,
        state.scratchTopicSnapshots, state.workbenchSpaceSelection, state.activeWorkspaceId, state.topicCategories, state.projectGroups]
      const spatialChanged = !previous || facts.some((fact, index) => fact !== previous![index])
      if (!spatialChanged && sessions === state.sessions) return result
      if (spatialChanged) {
        confirmed = confirmedMoteReference(state, scope, { reference })
        previous = facts
      }
      sessions = state.sessions
      const region = confirmed ? state.tabs[confirmed.tabId]?.regions[confirmed.regionId] : undefined
      const current = region?.kind === 'agent' ? sessionPresentationById(state.sessions).get(region.sessionId) : undefined
      const target = current?.kind === 'agent' && current.control.kind === 'agent' && current.control.hostId === current.hostId && queries.some(query =>
        query.scope?.hostId === current.hostId && query.scope.workspacePath === current.workspacePath)
        ? { hostId: current.control.hostId, workspacePath: current.workspacePath, agentSessionId: current.control.agentSessionId, providerId: current.providerId } : undefined
      const index = agentSessionPresentationIndex(state.sessions)
      const labels = source.records.map(record => {
        const candidates = index.get(record.agentSessionId)?.filter(session => matchesTarget(session, record)) ?? []
        return candidates.length === 1 ? candidates[0]!.label : undefined
      })
      if (target?.hostId === result.target?.hostId && target?.workspacePath === result.target?.workspacePath &&
        target?.agentSessionId === result.target?.agentSessionId && target?.providerId === result.target?.providerId &&
        labels.length === result.labels.length && labels.every((label, index) => label === result.labels[index])) return result
      result = { ...(target ? { target } : {}), labels }
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
      state.tabs, spatialCatalog(state, scratchTopicsForConfig(state.config, state.scratchTopicSnapshots) ?? []), () => {}, 'tab', candidates[0]!.control.agentSessionId)
    const location = located.projection?.selection[0]
    if (!location || !state.selectMainRegion(location, state.workbenchSpaceSelection)) {
      setNavigationIssue(located.issue ?? 'The original discussion could not be focused. Its arrangement is kept.'); return
    }
    state.setMainSurface('workbench'); contentPresentation?.collapse(); setNavigationIssue(undefined)
  }
  const records = useMemo(() => source.records.filter(record => showEnded || record.status !== 'stopped'), [source.records, showEnded])
  const ended = source.records.filter(record => record.status === 'stopped').length
  const byId = useMemo(() => new Map(source.records.map((record, index) => [record.loopId, { record, discussion: labels[index] }])), [source.records, labels])
  const start = DateTime.fromISO(month, { zone: timezone }).startOf('month')
  const selectedDate = DateTime.fromISO(selected, { zone: timezone })
  const gridStart = mode === 'week' ? selectedDate.startOf('week') : start.minus({ days: start.weekday - 1 })
  const cellCount = mode === 'week' ? 7 : Math.ceil((start.weekday - 1 + start.daysInMonth!) / 7) * 7
  const windowFrom = gridStart.toMillis(), windowTo = gridStart.plus({ days: cellCount }).toMillis()
  const minute = Math.floor(now / 60000)
  const occurrences = useMemo(() => active && mode !== 'upcoming'
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
    setSelected(key); setMonth(date.startOf('month').toISODate()!); setSelectedOccurrence(undefined)
    if (focus) {
      if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current)
      focusFrame.current = requestAnimationFrame(() => { if (visible.current) grid.current?.querySelector<HTMLButtonElement>('[data-mote-date="' + key + '"]')?.focus() })
    }
  }
  function prepare(date = selectedDate, time?: string) {
    chooseDate(date)
    setCreateRequest(previous => ({ sequence: (previous?.sequence ?? 0) + 1, date: date.toISODate()!, ...(time ? { time } : {}) }))
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
  const requested = useRef<typeof openRequest>(undefined)
  const pendingReveal = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    if (!active || !openRequest || requested.current === openRequest) return
    requested.current = openRequest
    pendingReveal.current = openRequest.scheduleId
    setMode('upcoming'); setShowEnded(true)
    // Any later input owns attention, even if the original read is still pending.
    const cancel = () => { pendingReveal.current = undefined }
    document.addEventListener('pointerdown', cancel, true)
    document.addEventListener('keydown', cancel, true)
    document.addEventListener('input', cancel, true)
    return () => { cancel(); document.removeEventListener('pointerdown', cancel, true); document.removeEventListener('keydown', cancel, true); document.removeEventListener('input', cancel, true) }
  }, [active, openRequest])
  useLayoutEffect(() => {
    const id = pendingReveal.current
    // A retained snapshot may predate the home row. Keep the original request
    // until this reader confirms it; read failures retain the same retry path.
    if (!active || mode !== 'upcoming' || !showEnded || !id || !byId.has(id)) return
    pendingReveal.current = undefined
    setNavigationIssue(undefined)
    focusArrangement(surface.current, id)
  }, [active, mode, showEnded, source.observed, byId, openRequest])
  const ordered = [...records].sort((a, b) => a.nextCheckAt - b.nextCheckAt || a.loopId.localeCompare(b.loopId))
  const today = DateTime.fromMillis(now, { zone: timezone }).toISODate()!
  const dayItems = days.get(selected) ?? []
  const visibleDates = useMemo(() => Array.from({ length: cellCount }, (_, index) => DateTime.fromMillis(windowFrom, { zone: timezone }).plus({ days: index })), [windowFrom, cellCount, timezone])
  const hourly = useMemo(() => {
    const result = new Map<string, typeof occurrences>()
    if (mode !== 'week') return result
    for (const item of occurrences) {
      const date = DateTime.fromMillis(item.at, { zone: timezone }), key = date.toISODate() + ':' + date.hour
      result.set(key, [...result.get(key) ?? [], item])
    }
    return result
  }, [mode, occurrences, timezone])
  useLayoutEffect(() => {
    if (!active || mode !== 'week' || !source.observed || !weekScroll.current) return
    const scroller = weekScroll.current, previous = weekViewport.current
    if (previous?.period === windowFrom) scroller.scrollTop = previous.top
    else {
      const current = DateTime.fromMillis(now, { zone: timezone })
      const earliest = occurrences.length ? Math.min(...occurrences.map(item => DateTime.fromMillis(item.at, { zone: timezone }).hour)) : undefined
      const firstHour = visibleDates.some(date => date.hasSame(current, 'day')) ? Math.min(current.hour, earliest ?? current.hour) : earliest ?? 9
      const hours = scroller.querySelectorAll<HTMLElement>('.mote-calendar__hour')
      scroller.scrollTop = (hours[Math.max(0, firstHour - 1)]?.offsetTop ?? 0) - (hours[0]?.offsetTop ?? 0)
    }
    weekViewport.current = { period: windowFrom, top: scroller.scrollTop }
  // Re-entry restores user scroll; countdown ticks and new records never move it.
  }, [active, mode, windowFrom, source.observed])
  const title = mode === 'upcoming' ? 'Upcoming' : mode === 'week' ? gridStart.toFormat('LLL d') + ' – ' + gridStart.plus({ days: 6 }).toFormat('LLL d, yyyy') : start.toFormat('LLLL yyyy')
  const occurrenceKey = (item: (typeof occurrences)[number]) => JSON.stringify([item.scheduleId, item.at])
  function focusArrangement(container: HTMLElement | null, scheduleId: string) {
    if (!visible.current) return
    const element = [...container?.querySelectorAll<HTMLElement>('[data-schedule-id]') ?? []].find(element => element.dataset.scheduleId === scheduleId)
    const details = element?.querySelector<HTMLDetailsElement>('details')
    if (details) { details.open = true; details.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true }) }
    element?.scrollIntoView?.({ block: 'nearest' })
  }
  function showSaved(record: ContinuousProgressLoop) {
    setMode('upcoming'); chooseDate(DateTime.fromMillis(record.nextCheckAt, { zone: timezone }))
    if (byId.get(record.loopId)?.record.status === 'stopped') setShowEnded(true)
    if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current)
    focusFrame.current = requestAnimationFrame(() => focusArrangement(surface.current, record.loopId))
  }
  function openOccurrence(item: (typeof occurrences)[number]) {
    chooseDate(DateTime.fromMillis(item.at, { zone: timezone })); setSelectedOccurrence(occurrenceKey(item))
    if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current)
    focusFrame.current = requestAnimationFrame(() => focusArrangement(agenda.current, item.scheduleId))
  }
  const point = (item: (typeof occurrences)[number], compact = false) => {
    const saved = byId.get(item.scheduleId)
    if (!saved) return null
    const date = DateTime.fromMillis(item.at, { zone: timezone }), text = saved.record.prompt.split('\n')[0]!
    const phase = item.kind === 'projected' ? 'Planned' : item.kind === 'last-accepted' ? 'Input accepted' : scheduleStateLabel(saved.record, now)
    return <button type="button" className={compact ? 'mote-calendar__point mote-calendar__point--week' : 'mote-calendar__point'} key={occurrenceKey(item)}
      data-calendar-schedule-id={item.scheduleId} data-phase={item.kind === 'projected' ? 'planned' : item.kind === 'last-accepted' ? 'accepted' : saved.record.lastOutcome === 'unknown' ? 'unknown' : saved.record.status}
      aria-label={date.toFormat('cccc, LLLL d, HH:mm') + ' · ' + text + ' · ' + phase} aria-pressed={selectedOccurrence === occurrenceKey(item)}
      title={date.toFormat('HH:mm') + ' · ' + text + ' · ' + phase} onClick={() => openOccurrence(item)}>
      <time dateTime={new Date(item.at).toISOString()}>{date.toFormat('HH:mm')}</time><span>{text}</span>{phase !== 'Active' ? <small>{phase}</small> : null}
    </button>
  }
  return <div ref={surface} className="mote-calendar calendar-schedules mote-details__content" role="tabpanel" aria-label="Mote calendar">
    <header className="mote-calendar__toolbar" aria-label="Calendar controls">
      <div className="mote-calendar__navigation">{mode !== 'upcoming' ? <><button type="button" aria-label={mode === 'week' ? 'Previous week' : 'Previous month'} onClick={() => chooseDate(mode === 'week' ? selectedDate.minus({ weeks: 1 }) : start.minus({ months: 1 }))}><ChevronLeft size={16} aria-hidden /></button>
        <button type="button" aria-label={mode === 'week' ? 'Next week' : 'Next month'} onClick={() => chooseDate(mode === 'week' ? selectedDate.plus({ weeks: 1 }) : start.plus({ months: 1 }))}><ChevronRight size={16} aria-hidden /></button>
        </> : null}<h4>{title}</h4>{mode !== 'upcoming' ? <button type="button" className="mote-calendar__today" onClick={() => chooseDate(DateTime.fromMillis(now, { zone: timezone }))}>Today</button> : null}</div>
      <SurfaceModeSwitch value={mode} active={active} ariaLabel="Calendar view" options={[{ value: 'month', label: 'Month' }, { value: 'week', label: 'Week' }, { value: 'upcoming', label: 'Upcoming' }]} onChange={setMode} />
      <button type="button" className="mote-calendar__create" aria-label="New arrangement" title="New arrangement" onClick={() => prepare()}><Plus size={14} aria-hidden /><span>New<span className="mote-calendar__create-label"> arrangement</span></span></button>
    </header>
    <div className="mote-calendar__meta"><span className="mote-calendar__zone">{timezone}</span><span>{source.observed ? source.records.length + ' saved arrangements' : 'Arrangements unconfirmed'}</span></div>
    {!queries.length || source.error ? <div className="calendar-schedules__notice" role="status"><p>{!queries.length ? scope.issue ?? scope.topic.readError ?? 'Mote directory scope is unconfirmed.' : source.error} Last confirmed arrangements are kept.</p>{queries.length ? <button type="button" className="small-button" onClick={source.refresh}>Retry arrangements</button> : null}</div> : null}
    {navigationIssue ? <p role="status" className="calendar-schedules__notice">{navigationIssue}</p> : null}
    {mode !== 'upcoming' && source.observed && !source.records.length ? <div className="mote-calendar__empty"><strong>No arrangements yet</strong><p>Choose a date and prepare a reminder for an original discussion.</p></div> : null}
    {mode === 'upcoming' ? <section aria-label="Upcoming arrangements">
      {ordered.length ? <ol className="calendar-schedules__list" aria-label="Upcoming arrangements">{ordered.map(record => row(record))}</ol>
        : source.observed ? <div className="mote-calendar__empty"><strong>{ended ? 'No upcoming arrangements' : 'Time for a first arrangement'}</strong><p>{ended ? 'Ended arrangements are available below.' : 'Save a reminder or countdown for a Mote discussion. It will appear here.'}</p></div>
          : <p className="continuous-progress-control__help">{source.error || !queries.length ? 'Arrangements have not been confirmed.' : 'Reading arrangements…'}</p>}
    </section> : <div className="mote-calendar__workspace">
      <div className="mote-calendar__canvas" ref={grid}>
        <div className="mote-calendar__weekdays" aria-hidden="true">{visibleDates.slice(0, 7).map(date => <span key={date.weekday}>{date.toFormat('ccc')}</span>)}</div>
        <div className="mote-calendar__grid" role="group" aria-label={title + ' dates'} data-view={mode}>
          {visibleDates.map(date => {
            const key = date.toISODate()!, items = days.get(key) ?? []
            return <div className="mote-calendar__cell" key={key} data-outside-month={mode === 'month' && date.month !== start.month} data-selected={selected === key} data-today={key === today}
              onClick={event => { if (!(event.target as HTMLElement).closest('button')) prepare(date) }}>
              <button type="button" className="mote-calendar__date" data-mote-date={key}
                aria-label={date.toFormat('cccc, LLLL d, yyyy') + ', ' + items.length + ' arrangements'} aria-pressed={selected === key} tabIndex={selected === key ? 0 : -1}
                onClick={() => chooseDate(date)} onKeyDown={event => dateKey(event, date)}><span>{date.day}</span><small>{items.length || '\u00a0'}</small></button>
              {mode === 'month' ? <div className="mote-calendar__previews">{items.slice(0, 2).map(item => point(item))}
                {items.length > 2 ? <button type="button" className="mote-calendar__more" onClick={() => chooseDate(date)}>+{items.length - 2} more</button> : null}</div> : null}
            </div>
          })}
        </div>
        {mode === 'week' ? <div ref={weekScroll} className="mote-calendar__week-scroll" aria-label="Week arrangement times" onScroll={event => {
          if (visible.current) weekViewport.current = { period: windowFrom, top: event.currentTarget.scrollTop }
        }}><div className="mote-calendar__week-timeline">
          {Array.from({ length: 24 }, (_, hour) => <div className="mote-calendar__hour" key={hour}><time>{String(hour).padStart(2, '0')}:00</time><div className="mote-calendar__hour-days">
            {visibleDates.map(date => <div className="mote-calendar__hour-day" key={date.toISODate()}>
              <button type="button" className="mote-calendar__slot" tabIndex={-1} aria-label={'Prepare arrangement ' + date.toFormat('cccc, LLLL d') + ' at ' + String(hour).padStart(2, '0') + ':00'} onClick={() => prepare(date, String(hour).padStart(2, '0') + ':00')} />
              {(hourly.get(date.toISODate() + ':' + hour) ?? []).map(item => point(item, true))}
            </div>)}
          </div></div>)}
        </div></div> : null}
      </div>
      <section ref={agenda} className="mote-calendar__day" aria-label="Selected day arrangements"><header><div><span className="mote-calendar__day-label">{selected === today ? 'Today' : selectedDate.toFormat('cccc')}</span><h4>{selectedDate.toFormat('LLLL d')}</h4></div><button type="button" className="mote-calendar__day-add" aria-label="Add arrangement on selected day" onClick={() => prepare()}><Plus size={15} aria-hidden /></button></header>
        {dayItems.length ? <ol className="calendar-schedules__list">{dayItems.map(item => { const saved = byId.get(item.scheduleId); return saved ? row(saved.record, item) : null })}</ol> : <p className="continuous-progress-control__help">{source.observed ? 'No saved arrangements for this day.' : 'Arrangements for this day are unconfirmed.'}</p>}
        {dayItems.some(item => item.kind !== 'next-due') ? <p className="mote-calendar__legend">Planned times are estimates. Input accepted confirms Host input, not completed work.</p> : null}
      </section>
    </div>}
    {ended ? <label className="mote-calendar__ended"><input type="checkbox" checked={showEnded} onChange={event => setShowEnded(event.target.checked)} />Show ended ({ended})</label> : null}
    <ScheduleCreateForm draftKey={'mote-schedule-create:' + JSON.stringify([scope.workspace.hostId, scope.workspace.id, scope.workspace.path, scope.topic.id])}
      target={target} onReceipt={source.accept} records={source.records} initialDate={selected} defaultKind="once" openRequest={createRequest} onShowSaved={showSaved} />
  </div>
}
