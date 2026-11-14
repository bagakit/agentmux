export type PixelFrame = { width: number; height: number; data: Uint8ClampedArray }
/** A rejected alignment candidate; the source and existing frames remain usable. */
export class ScrollOverlapError extends Error {
  override name = 'ScrollOverlapError'
}
/** Find the downward scroll between two equal viewports. Uncertain alignment stays explicit. */
export function matchScroll(previous: PixelFrame, next: PixelFrame): { shift: number; error: number } {
  const { width: w, height: h, data: a } = previous, b = next.data
  if (w !== next.width || h !== next.height || a.length !== w * h * 4 || b.length !== a.length) throw new Error('Keep the same capture region and pixel size while scrolling.')
  const score = (shift: number) => {
    const overlap = h - shift
    let total = 0, count = 0
    for (let row = 0; row < Math.min(48, overlap); row++) {
      const y = Math.floor(row * overlap / Math.min(48, overlap))
      for (let col = 1; col < 33; col++) {
        const x = Math.min(w - 1, Math.floor(col * w / 34)), i = ((y + shift) * w + x) * 4, j = (y * w + x) * 4
        for (let c = 0; c < 3; c++) { total += Math.abs(a[i + c]! - b[j + c]!); count++ }
      }
    }
    return total / count
  }
  const unchanged = score(0)
  if (unchanged < 0.5) return { shift: 0, error: unchanged }
  const minimumOverlap = Math.min(48, Math.floor(h / 3))
  const scores: { shift: number; error: number }[] = []
  for (let shift = 1; shift <= h - minimumOverlap; shift++) scores.push({ shift, error: score(shift) })
  scores.sort((a, b) => a.error - b.error)
  const best = scores[0], alternate = scores.find(item => best && Math.abs(item.shift - best.shift) > 2)
  // Local cursor or blinking content can change pixels without moving the viewport.
  // Prefer zero motion when it is both within the overlap budget and the best alignment.
  if (best && unchanged < 6 && unchanged < best.error) return { shift: 0, error: unchanged }
  if (!best || best.error > 6 || alternate && alternate.error - best.error < 1) throw new ScrollOverlapError('The overlap is unclear. Scroll back to overlap the last captured content, and pause moving content. Previous frames are kept.')
  return best
}
