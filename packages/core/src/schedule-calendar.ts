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
  /** Future interval occurrences in this half-open range are not individually projected. */
  omittedRepeat?: Readonly<{ from: number; to: number }>
}>

/** Read-only visible-window projection. Actual deadlines and accepted occurrences keep
 * their original timestamps; future rule estimates never change schedule eligibility. */
export function projectScheduleOccurrences(records: readonly Readonly<ContinuousProgressLoop>[], window: ScheduleOccurrenceWindow, now: number): readonly ScheduleOccurrence[] {
  if (![window.from, window.to, now].every(value => Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime())) || window.to < window.from) {
    throw new RangeError('Schedule projection requires a finite half-open UTC window and an explicit clock.')
  }
  const projected = new Map<string, ScheduleOccurrence>()
  const add = (record: Readonly<ContinuousProgressLoop>, at: number, kind: ScheduleOccurrence['kind'], omittedRepeat?: ScheduleOccurrence['omittedRepeat']) => {
    if (at < window.from || at >= window.to) return
    const key = JSON.stringify([record.loopId, at]), previous = projected.get(key)
    if (previous?.kind === 'last-accepted' || previous && kind === 'projected') {
      if (omittedRepeat && previous) projected.set(key, { ...previous, omittedRepeat })
      return
    }
    projected.set(key, { scheduleId: record.loopId, ...(record.revision === undefined ? {} : { revision: record.revision }), at, kind, ...(omittedRepeat ? { omittedRepeat } : {}) })
  }
  for (const record of records) {
    if (!isAgentSchedule(record)) continue
    add(record, record.nextCheckAt, 'next-due')
    // This is the plan's timestamp of the last Host-accepted input, not its actual
    // delivery wall clock, a completed Agent task or a replay of all past occurrences.
    if (record.lastOccurrenceAt !== undefined) add(record, record.lastOccurrenceAt, 'last-accepted')
    if (record.everyMs !== undefined && record.status === 'active' && record.lastOutcome !== 'unknown' && !record.pendingCompletion) {
      const start = Math.max(now, record.nextCheckAt, window.from)
      const first = record.nextCheckAt + Math.ceil((start - record.nextCheckAt) / record.everyMs) * record.everyMs
      if (Number.isSafeInteger(first) && first < window.to) {
        const omittedFrom = first + record.everyMs
        add(record, first, 'projected', Number.isSafeInteger(omittedFrom) && omittedFrom < window.to ? { from: omittedFrom, to: window.to } : undefined)
      }
      continue
    }
    if (record.status !== 'active' || record.lastOutcome === 'unknown' || record.pendingCompletion || !record.calendar || record.calendar.kind === 'once') continue
    let cursor = Math.max(now, record.nextCheckAt, window.from - 1)
    while (cursor < window.to) {
      const next = nextCalendarOccurrence(record.calendar, cursor)
      if (next === null || next >= window.to) break
      add(record, next, 'projected')
      cursor = next
    }
  }
  return [...projected.values()].sort((a, b) => a.at - b.at || a.scheduleId.localeCompare(b.scheduleId))
}
