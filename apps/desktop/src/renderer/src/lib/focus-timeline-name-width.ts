export const FOCUS_TIMELINE_NAME_WIDTH_DEFAULT = 112
export const FOCUS_TIMELINE_NAME_WIDTH_MIN = 96
export const FOCUS_TIMELINE_NAME_WIDTH_MAX = 320

/** Saved preference; a narrow time canvas only limits its rendered width. */
export function clampFocusTimelineNameWidth(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.min(FOCUS_TIMELINE_NAME_WIDTH_MAX, Math.max(FOCUS_TIMELINE_NAME_WIDTH_MIN, value)))
    : FOCUS_TIMELINE_NAME_WIDTH_DEFAULT
}
