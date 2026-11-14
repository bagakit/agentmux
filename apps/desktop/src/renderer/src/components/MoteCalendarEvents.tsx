import { useEffect, useMemo, useRef, useState } from 'react'
import { DateTime } from 'luxon'
import { Button } from '@agentmux/client-ui/components/Button'
import { validateScheduleRpcResult, type ScheduleResultMap } from '@agentmux/core/schedule-rpc'
import type { ContinuousProgressLoop } from '@agentmux/core/continuous-progress-scheduler'
import type { ScheduleOccurrence, ScheduleOccurrenceWindow } from '@agentmux/core/schedule-calendar'
import { api } from '../lib/api'
import type { CalendarSchedule } from '../lib/mote-calendar-range'
import { scheduleCalendarLabel, scheduleStateLabel } from './ScheduleArrangementRow'

type Page = ScheduleResultMap['schedule.history']
type Receipt = Page['entries'][number]
type Reading = { entries: Receipt[]; next: string | null; retry?: { cursor: string | undefined } }
type CalendarEvent = { at: number; saved: CalendarSchedule } & ({ receipt: Receipt } | { planned: ScheduleOccurrence })

const deliveryLabel: Record<Receipt['delivery'], string> = {
  'terminal-confirmed': 'Sent to terminal',
  'native-admitted': 'Input accepted',
  'not-applied': 'Not sent',
  unconfirmed: 'Delivery unconfirmed',
}
const nativeLabel = { completed: 'Agent turn completed', failed: 'Agent turn failed', interrupted: 'Agent turn interrupted' } as const
const receiptKey = (receipt: Receipt) => JSON.stringify([receipt.runId, receipt.operationId])
const slotKey = (id: string, at: number) => JSON.stringify([id, at])
const formatCount = new Intl.NumberFormat()

export function MoteCalendarEvents({ window, schedules, items, timezone, now, active, onOpenRule, onOpenDiscussion }: {
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
  const watch = JSON.stringify(from > now ? [] : [...schedules.values()].map(({ record }) => {
    const input = record.lastInputRef
    const occurrence = input?.futureIntent.occurrenceAt ?? record.lastOccurrenceAt ?? -1
    return [record.loopId, occurrence >= from && occurrence < to ? [occurrence, input?.inputKey, record.lastOutcome] : null]
  }).sort(([a], [b]) => String(a).localeCompare(String(b))))
  const [pages, setPages] = useState<ReadonlyMap<string, Reading>>(new Map())
  const current = useRef(pages)
  const [request, setRequest] = useState<{ action: 'more' | 'retry' }>()
  const [busy, setBusy] = useState(false)
  const [opened, setOpened] = useState<string>()
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

  const events = useMemo(() => {
    const timeline: CalendarEvent[] = []
    const recorded = new Set<string>()
    for (const [id, page] of pages) {
      const saved = schedules.get(id)
      if (!saved) continue
      for (const receipt of page.entries) {
        recorded.add(slotKey(id, receipt.occurrenceAt))
        timeline.push({ at: receipt.occurrenceAt, saved, receipt })
      }
    }
    for (const planned of items) {
      const saved = schedules.get(planned.scheduleId)
      if (saved && !recorded.has(slotKey(planned.scheduleId, planned.at))) timeline.push({ at: planned.at, saved, planned })
    }
    return timeline.sort((a, b) => a.at - b.at || a.saved.record.loopId.localeCompare(b.saved.record.loopId))
  }, [items, pages, schedules])
  const failed = [...pages.values()].some(page => page.retry)
  const more = [...pages.values()].some(page => page.next && !page.retry)
  return <div className="mote-calendar__events" aria-busy={busy}>
    {events.length ? <ol aria-label="Calendar events">{events.map(event => {
      const { saved, at } = event, { record } = saved
      const time = DateTime.fromMillis(at, { zone: timezone })
      const receipt = 'receipt' in event ? event.receipt : undefined
      const planned = 'planned' in event ? event.planned : undefined
      const key = JSON.stringify([record.loopId, at, receipt ? receiptKey(receipt) : 'plan'])
      const result = receipt?.nativeResult.state
      const nativeStatus = result && result !== 'unknown' && result !== 'unsupported' ? nativeLabel[result] : undefined
      const status = receipt ? nativeStatus ?? deliveryLabel[receipt.delivery]
        : planned?.kind === 'last-accepted' ? 'Input accepted'
        : planned?.repeat && planned.repeat.count > 1 ? formatCount.format(planned.repeat.count) + ' planned'
        : planned?.kind === 'next-due' ? scheduleStateLabel(record, now) === 'Active' ? 'Planned' : scheduleStateLabel(record, now)
        : 'Planned'
      const label = receipt?.recap ? scheduleCalendarLabel({ ...record, prompt: receipt.recap.text })
        : receipt && !record.managedSource ? 'Scheduled input' : scheduleCalendarLabel(record)
      return <li key={key} data-event-result={result} data-event-kind={receipt ? 'recorded' : planned?.kind}>
        <button type="button" className="mote-calendar__event" data-event-schedule={record.loopId} aria-expanded={receipt ? opened === key : undefined}
          onClick={() => receipt ? setOpened(opened === key ? undefined : key) : onOpenRule(record.loopId)}>
          <time dateTime={time.toISO()!} title={time.toFormat('HH:mm:ss ZZ')}>{time.toFormat('HH:mm')}</time>
          <span title={label}>{label}</span><small>{status}</small>
        </button>
        {receipt && opened === key ? <div className="mote-calendar__recap">
          <div><strong>Recap</strong><small>{deliveryLabel[receipt.delivery]}{nativeStatus ? ' · ' + nativeStatus : ''}</small></div>
          <p>{receipt.recap ? receipt.recap.text + (receipt.recap.truncated ? '…' : '') : 'Original input text is unavailable.'}</p>
          <Button type="button" onClick={() => onOpenDiscussion(record)}>Open original discussion</Button>
        </div> : null}
      </li>
    })}</ol> : !busy && !failed ? <p className="continuous-progress-control__help">No events in this period.</p> : null}
    {busy ? <p className="continuous-progress-control__help" role="status">Checking events…</p> : null}
    {failed ? <div className="mote-calendar__event-actions">
      <small role="status">Some events could not be checked.</small>
      <Button disabled={!active || busy} onClick={() => setRequest({ action: 'retry' })}>Retry</Button>
    </div> : null}
    {more ? <Button disabled={!active || busy} onClick={() => setRequest({ action: 'more' })}>Earlier events</Button> : null}
  </div>
}
