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
export type AgentScheduleCheckInPolicy = { silenceMs: number; minIntervalMs: number; dailyBudget: number; quiet: { start: string; end: string } }
export type AgentScheduleCheckInState = {
  lastClaimAt?: number
  budgetDate?: string
  budgetUsed?: number
  unanswered?: { humanId: string; humanCreatedAt: number; claimAt: number }
}
const civilClock = (hour: number) => [hour, 0].map(value => String(value).padStart(2, '0')).join(':')
export const DEFAULT_AGENT_SCHEDULE_CHECK_IN: AgentScheduleCheckInPolicy = { silenceMs: 18 * 3_600_000, minIntervalMs: 20 * 3_600_000, dailyBudget: 1, quiet: { start: civilClock(22), end: civilClock(8) } }
export const AGENT_SCHEDULE_CHECK_IN_GUIDANCE = 'This is an explicitly enabled quiet follow-up in this same conversation. Ask at most one short, concrete question about the user’s confirmed goals or unfinished decisions here. Use only facts available in this conversation. If relevant context is missing or uncertain, say so; do not invent a topic, an answer, or progress. Current user instructions and authorization take priority. Never claim that you worked or completed tasks in the background.'
export function parseAgentScheduleCheckIn(value: unknown, code = 'INVALID_CONTROL_REQUEST'): AgentScheduleCheckInPolicy {
  const p = rpcRecord(value, ['silenceMs','minIntervalMs','dailyBudget','quiet'], code), quiet = rpcRecord(p.quiet, ['start','end'], code)
  const invalid = (): never => { throw new AgentMuxError('Quiet follow-up requires an explicit silence interval, minimum interval, civil-day budget and local quiet period.', code) }
  for (const key of ['silenceMs','minIntervalMs']) if (!Number.isSafeInteger(p[key]) || (p[key] as number) < 300_000 || (p[key] as number) > 30 * 86_400_000) invalid()
  if (!Number.isSafeInteger(p.dailyBudget) || (p.dailyBudget as number) < 1 || (p.dailyBudget as number) > 3) invalid()
  if (![quiet.start, quiet.end].every(time => typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/u.test(time)) || quiet.start === quiet.end) invalid()
  return structuredClone(p) as AgentScheduleCheckInPolicy
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
    const day = new Date(p.date as string)
    day.setUTCHours(12)
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== p.date) invalid()
  } else if (p.date !== undefined) invalid()
  if (p.kind === 'weekly' ? !Number.isInteger(p.weekday) || (p.weekday as number) < 1 || (p.weekday as number) > 7 : p.weekday !== undefined) invalid()
  if (p.kind === 'monthly' || p.kind === 'yearly') {
    if (!Number.isInteger(p.day) || (p.day as number) < 1 || (p.day as number) > 31) invalid()
  } else if (p.day !== undefined) invalid()
  if (p.kind === 'yearly' ? !Number.isInteger(p.month) || (p.month as number) < 1 || (p.month as number) > 12 : p.month !== undefined) invalid()
  return structuredClone(p) as AgentScheduleCalendar
}
