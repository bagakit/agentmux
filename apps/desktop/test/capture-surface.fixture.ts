import type { CaptureSurfaceOutcome, CaptureSurfaceSession } from '../src/main/capture-surface'

type Selected = { state: string; screenshot?: { data: string; width: number; height: number; scale: number } }

/**
 * Stands in for the per-display capture surface in consumer tests. `select` is what the person did on the overlay:
 * a captured result is Done on that processed selection, anything else is Esc. A rejected delivery leaves the
 * surface, as the real one does, and the person then closes it.
 */
export function presentSelection(select: () => Promise<Selected>) {
  return async (session: CaptureSurfaceSession): Promise<CaptureSurfaceOutcome> => {
    const result = await select()
    if (result.state !== 'captured' || !result.screenshot) return { state: 'cancelled' }
    const { data, width, height, scale } = result.screenshot
    const image = { mimeType: 'image/png' as const, dataUrl: 'data:image/png;base64,' + data, width, height, byteLength: Buffer.byteLength(data, 'base64') }
    try { await session.complete(image, { rect: { x: 0, y: 0, width: width / scale, height: height / scale }, scale, capturedAt: 0 }, 'fixture-engine') }
    catch { return { state: 'cancelled' } }
    return { state: 'completed' }
  }
}
