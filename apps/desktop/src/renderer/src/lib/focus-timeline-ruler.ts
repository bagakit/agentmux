import { DateTime, IANAZone } from 'luxon'
import type { FocusTimeWindow } from './focus-time-window'

export type FocusRulerMode = 'daily' | 'uniform' | 'free'
export type FocusRulerPreferences = {
  mode: FocusRulerMode
  timeZone: string
  intervalMinutes: number
  phaseMinutes: number
}
export type FocusRulerTick = {
  instant: number
  tier: 'major' | 'short' | 'shorter' | 'fine'
  offset: number
  repeated: boolean
}
export const DEFAULT_FOCUS_RULER: FocusRulerPreferences = {
  mode: 'daily', timeZone: 'system', intervalMinutes: 120, phaseMinutes: 23 * 60
}
const MINUTE_MS = 60_000
const modulo = (value: number, divisor: number) => ((value % divisor) + divisor) % divisor

export function validFocusTimeZone(zone: string): boolean {
  return zone === 'system' || IANAZone.isValidZone(zone)
}
export function resolvedFocusTimeZone(zone: string): string {
  return zone === 'system' ? Intl.DateTimeFormat().resolvedOptions().timeZone : zone
}
export function restoreFocusRuler(candidate: unknown): FocusRulerPreferences {
  const value = candidate && typeof candidate === 'object' ? candidate as Partial<FocusRulerPreferences> : {}
  return {
    mode: value.mode === 'uniform' || value.mode === 'free' ? value.mode : 'daily',
    timeZone: typeof value.timeZone === 'string' && validFocusTimeZone(value.timeZone) ? value.timeZone : 'system',
    intervalMinutes: Number.isInteger(value.intervalMinutes) && value.intervalMinutes! >= 1 && value.intervalMinutes! <= 1440 ? value.intervalMinutes! : 120,
    phaseMinutes: Number.isInteger(value.phaseMinutes) && value.phaseMinutes! >= 0 && value.phaseMinutes! < 1440 ? value.phaseMinutes! : 23 * 60
  }
}
export function sameFocusRuler(left: FocusRulerPreferences, right: FocusRulerPreferences): boolean {
  return left.mode === right.mode && left.timeZone === right.timeZone && left.intervalMinutes === right.intervalMinutes && left.phaseMinutes === right.phaseMinutes
}
export function focusUtcOffset(minutes: number): string {
  return `UTC${minutes < 0 ? '−' : '+'}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}`
}

/** Reject a gap rather than accepting Luxon's forward normalization; retain both fold instants. */
export function focusDateCandidates(value: string, zone: string): Array<{ instant: number; offset: number }> {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return []
  const fields = { year: Number(value.slice(0, 4)), month: Number(value.slice(5, 7)), day: Number(value.slice(8, 10)), hour: Number(value.slice(11, 13)), minute: Number(value.slice(14, 16)), second: 0, millisecond: 0 }
  const date = DateTime.fromObject(fields, { zone: resolvedFocusTimeZone(zone) })
  if (!date.isValid) return []
  return date.getPossibleOffsets()
    .filter(item => item.year === fields.year && item.month === fields.month && item.day === fields.day && item.hour === fields.hour && item.minute === fields.minute)
    .sort((a, b) => a.toMillis() - b.toMillis())
    .map(item => ({ instant: item.toMillis(), offset: item.offset }))
}

/** Calendar coordinates use a fixed Gregorian civil origin, independent of the visible window. */
export function focusRulerTicks(window: FocusTimeWindow, preferences: FocusRulerPreferences, maxLines = 512): FocusRulerTick[] {
  const zone = resolvedFocusTimeZone(preferences.timeZone)
  if (preferences.mode === 'free') return Array.from({ length: 5 }, (_, index) => {
    const instant = window.start + (window.end - window.start) * index / 4
    return { instant, tier: 'major', offset: DateTime.fromMillis(instant, { zone }).offset, repeated: false }
  })
  const first = DateTime.fromMillis(window.start, { zone }), last = DateTime.fromMillis(window.end, { zone })
  if (!first.isValid || !last.isValid || window.end < window.start) return []
  const interval = preferences.mode === 'daily' ? 45 : preferences.intervalMinutes
  const phase = preferences.mode === 'daily' ? 0 : preferences.phaseMinutes
  const stride = preferences.mode === 'daily' ? 1 : Math.max(1, Math.ceil((window.end - window.start) / MINUTE_MS / interval / maxLines))
  const endDay = DateTime.utc(last.year, last.month, last.day).toMillis()
  const result: FocusRulerTick[] = []
  for (let day = DateTime.utc(first.year, first.month, first.day); day.toMillis() <= endDay; day = day.plus({ days: 1 })) {
    const civilDay = day.toMillis() / MINUTE_MS
    const firstMinute = preferences.mode === 'daily' ? 0 : modulo(phase - civilDay, interval)
    for (let minute = firstMinute; minute < 1440; minute += interval) {
      if (preferences.mode === 'uniform' && modulo((civilDay + minute - phase) / interval, stride) !== 0) continue
      const value = `${day.toISODate()}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
      const possible = focusDateCandidates(value, zone)
      const tier = preferences.mode === 'uniform' || minute % 360 === 0 ? 'major' : minute % 180 === 0 ? 'short' : minute % 90 === 0 ? 'shorter' : 'fine'
      for (const item of possible) if (item.instant >= window.start && item.instant <= window.end) result.push({ ...item, tier, repeated: possible.length > 1 })
    }
  }
  return result.sort((a, b) => a.instant - b.instant)
}

/** Label the strongest marks first, reserving their actual horizontal space. */
export function focusRulerLabels(ticks: readonly FocusRulerTick[], window: FocusTimeWindow, width: number): ReadonlySet<number> {
  if (width <= 0 || window.end <= window.start) return new Set()
  const order = { major: 0, short: 1, shorter: 2, fine: 3 }
  const accepted: Array<{ instant: number; x: number }> = []
  const margin = Math.min(36, width / 2)
  for (const tick of [...ticks].sort((a, b) => order[a.tier] - order[b.tier] || a.instant - b.instant)) {
    const x = Math.max(margin, Math.min(width - margin, (tick.instant - window.start) / (window.end - window.start) * width))
    if (accepted.every(label => Math.abs(label.x - x) >= 72)) accepted.push({ instant: tick.instant, x })
  }
  return new Set(accepted.map(label => label.instant))
}

export type FocusTimeFormatters = {
  zone: string
  clock(instant: number): string
  ruler(instant: number): string
  dateClock(instant: number): string
  detailed(instant: number): string
  dateInput(instant: number): string
}
const formatterSets = new Map<string, FocusTimeFormatters>()
/** Reuse Intl options across ruler changes; this cache contains no Session or message facts. */
export function createFocusTimeFormatters(timeZone: string, locale?: string): FocusTimeFormatters {
  const zone = resolvedFocusTimeZone(timeZone)
  const key = JSON.stringify([locale, zone])
  const existing = formatterSets.get(key)
  if (existing) return existing
  const clock = new Intl.DateTimeFormat(locale, { timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const ruler = new Intl.DateTimeFormat(locale, { timeZone: zone, hour: '2-digit', minute: '2-digit' })
  const dateClock = new Intl.DateTimeFormat(locale, { timeZone: zone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const detailed = new Intl.DateTimeFormat(locale, { timeZone: zone, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'shortOffset' })
  const result: FocusTimeFormatters = {
    zone,
    clock: (instant: number) => clock.format(instant),
    ruler: (instant: number) => ruler.format(instant),
    dateClock: (instant: number) => dateClock.format(instant),
    detailed: (instant: number) => detailed.format(instant),
    dateInput: (instant: number) => DateTime.fromMillis(instant, { zone }).toFormat("yyyy-MM-dd'T'HH:mm")
  }
  formatterSets.set(key, result)
  return result
}
