import { WebContentsView, type BrowserWindow } from 'electron'
import type { BrowserBounds } from '../shared/contracts.js'
import { normalizeBrowserBounds } from '../shared/browser-bounds.js'
import { boundsOverlap, NATIVE_OVERLAY_LIMIT, NATIVE_OVERLAY_PIXEL_LIMIT, type NativeBrowserPointer, type NativeOverlayReceipt, type NativeOverlayRegion } from '../shared/native-overlay.js'

const CHROME_DOCUMENT = 'data:text/html,' + encodeURIComponent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}img{display:block;width:100%;height:100%;pointer-events:none}</style><img alt="" aria-hidden="true">')

interface Projection {
  view: WebContentsView
  ready: Promise<void>
  region: NativeOverlayRegion
  revision: number
  framePending: boolean
  paintStage: string
  interactive: boolean
  throttlingSynchronized: boolean
}

async function boundedChromePaint(work: Promise<void>, budget = 1500): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Native Chrome frame was not ready within ${budget}ms`)), budget)
    })])
  } finally { clearTimeout(timer) }
}

/** One native Chrome layer; the original Renderer retains every handler, focus target and ARIA node. */
export class NativeOverlaySurfaces {
  private readonly projections = new Map<string, Projection>()
  private disposed = false
  private requested: NativeOverlayRegion[] = []
  private generation = 0
  constructor(private readonly window: BrowserWindow, private readonly visibleBrowsers: () => BrowserBounds[], private readonly onWarning: (warning: string) => void,
    private readonly onBrowserPointer: (point: NativeBrowserPointer) => void) {}

  forwardBrowserPointer(bounds: BrowserBounds, input: Electron.InputEvent): void {
    if (!this.requested.length || this.disposed || this.window.webContents.isDestroyed() || input.type !== 'mouseDown') return
    const pointer = input as Electron.MouseInputEvent
    if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y) || pointer.x < 0 || pointer.y < 0 || pointer.x >= bounds.width || pointer.y >= bounds.height) return
    const x = bounds.x + pointer.x, y = bounds.y + pointer.y
    // Projected content owns its own input. Only the still-operable page sends outside dismissal.
    if ([...this.projections.values()].some(projection => {
      const box = projection.region.bounds
      return x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height
    })) return
    const zoom = this.window.webContents.getZoomFactor()
    try {
      this.onBrowserPointer({ x: x / zoom, y: y / zoom, button: pointer.button === 'right' ? 2 : pointer.button === 'middle' ? 1 : 0 })
    } catch {
      this.onWarning('The native page input reached the Browser, but its outside-click notice could not reach the floating panel. The Browser remains available; close the panel with Escape or its original control.')
    }
  }

  async update(input: NativeOverlayRegion[]): Promise<NativeOverlayReceipt> {
    if (this.disposed) return { projected: 0, capturedPixels: 0 }
    if (!Array.isArray(input) || input.length > NATIVE_OVERLAY_LIMIT) throw new Error('Invalid native chrome region budget')
    const generation = ++this.generation
    if (!input.length) {
      this.requested = []
      for (const [id, projection] of this.projections) this.remove(id, projection)
      return { projected: 0, capturedPixels: 0 }
    }
    const { width, height } = this.window.getContentBounds()
    const browsers = this.visibleBrowsers()
    const regions: NativeOverlayRegion[] = []
    let capturedPixels = 0
    for (const region of input) {
      const bounds = normalizeBrowserBounds(region.bounds)
      if (!bounds || !/^chrome-\d+$/.test(region.id) || !Number.isFinite(region.radius) || region.radius < 0) throw new Error('Invalid native chrome geometry')
      bounds.width = Math.min(bounds.width, width - bounds.x)
      bounds.height = Math.min(bounds.height, height - bounds.y)
      if (bounds.width <= 0 || bounds.height <= 0 || !browsers.some(browser => boundsOverlap(browser, bounds))) continue
      if (region.scrim !== undefined && !/^rgba?\([\d.,%\s]+\)$/.test(region.scrim)) throw new Error('Invalid native chrome scrim')
      if (region.scrim === undefined) capturedPixels += bounds.width * bounds.height
      if (capturedPixels > NATIVE_OVERLAY_PIXEL_LIMIT) throw new Error('Invalid native chrome pixel budget')
      regions.push({ ...region, bounds })
    }
    this.requested = input.map(region => ({ ...region, bounds: { ...region.bounds } }))
    const current = new Set(regions.map(region => region.id))
    for (const [id, projection] of this.projections) if (!current.has(id)) this.remove(id, projection)
    const warnings: string[] = []
    for (const region of regions) {
      if (generation !== this.generation || this.disposed) break
      let projection = this.projections.get(region.id)
      if (!projection) {
        const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
        view.setBackgroundColor('#00000000')
        view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        view.webContents.on('will-navigate', event => event.preventDefault())
        // Establish the native owner and actual rectangle before navigation starts.
        // Load completion remains distinct from a usable compositor surface.
        this.window.contentView.addChildView(view)
        view.setBounds(region.bounds)
        view.setVisible(true)
        // A first native Renderer startup is a different boundary from an already loaded frame.
        // Keep both bounded, without treating cold process startup as a failed compositor frame.
        projection = { view, region, ready: boundedChromePaint(view.webContents.loadURL(CHROME_DOCUMENT), 5000), revision: 0, framePending: false, paintStage: 'Chrome document', interactive: false, throttlingSynchronized: false }
        this.projections.set(region.id, projection)
        const owner = projection
        view.webContents.on('input-event', (_event, input) => this.forward(owner, input))
      }
      projection.region = region
      projection.interactive = false
      try {
        projection.paintStage = 'Chrome geometry'
        // CSS pixels scaled by UI zoom can be fractional; the native View takes integer pixels.
        projection.view.setBorderRadius(Math.round(region.radius))
        this.window.contentView.addChildView(projection.view)
        await projection.ready
        await boundedChromePaint(this.paint(projection))
        if (this.current(projection) && generation === this.generation) projection.interactive = true
      } catch (error) {
        if (generation !== this.generation || !this.current(projection)) continue
        const cause = error instanceof Error ? error.message.slice(0, 160) : 'Unknown native frame failure'
        warnings.push(`Native floating content could not be painted (${projection.paintStage}: ${cause}). The Browser remains available; close and reopen the floating panel.`)
        this.remove(region.id, projection)
      }
    }
    return { projected: this.projections.size, capturedPixels, ...(warnings.length ? { warning: warnings[0] } : {}) }
  }

  async refresh(): Promise<NativeOverlayReceipt> {
    // Geometry changes while no portal exists do zero capture/native allocation work.
    if (!this.requested.length) return { projected: 0, capturedPixels: 0 }
    return await this.update(this.requested)
  }

  dispose(): void {
    this.disposed = true
    this.requested = []
    ++this.generation
    for (const [id, projection] of this.projections) this.remove(id, projection)
  }

  resourceProcessIds(): number[] {
    return [...new Set([...this.projections.values()].filter(projection => !projection.view.webContents.isDestroyed())
      .map(projection => projection.view.webContents.getOSProcessId()).filter(pid => pid > 0))]
  }

  private async paint(projection: Projection): Promise<void> {
    const revision = ++projection.revision
    projection.paintStage = 'Chrome document'
    await projection.ready
    if (!this.current(projection) || revision !== projection.revision) return
    // Reapply the current rectangle for any pending native layout. Equal bounds do not
    // guarantee compositor invalidation or prove that the first frame is available.
    projection.view.setBounds(projection.view.getBounds())
    if (projection.region.scrim !== undefined) {
      await projection.view.webContents.executeJavaScript(`document.body.style.backgroundColor=${JSON.stringify(projection.region.scrim)}`)
      this.finishLoadedPaint(projection, revision)
      return
    }
    // This is the original Chrome only: WebContents.capturePage excludes its native Browser siblings.
    projection.paintStage = 'Original Chrome frame'
    const image = await this.window.webContents.capturePage(projection.region.bounds)
    if (!this.current(projection) || revision !== projection.revision) return
    if (image.isEmpty()) throw new Error('Empty native Chrome frame')
    const png = image.toPNG()
    if (png.length > 8 * 1024 * 1024) throw new Error('Native Chrome frame exceeds byte budget')
    projection.paintStage = 'Chrome image'
    await projection.view.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const image=document.querySelector('img');image.onload=()=>resolve();image.onerror=()=>reject(new Error('Native Chrome image did not load'));image.src=${JSON.stringify(`data:image/png;base64,${png.toString('base64')}`)}})` )
    this.finishLoadedPaint(projection, revision)
  }

  private finishLoadedPaint(projection: Projection, revision: number): void {
    if (!this.current(projection) || revision !== projection.revision) return
    // Set the platform state explicitly once on the attached, loaded owner.
    // Document/image load and this call still do not prove a compositor frame.
    if (!projection.throttlingSynchronized) {
      projection.view.webContents.setBackgroundThrottling(false)
      projection.throttlingSynchronized = true
    }
    projection.view.setBounds(projection.region.bounds)
  }

  private forward(projection: Projection, input: Electron.InputEvent): void {
    if (!this.current(projection) || this.window.webContents.isDestroyed()) return
    if (!projection.interactive) return
    const event = input as Electron.MouseInputEvent | Electron.MouseWheelInputEvent | Electron.KeyboardInputEvent
    if ('x' in event && 'y' in event && Number.isFinite(event.x) && Number.isFinite(event.y)) {
      this.window.webContents.sendInputEvent({ ...event, x: event.x + projection.region.bounds.x, y: event.y + projection.region.bounds.y })
      if (event.type === 'mouseDown') this.window.webContents.focus()
    } else if (event.type === 'keyDown' || event.type === 'rawKeyDown' || event.type === 'keyUp' || event.type === 'char') {
      this.window.webContents.sendInputEvent(event)
    } else return
    // Related native hover/focus styles can change without a DOM mutation. One frame per projection,
    // driven only by actual input, never a window/session polling loop.
    if (!projection.framePending) {
      projection.framePending = true
      setTimeout(() => {
        projection.framePending = false
        if (this.current(projection) && projection.interactive) {
          const generation = this.generation
          const revision = projection.revision + 1
          void boundedChromePaint(this.paint(projection)).catch(() => {
            if (!this.current(projection) || generation !== this.generation || revision !== projection.revision) return
            this.onWarning('Native floating content could not be repainted. The Browser remains available; close and reopen the floating panel.')
            this.remove(projection.region.id, projection)
          })
        }
      }, 32)
    }
  }

  private current(projection: Projection): boolean {
    return !this.disposed && this.projections.get(projection.region.id) === projection && !projection.view.webContents.isDestroyed()
  }

  private remove(id: string, projection: Projection): void {
    ++projection.revision
    if (this.projections.get(id) === projection) this.projections.delete(id)
    // Closing this revoked owner can reject a document that geometry failure never awaited.
    // Consume its terminal result without delaying cleanup or changing the original warning.
    void projection.ready.catch(() => {})
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(projection.view)
    if (!projection.view.webContents.isDestroyed()) projection.view.webContents.close()
  }
}
