import { WebContentsView, type BrowserWindow } from 'electron'
import type { BrowserBounds, BrowserEvent, BrowserSnapshot } from '../shared/contracts.js'

type BrowserEntry = {
  id: string
  view: WebContentsView
  requestedUrl: string
  error: string | null
}

export const DEFAULT_BROWSER_ZOOM_FACTOR = 0.9

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
    const entry: BrowserEntry = { id, view, requestedUrl: url, error: null }
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

  setBounds(id: string, bounds: BrowserBounds | null): void {
    const entry = this.require(id)
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
    contents.on('did-finish-load', () => contents.setZoomFactor(DEFAULT_BROWSER_ZOOM_FACTOR))
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
      this.send({ type: 'closed', id: entry.id })
    })
  }

  private require(id: string): BrowserEntry {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`Unknown browser: ${id}`)
    return entry
  }

  private snapshot(entry: BrowserEntry): BrowserSnapshot {
    const contents = entry.view.webContents
    return {
      id: entry.id,
      url: contents.getURL() || entry.requestedUrl,
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
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
