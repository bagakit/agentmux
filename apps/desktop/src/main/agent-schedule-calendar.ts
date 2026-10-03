import { DateTime } from 'luxon'
import { parseAgentScheduleCalendar, type AgentScheduleCalendar } from '@agentmux/core'

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
