export const FOCUS_RECENT_ACTIVITY_HOURS = [12, 24, 48, 72, 168] as const
export type FocusRecentActivityHours = typeof FOCUS_RECENT_ACTIVITY_HOURS[number]
export type FocusPreferences = { recentActivityHours: FocusRecentActivityHours; linkDestination?: FocusLinkDestination }
export const DEFAULT_FOCUS_RECENT_ACTIVITY_HOURS: FocusRecentActivityHours = 48
/** Minimum project visibility guarantee, independent of a shorter sorting preference. */
export const FOCUS_RECENT_PROJECT_HOURS = 48

export function resolveFocusRecentActivityHours(value: unknown): FocusRecentActivityHours {
  return FOCUS_RECENT_ACTIVITY_HOURS.includes(value as FocusRecentActivityHours)
    ? value as FocusRecentActivityHours : DEFAULT_FOCUS_RECENT_ACTIVITY_HOURS
}

export const FOCUS_LINK_DESTINATIONS = ['region', 'tab'] as const
export type FocusLinkDestination = typeof FOCUS_LINK_DESTINATIONS[number]
export const DEFAULT_FOCUS_LINK_DESTINATION: FocusLinkDestination = 'region'
export function resolveFocusLinkDestination(value: unknown): FocusLinkDestination {
  return value === 'tab' ? 'tab' : DEFAULT_FOCUS_LINK_DESTINATION
}
