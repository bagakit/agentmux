import { isMoteHeartbeatSchedule } from '@agentmux/core/mote-preferences'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { DateTime } from 'luxon'
import { Button } from '@agentmux/client-ui/components/Button'
import { Notice } from '@agentmux/client-ui/components/Notice'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { validateScheduleRpcResult, type ScheduleResultMap } from '@agentmux/core/schedule-rpc'
import type { ContinuousProgressLoop } from '@agentmux/core/continuous-progress-scheduler'
import type { ScheduleOccurrence, ScheduleOccurrenceWindow } from '@agentmux/core/schedule-calendar'
import { deliveryLabel, needsAttention, turnLabel } from '../lib/mote-calendar-range'
import { api } from '../lib/api'
import type { CalendarSchedule } from '../lib/mote-calendar-range'
import { scheduleCalendarLabel, scheduleStateLabel } from './ScheduleArrangementRow'

type Page = ScheduleResultMap['schedule.history']
type Receipt = Page['entries'][number]
type Reading = { entries: Receipt[]; next: string | null; retry?: { cursor: string | undefined } }
type CalendarEvent = { at: number; saved: CalendarSchedule } & ({ receipt: Receipt } | { planned: ScheduleOccurrence })
type Disclosure = { key: string; inFocus: boolean; open: boolean }

const receiptKey = (receipt: Receipt) => JSON.stringify([receipt.runId, receipt.operationId])
const slotKey = (id: string, at: number) => JSON.stringify([id, at])
const formatCount = new Intl.NumberFormat()
const CalendarTime = semanticIconComponent('object.schedule')
const Heartbeat = semanticIconComponent('object.heartbeat')
const Warning = semanticIconComponent('status.warning')
const Completed = semanticIconComponent('status.completed')
const History = semanticIconComponent('object.history')
const Forward = semanticIconComponent('navigation.forward')
const Down = semanticIconComponent('navigation.down')

function eventDetails(event: CalendarEvent, heartbeatSourceId: string, now: number) {
  const { at, saved: { record } } = event
  const receipt = 'receipt' in event ? event.receipt : undefined
  const planned = 'planned' in event ? event.planned : undefined
  const state = planned?.kind === 'next-due' ? scheduleStateLabel(record, now) : undefined
  const result = receipt?.nativeResult.state
  const nativeStatus = result && turnLabel(result)
  const status = receipt ? nativeStatus ?? deliveryLabel(receipt.delivery)
    : planned?.kind === 'last-accepted' ? 'Input accepted'
    : planned?.repeat && planned.repeat.count > 1 ? formatCount.format(planned.repeat.count) + ' planned'
    : state && state !== 'Active' ? state : 'Planned'
  const heartbeat = isMoteHeartbeatSchedule(record, heartbeatSourceId)
  const label = !heartbeat && receipt && !receipt.recap ? 'Scheduled input'
    : scheduleCalendarLabel(receipt?.recap ? { ...record, prompt: receipt.recap.text } : record, heartbeat)
  return { at, record, receipt, planned, result, nativeStatus, status, heartbeat, label,
    key: JSON.stringify([record.loopId, at, receipt ? receiptKey(receipt) : 'plan']),
    attention: receipt ? needsAttention({ nativeState: receipt.nativeResult.state, delivery: receipt.delivery })
      : state === 'Delivery unconfirmed',
    upcoming: at >= now && (planned?.kind === 'projected' || state === 'Active') }
}

type EventDetails = ReturnType<typeof eventDetails>

function EventTime({ at, timezone }: { at: number; timezone: string }) {
  const time = DateTime.fromMillis(at, { zone: timezone })
  return <time dateTime={time.toISO()!} title={time.toFormat('HH:mm:ss ZZ')}>{time.toFormat('HH:mm')}</time>
}

function HeartbeatEventGroup({ first, last, count, timezone, children }: {
  first: EventDetails; last: EventDetails; count: number; timezone: string; children: ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  return <li className="mote-calendar__event-group">
    <button type="button" className="mote-calendar__event" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <span className="mote-calendar__event-range"><EventTime at={first.at} timezone={timezone} />–<EventTime at={last.at} timezone={timezone} /></span>
      <Heartbeat size={14} aria-hidden />
      <span className="mote-calendar__event-copy"><strong>{first.label}</strong><small>{first.status} · {formatCount.format(count)} events</small></span>
      <Down className="mote-calendar__event-arrow" size={12} aria-hidden />
    </button>
    <ol className="mote-calendar__reveal" aria-label={first.label} hidden={!expanded} inert={!expanded}>{children}</ol>
  </li>
}

export function MoteCalendarEvents({ heartbeatSourceId, window, schedules, items, timezone, now, active, onOpenRule, onOpenDiscussion }: {
  heartbeatSourceId: string
  window: ScheduleOccurrenceWindow
  schedules: ReadonlyMap<string, CalendarSchedule>
  items: readonly ScheduleOccurrence[]
  timezone: string
  now: number
  active: boolean
  onOpenRule(scheduleId: string): void
  onOpenDiscussion(record: ContinuousProgressLoop): void
}) {
  const { from, to } = window
  // Read only the selected period. A new operation in that period refreshes
  // the same reader; list polls and clock ticks alone never reread receipts.
  const watch = JSON.stringify(!active || from > now ? [] : [...schedules.values()].map(({ record }) => {
    const input = record.lastInputRef
    const occurrence = input?.futureIntent.occurrenceAt ?? record.lastOccurrenceAt ?? -1
    return [record.loopId, occurrence >= from && occurrence < to ? [occurrence, input?.inputKey, record.lastOutcome] : null]
  }).sort(([a], [b]) => String(a).localeCompare(String(b))))
  const [pages, setPages] = useState<ReadonlyMap<string, Reading>>(new Map())
  const current = useRef(pages)
  const [request, setRequest] = useState<{ action: 'more' | 'retry' }>()
  const [busy, setBusy] = useState(false)
  const [disclosure, setDisclosure] = useState<Disclosure>()
  const previous = useRef<string | undefined>(undefined)
  const consumed = useRef<typeof request>(undefined)

  useEffect(() => {
    if (!active) { setBusy(false); previous.current = undefined; return }
    const action = consumed.current !== request ? request?.action : undefined
    consumed.current = request
    const rows = JSON.parse(watch) as [string, unknown][]
    const before = new Map(previous.current ? JSON.parse(previous.current) as [string, unknown][] : [])
    const reads = rows.flatMap(([id, marker]) => {
      const page = current.current.get(id)
      if (action === 'more') return page?.next && !page.retry ? [{ id, cursor: page.next }] : []
      if (action === 'retry') return page?.retry ? [{ id, cursor: page.retry.cursor }] : []
      return !before.has(id) || JSON.stringify(before.get(id)) !== JSON.stringify(marker) ? [{ id, cursor: undefined }] : []
    })
    if (!reads.length) { previous.current = watch; setBusy(false); return }
    let valid = true
    setBusy(true)
    async function read() {
      for (let offset = 0; valid && offset < reads.length; offset += 4) {
        const results = await Promise.all(reads.slice(offset, offset + 4).map(async ({ id, cursor }) => {
          const params = { scheduleId: id, from, to, limit: 12, ...(cursor ? { cursor } : {}) }
          try { return { id, cursor, page: validateScheduleRpcResult('schedule.history', await api.schedule.history(params), params) } }
          catch { return { id, cursor, page: null } }
        }))
        if (!valid) return
        const merged = new Map(current.current)
        for (const { id, cursor, page } of results) {
          const prior = merged.get(id)
          const entries = new Map(prior?.entries.map(receipt => [receiptKey(receipt), receipt]))
          for (const receipt of page?.entries ?? []) {
            const key = receiptKey(receipt), known = entries.get(key)
            entries.set(key, known ? { ...receipt, occurrenceAt: known.occurrenceAt, recap: known.recap ?? receipt.recap } : receipt)
          }
          const failed = !page || page.coverage === 'unconfirmed'
          merged.set(id, { entries: [...entries.values()], next: page?.nextCursor ?? (failed ? prior?.next ?? null : null),
            ...(failed ? { retry: { cursor } } : {}) })
        }
        current.current = merged
        setPages(merged)
      }
      previous.current = watch
      setBusy(false)
    }
    void Promise.resolve().then(read)
    return () => { valid = false }
  }, [active, from, to, request, watch])

  const { events, failed, more } = useMemo(() => {
    const timeline: CalendarEvent[] = []
    const recorded = new Set<string>()
    let failed = false, more = false
    for (const [id, saved] of schedules) {
      const page = pages.get(id)
      if (!page) continue
      if (page.retry) failed = true
      else if (page.next) more = true
      for (const receipt of page.entries) {
        recorded.add(slotKey(id, receipt.occurrenceAt))
        timeline.push({ at: receipt.occurrenceAt, saved, receipt })
      }
    }
    for (const planned of items) {
      const saved = schedules.get(planned.scheduleId)
      if (saved && !recorded.has(slotKey(planned.scheduleId, planned.at))) timeline.push({ at: planned.at, saved, planned })
    }
    const events = timeline.sort((a, b) => a.at - b.at || a.saved.record.loopId.localeCompare(b.saved.record.loopId))
    return { events, failed, more }
  }, [items, pages, schedules])
  const { groups, focus, focusLabel } = useMemo(() => {
    const rows = events.map(event => eventDetails(event, heartbeatSourceId, now))
    const groups: EventDetails[][] = []
    let attention: EventDetails | undefined, upcoming: EventDetails | undefined, recent: EventDetails | undefined
    for (const row of rows) {
      if (row.attention) attention = row
      if (row.upcoming) upcoming ??= row
      if (row.receipt || row.planned?.kind === 'last-accepted') recent = row
      const group = groups.at(-1), previous = group?.[0]
      if (row.heartbeat && row.receipt && !row.attention && previous?.receipt && !previous.attention &&
        previous.record.loopId === row.record.loopId && previous.result === row.result && previous.receipt.delivery === row.receipt.delivery) {
        group!.push(row)
      } else groups.push([row])
    }
    return { groups, focus: attention ?? upcoming ?? recent, focusLabel: attention ? 'Needs attention' : upcoming ? 'Next up' : 'Latest event' }
  }, [events, heartbeatSourceId, now])

  function isExpanded(event: EventDetails, inFocus: boolean) {
    return disclosure?.key === event.key && disclosure.inFocus === inFocus && disclosure.open
  }
  function openEvent(event: EventDetails, inFocus: boolean) {
    if (event.receipt) setDisclosure({ key: event.key, inFocus, open: !isExpanded(event, inFocus) })
    else onOpenRule(event.record.loopId)
  }
  function recap(event: EventDetails, inFocus: boolean) {
    const { receipt, nativeStatus, record } = event
    if (!receipt || disclosure?.key !== event.key || disclosure.inFocus !== inFocus) return null
    return <div className="mote-calendar__recap mote-calendar__reveal" hidden={!disclosure.open} inert={!disclosure.open}>
      <div><strong>Recap</strong><small>{deliveryLabel(receipt.delivery)}{nativeStatus ? ' · ' + nativeStatus : ''}</small></div>
      <p>{receipt.recap ? receipt.recap.text + (receipt.recap.truncated ? '…' : '') : 'Original input text is unavailable.'}</p>
      <Button type="button" onClick={() => onOpenDiscussion(record)}>Open original discussion</Button>
    </div>
  }
  function eventRow(event: EventDetails) {
    const Icon = event.attention ? Warning : event.heartbeat ? Heartbeat : event.result === 'completed' ? Completed : event.upcoming ? CalendarTime : History
    return <li key={event.key} data-event-result={event.result} data-event-kind={event.receipt ? 'recorded' : event.planned?.kind}>
      <button type="button" className="mote-calendar__event" data-event-schedule={event.record.loopId} data-attention={event.attention || undefined}
        aria-expanded={event.receipt ? isExpanded(event, false) : undefined} onClick={() => openEvent(event, false)}>
        <EventTime at={event.at} timezone={timezone} />
        <Icon size={14} aria-hidden />
        <span className="mote-calendar__event-copy"><strong>{event.label}</strong><small>{event.status}</small></span>
        {event.receipt ? <Down className="mote-calendar__event-arrow" size={12} aria-hidden /> : <Forward className="mote-calendar__event-arrow" size={12} aria-hidden />}
      </button>
      {recap(event, false)}
    </li>
  }
  const FocusIcon = focus?.attention ? Warning : focus?.upcoming ? CalendarTime : History

  return <div className="mote-calendar__events" aria-busy={busy}>
    {focus ? <div className="mote-calendar__focus">
      <button type="button" className="mote-calendar__highlight" data-focus-event={focus.key} data-attention={focus.attention || undefined}
        aria-expanded={focus.receipt ? isExpanded(focus, true) : undefined} onClick={() => openEvent(focus, true)}>
        <span className="mote-calendar__highlight-heading"><FocusIcon size={15} aria-hidden /><span>{focusLabel}</span><EventTime at={focus.at} timezone={timezone} /></span>
        <strong>{focus.label}</strong>
        <small>{focus.status}</small>
        {focus.receipt ? <Down className="mote-calendar__event-arrow" size={14} aria-hidden /> : <Forward className="mote-calendar__event-arrow" size={14} aria-hidden />}
      </button>
      {recap(focus, true)}
    </div> : null}
    {failed ? <Notice tone="unknown" density="compact" messageRole="status"
      actions={<Button disabled={!active || busy} onClick={() => setRequest({ action: 'retry' })}>Retry</Button>}>
      Some events could not be checked.
    </Notice> : null}
    {groups.length || more ? <section className="mote-calendar__timeline">
      <h5>Events</h5>
      {more ? <Button className="mote-calendar__earlier" disabled={!active || busy} onClick={() => setRequest({ action: 'more' })}>Earlier events</Button> : null}
      <ol aria-label="Calendar events">{groups.map(group => {
        const first = group[0]!
        if (group.length === 1) return eventRow(first)
        return <HeartbeatEventGroup key={first.key} first={first} last={group.at(-1)!} count={group.length} timezone={timezone}>
          {group.map(eventRow)}
        </HeartbeatEventGroup>
      })}</ol>
    </section> : !busy && !failed ? <p className="mote-calendar__period-empty">No events in this period.</p> : null}
    {busy ? <p className="mote-calendar__period-empty" role="status">Checking events…</p> : null}
  </div>
}
