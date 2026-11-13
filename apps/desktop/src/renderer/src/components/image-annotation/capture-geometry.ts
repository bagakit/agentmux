import { intersectRect, normalizeRect, type NormalizedRect, type ScreenshotPoint } from './drawing-model'

/** The capture frame's CSS pixel size; its origin is the frame's top-left. */
export type CaptureFrame = { width: number; height: number }
export type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
/** One selection gesture in image pixels: a new selection, a move, or a resize from an edge or corner. */
export type CropGesture = { mode: 'create' | 'move' | CropHandle; start: ScreenshotPoint; at: ScreenshotPoint; original: NormalizedRect | null }

export const CROP_CURSORS: Record<CropHandle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' }
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export function rectContains(rect: NormalizedRect, at: ScreenshotPoint): boolean {
  return at.x >= rect.x && at.x <= rect.x + rect.width && at.y >= rect.y && at.y <= rect.y + rect.height
}

/** The corner or edge within tolerance of the point; corners win where two edges meet. */
export function hitCropHandle(rect: NormalizedRect, at: ScreenshotPoint, tolerance: number): CropHandle | null {
  const right = rect.x + rect.width, bottom = rect.y + rect.height
  const spansX = at.x >= rect.x - tolerance && at.x <= right + tolerance, spansY = at.y >= rect.y - tolerance && at.y <= bottom + tolerance
  const vertical = !spansX ? '' : Math.abs(at.y - rect.y) <= tolerance ? 'n' : Math.abs(at.y - bottom) <= tolerance ? 's' : ''
  const horizontal = !spansY ? '' : Math.abs(at.x - rect.x) <= tolerance ? 'w' : Math.abs(at.x - right) <= tolerance ? 'e' : ''
  return (vertical + horizontal || null) as CropHandle | null
}

/** The selection a gesture shows now, always inside the bounds; null while it has no area. */
export function cropGestureRect({ mode, start, at, original }: CropGesture, bounds: NormalizedRect): NormalizedRect | null {
  if (mode === 'create' || !original) return intersectRect(normalizeRect(start, at), bounds)
  const dx = at.x - start.x, dy = at.y - start.y, right = bounds.x + bounds.width, bottom = bounds.y + bounds.height
  if (mode === 'move') return { ...original, x: clamp(original.x + dx, bounds.x, right - original.width), y: clamp(original.y + dy, bounds.y, bottom - original.height) }
  const x = (edge: number) => clamp(edge + dx, bounds.x, right), y = (edge: number) => clamp(edge + dy, bounds.y, bottom)
  const rect = normalizeRect(
    { x: mode.includes('w') ? x(original.x) : original.x, y: mode.includes('n') ? y(original.y) : original.y },
    { x: mode.includes('e') ? x(original.x + original.width) : original.x + original.width, y: mode.includes('s') ? y(original.y + original.height) : original.y + original.height })
  return rect.width > 0 && rect.height > 0 ? rect : null
}

// The floating toolbar's height, its gap to the selection and its inset from the frame edge, in frame CSS pixels.
const CAPTURE_BAR_HEIGHT = 36, CAPTURE_BAR_GAP = 8, CAPTURE_BAR_INSET = 12
/** Right-aligned to the selection: below it, else above it, else inside its bottom-right corner; always 12 px inside the frame. */
export function captureToolbarPlacement(selection: NormalizedRect, barWidth: number, frame: CaptureFrame): { side: 'below' | 'above' | 'inside'; left: number; top: number } {
  const bottom = selection.y + selection.height, right = selection.x + selection.width
  const below = bottom + CAPTURE_BAR_GAP, above = selection.y - CAPTURE_BAR_GAP - CAPTURE_BAR_HEIGHT
  const side = below + CAPTURE_BAR_HEIGHT <= frame.height - CAPTURE_BAR_INSET ? 'below' : above >= CAPTURE_BAR_INSET ? 'above' : 'inside'
  const top = side === 'below' ? below : side === 'above' ? above : bottom - CAPTURE_BAR_INSET - CAPTURE_BAR_HEIGHT
  const end = side === 'inside' ? right - CAPTURE_BAR_INSET : right
  return { side, left: clamp(end - barWidth, CAPTURE_BAR_INSET, frame.width - CAPTURE_BAR_INSET - barWidth),
    top: clamp(top, CAPTURE_BAR_INSET, frame.height - CAPTURE_BAR_INSET - CAPTURE_BAR_HEIGHT) }
}

export const LOUPE_WIDTH = 136, LOUPE_HEIGHT = 150
// The loupe's distance from the pointer, and the clearance it keeps from the selection's border and handles.
const LOUPE_OFFSET = 16, LOUPE_CLEARANCE = 8
/** Beside the pointer, on the first diagonal that stays in the frame and off the selection. */
export function captureLoupePlacement(at: ScreenshotPoint, avoid: NormalizedRect | null, frame: CaptureFrame): { left: number; top: number } {
  const lefts = [at.x + LOUPE_OFFSET, at.x - LOUPE_OFFSET - LOUPE_WIDTH], tops = [at.y + LOUPE_OFFSET, at.y - LOUPE_OFFSET - LOUPE_HEIGHT]
  const candidates = [{ left: lefts[0], top: tops[0] }, { left: lefts[1], top: tops[0] }, { left: lefts[0], top: tops[1] }, { left: lefts[1], top: tops[1] }]
  const fits = (box: { left: number; top: number }) => box.left >= 0 && box.top >= 0 && box.left + LOUPE_WIDTH <= frame.width && box.top + LOUPE_HEIGHT <= frame.height
  const clear = (box: { left: number; top: number }) => !avoid || box.left >= avoid.x + avoid.width + LOUPE_CLEARANCE || box.left + LOUPE_WIDTH <= avoid.x - LOUPE_CLEARANCE ||
    box.top >= avoid.y + avoid.height + LOUPE_CLEARANCE || box.top + LOUPE_HEIGHT <= avoid.y - LOUPE_CLEARANCE
  const inFrame = candidates.filter(fits), chosen = inFrame.find(clear) ?? inFrame[0] ?? candidates[0]!
  return { left: clamp(chosen.left, 0, frame.width - LOUPE_WIDTH), top: clamp(chosen.top, 0, frame.height - LOUPE_HEIGHT) }
}
