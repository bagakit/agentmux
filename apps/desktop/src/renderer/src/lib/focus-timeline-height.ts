export const FOCUS_TIMELINE_HEIGHT_DEFAULT = 96
export const FOCUS_TIMELINE_HEIGHT_MIN = 72
export const FOCUS_TIMELINE_HEIGHT_MAX = 480
/** A presentation preference. Geometry clamps again to the actual available content height. */
export function clampFocusTimelineHeight(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.min(FOCUS_TIMELINE_HEIGHT_MAX, Math.max(FOCUS_TIMELINE_HEIGHT_MIN, value)))
    : FOCUS_TIMELINE_HEIGHT_DEFAULT
}
