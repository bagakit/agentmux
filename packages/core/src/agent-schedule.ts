import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'

/** Civil recurrence interpreted by the connected Host, never a fixed millisecond period. */
export type AgentScheduleCalendar = {
  kind: 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly'
  timezone: string
  time: string
  date?: string
  weekday?: number
  day?: number
  month?: number
  policies: { gap: 'skip'; fold: 'earlier' | 'later'; monthEnd: 'clamp'; overdue: 'latest' }
}
export function parseAgentScheduleCalendar(value: unknown, code = 'INVALID_CONTROL_REQUEST'): AgentScheduleCalendar {
  const p = rpcRecord(value, ['kind','timezone','time','date','weekday','day','month','policies'], code)
  const invalid = (): never => { throw new AgentMuxError('Calendar requires a valid civil recurrence, IANA timezone and explicit DST/month-end policies.', code) }
  if (!['once','daily','weekly','monthly','yearly'].includes(p.kind as string) || typeof p.timezone !== 'string' || !p.timezone ||
      typeof p.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(p.time)) invalid()
  try { new Intl.DateTimeFormat('en', { timeZone: p.timezone as string }).format() } catch { invalid() }
  const policy = rpcRecord(p.policies, ['gap','fold','monthEnd','overdue'], code)
  if (policy.gap !== 'skip' || !['earlier','later'].includes(policy.fold as string) || policy.monthEnd !== 'clamp' || policy.overdue !== 'latest') invalid()
  if (p.kind === 'once') {
    if (typeof p.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(p.date)) invalid()
    const day = new Date(p.date + new Date(12 * 60 * 60 * 1_000).toISOString().slice(10))
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== p.date) invalid()
  } else if (p.date !== undefined) invalid()
  if (p.kind === 'weekly' ? !Number.isInteger(p.weekday) || (p.weekday as number) < 1 || (p.weekday as number) > 7 : p.weekday !== undefined) invalid()
  if (p.kind === 'monthly' || p.kind === 'yearly') {
    if (!Number.isInteger(p.day) || (p.day as number) < 1 || (p.day as number) > 31) invalid()
  } else if (p.day !== undefined) invalid()
  if (p.kind === 'yearly' ? !Number.isInteger(p.month) || (p.month as number) < 1 || (p.month as number) > 12 : p.month !== undefined) invalid()
  return structuredClone(p) as AgentScheduleCalendar
}
