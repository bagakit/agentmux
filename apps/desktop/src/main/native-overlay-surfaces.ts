import { WebContentsView, type BrowserWindow } from 'electron'
import type { BrowserBounds } from '../shared/contracts.js'
import { normalizeBrowserBounds } from '../shared/browser-bounds.js'
import { boundsOverlap, NATIVE_OVERLAY_LIMIT, NATIVE_OVERLAY_PIXEL_LIMIT, type NativeBrowserInput, type NativeOverlayReceipt, type NativeOverlayRegion } from '../shared/native-overlay.js'
import type { BrowserViewManager, NativeBrowserOwner, NativeBrowserPageInput } from './browser-view-manager.js'

const CHROME_DOCUMENT = 'data:text/html,' + encodeURIComponent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}img,svg{display:block;width:100%;height:100%;pointer-events:none}svg{display:none}</style><img alt="" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg"><defs><mask id="chrome-clear" maskUnits="userSpaceOnUse"></mask></defs><path mask="url(#chrome-clear)"/></svg>')
const contains = (outer: BrowserBounds, inner: BrowserBounds): boolean => inner.x >= outer.x && inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height
const atPoint = (bounds: BrowserBounds, x: number, y: number): boolean => x >= bounds.x && y >= bounds.y && x < bounds.x + bounds.width && y < bounds.y + bounds.height


interface Projection {
  view: WebContentsView
  ready: Promise<void>
  region: NativeOverlayRegion
  revision: number
  framePending: boolean
  paintStage: string
  interactive: boolean
  throttlingSynchronized: boolean
  pressedButtons: Set<'leftbuttondown' | 'middlebuttondown' | 'rightbuttondown'>
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
  private readonly inputGuards = new Map<WebContentsView, () => void>()
  constructor(private readonly window: BrowserWindow, private readonly browsers: Pick<BrowserViewManager, 'visibleNativeBounds' | 'nativeOwner' | 'nativeOwnerForView'>, private readonly onWarning: (warning: string, modalId?: string) => void,
    private readonly onBrowserInput: (input: NativeBrowserInput) => void) {}

  forwardBrowserInput(owner: NativeBrowserOwner, input: NativeBrowserPageInput): boolean {
    if (!this.requested.length || this.disposed || this.window.webContents.isDestroyed() || this.browsers.nativeOwner(owner.browserId)?.view !== owner.view) return false
    // An observed background page cannot dismiss a lower floating owner through Escape
    // while another modal owns the foreground. Its native before-event guard owns input.
    if (this.modalBlocks(owner.view, owner.browserId)) return input.type === 'escape'
    const projection = [...this.projections.values()].reverse().find(candidate => this.current(candidate) &&
      candidate.region.browserStages?.some(stage => this.containedOwner(candidate, stage)?.view === owner.view))
    try {
      if (input.type === 'escape') {
        if (!projection) return false
        this.onBrowserInput({ type: 'escape', browserId: owner.browserId, overlayId: projection.region.id })
        return true
      }
      const pointer = input.event
      if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) return false
      const x = owner.bounds.x + pointer.x, y = owner.bounds.y + pointer.y
      if (pointer.type !== 'mouseLeave') {
        if (!atPoint(owner.bounds, x, y)) return false
        // CDP and other native producers also emit input-event. Never relay an action from a
        // page covered by another actual native owner, even when the source Browser is alive.
        const topmost = [...this.window.contentView.children].reverse().find(view => view.getVisible() && atPoint(view.getBounds(), x, y))
        if (topmost !== owner.view) return false
      }
      const zoom = this.window.webContents.getZoomFactor()
      this.onBrowserInput({ type: pointer.type === 'mouseDown' ? 'pointerDown' : pointer.type === 'mouseLeave' ? 'pointerLeave' : 'pointerMove',
        browserId: owner.browserId, ...(projection ? { overlayId: projection.region.id } : {}),
        x: x / zoom, y: y / zoom, button: pointer.button === 'right' ? 2 : pointer.button === 'middle' ? 1 : 0 })
      return false
    } catch {
      this.onWarning('The native page input reached the Browser, but its floating-panel notice could not reach the original owner. The Browser remains available; close the panel with Escape or its original control.')
      return false
    }
  }

  async update(input: NativeOverlayRegion[]): Promise<NativeOverlayReceipt> {
    if (this.disposed) return { projected: 0, capturedPixels: 0 }
    if (!Array.isArray(input) || input.length > NATIVE_OVERLAY_LIMIT && !input.some(region => region.modal)) throw new Error('Invalid native chrome region budget')
    if (!input.length) {
      ++this.generation
      this.requested = []
      this.synchronizeInputGuards()
      for (const [id, projection] of this.projections) this.remove(id, projection)
      return { projected: 0, capturedPixels: 0 }
    }
    const { width, height } = this.window.getContentBounds()
    const browsers = this.browsers.visibleNativeBounds()
    const regions: NativeOverlayRegion[] = []
    const failures: NonNullable<NativeOverlayReceipt['failures']> = []
    const failed = new Set<string>()
    const omitted = new Set<string>()
    const warnings: string[] = []
    const fail = (modalId: string, message: string): void => {
      if (failed.has(modalId)) return
      failed.add(modalId)
      failures.push({ modalId, message })
      this.removeModal(modalId)
      this.onWarning(message, modalId)
    }
    let capturedPixels = 0
    for (const region of input) {
      const bounds = normalizeBrowserBounds(region.bounds)
      if (!bounds || !/^chrome-\d+$/.test(region.id) || !Number.isFinite(region.radius) || region.radius < 0) throw new Error('Invalid native chrome geometry')
      if (region.modal && (typeof region.modal.id !== 'string' || !region.modal.id.trim() || !['scrim', 'content'].includes(region.modal.part))) throw new Error('Invalid native modal declaration')
      bounds.width = Math.min(bounds.width, width - bounds.x)
      bounds.height = Math.min(bounds.height, height - bounds.y)
      if (bounds.width <= 0 || bounds.height <= 0 || !browsers.some(browser => boundsOverlap(browser, bounds))) continue
      if (region.scrim !== undefined && (typeof region.scrim !== 'string' || !region.scrim.trim() || region.scrim.length > 256)) throw new Error('Invalid native chrome scrim')
      if (region.browserStages !== undefined && (!Array.isArray(region.browserStages) || region.browserStages.some(stage =>
        typeof stage.browserId !== 'string' || !stage.browserId.trim() || !normalizeBrowserBounds(stage.bounds)))) throw new Error('Invalid native Browser stage declaration')
      regions.push({ ...region, bounds })
    }
    // Invalid geometry cannot cancel a previously accepted foreground preparation.
    const generation = ++this.generation
    this.requested = input.map(region => ({ ...region, bounds: { ...region.bounds } }))
    const units: NativeOverlayRegion[][] = []
    const modals = new Map<string, NativeOverlayRegion[]>()
    for (const region of regions) {
      if (!region.modal) { units.push([region]); continue }
      let unit = modals.get(region.modal.id)
      if (!unit) { unit = []; modals.set(region.modal.id, unit); units.push(unit) }
      unit.push(region)
    }
    let admitted = 0
    for (const unit of units) {
      const modalId = unit[0]!.modal?.id
      const declared = modalId ? input.filter(region => region.modal?.id === modalId) : []
      const cost = unit.reduce((sum, region) => sum + (region.scrim === undefined ? region.bounds.width * region.bounds.height : 0), 0)
      if (modalId && (declared.filter(region => region.modal?.part === 'content' && region.scrim === undefined).length !== 1 ||
        declared.filter(region => region.modal?.part === 'scrim' && region.scrim !== undefined).length !== 1)) {
        fail(modalId, 'The complete modal content and scrim were not available. Original Browser and pending action remain; reopen the confirmation.')
      } else if (admitted + unit.length > NATIVE_OVERLAY_LIMIT || capturedPixels + cost > NATIVE_OVERLAY_PIXEL_LIMIT) {
        if (modalId) fail(modalId, 'The modal exceeds the native chrome budget. Original Browser and pending action remain; reopen the confirmation in a smaller window.')
        else {
          omitted.add(unit[0]!.id)
          warnings.push('Floating content exceeds the native chrome budget. The Browser and original modal remain available; close an unused floating panel.')
        }
      } else { admitted += unit.length; capturedPixels += cost }
    }
    this.requested = this.requested.filter(region => !omitted.has(region.id) && (!region.modal || !failed.has(region.modal.id)))
    const current = new Set(regions.filter(region => !omitted.has(region.id) && (!region.modal || !failed.has(region.modal.id))).map(region => region.id))
    for (const [id, projection] of this.projections) if (!current.has(id)) this.remove(id, projection)
    // The original modal declaration is the input fact. Only its actual native Browser
    // attachments yield, including while the first foreground frame is being prepared.
    this.synchronizeInputGuards()
    for (const unit of units) {
      if (generation !== this.generation || this.disposed) break
      const modalId = unit[0]!.modal?.id
      if (omitted.has(unit[0]!.id) || modalId && failed.has(modalId)) continue
      const prepared: Projection[] = []
      try {
        for (const region of unit) {
          if (generation !== this.generation || this.disposed) break
          let projection = this.projections.get(region.id)
          if (!projection) {
            // Loading a projection must not claim the original input's focus.
            const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, focusOnNavigation: false } })
            view.setBackgroundColor('#00000000')
            view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
            view.webContents.on('will-navigate', event => event.preventDefault())
            view.setBounds(region.bounds)
            view.setVisible(true)
            // Cold Renderer startup has its own bounded preparation phase.
            projection = { view, region, ready: boundedChromePaint(view.webContents.loadURL(CHROME_DOCUMENT), 5000), revision: 0, framePending: false, paintStage: 'Chrome document', interactive: false, throttlingSynchronized: false, pressedButtons: new Set() }
            this.projections.set(region.id, projection)
            const owner = projection
            view.webContents.on('input-event', (_event, input) => this.forward(owner, input))
          }
          projection.region = region
          prepared.push(projection)
          const paintedBounds = projection.interactive ? projection.view.getBounds() : region.bounds
          // Repainting the same frame retains confirmed input. A moved frame waits
          // for paint, comparing actual geometry rather than an in-flight request.
          projection.interactive = projection.interactive && paintedBounds.x === region.bounds.x &&
            paintedBounds.y === region.bounds.y && paintedBounds.width === region.bounds.width && paintedBounds.height === region.bounds.height
          projection.paintStage = 'Chrome geometry'
          projection.view.setBorderRadius(Math.round(region.radius))
          await projection.ready
          await boundedChromePaint(this.paint(projection, Boolean(modalId)))
        }
        if (generation !== this.generation || this.disposed) continue
        // A required pair enters in one synchronous compositor commit. Cold members
        // stay offscreen and moved frames stay noninteractive until all are ready.
        for (const projection of prepared) if (this.current(projection)) {
          if (modalId) this.finishLoadedPaint(projection, projection.revision, false)
          projection.interactive = true
        }
        if (modalId) this.arrangeLayers()
      } catch (error) {
        if (generation !== this.generation || this.disposed) continue
        const cause = error instanceof Error ? error.message.slice(0, 160) : 'Unknown native frame failure'
        const message = `Native floating content could not be painted (${prepared.at(-1)?.paintStage ?? 'Chrome preparation'}: ${cause}). The Browser remains available; close and reopen the floating panel.`
        warnings.push(message)
        if (modalId) fail(modalId, message)
        else for (const projection of prepared) this.remove(projection.region.id, projection)
      }
    }
    return { projected: this.projections.size, capturedPixels, ...(warnings.length ? { warning: warnings[0] } : {}), ...(failures.length ? { failures } : {}) }
  }

  async refresh(): Promise<NativeOverlayReceipt> {
    // Geometry changes while no portal exists do zero capture/native allocation work.
    if (!this.requested.length) return { projected: 0, capturedPixels: 0 }
    return await this.update(this.requested)
  }

  dispose(): void {
    this.disposed = true
    this.requested = []
    this.synchronizeInputGuards()
    ++this.generation
    for (const [id, projection] of this.projections) this.remove(id, projection)
  }

  resourceProcessIds(): number[] {
    return [...new Set([...this.projections.values()].filter(projection => !projection.view.webContents.isDestroyed())
      .map(projection => projection.view.webContents.getOSProcessId()).filter(pid => pid > 0))]
  }

  // Native document blur precedes the sibling WebContents focus event. The containing
  // window owns departure; a current attached projection owns the original menu route.
  // Paint readiness gates forwarded input, not membership in that same native window.
  hasProjectionInFocusedWindow(): boolean {
    return !this.disposed && !this.window.isDestroyed() && this.window.isFocused() &&
      [...this.projections.values()].some(projection => this.current(projection) && projection.view.getVisible() &&
        this.window.contentView.children.includes(projection.view))
  }

  private async paint(projection: Projection, deferCommit = false): Promise<void> {
    const revision = ++projection.revision
    projection.paintStage = 'Chrome document'
    await projection.ready
    if (!this.current(projection) || revision !== projection.revision) return
    if (!this.window.contentView.children.includes(projection.view)) {
      projection.paintStage = 'Chrome attachment'
      // Initialize the drawable without covering or intercepting the original workface.
      // Only a prepared image is moved into its actual menu rectangle below.
      projection.view.setBounds({ ...projection.region.bounds, x: -projection.region.bounds.width, y: -projection.region.bounds.height })
      this.window.contentView.addChildView(projection.view)
    }
    // Reapply the current rectangle for any pending native layout. Equal bounds do not
    // guarantee compositor invalidation or prove that the first frame is available.
    projection.view.setBounds(projection.view.getBounds())
    if (projection.region.scrim !== undefined) {
      const bounds = projection.region.bounds
      // A single nonzero-fill path paints the union once, including overlapping pages.
      // Renderer chrome already has its own scrim and must not be darkened a second time.
      const path = this.browsers.visibleNativeBounds().flatMap(browser => {
        const x = Math.max(bounds.x, browser.x), y = Math.max(bounds.y, browser.y)
        const right = Math.min(bounds.x + bounds.width, browser.x + browser.width), bottom = Math.min(bounds.y + bounds.height, browser.y + browser.height)
        return right > x && bottom > y ? [`M${x - bounds.x},${y - bounds.y}h${right - x}v${bottom - y}h${x - right}Z`] : []
      }).join('')
      const clear = [`<rect width="${bounds.width}" height="${bounds.height}" fill="white"/>`]
      for (const region of this.requested) {
        if (region.id === projection.region.id) break
        const lower = this.projections.get(region.id)
        // Chrome capture already contains higher DOM scrims. Exclude its actual
        // opaque native coverage, keeping rounded corners on the Browser dimmed.
        if (lower && region.scrim === undefined && lower.interactive && this.current(lower) &&
          this.window.contentView.children.includes(lower.view)) {
          const box = lower.view.getBounds()
          clear.push(`<rect x="${box.x - bounds.x}" y="${box.y - bounds.y}" width="${box.width}" height="${box.height}" rx="${Math.round(region.radius)}" fill="black"/>`)
          for (const stage of region.browserStages ?? []) {
            const page = this.containedOwner(lower, stage)
            if (page) clear.push(`<rect x="${page.bounds.x - bounds.x}" y="${page.bounds.y - bounds.y}" width="${page.bounds.width}" height="${page.bounds.height}" fill="white"/>`)
          }
        }
      }
      await projection.view.webContents.executeJavaScript(`(() => { const colour=${JSON.stringify(projection.region.scrim)}; if(!CSS.supports('color',colour)) throw new Error('Invalid native scrim colour'); document.querySelector('img').style.display='none'; const svg=document.querySelector('svg'); svg.style.display='block'; svg.setAttribute('viewBox',${JSON.stringify(`0 0 ${bounds.width} ${bounds.height}`)}); const mask=svg.querySelector('mask'); mask.setAttribute('width',${JSON.stringify(String(bounds.width))}); mask.setAttribute('height',${JSON.stringify(String(bounds.height))}); mask.innerHTML=${JSON.stringify(clear.join(''))}; const path=svg.querySelector('path'); path.setAttribute('d',${JSON.stringify(path)}); path.style.fill=colour; })()`)
      if (!deferCommit) this.finishLoadedPaint(projection, revision)
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
    // Each in-flight frame owns its decoder. Replacing one shared img.onload could
    // strand an earlier preparation, and a late image must never replace newer pixels.
    await projection.view.webContents.executeJavaScript(`(async () => {
      const root = document.documentElement, revision = ${JSON.stringify(String(revision))};
      root.dataset.chromeRevision = revision;
      const image = new Image(); image.alt = ''; image.setAttribute('aria-hidden', 'true');
      image.src = ${JSON.stringify(`data:image/png;base64,${png.toString('base64')}`)};
      await image.decode();
      if (root.dataset.chromeRevision !== revision) return;
      document.querySelector('svg').style.display = 'none';
      document.querySelector('img').replaceWith(image);
    })()`)
    if (!deferCommit) this.finishLoadedPaint(projection, revision)
  }

  private finishLoadedPaint(projection: Projection, revision: number, arrange = true): void {
    if (!this.current(projection) || revision !== projection.revision) return
    projection.view.setBounds(projection.region.bounds)
    // Synchronize once on the actual attached owner, after document and image preparation.
    // Further paints reuse the same native attachment and its original input route.
    if (!projection.throttlingSynchronized) {
      projection.view.webContents.setBackgroundThrottling(false)
      projection.throttlingSynchronized = true
    }
    if (arrange) this.arrangeLayers()
  }

  private containedOwner(projection: Projection, stage: NonNullable<NativeOverlayRegion['browserStages']>[number]): NativeBrowserOwner | undefined {
    const declared = normalizeBrowserBounds(stage.bounds), owner = this.browsers.nativeOwner(stage.browserId)
    if (!declared || !owner || !contains(declared, owner.bounds) || !contains(projection.view.getBounds(), owner.bounds) ||
      !this.window.contentView.children.includes(owner.view)) return
    return owner
  }

  private removeModal(modalId: string): void {
    this.requested = this.requested.filter(region => region.modal?.id !== modalId)
    for (const [id, projection] of this.projections) if (projection.region.modal?.id === modalId) this.remove(id, projection)
    this.synchronizeInputGuards()
  }

  /** Modal input is a presentation fact, scoped to the exact attached background page. */
  private modalBlocks(view: WebContentsView, browserId: string): boolean {
    if (this.disposed || this.window.isDestroyed() || !view.getVisible() || !this.window.contentView.children.includes(view)) return false
    if (this.browsers.nativeOwner(browserId)?.view !== view) return false
    const modal = [...this.requested].reverse().find(region => region.modal?.part === 'content')
    const scrim = modal && this.requested.find(region => region.modal?.id === modal.modal!.id && region.modal?.part === 'scrim')
    if (!modal || !scrim || !boundsOverlap(scrim.bounds, view.getBounds())) return false
    // An original page intentionally hosted inside the top modal remains usable.
    return !modal.browserStages?.some(stage => {
      const owner = this.browsers.nativeOwner(stage.browserId)
      return owner?.view === view && contains(stage.bounds, owner.bounds) && contains(modal.bounds, owner.bounds)
    })
  }

  private synchronizeInputGuards(): void {
    const hasModal = !this.disposed && this.requested.some(region => region.modal)
    const chrome = new Set([...this.projections.values()].map(projection => projection.view))
    const pages = new Set(this.window.isDestroyed() || !hasModal ? [] : this.window.contentView.children.filter(candidate => {
      if (chrome.has(candidate as WebContentsView) || !('webContents' in candidate)) return false
      const view = candidate as WebContentsView
      if (view.webContents === this.window.webContents || view.webContents.isDestroyed() || !view.getVisible()) return false
      return this.browsers.nativeOwnerForView(view)?.view === view
    }) as WebContentsView[])
    for (const [view, release] of this.inputGuards) if (!pages.has(view)) { release(); this.inputGuards.delete(view) }
    for (const view of pages) if (!this.inputGuards.has(view)) {
      const owner = this.browsers.nativeOwnerForView(view)
      if (!owner) continue
      const prevent = (event: Electron.Event): void => { if (this.modalBlocks(view, owner.browserId)) event.preventDefault() }
      view.webContents.on('before-mouse-event', prevent)
      view.webContents.on('before-input-event', prevent)
      this.inputGuards.set(view, () => {
        if (view.webContents.isDestroyed()) return
        view.webContents.off('before-mouse-event', prevent)
        view.webContents.off('before-input-event', prevent)
      })
    }
  }

  private arrangeLayers(): void {
    if (this.disposed || this.window.isDestroyed()) return
    const layers = this.requested.flatMap(region => {
      const projection = this.projections.get(region.id)
      if (!projection || !this.current(projection) || !this.window.contentView.children.includes(projection.view)) return []
      const pages = projection.region.browserStages?.flatMap(stage => {
        const owner = this.containedOwner(projection, stage)
        return owner ? [owner.view] : []
      }) ?? []
      return [{ projection, pages: [...new Set(pages)] }]
    })
    const contained = new Set(layers.flatMap(layer => layer.pages))
    const chrome = new Set([...this.projections.values()].map(projection => projection.view))
    const background = this.window.contentView.children.filter(view => !chrome.has(view as WebContentsView) && !contained.has(view as WebContentsView) && view.getVisible())
    let previous = -1
    for (const { projection, pages } of layers) {
      // Original background pages stay put. Only a layer that is actually below an intersecting
      // page or its preceding float moves. A later popup can still cover an earlier float's page.
      let floor = previous
      for (const view of background) if (boundsOverlap(view.getBounds(), projection.view.getBounds())) floor = Math.max(floor, this.window.contentView.children.indexOf(view))
      if (this.window.contentView.children.indexOf(projection.view) <= floor) this.window.contentView.addChildView(projection.view)
      previous = this.window.contentView.children.indexOf(projection.view)
      for (const view of pages) {
        if (this.window.contentView.children.indexOf(view) <= previous) this.window.contentView.addChildView(view)
        previous = this.window.contentView.children.indexOf(view)
      }
    }
  }

  private forward(projection: Projection, input: Electron.InputEvent): void {
    if (!this.current(projection) || this.window.webContents.isDestroyed()) return
    let event = input as Electron.MouseInputEvent | Electron.MouseWheelInputEvent | Electron.KeyboardInputEvent
    const button = 'button' in event && event.button === 'left' ? 'leftbuttondown'
      : 'button' in event && event.button === 'middle' ? 'middlebuttondown'
      : 'button' in event && event.button === 'right' ? 'rightbuttondown' : undefined
    const continuingGesture = event.type === 'mouseMove' && projection.pressedButtons.size > 0
      || event.type === 'mouseUp' && button !== undefined && projection.pressedButtons.has(button)
    // A repaint cannot drop the release of a gesture already accepted by this owner.
    if (!projection.interactive && !continuingGesture) return
    if ('x' in event && 'y' in event && Number.isFinite(event.x) && Number.isFinite(event.y)) {
      // Native input-event omits mouse modifiers. Retain this owner's actual
      // button transitions so the next move does not end the original pointer capture.
      if (button && event.type === 'mouseDown') projection.pressedButtons.add(button)
      if (button && event.type === 'mouseUp') projection.pressedButtons.delete(button)
      if (event.type === 'mouseMove' && projection.pressedButtons.size) {
        event = { ...event, modifiers: [...new Set([...(event.modifiers ?? []), ...projection.pressedButtons])] }
      }
      const bounds = projection.view.getBounds()
      this.window.webContents.sendInputEvent({ ...event, x: event.x + bounds.x, y: event.y + bounds.y })
      if (event.type === 'mouseDown') this.window.webContents.focus()
    } else if (event.type === 'keyDown' || event.type === 'rawKeyDown' || event.type === 'keyUp' || event.type === 'char') {
      // Electron observes DOM key names but sendInputEvent requires an Accelerator.
      const { key } = input as Electron.Input
      const { modifiers = [] } = input
      const arrows: Record<string, string> = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' }
      // The real control may close and remove this focused image projection.
      this.window.webContents.focus()
      this.window.webContents.sendInputEvent({ type: event.type, keyCode: arrows[key] ?? key, modifiers })
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
            const message = 'Native floating content could not be repainted. The Browser remains available; close and reopen the floating panel.'
            const modalId = projection.region.modal?.id
            if (modalId) this.removeModal(modalId)
            else this.remove(projection.region.id, projection)
            this.onWarning(message, modalId)
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
