export const FOCUS_RECENT_ACTIVITY_HOURS = [12, 24, 72, 168] as const
export type FocusRecentActivityHours = typeof FOCUS_RECENT_ACTIVITY_HOURS[number]
export type FocusPreferences = { recentActivityHours: FocusRecentActivityHours }
export const DEFAULT_FOCUS_RECENT_ACTIVITY_HOURS: FocusRecentActivityHours = 24

export function resolveFocusRecentActivityHours(value: unknown): FocusRecentActivityHours {
  return FOCUS_RECENT_ACTIVITY_HOURS.includes(value as FocusRecentActivityHours)
    ? value as FocusRecentActivityHours : DEFAULT_FOCUS_RECENT_ACTIVITY_HOURS
}
