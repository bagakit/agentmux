import { DEFAULT_AGENT_SCHEDULE_CHECK_IN, parseAgentScheduleCalendar, parseAgentScheduleCheckIn, type AgentScheduleCheckInPolicy } from '@agentmux/core/schedule'

export type AutomationDefaults = {
  progressIntervalMs: number
  progressPrompt: string
  /** Empty means the system timezone at new-form initialization. */
  calendarTimezone: string
  checkInSilenceMs: number
  checkInMinIntervalMs: number
  checkInDailyBudget: number
  checkInQuietStart: string
  checkInQuietEnd: string
}
export type AutomationPreferences = Partial<AutomationDefaults>

export const DEFAULT_AUTOMATION_PREFERENCES: Readonly<AutomationDefaults> = Object.freeze({
  progressIntervalMs: 30 * 60_000, progressPrompt: '', calendarTimezone: '',
  checkInSilenceMs: DEFAULT_AGENT_SCHEDULE_CHECK_IN.silenceMs,
  checkInMinIntervalMs: DEFAULT_AGENT_SCHEDULE_CHECK_IN.minIntervalMs,
  checkInDailyBudget: DEFAULT_AGENT_SCHEDULE_CHECK_IN.dailyBudget,
  checkInQuietStart: DEFAULT_AGENT_SCHEDULE_CHECK_IN.quiet.start,
  checkInQuietEnd: DEFAULT_AGENT_SCHEDULE_CHECK_IN.quiet.end
})

/** Effective preferences never author or persist an absent field. */
export function resolveAutomationPreferences(value?: AutomationPreferences): AutomationDefaults {
  return Object.fromEntries(Object.entries(DEFAULT_AUTOMATION_PREFERENCES).map(([key, fallback]) =>
    [key, value?.[key as keyof AutomationDefaults] ?? fallback])) as AutomationDefaults
}

export function automationCheckInPolicy(value: AutomationDefaults): AgentScheduleCheckInPolicy {
  return { silenceMs: value.checkInSilenceMs, minIntervalMs: value.checkInMinIntervalMs,
    dailyBudget: value.checkInDailyBudget, quiet: { start: value.checkInQuietStart, end: value.checkInQuietEnd } }
}

export function automationCalendarTimezone(value: AutomationDefaults): string {
  return value.calendarTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone
}

export function validateAutomationPreferences(value: AutomationPreferences | undefined): void {
  const resolved = resolveAutomationPreferences(value)
  // The existing periodic form uses minutes (minimum one); no arbitrary product maximum.
  if (!Number.isSafeInteger(resolved.progressIntervalMs) || resolved.progressIntervalMs < 60_000)
    throw new TypeError('Choose a periodic interval of at least one minute in whole milliseconds.')
  if (typeof resolved.progressPrompt !== 'string' || typeof resolved.calendarTimezone !== 'string')
    throw new TypeError('Periodic prompt and calendar timezone must be text.')
  if (resolved.calendarTimezone) parseAgentScheduleCalendar({ kind: 'daily', timezone: resolved.calendarTimezone,
    time: [9, 0].map(value => String(value).padStart(2, '0')).join(':'), policies: { gap: 'skip', fold: 'earlier', monthEnd: 'clamp', overdue: 'latest' } })
  parseAgentScheduleCheckIn(automationCheckInPolicy(resolved))
}
