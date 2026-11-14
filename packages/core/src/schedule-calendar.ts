import { DateTime } from 'luxon'
import { isAgentSchedule, type ContinuousProgressLoop } from './continuous-progress-scheduler.js'
import { parseAgentScheduleCalendar, type AgentScheduleCalendar } from './agent-schedule.js'

/** The sole civil-time calculator. Luxon handles IANA offsets; round-trip guards its gap normalization. */
function occurrence(rule: AgentScheduleCalendar, date: DateTime): number | null {
  const [hour, minute] = rule.time.split(':').map(Number)
  const civil = DateTime.fromObject({ year: date.year, month: date.month, day: date.day, hour, minute }, { zone: rule.timezone })
  if (!civil.isValid || civil.year !== date.year || civil.month !== date.month || civil.day !== date.day || civil.hour !== hour || civil.minute !== minute) return null
  const offsets = civil.getPossibleOffsets().sort((a, b) => a.toMillis() - b.toMillis())
  return (rule.policies.fold === 'earlier' ? offsets[0]! : offsets.at(-1)!).toMillis()
}
function relevantDate(rule: AgentScheduleCalendar, base: DateTime): DateTime | null {
  if (rule.kind === 'weekly' && base.weekday !== rule.weekday) return null
  if (rule.kind === 'monthly' && base.day !== Math.min(rule.day!, base.daysInMonth!)) return null
  if (rule.kind === 'yearly' && (base.month !== rule.month || base.day !== Math.min(rule.day!, base.daysInMonth!))) return null
  return base
}
/** At most one latest overdue occurrence is handled; successful sends advance from current civil time. */
export function nextCalendarOccurrence(input: AgentScheduleCalendar, after: number): number | null {
  const rule = parseAgentScheduleCalendar(input)
  if (rule.kind === 'once') {
    const date = DateTime.fromISO(rule.date!, { zone: rule.timezone })
    const due = occurrence(rule, date)
    return due !== null && due > after ? due : null
  }
  const start = DateTime.fromMillis(after, { zone: rule.timezone }).startOf('day')
  for (let days = 0; days <= 740; days++) {
    const date = relevantDate(rule, start.plus({ days }))
    if (!date) continue
    const due = occurrence(rule, date)
    if (due !== null && due > after) return due
  }
  throw new Error('No valid calendar occurrence within the bounded two-year horizon.')
}
export function latestCalendarOccurrence(input: AgentScheduleCalendar, due: number, now: number): number {
  const rule = parseAgentScheduleCalendar(input)
  if (rule.kind === 'once' || due > now) return due
  const start = DateTime.fromMillis(now, { zone: rule.timezone }).startOf('day')
  for (let days = 0; days <= 740; days++) {
    const date = relevantDate(rule, start.minus({ days }))
    if (!date) continue
    const value = occurrence(rule, date)
    if (value !== null && value <= now) return Math.max(due, value)
  }
  return due
}

/** The original due timestamp anchors the cadence; missed occurrences collapse to the latest. */
export function latestIntervalOccurrence(due: number, now: number, everyMs: number): number {
  if (due > now) return due
  return due + Math.floor((now - due) / everyMs) * everyMs
}

/** Null keeps the schedule recoverable when its next absolute time is not representable. */
export function nextIntervalOccurrence(due: number, now: number, everyMs: number): number | null {
  const next = latestIntervalOccurrence(due, now, everyMs) + everyMs
  return Number.isSafeInteger(next) && Number.isFinite(new Date(next).getTime()) ? next : null
}

export type ScheduleOccurrenceWindow = Readonly<{ from: number; to: number }>
/** A display reference to the original record, never an input claim or mutation receipt. */
export type ScheduleOccurrence = Readonly<{
  scheduleId: string
  revision?: number
  at: number
  kind: 'next-due' | 'projected' | 'last-accepted'
  /** For a projected interval, at is the first time and count includes it. */
  repeat?: Readonly<{ everyMs: number; count: number }>
}>

function assertOccurrenceWindow(window: ScheduleOccurrenceWindow, now = window.from) {
  if (![window.from, window.to, now].every(value => Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime())) || window.to < window.from) {
    throw new RangeError('Schedule projection requires a finite half-open UTC window and an explicit clock.')
  }
}

/** Intersect compact recurrences with a visible subrange without allocating each occurrence. */
export function sliceScheduleOccurrences(items: readonly ScheduleOccurrence[], window: ScheduleOccurrenceWindow): ScheduleOccurrence[] {
  assertOccurrenceWindow(window)
  const result: ScheduleOccurrence[] = []
  for (const item of items) {
    if (!item.repeat) {
      if (item.at >= window.from && item.at < window.to) result.push(item)
      continue
    }
    const { everyMs, count } = item.repeat
    const start = Math.max(0, Math.ceil((window.from - item.at) / everyMs))
    const end = Math.min(count, Math.ceil((window.to - item.at) / everyMs))
    if (start < end) result.push({ ...item, at: item.at + start * everyMs, repeat: { everyMs, count: end - start } })
  }
  return result.sort(compareOccurrences)
}

const compareOccurrences = (a: ScheduleOccurrence, b: ScheduleOccurrence) => a.at - b.at || a.scheduleId.localeCompare(b.scheduleId)
const canForecast = (record: Readonly<ContinuousProgressLoop>) => record.status === 'active' && record.lastOutcome !== 'unknown' && !record.pendingCompletion

/** Dates already due or accepted are displayed separately from future estimates. */
export function scheduleForecastCount(item: ScheduleOccurrence, record: Readonly<ContinuousProgressLoop>, now: number): number {
  return item.kind === 'projected' ? item.repeat?.count ?? 1
    : item.kind === 'next-due' && item.at >= now && canForecast(record) ? 1 : 0
}

/** Read-only visible-window projection. Actual deadlines and accepted occurrences keep
 * their original timestamps; future rule estimates never change schedule eligibility. */
export function projectScheduleOccurrences(records: readonly Readonly<ContinuousProgressLoop>[], window: ScheduleOccurrenceWindow, now: number): readonly ScheduleOccurrence[] {
  assertOccurrenceWindow(window, now)
  const projected = new Map<string, ScheduleOccurrence>()
  const add = (record: Readonly<ContinuousProgressLoop>, at: number, kind: ScheduleOccurrence['kind'], repeat?: ScheduleOccurrence['repeat']) => {
    if (at < window.from || at >= window.to) return
    const key = JSON.stringify([record.loopId, at]), previous = projected.get(key)
    if (previous?.kind === 'last-accepted' || previous && kind === 'projected') return
    projected.set(key, { scheduleId: record.loopId, ...(record.revision === undefined ? {} : { revision: record.revision }), at, kind, ...(repeat ? { repeat } : {}) })
  }
  for (const record of records) {
    if (!isAgentSchedule(record)) continue
    add(record, record.nextCheckAt, 'next-due')
    // This is the plan's timestamp of the last Host-accepted input, not its actual
    // delivery wall clock, a completed Agent task or a replay of all past occurrences.
    if (record.lastOccurrenceAt !== undefined) add(record, record.lastOccurrenceAt, 'last-accepted')
    if (!canForecast(record)) continue
    if (record.everyMs !== undefined) {
      const start = Math.max(now, record.nextCheckAt + 1, (record.lastOccurrenceAt ?? -Infinity) + 1, window.from)
      const first = record.nextCheckAt + Math.ceil((start - record.nextCheckAt) / record.everyMs) * record.everyMs
      if (Number.isSafeInteger(first) && first < window.to) {
        add(record, first, 'projected', { everyMs: record.everyMs, count: Math.ceil((window.to - first) / record.everyMs) })
      }
      continue
    }
    if (!record.calendar || record.calendar.kind === 'once') continue
    let cursor = Math.max(now, record.nextCheckAt, window.from - 1)
    while (cursor < window.to) {
      const next = nextCalendarOccurrence(record.calendar, cursor)
      if (next === null || next >= window.to) break
      add(record, next, 'projected')
      cursor = next
    }
  }
  return [...projected.values()].sort(compareOccurrences)
}
