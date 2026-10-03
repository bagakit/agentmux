import { formatClock, formatOffset } from './conversation-time.js'
/** A recorded activity range, not a Session or process lifetime. */
export function describeActivityRecordTime(from: number, to: number, origin: number): {
  from: string
  to: string
  offset: string
} {
  const first = new Date(from)
  const last = new Date(to)
  const valid = (at: number, date: Date): boolean => Number.isFinite(at) && Number.isFinite(date.getTime())
  const hasFirst = valid(from, first)
  const hasLast = valid(to, last)
  const crossDay = hasFirst && hasLast && (
    first.getFullYear() !== last.getFullYear() ||
    first.getMonth() !== last.getMonth() ||
    first.getDate() !== last.getDate()
  )
  const clock = (at: number, date: Date, present: boolean): string => {
    if (!present) return 'Unknown time'
    if (!crossDay) return formatClock(at)
    const pad = (value: number): string => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${formatClock(at)}`
  }
  const hasOrigin = valid(origin, new Date(origin))
  const offset = hasFirst && hasLast && hasOrigin
    ? `${formatOffset(from, origin)}${from === to ? '' : ` to ${formatOffset(to, origin)}`} from start`
    : 'Offset not recorded'
  return {
    from: clock(from, first, hasFirst),
    to: clock(to, last, hasLast),
    offset
  }
}

