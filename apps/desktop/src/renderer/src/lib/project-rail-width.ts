export const PROJECT_RAIL_DEFAULT_WIDTH = 210
export const PROJECT_RAIL_MIN_WIDTH = 180
export const PROJECT_RAIL_MAX_WIDTH = 420

export function clampProjectRailWidth(width: number): number {
  return Number.isFinite(width)
    ? Math.min(PROJECT_RAIL_MAX_WIDTH, Math.max(PROJECT_RAIL_MIN_WIDTH, width))
    : PROJECT_RAIL_DEFAULT_WIDTH
}
