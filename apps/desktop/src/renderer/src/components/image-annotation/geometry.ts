export function clampScreenshotScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1
  return Math.min(Math.max(scale, 1), 4)
}

