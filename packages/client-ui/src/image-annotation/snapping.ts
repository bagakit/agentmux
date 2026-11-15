import type { NormalizedRect, ScreenshotPoint } from './drawing-model.js'

/** How close, in screen points, a moving edge or point must come to a line before it snaps. */
export const SNAP_DISTANCE = 6

/** Vertical lines at each `x` and horizontal lines at each `y`, in image pixels. */
export type SnapLines = { x: readonly number[]; y: readonly number[] }
/** What a gesture moves: the x positions of its vertical edges and the y positions of its horizontal ones, in image pixels. */
export type SnapFeatures = { x: readonly number[]; y: readonly number[] }
/** The shift that lands the nearest feature on its line, and the lines a shifted feature lies on. */
export type Snap = { dx: number; dy: number; guides: SnapLines }

const EPSILON = 1e-6

/** Each window's edges, the selection's edges, and every other mark's edges and centre. */
export function snapLines(windows: readonly NormalizedRect[], selection: NormalizedRect | null, marks: readonly NormalizedRect[]): SnapLines {
  const x: number[] = [], y: number[] = []
  for (const rect of selection ? [...windows, selection] : windows) {
    x.push(rect.x, rect.x + rect.width); y.push(rect.y, rect.y + rect.height)
  }
  for (const rect of marks) {
    x.push(rect.x, rect.x + rect.width / 2, rect.x + rect.width); y.push(rect.y, rect.y + rect.height / 2, rect.y + rect.height)
  }
  return { x, y }
}

/** A moved rect offers its edges and centre; a resized one only the edges its handle (`n`, `se`, …) moves. */
export function rectFeatures(rect: NormalizedRect, handle: string | null): SnapFeatures {
  const right = rect.x + rect.width, bottom = rect.y + rect.height
  if (!handle) return { x: [rect.x, rect.x + rect.width / 2, right], y: [rect.y, rect.y + rect.height / 2, bottom] }
  return { x: handle.includes('w') ? [rect.x] : handle.includes('e') ? [right] : [], y: handle.includes('n') ? [rect.y] : handle.includes('s') ? [bottom] : [] }
}

export function pointFeatures(at: ScreenshotPoint): SnapFeatures { return { x: [at.x], y: [at.y] } }

/** Per axis, the feature nearest a line within `threshold` image pixels moves onto it; of equal distances the first wins. */
export function snap(features: SnapFeatures, lines: SnapLines, threshold: number): Snap {
  const x = snapAxis(features.x, lines.x, threshold), y = snapAxis(features.y, lines.y, threshold)
  return { dx: x.delta, dy: y.delta, guides: { x: x.guides, y: y.guides } }
}

function snapAxis(features: readonly number[], lines: readonly number[], threshold: number): { delta: number; guides: number[] } {
  let delta = 0, best = Infinity
  for (const feature of features) for (const line of lines) {
    const gap = Math.abs(line - feature)
    if (gap <= threshold && gap < best) { delta = line - feature; best = gap }
  }
  return best === Infinity ? { delta: 0, guides: [] } : { delta, guides: on(features, lines, delta) }
}

function on(features: readonly number[], lines: readonly number[], delta: number): number[] {
  const out: number[] = []
  for (const line of lines) if (!out.includes(line) && features.some(feature => Math.abs(feature + delta - line) < EPSILON)) out.push(line)
  return out
}
