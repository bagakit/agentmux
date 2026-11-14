import { isMoteHeartbeatSchedule } from '@agentmux/core/mote-preferences'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { DateTime } from 'luxon'
import type { ScheduleOccurrence } from '@agentmux/core/schedule-calendar'
import { Button } from '@agentmux/client-ui/components/Button'
import { scheduleCalendarLabel, scheduleStateLabel, scheduleDisplayTitle } from './ScheduleArrangementRow'
import type { CalendarSchedule } from '../lib/mote-calendar-range'

const pageSize = 12

export function MoteCalendarTimes({ heartbeatSourceId, items, schedules, timezone, now, repeatedHour, onOpen }: {
  heartbeatSourceId: string
  items: readonly ScheduleOccurrence[]; schedules: ReadonlyMap<string, CalendarSchedule>
  timezone: string; now: number; repeatedHour: boolean; onOpen(scheduleId: string, recorded: boolean): void
}) {
  const [expanded, setExpanded] = useState(false)
  const [requestedPage, setPage] = useState(0)
  const pageElement = useRef<HTMLDivElement>(null)
  // A single selected civil hour bounds materialization even at one-minute cadence.
  const times = useMemo(() => expanded ? items.flatMap(item => item.repeat
    ? Array.from({ length: item.repeat.count }, (_, index) => ({ scheduleId: item.scheduleId, kind: item.kind, at: item.at + index * item.repeat!.everyMs }))
    : [item]).sort((a, b) => a.at - b.at || a.scheduleId.localeCompare(b.scheduleId)) : [], [expanded, items])
  const page = Math.min(requestedPage, Math.max(0, Math.ceil(times.length / pageSize) - 1))
  useLayoutEffect(() => {
    const body = pageElement.current, pane = body?.closest<HTMLElement>('.mote-calendar__day')
    const summary = body?.previousElementSibling
    if (!expanded || !body || !pane || !summary || getComputedStyle(pane).overflowY !== 'auto') return
    const bounds = pane.getBoundingClientRect()
    const bottom = body.getBoundingClientRect().bottom - bounds.bottom
    const top = summary.getBoundingClientRect().top - bounds.top
    if (bottom > 0 && top > 0) pane.scrollTop += Math.min(bottom, top)
  }, [expanded])
  if (!items.length) return null
  return <details className="mote-calendar__time-details" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>View times</summary>
    {expanded ? <div ref={pageElement} className="mote-calendar__time-page">
      {times.length > pageSize ? <nav aria-label="Occurrence pages" className="mote-calendar__time-pager">
        <Button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
        <span>{page * pageSize + 1}–{Math.min(times.length, (page + 1) * pageSize)} / {times.length}</span>
        <Button type="button" disabled={(page + 1) * pageSize >= times.length} onClick={() => setPage(page + 1)}>Next</Button>
      </nav> : null}
      <ol aria-label="Occurrence times">{times.slice(page * pageSize, (page + 1) * pageSize).map(item => {
        const saved = schedules.get(item.scheduleId)
        if (!saved) return null
        const local = DateTime.fromMillis(item.at, { zone: timezone })
        const status = scheduleStateLabel(saved.record, now)
        const state = item.kind === 'last-accepted' ? 'Input accepted' : item.kind === 'projected' ? 'Planned' : status === 'Active' ? 'Next planned' : status
        return <li key={JSON.stringify([item.scheduleId, item.at])} data-occurrence-kind={item.kind}>
          <time dateTime={new Date(item.at).toISOString()}>{local.toFormat(repeatedHour ? 'HH:mm ZZ' : 'HH:mm')}</time>
          <button type="button" title={scheduleDisplayTitle(saved.record)} onClick={() => onOpen(item.scheduleId, item.kind === 'last-accepted')}>{scheduleCalendarLabel(saved.record, isMoteHeartbeatSchedule(saved.record, heartbeatSourceId))}</button>
          <small>{state}</small>
        </li>
      })}</ol>
    </div> : null}
  </details>
}
