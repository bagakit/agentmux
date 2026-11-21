import type { ScheduleHistoryEntry, ScheduleHistoryGroup } from '@agentmux/core/schedule-rpc'
import type { ContinuousProgressLoop } from '@agentmux/core/continuous-progress-scheduler'
import { scheduleForecastCount, type ScheduleOccurrence, type ScheduleOccurrenceWindow } from '@agentmux/core/schedule-calendar'
import { DateTime } from 'luxon'

const deliveryLabels: Record<ScheduleHistoryEntry['delivery'], string> = {
  'terminal-confirmed': 'Sent to terminal', 'native-admitted': 'Input accepted', 'not-applied': 'Not sent', unconfirmed: 'Delivery unconfirmed',
}
const nativeLabels = { completed: 'Agent turn completed', failed: 'Agent turn failed', interrupted: 'Agent turn interrupted' } as const
export const deliveryLabel = (delivery: ScheduleHistoryEntry['delivery']) => deliveryLabels[delivery]
export const turnLabel = (state: ScheduleHistoryGroup['nativeState']) => state === 'unknown' || state === 'unsupported' ? undefined : nativeLabels[state]
export const needsAttention = (group: Pick<ScheduleHistoryGroup, 'nativeState' | 'delivery'>) =>
  group.nativeState === 'failed' || group.nativeState === 'interrupted' || group.delivery === 'not-applied' || group.delivery === 'unconfirmed'

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
  const groups = new Map<string, { record: ContinuousProgressLoop; firstPlannedAt?: number; planned: number; accepted?: ScheduleOccurrence; due?: ScheduleOccurrence }>()
  for (const item of items) {
    const saved = records.get(item.scheduleId)
    if (!saved) continue
    const group = groups.get(item.scheduleId) ?? { record: saved.record, planned: 0 }
    const forecast = scheduleForecastCount(item, saved.record, now)
    if (forecast && group.firstPlannedAt === undefined) group.firstPlannedAt = item.at
    group.planned += forecast
    if (item.kind === 'last-accepted') group.accepted = item
    if (item.kind === 'next-due') group.due = item
    groups.set(item.scheduleId, group)
  }
  return [...groups.values()]
}

export type CalendarCellLine = { record: ContinuousProgressLoop; at: number; text: string; attention?: boolean; recorded?: number; lastAt?: number; originalLabel?: string | null; planned?: number }

/** Index original receipt groups once per visible window, independent of rule forecasts. */
export function calendarReceiptLines(rows: ReadonlyMap<string, { buckets: ReadonlyMap<number, ScheduleHistoryGroup[]>;
  publications?: ReadonlyMap<number, { count: number; firstAt: number; lastAt: number }> }>, byId: ReadonlyMap<string, CalendarSchedule>) {
  const byStart = new Map<number, CalendarCellLine[]>()
  for (const [id, row] of rows) {
    const record = byId.get(id)?.record
    if (!record) continue
    for (const [start, publication] of row.publications ?? []) {
      const lines = byStart.get(start) ?? []
      lines.push({ record, at: publication.firstAt, lastAt: publication.lastAt, recorded: publication.count, text: 'Assignment published' })
      byStart.set(start, lines)
    }
    for (const [start, groups] of row.buckets) {
      const lines = byStart.get(start) ?? []
      const byStatus = new Map<string, CalendarCellLine>()
      for (const group of groups) {
        const text = turnLabel(group.nativeState) ?? deliveryLabel(group.delivery)
        const existing = byStatus.get(text)
        if (existing) {
          if (existing.originalLabel !== group.originalLabel) existing.originalLabel = null
          existing.recorded = existing.recorded! + group.count
          existing.at = Math.min(existing.at, group.firstAt)
          existing.lastAt = Math.max(existing.lastAt!, group.lastAt)
        } else byStatus.set(text, { record, at: group.firstAt, lastAt: group.lastAt, originalLabel: group.originalLabel, recorded: group.count, attention: needsAttention(group), text })
      }
      lines.push(...byStatus.values())
      byStart.set(start, lines)
    }
  }
  return byStart
}

export function calendarCellLines(groups: ReturnType<typeof calendarScheduleGroups>, receipts: CalendarCellLine[], dueLabel: (record: ContinuousProgressLoop) => string) {
  const lines = [...receipts]
  const recorded = new Set(receipts.map(line => line.record.loopId))
  for (const group of groups) {
    const { record, accepted, planned, due } = group
    if (accepted && !recorded.has(record.loopId)) lines.push({ record, at: accepted.at,
      text: record.lastMotePublication?.occurrenceAt === accepted.at ? 'Assignment published' : 'Input accepted', recorded: 1 })
    if (planned && group.firstPlannedAt !== undefined) lines.push({ record, at: group.firstPlannedAt, text: 'planned', planned })
    else if (!accepted && due && !recorded.has(record.loopId)) lines.push({ record, at: due.at, text: dueLabel(record) })
  }
  return lines.sort((a, b) => Number(!!b.attention) - Number(!!a.attention) || a.at - b.at || a.record.loopId.localeCompare(b.record.loopId))
}
