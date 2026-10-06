import type { BrowserScreenshotCapture } from '../shared/contracts.js'
type Viewport = BrowserScreenshotCapture['source']['viewport']
export const SCREENSHOT_VIEWPORT_SCRIPT = '({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio})'

/** Optional observation never prevents the original screenshot from working. */
export async function readScreenshotObservation(read: () => Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([read().catch(() => null), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 500) })])
  } catch { return null } finally { clearTimeout(timer) }
}

export async function readScreenshotViewport(read: () => Promise<unknown>): Promise<Viewport> {
  const value = await readScreenshotObservation(read)
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (typeof row.width !== 'number' || !Number.isFinite(row.width) || row.width <= 0 || typeof row.height !== 'number' || !Number.isFinite(row.height) || row.height <= 0) return null
  return { width: row.width, height: row.height, deviceScaleFactor: typeof row.deviceScaleFactor === 'number' && Number.isFinite(row.deviceScaleFactor) && row.deviceScaleFactor > 0 ? row.deviceScaleFactor : null }
}

export function screenshotSource(url: string | null, title: string | null, before: Viewport, after: Viewport): BrowserScreenshotCapture['source'] {
  const viewport = before && after && before.width === after.width && before.height === after.height && before.deviceScaleFactor === after.deviceScaleFactor ? before : null
  return { url, title, viewport, viewportWarning: viewport ? null : 'CSS viewport could not be confirmed around this capture. Image pixel coordinates are available.' }
}
