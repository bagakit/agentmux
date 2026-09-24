import { expect, it, vi } from 'vitest'
import { BrowserViewManager } from '../src/main/browser-view-manager'
import { BrowserRefLedgerStore } from '../src/main/browser-ref-ledger-store'
const fixture = vi.hoisted(() => ({ views: [] as any[] }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Contents extends EventEmitter {
    url = ''; destroyed = false
    session = { setPermissionCheckHandler() {}, setPermissionRequestHandler() {} }
    navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    getURL() { return this.url } getTitle() { return 'Current native document' }
    isLoading() { return false } isDestroyed() { return this.destroyed }
    getBackgroundThrottling() { return true }
    setBackgroundThrottling = vi.fn()
    setWindowOpenHandler() {} setZoomFactor() {}
    async executeJavaScriptInIsolatedWorld() {}
    async loadURL(url: string) { this.url = url }
    close() { this.destroyed = true; this.emit('destroyed', {}) }
  }
  return { WebContentsView: class {
    webContents = new Contents()
    setVisible() {} setBounds() {}
    constructor() { fixture.views.push(this) }
  } }
})

it('native input comes only from the currently visible physical Browser owner and current bounds', async () => {
  fixture.views = []
  const window = { isDestroyed: () => false, contentView: { addChildView() {}, removeChildView() {} }, webContents: { isDestroyed: () => false, send() {} } }
  const manager = new BrowserViewManager(window as any, { defaultProfileId: () => 'default', resolvePartition: () => 'persist:private-pointer' },
    new BrowserRefLedgerStore('unused-pointer-ledger'), { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal() {} })
  const pointer = vi.fn(); manager.onNativePointer = pointer
  try {
    await manager.create('page', 'https://example.invalid/')
    const first = fixture.views[0], input = { type: 'mouseDown', x: 5, y: 7, button: 'left' }
    first.webContents.emit('input-event', {}, input)
    expect(pointer).not.toHaveBeenCalled()
    const bounds = { x: 100, y: 70, width: 400, height: 300 }
    manager.setBounds('page', bounds)
    expect(first.webContents.setBackgroundThrottling.mock.calls).toEqual([[true]])
    first.webContents.emit('input-event', {}, input)
    expect(pointer.mock.calls).toEqual([[bounds, input]])
    manager.setBounds('page', null)
    first.webContents.emit('input-event', {}, input)
    expect(pointer).toHaveBeenCalledTimes(1)
    await manager.release('page')
    await manager.restore('page')
    const moved = { ...bounds, x: 200 }
    manager.setBounds('page', moved)
    first.webContents.emit('input-event', {}, input)
    expect(pointer).toHaveBeenCalledTimes(1)
    expect(fixture.views).toHaveLength(2)
    fixture.views[1].webContents.emit('input-event', {}, input)
    expect(pointer.mock.calls).toEqual([[bounds, input], [moved, input]])
  } finally { manager.dispose() }
})
