import type { NormalizedRect, ScreenshotPoint } from './drawing-model.js'

/** The wand's tolerance scale: 0 selects only the exact seed color, 100 the whole connected image. */
export const MAGIC_WAND_TOLERANCE_RANGE = { min: 0, max: 100 } as const
export const DEFAULT_MAGIC_WAND_TOLERANCE = 20
const MAX_RGB_DISTANCE = Math.sqrt(3 * 255 * 255)

/** A wand selection in original image pixels: each pixel is a unit square. */
export type MagicWandRegion = { width: number; height: number; mask: Uint8Array; bounds: NormalizedRect }

/** Every pixel 4-connected to the seed whose RGB distance to the seed color, as a share of the largest possible
 * distance, is at most tolerance / 100. Alpha is ignored. A seed outside the image selects nothing. */
export function magicWandRegion(pixels: { width: number; height: number; data: ArrayLike<number> }, seed: ScreenshotPoint, tolerance: number): MagicWandRegion | null {
  const { width, height, data } = pixels
  const x0 = Math.floor(seed.x), y0 = Math.floor(seed.y)
  if (!Number.isFinite(x0) || !Number.isFinite(y0) || x0 < 0 || y0 < 0 || x0 >= width || y0 >= height) return null
  const limit = Math.max(0, Math.min(100, tolerance)) / 100 * MAX_RGB_DISTANCE, limitSquared = limit * limit
  const start = (y0 * width + x0) * 4, r = data[start]!, g = data[start + 1]!, b = data[start + 2]!
  // The stack grows with the region instead of the image, so a small click on a large frame stays small.
  const mask = new Uint8Array(width * height)
  let stack = new Int32Array(Math.min(width * height, 4096))
  let top = 0, left = x0, right = x0, upper = y0, lower = y0
  mask[y0 * width + x0] = 1; stack[top++] = y0 * width + x0
  while (top) {
    const index = stack[--top]!, x = index % width, y = (index - x) / width
    if (x < left) left = x; if (x > right) right = x; if (y < upper) upper = y; if (y > lower) lower = y
    for (const next of [x > 0 ? index - 1 : -1, x < width - 1 ? index + 1 : -1, y > 0 ? index - width : -1, y < height - 1 ? index + width : -1]) {
      if (next < 0 || mask[next]) continue
      const offset = next * 4, dr = data[offset]! - r, dg = data[offset + 1]! - g, db = data[offset + 2]! - b
      if (dr * dr + dg * dg + db * db > limitSquared) continue
      mask[next] = 1
      if (top === stack.length) { const grown = new Int32Array(Math.min(width * height, stack.length * 2)); grown.set(stack); stack = grown }
      stack[top++] = next
    }
  }
  return { width, height, mask, bounds: { x: left, y: upper, width: right - left + 1, height: lower - upper + 1 } }
}

/** The union of two selections over the same image, for Shift-click. */
export function unionMagicWandRegions(a: MagicWandRegion, b: MagicWandRegion): MagicWandRegion {
  if (a.width !== b.width || a.height !== b.height) throw new Error('Magic wand regions belong to different images')
  const mask = new Uint8Array(a.mask.length)
  for (let index = 0; index < mask.length; index++) if (a.mask[index] || b.mask[index]) mask[index] = 1
  const left = Math.min(a.bounds.x, b.bounds.x), upper = Math.min(a.bounds.y, b.bounds.y)
  const right = Math.max(a.bounds.x + a.bounds.width, b.bounds.x + b.bounds.width), lower = Math.max(a.bounds.y + a.bounds.height, b.bounds.y + b.bounds.height)
  return { width: a.width, height: a.height, mask, bounds: { x: left, y: upper, width: right - left, height: lower - upper } }
}

/** The closed rings of a selection's pixel-edge boundary: outer rings and the rings of its holes, so even-odd filling
 * paints exactly the selected pixels. Points sit on pixel corners, only where the boundary turns, so merging
 * collinear edges never shrinks coverage. Diagonally touching pixels stay separate rings. */
export function magicWandOutline(region: MagicWandRegion): ScreenshotPoint[][] {
  const { width, height, mask } = region
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1
  // Directed boundary edges keep the selected pixel on their left: right 0, down 1, left 2, up 3.
  const stride = width + 1, key = (x: number, y: number, direction: number) => ((y * stride + x) << 2) | direction
  const pending = new Set<number>()
  const { x: bx, y: by, width: bw, height: bh } = region.bounds
  for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) {
    if (!inside(x, y)) continue
    if (!inside(x, y - 1)) pending.add(key(x + 1, y, 2))
    if (!inside(x + 1, y)) pending.add(key(x + 1, y + 1, 3))
    if (!inside(x, y + 1)) pending.add(key(x, y + 1, 0))
    if (!inside(x - 1, y)) pending.add(key(x, y, 1))
  }
  const steps = [[1, 0], [0, 1], [-1, 0], [0, -1]] as const
  const rings: ScreenshotPoint[][] = []
  for (const first of pending) {
    const ring: ScreenshotPoint[] = []
    let edge = first
    while (pending.delete(edge)) {
      const direction = edge & 3, cell = edge >> 2, x = cell % stride, y = (cell - x) / stride
      const [dx, dy] = steps[direction]!, nx = x + dx, ny = y + dy
      // At a shared corner prefer the left turn, so diagonal neighbours never merge into one ring.
      const turns = [(direction + 3) % 4, direction, (direction + 1) % 4]
      const next = turns.map(turn => key(nx, ny, turn)).find(candidate => pending.has(candidate) || candidate === first)
      if (next === undefined) break
      if ((next & 3) !== direction) ring.push({ x: nx, y: ny })
      edge = next
    }
    if (ring.length >= 4) rings.push(ring)
  }
  return rings
}

/** Even-odd containment of a point in a set of closed rings. */
export function outlineContains(outline: readonly (readonly ScreenshotPoint[])[], point: ScreenshotPoint): boolean {
  let inside = false
  for (const ring of outline) for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const a = ring[index]!, b = ring[previous]!
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}
