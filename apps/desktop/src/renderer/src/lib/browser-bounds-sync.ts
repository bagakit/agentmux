import type { BrowserBounds } from '../../../shared/contracts'

/** Converts zoomed Renderer CSS geometry into BrowserWindow content-view DIP. */
export function rendererCssBoundsToWindowDip(
  bounds: BrowserBounds,
  zoomFactor: number
): BrowserBounds {
  return {
    x: bounds.x * zoomFactor,
    y: bounds.y * zoomFactor,
    width: bounds.width * zoomFactor,
    height: bounds.height * zoomFactor
  }
}

function normalizeBounds(bounds: BrowserBounds | null): BrowserBounds | null {
  if (!bounds) return null
  const values = [bounds.x, bounds.y, bounds.width, bounds.height]
  if (values.some((value) => !Number.isFinite(value)) || bounds.width < 1 || bounds.height < 1) {
    return null
  }
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height))
  }
}

function sameBounds(left: BrowserBounds | null | undefined, right: BrowserBounds | null): boolean {
  if (left === undefined) return false
  if (left === null || right === null) return left === right
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  )
}

/** Owns the Renderer-to-Main geometry hot path for one native Browser surface. */
export class LatestBrowserBoundsSynchronizer {
  private disposed = false
  private draining = false
  private pending: BrowserBounds | null | undefined
  private applied: BrowserBounds | null | undefined

  constructor(
    private readonly apply: (bounds: BrowserBounds | null) => Promise<void>,
    private readonly onError: (error: unknown) => void
  ) {}

  observe(bounds: BrowserBounds | null): void {
    if (this.disposed) return
    this.pending = normalizeBounds(bounds)
    void this.drain()
  }

  dispose(): void {
    this.disposed = true
    this.pending = undefined
  }

  private async drain(): Promise<void> {
    if (this.draining || this.disposed) return
    this.draining = true
    try {
      while (!this.disposed && this.pending !== undefined) {
        const next = this.pending
        this.pending = undefined
        if (sameBounds(this.applied, next)) continue
        await this.apply(next)
        this.applied = next
      }
    } catch (error) {
      if (!this.disposed) this.onError(error)
    } finally {
      this.draining = false
      if (!this.disposed && this.pending !== undefined) void this.drain()
    }
  }
}
