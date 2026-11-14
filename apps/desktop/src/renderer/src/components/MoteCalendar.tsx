import { Button } from '@agentmux/client-ui/components/Button'
import { requestDesktopFocusWorkfaceReveal } from '../lib/desktop-presentation'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { DateTime } from 'luxon'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { ContinuousProgressLoop, ContinuousProgressTarget } from '@agentmux/core/continuous-progress-scheduler'
import { projectScheduleOccurrences, sliceScheduleOccurrences } from '@agentmux/core/schedule-calendar'
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
import { useCalendarReceipts } from '../lib/mote-calendar-receipts'
import { calendarCellLines, calendarDayWindow, calendarHourWindows, calendarReceiptLines, calendarScheduleGroups, type CalendarCellLine } from '../lib/mote-calendar-range'
import { SurfaceModeSwitch } from './SurfaceModeSwitch'
import { ScheduleArrangementRow, scheduleCalendarLabel, scheduleStateLabel } from './ScheduleArrangementRow'
import { ScheduleCreateForm, type CalendarCreateSelection } from './ScheduleCreateForm'
import { MoteCalendarTimes } from './MoteCalendarTimes'
import { MoteCalendarEvents } from './MoteCalendarEvents'

const ChevronLeft = semanticIconComponent('navigation.back')
const ChevronRight = semanticIconComponent('navigation.forward')
const Plus = semanticIconComponent('action.create')
type CalendarMode = 'day' | 'three-days' | 'week' | 'month' | 'upcoming'
const hourLabel = (hour: number) => String(hour).padStart(2, '0') + ':00'
const hoursOfDay = Array.from({ length: 24 }, (_, hour) => hour)
const formatCount = new Intl.NumberFormat()

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

export function MoteCalendar({ scope, reference, active, openRequest, onSelectDiscussion }: {
  scope: MoteWorkfaceScope; reference?: WorkbenchProjectionSelection | null | undefined; active: boolean
  onSelectDiscussion?: (reference: WorkbenchProjectionSelection) => boolean
  openRequest?: { scheduleId: string } | undefined
}) {
  const contentPresentation = useSpaceContentPresentation()
  const queries = moteScheduleQueries(scope)
  const retained = useRef(queries)
  if (queries.length) retained.current = queries
  const source = useScheduleRecords(queries.length ? queries : retained.current, active && queries.length > 0)
  const [timezone] = useState(() => automationCalendarTimezone(resolveAutomationPreferences(useAppStore.getState().config?.automation)))
  const [mode, setMode] = useState<CalendarMode>('month')
  const now = useScheduleClock(active, mode === 'upcoming' ? 1000 : 60000)
  const [selected, setSelected] = useState(() => DateTime.now().setZone(timezone).toISODate()!)
  const [period, setPeriod] = useState(selected)
  const [selectedHour, setSelectedHour] = useState(() => DateTime.fromMillis(now, { zone: timezone }).hour)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsInvoker = useRef<HTMLElement | null>(null)
  const [showEnded, setShowEnded] = useState(false), [navigationIssue, setNavigationIssue] = useState<string>()
  const [createRequest, setCreateRequest] = useState<CalendarCreateSelection>()
  const createTrigger = useRef<HTMLButtonElement>(null)
  const surface = useRef<HTMLDivElement>(null), grid = useRef<HTMLDivElement>(null), focusFrame = useRef<number | undefined>(undefined)
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
    let result: { target?: ContinuousProgressTarget; discussion?: string; labels: (string | undefined)[] } = { labels: [] }
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
        current?.label === result.discussion && labels.length === result.labels.length && labels.every((label, index) => label === result.labels[index])) return result
      result = { ...(target ? { target } : {}), ...(current?.label ? { discussion: current.label } : {}), labels }
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
    if (!location || !(onSelectDiscussion ? onSelectDiscussion(location) : state.selectMainRegion(location, state.workbenchSpaceSelection))) {
      setNavigationIssue(located.issue ?? 'The original discussion could not be focused. Its arrangement is kept.'); return
    }
    setNavigationIssue(undefined)
    if (onSelectDiscussion) return
    const choice = useAppStore.getState().workbenchSpaceSelection
    if (choice) requestDesktopFocusWorkfaceReveal(choice)
    state.setMainSurface('workbench'); contentPresentation?.collapse()
  }
  const records = useMemo(() => source.records.filter(record => record.status !== 'stopped'), [source.records])
  const ended = source.records.length - records.length
  const byId = useMemo(() => new Map(source.records.map((record, index) => [record.loopId, { record, discussion: labels[index] }])), [source.records, labels])
  const periodDate = DateTime.fromISO(period, { zone: timezone })
  const start = periodDate.startOf('month')
  const selectedDate = DateTime.fromISO(selected, { zone: timezone })
  const timed = mode !== 'month' && mode !== 'upcoming'
  const gridStart = mode === 'week' ? periodDate.startOf('week') : timed ? periodDate : start.minus({ days: start.weekday - 1 })
  const cellCount = mode === 'week' ? 7 : mode === 'three-days' ? 3 : mode === 'day' ? 1 : Math.ceil((start.weekday - 1 + start.daysInMonth!) / 7) * 7
  const windowFrom = gridStart.startOf('day').toMillis(), windowTo = gridStart.plus({ days: cellCount }).startOf('day').toMillis()
  const minute = Math.floor(now / 60000) * 60000
  const occurrences = useMemo(() => active && mode !== 'upcoming'
    ? projectScheduleOccurrences(source.records, { from: windowFrom, to: windowTo }, minute)
      .filter(item => item.kind === 'last-accepted' || byId.get(item.scheduleId)?.record.status !== 'stopped') : [],
  [active, mode, source.records, byId, windowFrom, windowTo, minute])
  const visibleDates = useMemo(() => Array.from({ length: cellCount }, (_, index) => DateTime.fromMillis(windowFrom, { zone: timezone }).plus({ days: index }).startOf('day')), [windowFrom, cellCount, timezone])
  const days = useMemo(() => {
    return new Map(visibleDates.map(date => {
      const items = sliceScheduleOccurrences(occurrences, calendarDayWindow(date))
      return [date.toISODate()!, calendarScheduleGroups(items, byId, minute)]
    }))
  }, [visibleDates, occurrences, byId, minute])
  const hourWindows = useMemo(() => new Map(timed ? visibleDates.flatMap(date => [...calendarHourWindows(date)].map(([hour, window]) =>
    [date.toISODate()! + ':' + hour, window] as const)) : []), [timed, visibleDates])
  const hourly = useMemo(() => new Map(active ? [...hourWindows].map(([key, window]) => {
    const items = sliceScheduleOccurrences(occurrences, window)
    return [key, { items, window, groups: calendarScheduleGroups(items, byId, minute) }]
  }) : []), [active, hourWindows, occurrences, byId, minute])
  const bucketStarts = useMemo(() => timed ? Array.from(hourWindows.values(), window => window.from) : visibleDates.map(date => date.toMillis()), [timed, hourWindows, visibleDates])
  const history = useCalendarReceipts(source.records, bucketStarts, windowTo, JSON.stringify(retained.current), active && mode !== 'upcoming' && queries.length > 0 && source.observed && windowFrom <= now)
  const receiptLines = useMemo(() => calendarReceiptLines(history.rows, byId), [history.rows, byId])
  function openPeriod(invoker: HTMLElement) {
    detailsInvoker.current = invoker
    setDetailsOpen(true)
  }
  function closePeriod() {
    setDetailsOpen(false)
    if (detailsInvoker.current?.isConnected) detailsInvoker.current.focus({ preventScroll: true })
  }
  function lineTitle(line: CalendarCellLine) {
    if (!line.recorded || line.record.managedSource) return scheduleCalendarLabel(line.record)
    return line.originalLabel ? scheduleCalendarLabel({ ...line.record, prompt: line.originalLabel }) : 'Scheduled input'
  }
  const localTime = useMemo(() => new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }), [timezone])
  function lineText(line: CalendarCellLine) {
    if (line.planned && line.planned > 1) return formatCount.format(line.planned) + ' planned'
    const time = localTime.format(line.at)
    if (line.recorded && line.recorded > 1) return line.text + ' ×' + formatCount.format(line.recorded)
    return time + ' · ' + line.text
  }
  function describeLine(line: CalendarCellLine) {
    const label = lineTitle(line) + ' · ' + lineText(line)
    return line.lastAt && line.lastAt !== line.at ? label + ' (' + localTime.format(line.at) + '–' + localTime.format(line.lastAt) + ')' : label
  }
  function chooseDate(date: DateTime, focus = false, changePeriod = false) {
    const key = date.toISODate()!
    setSelected(key)
    if (changePeriod || mode !== 'three-days' || date.toMillis() < windowFrom || date.toMillis() >= windowTo) setPeriod(key)
    if (focus) {
      if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current)
      focusFrame.current = requestAnimationFrame(() => { if (visible.current) grid.current?.querySelector<HTMLButtonElement>('[data-mote-date="' + key + '"]')?.focus() })
    }
  }
  function changeMode(value: CalendarMode) {
    setDetailsOpen(false); setPeriod(selected); setMode(value)
  }
  function movePeriod(direction: 1 | -1) {
    chooseDate(mode === 'month' ? start.plus({ months: direction }) : gridStart.plus({ days: direction * cellCount }), false, true)
  }
  function prepare(anchor: HTMLElement, date = selectedDate, time = timed ? hourLabel(selectedHour) : undefined) {
    chooseDate(date)
    setCreateRequest(previous => ({ sequence: (previous?.sequence ?? 0) + 1, date: date.toISODate()!, timezone, anchor, ...(time ? { time } : {}) }))
  }
  function dateKey(event: KeyboardEvent<HTMLButtonElement>, date: DateTime) {
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key]
    const next = delta !== undefined ? date.plus({ days: delta }) : event.key === 'Home' ? date.minus({ days: date.weekday - 1 })
      : event.key === 'End' ? date.plus({ days: 7 - date.weekday }) : event.key === 'PageUp' ? date.minus({ months: 1 }) : event.key === 'PageDown' ? date.plus({ months: 1 }) : null
    if (next) { event.preventDefault(); chooseDate(next, true) }
  }
  const row = (record: ContinuousProgressLoop) => <ScheduleArrangementRow
    key={record.loopId} schedule={record} calendarSummary timezone={timezone} now={now}
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
  const today = DateTime.fromMillis(now, { zone: timezone }).toISODate()!
  const hourKeyOfSelection = selected + ':' + selectedHour
  const selectedSlot = hourly.get(hourKeyOfSelection)
  const eventWindow = timed ? hourWindows.get(hourKeyOfSelection) : calendarDayWindow(selectedDate)
  const selectedGroups = timed ? selectedSlot?.groups ?? [] : days.get(selected) ?? []
  const selectedCount = selectedGroups.reduce((sum, group) => sum + group.planned, 0)
  const selectedEvents = useMemo(() => eventWindow ? sliceScheduleOccurrences(occurrences, eventWindow) : [],
    [occurrences, eventWindow?.from, eventWindow?.to])
  const selectedPlans = useMemo(() => selectedEvents.filter(item => item.kind !== 'last-accepted'), [selectedEvents])
  const ordered = [...(showEnded ? source.records : records)].sort((a, b) => a.nextCheckAt - b.nextCheckAt || a.loopId.localeCompare(b.loopId))
  const previousRange = useRef(windowFrom)
  useLayoutEffect(() => {
    const direction = Math.sign(windowFrom - previousRange.current)
    previousRange.current = windowFrom
    const board = grid.current
    if (!active || !board || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const animation = board.animate?.([{ opacity: .62, transform: `translateX(${direction * 12}px)` }, { opacity: 1, transform: 'translateX(0)' }],
      { duration: 190, easing: 'cubic-bezier(.2,.72,.18,1)' })
    // A new range or a hidden surface cancels this presentation-only transition.
    void animation?.finished.catch(() => {})
    return () => animation?.cancel()
  }, [active, mode, windowFrom])
  useLayoutEffect(() => {
    if (!active || !timed || !source.observed || !weekScroll.current) return
    const scroller = weekScroll.current, previous = weekViewport.current
    if (previous?.period === windowFrom) scroller.scrollTop = previous.top
    else {
      const hours = scroller.querySelectorAll<HTMLElement>('.mote-calendar__hour')
      scroller.scrollTop = (hours[Math.max(0, selectedHour - 2)]?.offsetTop ?? 0) - (hours[0]?.offsetTop ?? 0)
    }
    weekViewport.current = { period: windowFrom, top: scroller.scrollTop }
  // Re-entry restores user scroll; countdown ticks and new records never move it.
  }, [active, timed, mode, windowFrom, source.observed])
  const title = mode === 'upcoming' ? 'Upcoming' : mode === 'month' ? start.toFormat('LLLL yyyy') : mode === 'day' ? gridStart.toFormat('ccc, LLL d')
    : gridStart.toFormat('LLL d') + ' – ' + gridStart.plus({ days: cellCount - 1 }).toFormat('LLL d, yyyy')
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
  function revealArrangement(scheduleId: string) {
    const saved = byId.get(scheduleId)
    if (saved) showSaved(saved.record)
  }
  function selectHour(date: DateTime, hour: number, focus = false) {
    chooseDate(date); setSelectedHour(hour)
    if (focus) {
      if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current)
      const key = date.toISODate()! + ':' + hour
      focusFrame.current = requestAnimationFrame(() => { if (visible.current) grid.current?.querySelector<HTMLButtonElement>(`[data-calendar-hour="${key}"]`)?.focus() })
    }
  }
  function hourKey(event: KeyboardEvent<HTMLButtonElement>, date: DateTime, hour: number) {
    const offset = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: 0, ArrowRight: 0 }[event.key]
    if (offset === undefined) return
    const nextDate = date.plus({ days: event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0 })
    let nextHour = hour + offset
    while (offset && nextHour >= 0 && nextHour < 24 && !hourly.has(nextDate.toISODate()! + ':' + nextHour)) nextHour += offset
    if (!hourly.has(nextDate.toISODate()! + ':' + nextHour)) return
    event.preventDefault(); selectHour(nextDate, nextHour, true)
  }
  return <div ref={surface} className="mote-calendar calendar-schedules mote-details__content" role="tabpanel" aria-label="Mote calendar">
    <div className="mote-calendar__surface">
    <header className="mote-calendar__toolbar" aria-label="Calendar controls">
      <div className="mote-calendar__navigation">{mode !== 'upcoming' ? <><button type="button" aria-label={'Previous ' + mode.replace('-', ' ')} onClick={() => movePeriod(-1)}><ChevronLeft size={16} aria-hidden /></button>
        <button type="button" aria-label={'Next ' + mode.replace('-', ' ')} onClick={() => movePeriod(1)}><ChevronRight size={16} aria-hidden /></button>
        </> : null}<h4>{title}</h4>{mode !== 'upcoming' ? <button type="button" className="mote-calendar__today" onClick={() => { const date = DateTime.fromMillis(now, { zone: timezone }); chooseDate(date, false, true); setSelectedHour(date.hour) }}>Today</button> : null}</div>
      <SurfaceModeSwitch value={mode} active={active} ariaLabel="Calendar view" options={[{ value: 'day', label: 'Day' }, { value: 'three-days', label: '3 Days' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'upcoming', label: 'Upcoming' }]} onChange={changeMode} />
      <Button variant="primary" className="mote-calendar__create" ref={createTrigger} aria-haspopup="dialog" aria-label="New arrangement" title="New arrangement" onClick={event => prepare(event.currentTarget)}><Plus size={14} aria-hidden /><span>New<span className="mote-calendar__create-label"> arrangement</span></span></Button>
    </header>
    {!queries.length || source.error ? <div className="calendar-schedules__notice" role="status"><p>{!queries.length ? scope.issue || scope.topic.readError || 'The current arrangement scope is unconfirmed.' : source.error} Last confirmed arrangements are kept.</p>{queries.length ? <Button type="button" onClick={source.refresh}>Retry arrangements</Button> : null}</div> : null}
    {navigationIssue ? <p role="status" className="calendar-schedules__notice">{navigationIssue}</p> : null}
    {mode !== 'upcoming' && queries.length > 0 && !source.error && source.observed && !source.records.length ? <div className="mote-calendar__empty"><strong>No arrangements yet</strong><p>Choose a date and prepare a reminder for an original discussion.</p></div> : null}
    {mode === 'upcoming' ? <section aria-label="Upcoming arrangements">
      {ordered.length ? <ol className="calendar-schedules__list" aria-label="Upcoming arrangements">{ordered.map(record => row(record))}</ol>
        : queries.length > 0 && !source.error && source.observed ? <div className="mote-calendar__empty"><strong>{ended ? 'No upcoming arrangements' : 'Time for a first arrangement'}</strong><p>{ended ? 'Ended arrangements are available below.' : 'Save a reminder or countdown for a Mote discussion. It will appear here.'}</p></div>
          : <p className="continuous-progress-control__help">{source.error || !queries.length ? 'Arrangements have not been confirmed.' : 'Reading arrangements…'}</p>}
      {ended ? <label className="mote-calendar__ended"><input type="checkbox" checked={showEnded} onChange={event => setShowEnded(event.target.checked)} />Show ended ({ended})</label> : null}
    </section> : <div className="mote-calendar__workspace" data-detail={detailsOpen}>
      <div className="mote-calendar__canvas" ref={grid} data-days={timed ? cellCount : 7} style={{ '--mote-calendar-days': timed ? cellCount : 7 } as CSSProperties}>
        {!timed ? <div className="mote-calendar__weekdays" aria-hidden="true">{visibleDates.slice(0, 7).map(date => <span key={date.weekday}>{date.toFormat('ccc')}</span>)}</div> : null}
        <div className="mote-calendar__grid" role="group" aria-label={title + ' dates'} data-view={mode}>
          {visibleDates.map(date => {
            const key = date.toISODate()!, groups = days.get(key) ?? []
            const planned = groups.reduce((sum, group) => sum + group.planned, 0)
            const lines = timed ? [] : calendarCellLines(groups, receiptLines.get(date.toMillis()) ?? [], record => scheduleStateLabel(record, minute))
            return <div className="mote-calendar__cell" key={key} data-outside-month={mode === 'month' && date.month !== start.month} data-selected={selected === key} data-today={key === today}
              onClick={event => { if (!(event.target as HTMLElement).closest('button')) prepare(event.currentTarget.querySelector('button') ?? event.currentTarget, date) }}>
              <button type="button" className="mote-calendar__date" data-mote-date={key}
                aria-label={date.toFormat('cccc, LLLL d, yyyy') + ', ' + groups.length + ' arrangements, ' + planned + ' planned'} aria-pressed={selected === key} tabIndex={selected === key ? 0 : -1}
                onClick={event => { chooseDate(date); openPeriod(event.currentTarget) }} onKeyDown={event => dateKey(event, date)}><span>{date.day}</span>{timed ? <strong>{date.toFormat('ccc')}</strong> : null}{planned ? <small>{formatCount.format(planned)}<span> planned</span></small> : null}</button>
              {!timed ? <div className="mote-calendar__previews">{lines.slice(0, 3).map(line =>
                <button key={line.record.loopId + line.text} type="button" className="mote-calendar__point" data-calendar-schedule-id={line.record.loopId} data-managed={!!line.record.managedSource} data-attention={line.attention}
                  aria-label={describeLine(line)} title={describeLine(line)}
                  onClick={event => { chooseDate(date); openPeriod(event.currentTarget) }}>
                  <span>{lineTitle(line)}</span><small>{lineText(line)}</small>
                  <b aria-hidden="true">{line.attention ? '!' : line.recorded ? '✓' : ''}{(line.recorded ?? line.planned ?? 0) > 1 ? '×' + formatCount.format((line.recorded ?? line.planned)!) : ''}</b>
                </button>)}
                {lines.length > 3 ? <button type="button" className="mote-calendar__more" onClick={event => { chooseDate(date); openPeriod(event.currentTarget) }}>+{lines.length - 3} more</button> : null}</div> : null}
            </div>
          })}
        </div>
        {timed ? <div ref={weekScroll} className="mote-calendar__week-scroll" aria-label="Arrangement hours" onScroll={event => {
          if (visible.current) weekViewport.current = { period: windowFrom, top: event.currentTarget.scrollTop }
        }}><div className="mote-calendar__week-timeline">
          {hoursOfDay.map(hour => <div className="mote-calendar__hour" key={hour}><time>{hourLabel(hour)}</time><div className="mote-calendar__hour-days">
            {visibleDates.map(date => {
              const key = date.toISODate()!, slotKey = key + ':' + hour, slot = hourly.get(slotKey)
              const groups = slot?.groups ?? [], planned = groups.reduce((sum, group) => sum + group.planned, 0)
              const lines = calendarCellLines(groups, slot ? receiptLines.get(slot.window.from) ?? [] : [], record => scheduleStateLabel(record, minute))
              const recorded = lines.reduce((sum, line) => sum + (line.recorded ?? 0), 0)
              const emptyFuture = !!slot && !lines.length && slot.window.from > now
              return <div className="mote-calendar__hour-day" key={key}>
                <button type="button" className="mote-calendar__bucket" data-calendar-hour={slotKey} data-calendar-planned={planned} disabled={!slot}
                  aria-label={date.toFormat('cccc, LLLL d') + ' at ' + hourLabel(hour) + ', ' + formatCount.format(planned) + ' planned' + (recorded ? ', ' + recorded + ' recorded' : '') + (emptyFuture ? ', prepare arrangement' : '')}
                  aria-pressed={key === selected && hour === selectedHour} tabIndex={key === selected && hour === selectedHour ? 0 : -1}
                  onClick={event => {
                    selectHour(date, hour)
                    if (emptyFuture) prepare(event.currentTarget, date, hourLabel(hour))
                    else openPeriod(event.currentTarget)
                  }} onKeyDown={event => hourKey(event, date, hour)}>
                  {lines.slice(0, 3).map(line => <span key={line.record.loopId + line.text} className="mote-calendar__rate" data-managed={!!line.record.managedSource} data-attention={line.attention}
                    title={describeLine(line)}>
                    <span>{lineTitle(line)}</span><small>{lineText(line)}</small>
                  </span>)}
                  {lines.length > 3 ? <small className="mote-calendar__more">+{lines.length - 3} more</small> : null}
                  {!slot ? <small>Skipped hour</small> : null}
                </button>
                {slot ? <button type="button" className="mote-calendar__slot" tabIndex={-1} aria-label={'Prepare arrangement ' + date.toFormat('cccc, LLLL d') + ' at ' + hourLabel(hour)} aria-haspopup="dialog" onClick={event => { setSelectedHour(hour); prepare(event.currentTarget, date, hourLabel(hour)) }}><Plus size={12} aria-hidden /></button> : null}
              </div>
            })}
          </div></div>)}
        </div></div> : null}
        <footer className="mote-calendar__legend"><span>{timezone}</span><span>{timed ? 'Events by hour' : 'Events by day'}</span>{history.partial ? <span role="status">Recorded events partially available <button type="button" onClick={history.retry}>Retry calendar</button></span> : history.busy ? <span role="status">Reading recorded events…</span> : null}</footer>
      </div>
      {detailsOpen ? <section className="mote-calendar__day" aria-label="Selected day arrangements" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); closePeriod() } }}>
        <section className="mote-calendar__window-info" aria-label={timed ? 'Selected hour' : 'Selected date'}>
          <header><h4>{selectedDate.toFormat('ccc, LLL d')}{timed ? ' · ' + hourLabel(selectedHour) : ''}</h4><button type="button" aria-label="Close period details" onClick={closePeriod}>×</button></header>
          {source.observed && eventWindow ? <MoteCalendarEvents key={JSON.stringify([retained.current, eventWindow.from, eventWindow.to])}
            window={eventWindow} schedules={byId} items={selectedEvents} timezone={timezone} now={now}
            active={active && queries.length > 0} onOpenRule={revealArrangement} onOpenDiscussion={openDiscussion} />
            : <p className="continuous-progress-control__help">{source.observed ? 'This hour does not exist in the calendar timezone.' : 'Arrangements are unconfirmed.'}</p>}
          {selectedCount ? <div className="mote-calendar__period-plan">
            <p className="mote-calendar__plan-total"><strong>{formatCount.format(selectedCount)}</strong> planned</p>
            {timed && selectedSlot ? <MoteCalendarTimes key={selected + ':' + selectedHour} items={selectedPlans} schedules={byId} timezone={timezone} now={now}
              repeatedHour={selectedSlot.window.to - selectedSlot.window.from > 3_600_000} onOpen={revealArrangement} />
              : <Button type="button" onClick={() => changeMode('day')}>Open day</Button>}
          </div> : null}
        </section>
      </section> : null}
    </div>}
    </div>
    <ScheduleCreateForm draftKey={'mote-schedule-create:' + JSON.stringify([scope.workspace.hostId, scope.workspace.id, scope.workspace.path, scope.topic.id])}
      target={target} onReceipt={source.accept} records={source.records} initialDate={selected} defaultKind="once" calendarEditor={{ active, selection: createRequest, trigger: createTrigger, discussion: related.discussion }} onShowSaved={showSaved} />
  </div>
}
