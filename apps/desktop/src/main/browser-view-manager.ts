import { randomUUID } from 'node:crypto'
import { WebContentsView, type BrowserWindow } from 'electron'
import {
  BROWSER_VIEWPORT_PRESETS,
  type BrowserAnnotationMarker,
  type BrowserBounds,
  type BrowserElementRect,
  type BrowserElementSelection,
  type BrowserEvent,
  type BrowserScreenshotCapture,
  type BrowserSnapshot,
  type BrowserViewport
} from '../shared/contracts.js'
import { browserPngFromNativeImage } from './browser-image.js'
import { sanitizeBrowserElementSelection } from './browser-selection.js'
import {
  BROWSER_SELECTION_WORLD_ID,
  buildBrowserAnnotationMarkerScript,
  buildCancelBrowserAnnotationMarkerScript,
  buildBrowserElementSelectionScript,
  buildCancelBrowserElementSelectionScript
} from './browser-selection-script.js'

type BrowserEntry = {
  id: string
  view: WebContentsView
  requestedUrl: string
  navigationId: string
  selectionRevision: number
  selectionOperation: number | null
  annotationRevision: number
  viewport: BrowserViewport
  error: string | null
}

export const DEFAULT_BROWSER_ZOOM_FACTOR = 0.9
const BROWSER_SELECTION_TIMEOUT_MS = 120_000
const BROWSER_MARKER_MAX_COUNT = 50
const BROWSER_MARKER_MAX_COORDINATE = 10_000_000

export function assertAllowedBrowserUrl(value: string): string {
  if (value === 'about:blank') return value
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported browser URL protocol: ${url.protocol}`)
  }
  return url.toString()
}

export function normalizeBrowserUrl(value: string): string {
  const input = value.trim()
  if (!input || input === 'about:blank') return 'about:blank'
  if (/\s/.test(input) && !/^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(input)) {
    return `https://www.google.com/search?q=${encodeURIComponent(input)}`
  }
  const localAddress = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::|\/|$)/i.test(input)
  const hasProtocol = /^[A-Za-z][A-Za-z\d+.-]*:/.test(input)
  const withProtocol = localAddress ? `http://${input}` : hasProtocol ? input : `https://${input}`
  return assertAllowedBrowserUrl(withProtocol)
}

export class BrowserViewManager {
  private readonly entries = new Map<string, BrowserEntry>()

  constructor(private readonly window: BrowserWindow) {}

  async create(id: string, rawUrl: string): Promise<BrowserSnapshot> {
    if (!id.trim()) throw new Error('Browser id is required')
    if (this.entries.has(id)) throw new Error(`Browser already exists: ${id}`)
    const url = normalizeBrowserUrl(rawUrl)
    const view = new WebContentsView({
      webPreferences: {
        partition: 'persist:agentmux-browser',
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    })
    const entry: BrowserEntry = {
      id,
      view,
      requestedUrl: url,
      navigationId: randomUUID(),
      selectionRevision: 0,
      selectionOperation: null,
      annotationRevision: 0,
      viewport: 'responsive',
      error: null
    }
    this.entries.set(id, entry)
    this.window.contentView.addChildView(view)
    view.setVisible(false)
    view.webContents.session.setPermissionCheckHandler(() => false)
    view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    this.attach(entry)
    this.emit(entry)
    void view.webContents.loadURL(url).catch((error) => {
      if (!this.entries.has(id)) return
      entry.error = error instanceof Error ? error.message : String(error)
      this.emit(entry)
    })
    return this.snapshot(entry)
  }

  async navigate(id: string, rawUrl: string): Promise<BrowserSnapshot> {
    const entry = this.require(id)
    const url = normalizeBrowserUrl(rawUrl)
    entry.requestedUrl = url
    entry.error = null
    this.emit(entry)
    void entry.view.webContents.loadURL(url).catch((error) => {
      if (!this.entries.has(id)) return
      entry.error = error instanceof Error ? error.message : String(error)
      this.emit(entry)
    })
    return this.snapshot(entry)
  }

  async back(id: string): Promise<BrowserSnapshot> {
    const entry = this.require(id)
    if (entry.view.webContents.navigationHistory.canGoBack()) {
      entry.view.webContents.navigationHistory.goBack()
    }
    return this.snapshot(entry)
  }

  async forward(id: string): Promise<BrowserSnapshot> {
    const entry = this.require(id)
    if (entry.view.webContents.navigationHistory.canGoForward()) {
      entry.view.webContents.navigationHistory.goForward()
    }
    return this.snapshot(entry)
  }

  async reload(id: string): Promise<BrowserSnapshot> {
    const entry = this.require(id)
    entry.error = null
    entry.view.webContents.reload()
    return this.snapshot(entry)
  }

  openDevTools(id: string): void {
    this.require(id).view.webContents.openDevTools({ mode: 'detach', activate: true })
  }

  setViewport(id: string, viewport: BrowserViewport): BrowserSnapshot {
    const entry = this.require(id)
    if (!Object.hasOwn(BROWSER_VIEWPORT_PRESETS, viewport)) {
      throw new Error(`Unknown browser viewport: ${String(viewport)}`)
    }
    entry.viewport = viewport
    this.applyViewport(entry)
    this.emit(entry)
    return this.snapshot(entry)
  }

  async captureScreenshot(id: string): Promise<BrowserScreenshotCapture> {
    const entry = this.require(id)
    const navigationId = entry.navigationId
    const image = await entry.view.webContents.capturePage()
    if (
      this.entries.get(id) !== entry ||
      entry.view.webContents.isDestroyed() ||
      entry.navigationId !== navigationId
    ) {
      throw new Error('Browser page changed while the screenshot was being captured')
    }
    return {
      browserId: id,
      navigationId,
      image: browserPngFromNativeImage(image)
    }
  }

  async selectElement(id: string): Promise<BrowserElementSelection | null> {
    const entry = this.require(id)
    const navigationId = entry.navigationId
    entry.selectionOperation = null
    const preflightRevision = ++entry.selectionRevision
    await entry.view.webContents.executeJavaScriptInIsolatedWorld(
      BROWSER_SELECTION_WORLD_ID,
      [{ code: buildCancelBrowserElementSelectionScript(preflightRevision) }]
    )
    if (
      this.entries.get(id) !== entry ||
      entry.view.webContents.isDestroyed() ||
      entry.navigationId !== navigationId ||
      entry.selectionRevision !== preflightRevision
    ) {
      return null
    }
    const operation = ++entry.selectionRevision
    entry.selectionOperation = operation
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const raw = await Promise.race([
        entry.view.webContents.executeJavaScriptInIsolatedWorld(
          BROWSER_SELECTION_WORLD_ID,
          [{ code: buildBrowserElementSelectionScript(operation) }],
          true
        ),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Browser element selection timed out')), BROWSER_SELECTION_TIMEOUT_MS)
        })
      ])
      if (raw === null) return null
      if (
        this.entries.get(id) !== entry ||
        entry.view.webContents.isDestroyed() ||
        entry.navigationId !== navigationId ||
        entry.selectionOperation !== operation
      ) {
        throw new Error('Browser page changed while an element was being selected')
      }
      return {
        browserId: id,
        navigationId,
        ...sanitizeBrowserElementSelection(raw)
      }
    } finally {
      if (timeout) clearTimeout(timeout)
      if (entry.selectionOperation === operation) entry.selectionOperation = null
      if (this.entries.get(id) === entry && !entry.view.webContents.isDestroyed()) {
        void entry.view.webContents.executeJavaScriptInIsolatedWorld(
          BROWSER_SELECTION_WORLD_ID,
          [{ code: buildCancelBrowserElementSelectionScript(operation) }]
        ).catch(() => {})
      }
    }
  }

  async cancelElementSelection(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry || entry.view.webContents.isDestroyed()) return
    entry.selectionOperation = null
    const revision = ++entry.selectionRevision
    await entry.view.webContents.executeJavaScriptInIsolatedWorld(
      BROWSER_SELECTION_WORLD_ID,
      [{ code: buildCancelBrowserElementSelectionScript(revision) }]
    )
  }

  async setAnnotationMarkers(
    id: string,
    navigationId: string,
    markers: readonly BrowserAnnotationMarker[]
  ): Promise<void> {
    const entry = this.require(id)
    if (entry.navigationId !== navigationId) {
      return
    }
    if (!Array.isArray(markers) || markers.length > BROWSER_MARKER_MAX_COUNT) {
      throw new Error('Browser annotation marker count exceeds the limit')
    }
    const ids = new Set<string>()
    const indexes = new Set<number>()
    const normalized = Array.from(markers, (marker, index): BrowserAnnotationMarker => {
      if (
        !marker ||
        typeof marker.id !== 'string' ||
        !marker.id ||
        marker.id.length > 100 ||
        !Number.isInteger(marker.index) ||
        marker.index < 0 ||
        marker.index >= BROWSER_MARKER_MAX_COUNT ||
        typeof marker.isFixed !== 'boolean'
      ) {
        throw new Error(`Browser annotation marker ${index} is invalid`)
      }
      if (ids.has(marker.id) || indexes.has(marker.index)) {
        throw new Error(`Browser annotation marker ${index} duplicates an id or index`)
      }
      ids.add(marker.id)
      indexes.add(marker.index)
      return {
        id: marker.id,
        index: marker.index,
        isFixed: marker.isFixed,
        rectViewport: normalizeMarkerRect(marker.rectViewport),
        rectPage: normalizeMarkerRect(marker.rectPage)
      }
    })
    const revision = ++entry.annotationRevision
    await entry.view.webContents.executeJavaScriptInIsolatedWorld(
      BROWSER_SELECTION_WORLD_ID,
      [{ code: buildBrowserAnnotationMarkerScript(normalized, revision) }]
    )
    if (
      this.entries.get(id) !== entry ||
      entry.view.webContents.isDestroyed() ||
      entry.navigationId !== navigationId ||
      entry.annotationRevision !== revision
    ) {
      if (this.entries.get(id) === entry && !entry.view.webContents.isDestroyed()) {
        void entry.view.webContents.executeJavaScriptInIsolatedWorld(
          BROWSER_SELECTION_WORLD_ID,
          [{ code: buildCancelBrowserAnnotationMarkerScript(revision) }]
        ).catch(() => {})
      }
    }
  }

  setBounds(id: string, bounds: BrowserBounds | null): void {
    const entry = this.entries.get(id)
    if (!entry) return
    if (bounds === null) {
      entry.view.setVisible(false)
      return
    }
    const values = [bounds.x, bounds.y, bounds.width, bounds.height]
    if (values.some((value) => !Number.isFinite(value)) || bounds.width < 1 || bounds.height < 1) {
      throw new Error('Browser bounds must be finite with a positive size')
    }
    entry.view.setBounds({
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height))
    })
    entry.view.setVisible(true)
  }

  close(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    if (!entry.view.webContents.isDestroyed()) {
      entry.selectionOperation = null
      const selectionRevision = ++entry.selectionRevision
      const annotationRevision = ++entry.annotationRevision
      void entry.view.webContents.executeJavaScriptInIsolatedWorld(
        BROWSER_SELECTION_WORLD_ID,
        [{ code: buildCancelBrowserElementSelectionScript(selectionRevision) }]
      ).catch(() => {})
      void entry.view.webContents.executeJavaScriptInIsolatedWorld(
        BROWSER_SELECTION_WORLD_ID,
        [{ code: buildBrowserAnnotationMarkerScript([], annotationRevision) }]
      ).catch(() => {})
    }
    this.entries.delete(id)
    this.window.contentView.removeChildView(entry.view)
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close()
    this.send({ type: 'closed', id })
  }

  dispose(): void {
    for (const id of [...this.entries.keys()]) this.close(id)
  }

  private attach(entry: BrowserEntry): void {
    const contents = entry.view.webContents
    const guardNavigation = (event: { url: string; isMainFrame: boolean; preventDefault(): void }): void => {
      if (!event.isMainFrame) return
      try {
        assertAllowedBrowserUrl(event.url)
      } catch (error) {
        event.preventDefault()
        entry.error = error instanceof Error ? error.message : String(error)
        this.emit(entry)
      }
    }
    contents.setWindowOpenHandler(({ url }) => {
      void this.navigate(entry.id, url).catch((error) => {
        entry.error = error instanceof Error ? error.message : String(error)
        this.emit(entry)
      })
      return { action: 'deny' }
    })
    contents.on('will-navigate', guardNavigation)
    contents.on('will-redirect', guardNavigation)
    contents.on('did-finish-load', () => {
      contents.setZoomFactor(DEFAULT_BROWSER_ZOOM_FACTOR)
      this.applyViewport(entry)
    })
    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame) return
      entry.selectionOperation = null
      const selectionRevision = ++entry.selectionRevision
      const annotationRevision = ++entry.annotationRevision
      void contents.executeJavaScriptInIsolatedWorld(
        BROWSER_SELECTION_WORLD_ID,
        [{ code: buildCancelBrowserElementSelectionScript(selectionRevision) }]
      ).catch(() => {})
      void contents.executeJavaScriptInIsolatedWorld(
        BROWSER_SELECTION_WORLD_ID,
        [{ code: buildBrowserAnnotationMarkerScript([], annotationRevision) }]
      ).catch(() => {})
      entry.navigationId = randomUUID()
      entry.error = null
      this.emit(entry)
    })
    contents.on('did-start-loading', () => {
      entry.error = null
      this.emit(entry)
    })
    contents.on('did-stop-loading', () => this.emit(entry))
    contents.on('did-navigate', (_event, url) => {
      entry.requestedUrl = url
      entry.error = null
      this.emit(entry)
    })
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return
      entry.requestedUrl = url
      this.emit(entry)
    })
    contents.on('page-title-updated', () => this.emit(entry))
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      entry.requestedUrl = validatedURL || entry.requestedUrl
      entry.error = `${errorDescription} (${errorCode})`
      this.emit(entry)
    })
    contents.on('render-process-gone', (_event, details) => {
      entry.error = `Browser renderer stopped: ${details.reason}`
      this.emit(entry)
    })
    contents.once('destroyed', () => {
      if (!this.entries.delete(entry.id)) return
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(entry.view)
      this.send({ type: 'closed', id: entry.id })
    })
  }

  private require(id: string): BrowserEntry {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`Unknown browser: ${id}`)
    return entry
  }

  private applyViewport(entry: BrowserEntry): void {
    const contents = entry.view.webContents
    if (entry.viewport === 'responsive') {
      contents.disableDeviceEmulation()
      return
    }
    const size = BROWSER_VIEWPORT_PRESETS[entry.viewport]
    contents.enableDeviceEmulation({
      screenPosition: entry.viewport === 'desktop' ? 'desktop' : 'mobile',
      screenSize: size,
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 0,
      viewSize: size,
      scale: 1
    })
  }

  private snapshot(entry: BrowserEntry): BrowserSnapshot {
    const contents = entry.view.webContents
    return {
      id: entry.id,
      navigationId: entry.navigationId,
      url: contents.getURL() || entry.requestedUrl,
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      viewport: entry.viewport,
      error: entry.error
    }
  }

  private emit(entry: BrowserEntry): void {
    if (!this.entries.has(entry.id) || entry.view.webContents.isDestroyed()) return
    this.send({ type: 'updated', browser: this.snapshot(entry) })
  }

  private send(event: BrowserEvent): void {
    if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed()) {
      this.window.webContents.send('agentmux:browser-event', event)
    }
  }
}

function normalizeMarkerRect(value: BrowserElementRect): BrowserElementRect {
  if (
    !value ||
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y) ||
    !Number.isFinite(value.width) ||
    !Number.isFinite(value.height) ||
    value.width < 0 ||
    value.height < 0
  ) {
    throw new Error('Browser annotation marker geometry is invalid')
  }
  return {
    x: Math.min(BROWSER_MARKER_MAX_COORDINATE, Math.max(-BROWSER_MARKER_MAX_COORDINATE, value.x)),
    y: Math.min(BROWSER_MARKER_MAX_COORDINATE, Math.max(-BROWSER_MARKER_MAX_COORDINATE, value.y)),
    width: Math.min(BROWSER_MARKER_MAX_COORDINATE, value.width),
    height: Math.min(BROWSER_MARKER_MAX_COORDINATE, value.height)
  }
}
