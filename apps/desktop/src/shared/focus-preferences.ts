import { resolveFocusMapPreferences, type FocusMapPreferences } from './focus-map-preferences'

export const FOCUS_RECENT_ACTIVITY_HOURS = [12, 24, 48, 72, 168] as const
export type FocusRecentActivityHours = typeof FOCUS_RECENT_ACTIVITY_HOURS[number]
export type FocusPreferences = { recentActivityHours: FocusRecentActivityHours; linkDestination?: FocusLinkDestination; replyLines?: FocusReplyLines; previewTrigger?: FocusPreviewTrigger; recentInputs?: FocusRecentInputs; mapMotion?: FocusMapMotion; map?: FocusMapPreferences }
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

export const FOCUS_REPLY_LINES = [1, 2, 3] as const
export type FocusReplyLines = typeof FOCUS_REPLY_LINES[number]
export function resolveFocusReplyLines(value: unknown): FocusReplyLines {
  return FOCUS_REPLY_LINES.includes(value as FocusReplyLines) ? value as FocusReplyLines : 2
}
export const FOCUS_PREVIEW_TRIGGERS = ['quick', 'deliberate', 'keyboard'] as const
export type FocusPreviewTrigger = typeof FOCUS_PREVIEW_TRIGGERS[number]
export function resolveFocusPreviewTrigger(value: unknown): FocusPreviewTrigger {
  return FOCUS_PREVIEW_TRIGGERS.includes(value as FocusPreviewTrigger) ? value as FocusPreviewTrigger : 'quick'
}
/** One intent policy shared by actual Agent cards and their settings example. */
export function focusPreviewDelay(value: FocusPreviewTrigger): number | null {
  return value === 'keyboard' ? null : value === 'deliberate' ? 600 : 180
}
export const FOCUS_RECENT_INPUTS = [3, 6, 10] as const
export type FocusRecentInputs = typeof FOCUS_RECENT_INPUTS[number]
export function resolveFocusRecentInputs(value: unknown): FocusRecentInputs {
  return FOCUS_RECENT_INPUTS.includes(value as FocusRecentInputs) ? value as FocusRecentInputs : 6
}
export const FOCUS_MAP_MOTION = ['system', 'on', 'off'] as const
export type FocusMapMotion = typeof FOCUS_MAP_MOTION[number]
export function resolveFocusMapMotion(value: unknown): FocusMapMotion {
  return FOCUS_MAP_MOTION.includes(value as FocusMapMotion) ? value as FocusMapMotion : 'system'
}
export function resolveFocusPreferences(value: FocusPreferences | undefined): Required<FocusPreferences> {
  return { recentActivityHours: resolveFocusRecentActivityHours(value?.recentActivityHours), linkDestination: resolveFocusLinkDestination(value?.linkDestination),
    replyLines: resolveFocusReplyLines(value?.replyLines), previewTrigger: resolveFocusPreviewTrigger(value?.previewTrigger), recentInputs: resolveFocusRecentInputs(value?.recentInputs), mapMotion: resolveFocusMapMotion(value?.mapMotion), map: resolveFocusMapPreferences(value?.map) }
}
