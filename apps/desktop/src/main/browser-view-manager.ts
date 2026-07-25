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
  profileId: string
  requestedUrl: string
  navigationId: string
  selectionRevision: number
  selectionOperation: number | null
  annotationRevision: number
  switchRevision: number
  pendingSwitch: PendingProfileSwitch | null
  bounds: BrowserBounds | null
  visible: boolean
  viewport: BrowserViewport
  error: string | null
}

type PendingProfileSwitch = {
  token: number
  profileId: string
  view: WebContentsView
  rejectCancellation(error: Error): void
  attached: boolean
  released: boolean
}

export interface BrowserProfileResolver {
  defaultProfileId(): string
  resolvePartition(profileId: string): string
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

  constructor(
    private readonly window: BrowserWindow,
    private readonly profiles: BrowserProfileResolver
  ) {}

  async create(id: string, rawUrl: string): Promise<BrowserSnapshot> {
    if (!id.trim()) throw new Error('Browser id is required')
    if (this.entries.has(id)) throw new Error(`Browser already exists: ${id}`)
    const url = normalizeBrowserUrl(rawUrl)
    const profileId = this.profiles.defaultProfileId()
    const view = this.createView(this.resolvePartition(profileId))
    const entry: BrowserEntry = {
      id,
      view,
      profileId,
      requestedUrl: url,
      navigationId: randomUUID(),
      selectionRevision: 0,
      selectionOperation: null,
      annotationRevision: 0,
      switchRevision: 0,
      pendingSwitch: null,
      bounds: null,
      visible: false,
      viewport: 'responsive',
      error: null
    }
    this.entries.set(id, entry)
    this.window.contentView.addChildView(view)
    view.setVisible(false)
    this.attach(entry, view)
    this.emit(entry)
    void view.webContents.loadURL(url).catch((error) => {
      if (!this.owns(entry, view)) return
      entry.error = error instanceof Error ? error.message : String(error)
      this.emit(entry)
    })
    return this.snapshot(entry)
  }

  async navigate(id: string, rawUrl: string): Promise<BrowserSnapshot> {
    const entry = this.require(id)
    const url = normalizeBrowserUrl(rawUrl)
    this.cancelPendingSwitch(entry, new Error('Browser profile switch was superseded by navigation'))
    const view = entry.view
    entry.requestedUrl = url
    entry.error = null
    this.emit(entry)
    void view.webContents.loadURL(url).catch((error) => {
      if (!this.owns(entry, view)) return
      entry.error = error instanceof Error ? error.message : String(error)
      this.emit(entry)
    })
    return this.snapshot(entry)
  }

  async back(id: string): Promise<BrowserSnapshot> {
    const entry = this.require(id)
    this.cancelPendingSwitch(entry, new Error('Browser profile switch was superseded by navigation'))
    if (entry.view.webContents.navigationHistory.canGoBack()) {
      entry.view.webContents.navigationHistory.goBack()
    }
    return this.snapshot(entry)
  }

  async forward(id: string): Promise<BrowserSnapshot> {
    const entry = this.require(id)
    this.cancelPendingSwitch(entry, new Error('Browser profile switch was superseded by navigation'))
    if (entry.view.webContents.navigationHistory.canGoForward()) {
      entry.view.webContents.navigationHistory.goForward()
    }
    return this.snapshot(entry)
  }

  async reload(id: string): Promise<BrowserSnapshot> {
    const entry = this.require(id)
    this.cancelPendingSwitch(entry, new Error('Browser profile switch was superseded by reload'))
    entry.error = null
    entry.view.webContents.reload()
    return this.snapshot(entry)
  }

  async switchProfile(id: string, profileId: string): Promise<BrowserSnapshot> {
    const entry = this.require(id)
    const partition = this.resolvePartition(profileId)
    this.cancelPendingSwitch(entry, new Error('Browser profile switch was superseded'))
    if (entry.profileId === profileId) return this.snapshot(entry)

    const authoritativeView = entry.view
    const url = assertAllowedBrowserUrl(authoritativeView.webContents.getURL() || entry.requestedUrl)
    const candidate = this.createView(partition)
    candidate.setVisible(false)
    let rejectCancellation!: (error: Error) => void
    const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject })
    const pending: PendingProfileSwitch = {
      token: ++entry.switchRevision,
      profileId,
      view: candidate,
      rejectCancellation,
      attached: false,
      released: false
    }

    let committed = false
    try {
      entry.pendingSwitch = pending
      this.window.contentView.addChildView(candidate)
      pending.attached = true
      this.attach(entry, candidate)
      await Promise.race([candidate.webContents.loadURL(url), cancellation])
      if (
        this.entries.get(id) !== entry ||
        entry.view !== authoritativeView ||
        entry.pendingSwitch !== pending ||
        entry.switchRevision !== pending.token ||
        authoritativeView.webContents.isDestroyed() ||
        candidate.webContents.isDestroyed()
      ) {
        throw new Error('Browser profile switch was superseded')
      }

      const zoomFactor = authoritativeView.webContents.getZoomFactor()
      candidate.webContents.setZoomFactor(zoomFactor)
      this.applyViewport(entry, candidate)
      if (entry.bounds) candidate.setBounds(entry.bounds)
      candidate.setVisible(entry.visible)
      this.window.contentView.removeChildView(authoritativeView)

      entry.pendingSwitch = null
      entry.view = candidate
      entry.profileId = profileId
      entry.requestedUrl = candidate.webContents.getURL() || url
      entry.navigationId = randomUUID()
      entry.selectionOperation = null
      entry.selectionRevision += 1
      entry.annotationRevision += 1
      entry.error = null
      committed = true
      if (!authoritativeView.webContents.isDestroyed()) authoritativeView.webContents.close()
      this.emit(entry)
      return this.snapshot(entry)
    } finally {
      if (!committed) {
        if (entry.pendingSwitch === pending) {
          entry.pendingSwitch = null
          entry.switchRevision += 1
        }
        this.releasePendingSwitch(pending)
      }
    }
  }

  openDevTools(id: string): void {
    this.require(id).view.webContents.openDevTools({ mode: 'detach', activate: true })
  }

  usesProfile(profileId: string): boolean {
    return [...this.entries.values()].some((entry) => (
      entry.profileId === profileId || entry.pendingSwitch?.profileId === profileId
    ))
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
    const view = entry.view
    const navigationId = entry.navigationId
    const image = await view.webContents.capturePage()
    if (
      this.entries.get(id) !== entry ||
      entry.view !== view ||
      view.webContents.isDestroyed() ||
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
    const view = entry.view
    const navigationId = entry.navigationId
    entry.selectionOperation = null
    const preflightRevision = ++entry.selectionRevision
    await view.webContents.executeJavaScriptInIsolatedWorld(
      BROWSER_SELECTION_WORLD_ID,
      [{ code: buildCancelBrowserElementSelectionScript(preflightRevision) }]
    )
    if (
      this.entries.get(id) !== entry ||
      entry.view !== view ||
      view.webContents.isDestroyed() ||
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
        view.webContents.executeJavaScriptInIsolatedWorld(
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
        entry.view !== view ||
        view.webContents.isDestroyed() ||
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
      if (this.entries.get(id) === entry && entry.view === view && !view.webContents.isDestroyed()) {
        void view.webContents.executeJavaScriptInIsolatedWorld(
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
    const view = entry.view
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
    await view.webContents.executeJavaScriptInIsolatedWorld(
      BROWSER_SELECTION_WORLD_ID,
      [{ code: buildBrowserAnnotationMarkerScript(normalized, revision) }]
    )
    if (
      this.entries.get(id) !== entry ||
      entry.view !== view ||
      view.webContents.isDestroyed() ||
      entry.navigationId !== navigationId ||
      entry.annotationRevision !== revision
    ) {
      if (this.entries.get(id) === entry && entry.view === view && !view.webContents.isDestroyed()) {
        void view.webContents.executeJavaScriptInIsolatedWorld(
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
      entry.visible = false
      entry.view.setVisible(false)
      return
    }
    const values = [bounds.x, bounds.y, bounds.width, bounds.height]
    if (values.some((value) => !Number.isFinite(value)) || bounds.width < 1 || bounds.height < 1) {
      throw new Error('Browser bounds must be finite with a positive size')
    }
    entry.bounds = {
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height))
    }
    entry.visible = true
    entry.view.setBounds(entry.bounds)
    entry.view.setVisible(true)
  }

  close(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.cancelPendingSwitch(entry, new Error('Browser closed during profile switch'))
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

  private attach(entry: BrowserEntry, view: WebContentsView): void {
    const contents = view.webContents
    const guardNavigation = (event: { url: string; isMainFrame: boolean; preventDefault(): void }): void => {
      if (!event.isMainFrame) return
      try {
        assertAllowedBrowserUrl(event.url)
      } catch (error) {
        event.preventDefault()
        if (!this.owns(entry, view)) return
        entry.error = error instanceof Error ? error.message : String(error)
        this.emit(entry)
      }
    }
    contents.on('will-navigate', guardNavigation)
    contents.on('will-redirect', guardNavigation)
    contents.on('did-finish-load', () => {
      if (!this.owns(entry, view)) return
      contents.setZoomFactor(DEFAULT_BROWSER_ZOOM_FACTOR)
      this.applyViewport(entry, view)
    })
    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || !this.owns(entry, view)) return
      this.cancelPendingSwitch(entry, new Error('Browser profile switch was superseded by navigation'))
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
      if (!this.owns(entry, view)) return
      entry.error = null
      this.emit(entry)
    })
    contents.on('did-stop-loading', () => {
      if (!this.owns(entry, view)) return
      this.emit(entry)
    })
    contents.on('did-navigate', (_event, url) => {
      if (!this.owns(entry, view)) return
      entry.requestedUrl = url
      entry.error = null
      this.emit(entry)
    })
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame || !this.owns(entry, view)) return
      entry.requestedUrl = url
      this.emit(entry)
    })
    contents.on('page-title-updated', () => {
      if (!this.owns(entry, view)) return
      this.emit(entry)
    })
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 || !this.owns(entry, view)) return
      entry.requestedUrl = validatedURL || entry.requestedUrl
      entry.error = `${errorDescription} (${errorCode})`
      this.emit(entry)
    })
    contents.on('render-process-gone', (_event, details) => {
      if (!this.owns(entry, view)) return
      entry.error = `Browser renderer stopped: ${details.reason}`
      this.emit(entry)
    })
    contents.once('destroyed', () => {
      if (entry.pendingSwitch?.view === view) {
        this.cancelPendingSwitch(entry, new Error('Browser profile candidate was destroyed'))
        return
      }
      if (!this.owns(entry, view)) return
      this.cancelPendingSwitch(entry, new Error('Browser closed during profile switch'))
      if (this.entries.get(entry.id) !== entry || entry.view !== view) return
      this.entries.delete(entry.id)
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view)
      this.send({ type: 'closed', id: entry.id })
    })
  }

  private require(id: string): BrowserEntry {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`Unknown browser: ${id}`)
    return entry
  }

  private createView(partition: string): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    })
    view.webContents.session.setPermissionCheckHandler(() => false)
    view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    return view
  }

  private resolvePartition(profileId: string): string {
    if (!profileId.trim()) throw new Error('Browser profile id is required')
    const partition = this.profiles.resolvePartition(profileId)
    if (!partition.trim()) throw new Error(`Browser profile has no partition: ${profileId}`)
    return partition
  }

  private owns(entry: BrowserEntry, view: WebContentsView): boolean {
    return this.entries.get(entry.id) === entry && entry.view === view
  }

  private cancelPendingSwitch(entry: BrowserEntry, error: Error): void {
    entry.switchRevision += 1
    const pending = entry.pendingSwitch
    if (!pending) return
    entry.pendingSwitch = null
    pending.rejectCancellation(error)
    this.releasePendingSwitch(pending)
  }

  private releasePendingSwitch(pending: PendingProfileSwitch): void {
    if (pending.released) return
    pending.released = true
    if (pending.attached && !this.window.isDestroyed()) {
      this.window.contentView.removeChildView(pending.view)
      pending.attached = false
    }
    if (!pending.view.webContents.isDestroyed()) pending.view.webContents.close()
  }

  private applyViewport(entry: BrowserEntry, view = entry.view): void {
    const contents = view.webContents
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
      profileId: entry.profileId,
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
    if (this.entries.get(entry.id) !== entry || entry.view.webContents.isDestroyed()) return
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
