import { fixtureFileUrl as _tailFixtureFileUrl } from "../../../../test/fixture-values.mjs"
import { vi } from 'vitest'

/** Controlled Electron ports. No App, Browser or OS input is created by these Node consumers. */
export function directoryNativePorts() {
  class Session {
    display: ((request: any, callback: (streams: any) => void) => void) | null = null
    setDisplayMediaRequestHandler = vi.fn((handler: ((request: any, callback: (streams: any) => void) => void) | null) => { this.display = handler })
    setPermissionCheckHandler = vi.fn()
    setPermissionRequestHandler = vi.fn()
    setDevicePermissionHandler = vi.fn()
    on = vi.fn()
    removeListener = vi.fn()
  }
  let nextPid = 4100
  class Contents {
    readonly id = ++nextPid
    readonly getOSProcessId = () => this.id
    readonly session = new Session()
    url = _tailFixtureFileUrl('private-fixture/renderer/index.html')
    dead = false
    readonly mainFrame: { url: string; detached: boolean; parent: null; osProcessId: number; framesInSubtree: { detached: boolean; osProcessId: number }[] } = { url: this.url, detached: false, parent: null, osProcessId: this.id, framesInSubtree: [{ detached: false, osProcessId: this.id }] }
    readonly listeners = new Map<string, Set<(...args: any[]) => void>>()
    readonly navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    send = vi.fn()
    focus = vi.fn()
    setWindowOpenHandler = vi.fn()
    zoom = 0.9
    getZoomFactor = () => this.zoom
    sendInputEvent = vi.fn((input: any) => { this.emit('input-event', {}, input) })
    setZoomFactor = vi.fn()
    disableDeviceEmulation = vi.fn()
    enableDeviceEmulation = vi.fn()
    getBackgroundThrottling = () => true
    setBackgroundThrottling = vi.fn()
    executeJavaScriptInIsolatedWorld = vi.fn(async () => true)
    getURL = () => this.url
    getTitle = () => 'Original Browser'
    isLoading = () => false
    isLoadingMainFrame = () => false
    isBeingCaptured = () => false
    isCurrentlyAudible = () => false
    isDestroyed = () => this.dead
    on(event: string, listener: (...args: any[]) => void) {
      const set = this.listeners.get(event) ?? new Set()
      set.add(listener); this.listeners.set(event, set); return this
    }
    once(event: string, listener: (...args: any[]) => void) {
      const wrapped = (...args: any[]) => { this.removeListener(event, wrapped); listener(...args) }
      return this.on(event, wrapped)
    }
    removeListener(event: string, listener: (...args: any[]) => void) { this.listeners.get(event)?.delete(listener) }
    emit(event: string, ...args: any[]) { for (const listener of this.listeners.get(event) ?? []) listener(...args) }
    readonly loads: string[] = []
    async loadURL(url: string) {
      this.loads.push(url)
      this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url })
      this.url = url; this.mainFrame.url = url
      this.emit('did-navigate', {}, url)
      this.emit('did-finish-load'); this.emit('did-stop-loading')
    }
    reload() { void this.loadURL(this.url) }
    close = vi.fn(() => { this.dead = true; this.emit('destroyed') })
  }
  class View {
    readonly webContents = new Contents()
    visible = false
    bounds = { x: 0, y: 0, width: 0, height: 0 }
    setVisible(value: boolean) { this.visible = value }
    getVisible() { return this.visible }
    setBounds(value: typeof this.bounds) { this.bounds = { ...value } }
    getBounds() { return this.bounds }
  }
  const shells: BaseWindow[] = []
  class BaseWindow {
    readonly views: View[] = []
    readonly contentView = {
      children: this.views,
      addChildView: (view: View) => { this.views.push(view) },
      removeChildView: (view: View) => { const index = this.views.indexOf(view); if (index !== -1) this.views.splice(index, 1) }
    }
    dead = false
    constructor(readonly options: Record<string, unknown>) { shells.push(this) }
    isDestroyed = () => this.dead
    destroy = vi.fn(() => { this.dead = true })
  }
  return { Session, Contents, View, BaseWindow, shells }
}
