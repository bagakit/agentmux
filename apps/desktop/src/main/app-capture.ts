import { nativeImage, type BrowserWindow, type WebContentsView } from 'electron'
import { AgentMuxError, APP_CAPTURE_LIMITS, parseAppCaptureFrame, parseAppCaptureTarget,
  type AppCaptureFrame, type AppCaptureRect, type AppCaptureTarget } from '@agentmux/core/control'
import type { WorkbenchWindows } from './workbench-windows.js'
import type { BrowserViewManager } from './browser-view-manager.js'

type Layer = { view: WebContentsView; bounds: AppCaptureRect; browserId: string | null; navigationId?: string }
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const intersects = (a: AppCaptureRect, b: AppCaptureRect) => a.x < b.x + b.width && a.y < b.y + b.height && a.x + a.width > b.x && a.y + a.height > b.y
function unavailable(message: string): never { throw new AgentMuxError(message + ' Original workfaces, input and Agents remain available.', 'APP_CAPTURE_UNAVAILABLE') }
function frameChanged(message: string): never { throw new AgentMuxError(message + ' This frame was discarded; the original document remains available for a new observation.', 'APP_CAPTURE_FRAME_CHANGED') }

/** Read-only pixel owner. The original window and child views keep focus and input. */
export class AppCaptureSource {
  constructor(private readonly windows: Pick<WorkbenchWindows, 'windowForDocument'>,
    private readonly browsers: Pick<BrowserViewManager, 'captureWorkbenchViews'>) {}

  private layers(window: BrowserWindow): Layer[] {
    const browsers = new Map(this.browsers.captureWorkbenchViews(window).map(entry => [entry.view, entry]))
    return window.contentView.children.flatMap(child => {
      const view = child as WebContentsView
      if (!('webContents' in view) || view.webContents === window.webContents || view.webContents.isDestroyed() || !view.getVisible()) return []
      const bounds = view.getBounds()
      if (bounds.width <= 0 || bounds.height <= 0) return []
      const browser = browsers.get(view)
      return [{ view, bounds, browserId: browser?.browserId ?? null, ...(browser ? { navigationId: browser.navigationId } : {}) }]
    })
  }

  private async crop(window: BrowserWindow, target: AppCaptureTarget): Promise<AppCaptureRect> {
    const [width, height] = window.getContentSize()
    if (!target.region) return { x: 0, y: 0, width: width!, height: height! }
    const r = target.region, reference = `primary:${JSON.stringify([r.displayWorkspaceId, r.groupId, r.tabId, r.regionId])}`
    // StableWorkbenchView publishes this exact original occurrence identity. No display
    // prose, selectors supplied by a caller, or screen coordinates establish a target.
    const code = `(() => {
      const matches = [...document.querySelectorAll('[data-workbench-region-reference]')]
        .filter(e => e.dataset.workbenchRegionReference === ${JSON.stringify(reference)} &&
          !e.closest('[hidden], [inert]') && e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));
      if (matches.length !== 1) return null;
      const r = matches[0].getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.left < 0 || r.top < 0 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) return null;
      return {x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height)};
    })()`
    const crop = await window.webContents.executeJavaScriptInIsolatedWorld(998, [{ code }]) as AppCaptureRect | null
    if (!crop || crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > width! || crop.y + crop.height > height!) {
      unavailable('The exact Region occurrence is not currently presented in this document; navigate it explicitly, then capture again.')
    }
    return crop
  }

  async capture(raw: AppCaptureTarget): Promise<AppCaptureFrame> {
    const target = parseAppCaptureTarget(raw), startedAt = Date.now()
    const window = this.windows.windowForDocument(target)
    if (window.isDestroyed() || window.webContents.isDestroyed() || window.isMinimized() || !window.isVisible()) {
      unavailable('The original window is hidden, minimized or unavailable; its current pixels are unconfirmed.')
    }
    const contents = window.webContents, crop = await this.crop(window, target), size = window.getContentSize()
    const width = crop.width, height = crop.height
    if (width <= 0 || height <= 0 || width * height > APP_CAPTURE_LIMITS.maxPixels) unavailable('This window exceeds the capture pixel memory budget.')
    const layers = this.layers(window).filter(layer => intersects(layer.bounds, crop))
    const verify = () => {
      if (this.windows.windowForDocument(target) !== window || window.isDestroyed() || contents.isDestroyed() ||
        !window.isVisible() || window.isMinimized()) unavailable('The original capture document is no longer presented during observation.')
      if (!equal(size, window.getContentSize())) frameChanged('The original window resized during this frame.')
      const current = this.layers(window).filter(layer => intersects(layer.bounds, crop))
      if (current.length !== layers.length || layers.some((layer, i) => layer.view !== current[i]?.view ||
        layer.navigationId !== current[i]?.navigationId || !equal(layer.bounds, current[i]?.bounds))) frameChanged('The native capture layers changed during observation.')
    }
    verify()
    const image = await contents.capturePage(crop, { stayHidden: true, stayAwake: true }); verify()
    const base = image.resize({ width, height }).toBitmap({ scaleFactor: 1 })
    if (base.length !== width * height * 4) unavailable('The original Renderer returned unexpected pixel dimensions.')
    for (const layer of layers) {
      const b = layer.bounds
      const left = Math.max(crop.x, b.x), right = Math.min(crop.x + width, b.x + b.width)
      const top = Math.max(crop.y, b.y), bottom = Math.min(crop.y + height, b.y + b.height)
      const clip = { x: left - b.x, y: top - b.y, width: right - left, height: bottom - top }
      const pixels = await layer.view.webContents.capturePage(clip, { stayHidden: true, stayAwake: true }); verify()
      const source = pixels.resize({ width: clip.width, height: clip.height }).toBitmap({ scaleFactor: 1 })
      if (source.length !== clip.width * clip.height * 4) unavailable('A native view returned unexpected pixel dimensions.')
      const sourceWords = new Uint32Array(source.buffer, source.byteOffset, source.length / 4)
      const baseWords = new Uint32Array(base.buffer, base.byteOffset, base.length / 4)
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const sourceIndex = (y - top) * clip.width + x - left, baseIndex = (y - crop.y) * width + x - crop.x
          const from = sourceIndex * 4, to = baseIndex * 4, alphaByte = source[from + 3]!
          if (alphaByte === 255) { baseWords[baseIndex] = sourceWords[sourceIndex]!; continue }
          if (alphaByte === 0) continue
          const alpha = alphaByte / 255
          // NativeImage bitmaps use premultiplied BGRA on this Electron platform.
          for (let c = 0; c < 3; c++) base[to + c] = Math.min(255, Math.round(source[from + c]! + base[to + c]! * (1 - alpha)))
          base[to + 3] = Math.min(255, Math.round(source[from + 3]! + base[to + 3]! * (1 - alpha)))
        }
      }
    }
    verify()
    if (!equal(crop, await this.crop(window, target))) frameChanged('The exact Region moved during capture; no stale crop was returned.')
    verify()
    const captured = nativeImage.createFromBitmap(base, { width, height, scaleFactor: 1 })
    const png = captured.toPNG(), dimensions = captured.getSize()
    return parseAppCaptureFrame({ target, startedAt, observedAt: Date.now(), bounds: crop, image: {
      format: 'png', data: png.toString('base64'), ...dimensions, scale: 1 }, layers: [
      { kind: 'renderer', webContentsId: contents.id, browserId: null, bounds: crop },
      ...layers.map(layer => ({ kind: layer.browserId ? 'browser' : 'renderer', webContentsId: layer.view.webContents.id,
        browserId: layer.browserId, bounds: layer.bounds }))] }, target)
  }
}
