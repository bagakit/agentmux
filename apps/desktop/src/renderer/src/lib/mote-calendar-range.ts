import type { ContinuousProgressLoop } from '@agentmux/core/continuous-progress-scheduler'
import { scheduleForecastCount, type ScheduleOccurrence, type ScheduleOccurrenceWindow } from '@agentmux/core/schedule-calendar'
import { DateTime } from 'luxon'

export type CalendarSchedule = { record: ContinuousProgressLoop; discussion?: string | undefined }

export function calendarDayWindow(date: DateTime): ScheduleOccurrenceWindow {
  return { from: date.startOf('day').toMillis(), to: date.plus({ days: 1 }).startOf('day').toMillis() }
}

/** Civil hour boundaries use the browser's zone. A folded hour shares one bucket;
 * a skipped hour has no bucket. The interval counts still use absolute time. */
export function calendarHourWindows(date: DateTime): ReadonlyMap<number, ScheduleOccurrenceWindow> {
  const starts: { hour: number; at: number }[] = []
  for (let hour = 0; hour < 24; hour++) {
    const time = DateTime.fromObject({ year: date.year, month: date.month, day: date.day, hour }, { zone: date.zone })
    if (!time.isValid || time.hour !== hour) continue
    starts.push({ hour, at: Math.min(...time.getPossibleOffsets().map(candidate => candidate.toMillis())) })
  }
  const { to } = calendarDayWindow(date)
  return new Map(starts.map(({ hour, at }, index) => [hour, { from: at, to: starts[index + 1]?.at ?? to }]))
}

export function calendarScheduleGroups(items: readonly ScheduleOccurrence[], records: ReadonlyMap<string, CalendarSchedule>, now: number) {
  const groups = new Map<string, { record: ContinuousProgressLoop; firstAt: number; planned: number; accepted?: ScheduleOccurrence; due?: ScheduleOccurrence }>()
  for (const item of items) {
    const saved = records.get(item.scheduleId)
    if (!saved) continue
    const group = groups.get(item.scheduleId) ?? { record: saved.record, firstAt: item.at, planned: 0 }
    group.planned += scheduleForecastCount(item, saved.record, now)
    if (item.kind === 'last-accepted') group.accepted = item
    if (item.kind === 'next-due') group.due = item
    groups.set(item.scheduleId, group)
  }
  return [...groups.values()]
}
