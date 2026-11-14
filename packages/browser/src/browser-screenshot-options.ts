import type { BrowserCdpSender } from './browser-page-snapshot.js'
import { resolveBrowserStructuredTarget } from './browser-structured-target.js'
import { BROWSER_PNG_MAX_DIMENSION, BROWSER_PNG_MAX_PIXELS } from './model/page.js'

export type BrowserScreenshotOptions = {
  /** Exactly one CSS region in the main document, already entirely in the viewport. */
  within?: string
  /** CSS pixels relative to the current viewport; capture never scrolls. */
  clip?: { x: number; y: number; width: number; height: number }
  /** Output pixels per CSS pixel, without changing device emulation or page zoom. */
  pixelRatio?: number
}
type Viewport = { width: number; height: number; deviceScaleFactor: number | null }
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

export function parseBrowserScreenshotOptions(input: unknown): BrowserScreenshotOptions {
  if (input === undefined) return {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Screenshot options must be an object.')
  const p = input as Record<string, unknown>
  if (Object.keys(p).some(key => !['within', 'clip', 'pixelRatio'].includes(key))) throw new Error('Screenshot options support within, clip and pixelRatio only.')
  if (p.within !== undefined && (typeof p.within !== 'string' || !p.within.trim())) throw new Error('Screenshot within requires one nonempty CSS selector in the main document.')
  if (p.within !== undefined && p.clip !== undefined) throw new Error('Choose either a CSS region or a viewport clip, not both.')
  if (p.pixelRatio !== undefined && (!finite(p.pixelRatio) || p.pixelRatio <= 0 || p.pixelRatio > 4)) throw new Error('Screenshot pixelRatio must be greater than zero and at most 4.')
  let clip: BrowserScreenshotOptions['clip']
  if (p.clip !== undefined) {
    if (!p.clip || typeof p.clip !== 'object' || Array.isArray(p.clip)) throw new Error('Screenshot clip requires x, y, width and height in CSS pixels.')
    const c = p.clip as Record<string, unknown>
    if (Object.keys(c).length !== 4 || Object.keys(c).some(key => !['x', 'y', 'width', 'height'].includes(key)) ||
        ![c.x, c.y, c.width, c.height].every(finite) || Number(c.x) < 0 || Number(c.y) < 0 || Number(c.width) <= 0 || Number(c.height) <= 0) {
      throw new Error('Screenshot clip requires finite nonnegative x/y and positive width/height.')
    }
    clip = { x: Number(c.x), y: Number(c.y), width: Number(c.width), height: Number(c.height) }
  }
  return { ...(p.within === undefined ? {} : { within: p.within as string }), ...(clip ? { clip } : {}),
    ...(p.pixelRatio === undefined ? {} : { pixelRatio: p.pixelRatio as number }) }
}

/** Prepare only this document's pixels. No input, scrolling, focus or device emulation. */
export async function prepareBrowserScreenshot(send: BrowserCdpSender, input: BrowserScreenshotOptions, viewport: Viewport | null) {
  const options = parseBrowserScreenshotOptions(input)
  const wantsRegion = options.clip !== undefined || options.within !== undefined || options.pixelRatio !== undefined
  if (!wantsRegion) return { parameters: { format: 'png', fromSurface: true, captureBeyondViewport: false }, region: null }
  if (!viewport) throw new Error('The current CSS viewport is unconfirmed; an exact region screenshot cannot be captured. The original page remains available.')
  const metrics = await send('Page.getLayoutMetrics') as { cssVisualViewport?: { pageX?: number; pageY?: number; zoom?: number; clientWidth?: number; clientHeight?: number } }
  const { pageX, pageY, zoom, clientWidth, clientHeight } = metrics.cssVisualViewport ?? {}
  if (!finite(pageX) || !finite(pageY) || !finite(zoom) || zoom <= 0 || !finite(clientWidth) || !finite(clientHeight) || clientWidth <= 0 || clientHeight <= 0) {
    throw new Error('The current viewport position, size or page zoom is unconfirmed; exact-region capture is unavailable.')
  }
  // innerWidth/Height are integer layout observations. The actual visible viewport
  // can have a fractional CSS edge at page zoom; preserve that edge for a full PNG.
  let clip = options.clip ?? { x: 0, y: 0, width: clientWidth, height: clientHeight }
  if (options.within) {
    const target = await resolveBrowserStructuredTarget(send, { within: options.within })
    try {
      const response = await send('Runtime.callFunctionOn', { objectId: target.objectId, returnByValue: true,
        functionDeclaration: 'function(){ if(!this.isConnected || !this.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) throw new Error("The screenshot region is not visible in its document."); const r=this.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; }' }) as {
          result?: { value?: unknown }; exceptionDetails?: unknown
        }
      if (response.exceptionDetails) throw new Error('The screenshot region is not visible. Capture never scrolls or selects a substitute.')
      clip = parseBrowserScreenshotOptions({ clip: response.result?.value }).clip!
      if (!await target.isCurrent()) throw new Error('The screenshot region changed before capture. Take a fresh observation.')
    } finally { await target.release() }
  }
  if (clip.x + clip.width > clientWidth + 0.01 || clip.y + clip.height > clientHeight + 0.01) {
    throw new Error('The screenshot region must be entirely inside the current viewport. Capture does not scroll, resize or silently crop the requested region.')
  }
  const ratio = options.pixelRatio ?? viewport.deviceScaleFactor
  if (!ratio || !viewport.deviceScaleFactor) throw new Error('The native pixel density is unconfirmed; exact-density capture is unavailable for this observation.')
  const width = Math.ceil(clip.width * ratio), height = Math.ceil(clip.height * ratio)
  if (width > BROWSER_PNG_MAX_DIMENSION || height > BROWSER_PNG_MAX_DIMENSION || width * height > BROWSER_PNG_MAX_PIXELS) throw new Error('The requested screenshot exceeds the PNG pixel budget. Choose a smaller region or pixelRatio.')
  // Page.Viewport is in DIP, while DOM rectangles and cssVisualViewport are CSS.
  // document DPR already includes page zoom; Chromium applies its physical DSF
  // after clip.scale. Convert both the rectangle and sampling, not just its size.
  // Zoom is reported at float32 precision. Snap only its roundoff near an integer
  // DIP; otherwise Chromium can truncate 287.999992 to 287 before raster scaling.
  const dip = (css: number) => {
    const value = css * zoom, integer = Math.round(value)
    return Math.abs(value - integer) <= Math.max(1, Math.abs(value)) * 2 ** -23 ? integer : value
  }
  return { parameters: { format: 'png', fromSurface: true, captureBeyondViewport: false,
    clip: { x: dip(pageX + clip.x), y: dip(pageY + clip.y), width: dip(clip.width), height: dip(clip.height), scale: ratio / viewport.deviceScaleFactor } },
    region: { ...clip, pixelRatio: ratio } }
}
