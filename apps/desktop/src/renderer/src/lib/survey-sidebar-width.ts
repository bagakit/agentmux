export const SURVEY_SIDEBAR_DEFAULT_WIDTH = 220
export const SURVEY_SIDEBAR_MIN_WIDTH = 176
export const SURVEY_SIDEBAR_MAX_WIDTH = 420
const WORK_SURFACE_MIN_WIDTH = 320

export function clampSurveySidebarWidth(width: number): number {
  return Number.isFinite(width) ? Math.min(SURVEY_SIDEBAR_MAX_WIDTH, Math.max(SURVEY_SIDEBAR_MIN_WIDTH, width)) : SURVEY_SIDEBAR_DEFAULT_WIDTH
}

/** Bound the presentation to its actual available space without rewriting the saved preference. */
export function surveySidebarBounds(availableWidth: number): { minWidth: number; maxWidth: number } {
  const maxWidth = availableWidth > 0 ? Math.min(SURVEY_SIDEBAR_MAX_WIDTH, Math.max(48, availableWidth - WORK_SURFACE_MIN_WIDTH)) : SURVEY_SIDEBAR_MAX_WIDTH
  return { minWidth: Math.min(SURVEY_SIDEBAR_MIN_WIDTH, maxWidth), maxWidth }
}
