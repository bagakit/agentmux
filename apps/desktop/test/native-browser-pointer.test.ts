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
    visible = false
    bounds = { x: 0, y: 0, width: 0, height: 0 }
    setVisible(value: boolean) { this.visible = value } setBounds(value: typeof this.bounds) { this.bounds = value }
    getVisible() { return this.visible } getBounds() { return this.bounds }
    constructor() { fixture.views.push(this) }
  } }
})

it('native input comes only from the currently visible physical Browser owner and current bounds', async () => {
  fixture.views = []
  const window = { isDestroyed: () => false, contentView: { addChildView() {}, removeChildView() {} }, webContents: { isDestroyed: () => false, send() {} } }
  const manager = new BrowserViewManager(window as any, { defaultProfileId: () => 'default', resolvePartition: () => 'persist:private-pointer' },
    new BrowserRefLedgerStore('unused-pointer-ledger'), { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal() {} })
  const pointer = vi.fn(); manager.onNativeInput = pointer
  try {
    await manager.create('page', 'https://example.invalid/')
    const first = fixture.views[0], input = { type: 'mouseDown', x: 5, y: 7, button: 'left' }
    first.webContents.emit('input-event', {}, input)
    expect(pointer).not.toHaveBeenCalled()
    const bounds = { x: 100, y: 70, width: 400, height: 300 }
    manager.setBounds('page', bounds)
    expect(first.webContents.setBackgroundThrottling.mock.calls).toEqual([[true]])
    first.webContents.emit('input-event', {}, input)
    expect(pointer.mock.calls).toEqual([[{ browserId: 'page', bounds, view: first }, { type: 'pointer', event: input }]])
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
    expect(pointer.mock.calls).toEqual([[{ browserId: 'page', bounds, view: first }, { type: 'pointer', event: input }],
      [{ browserId: 'page', bounds: moved, view: fixture.views[1] }, { type: 'pointer', event: input }]])
  } finally { manager.dispose() }
})

it('only current visible owners relay non-IME Escape and prevent its original native event when the float accepts it', async () => {
  fixture.views = []
  const window = { isDestroyed: () => false, contentView: { addChildView() {}, removeChildView() {} }, webContents: { isDestroyed: () => false, send() {} } }
  const manager = new BrowserViewManager(window as any, { defaultProfileId: () => 'default', resolvePartition: () => 'persist:private-keyboard' },
    new BrowserRefLedgerStore('unused-keyboard-ledger'), { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal() {} })
  const input = vi.fn(() => true); manager.onNativeInput = input
  try {
    await manager.create('inside', 'https://example.invalid/')
    const page = fixture.views[0], bounds = { x: 100, y: 70, width: 400, height: 300 }
    manager.setBounds('inside', bounds)
    const composing = { preventDefault: vi.fn() }, ordinary = { preventDefault: vi.fn() }, rejected = { preventDefault: vi.fn() }
    page.webContents.emit('before-input-event', composing, { type: 'keyDown', key: 'Escape', isComposing: true })
    page.webContents.emit('before-input-event', composing, { type: 'keyDown', key: 'Process', isComposing: false })
    expect(input.mock.calls).toEqual([]); expect(composing.preventDefault).not.toHaveBeenCalled()
    page.webContents.emit('before-input-event', ordinary, { type: 'keyDown', key: 'Escape', isComposing: false })
    expect(input.mock.calls).toEqual([[{ browserId: 'inside', bounds, view: page }, { type: 'escape' }]])
    expect(ordinary.preventDefault).toHaveBeenCalledTimes(1)
    input.mockReturnValueOnce(false)
    page.webContents.emit('before-input-event', rejected, { type: 'keyDown', key: 'Escape', isComposing: false })
    expect(rejected.preventDefault).not.toHaveBeenCalled()
    manager.setBounds('inside', null)
    page.webContents.emit('before-input-event', rejected, { type: 'keyDown', key: 'Escape', isComposing: false })
    expect(input).toHaveBeenCalledTimes(2)
    await manager.release('inside')
    page.webContents.emit('before-input-event', rejected, { type: 'keyDown', key: 'Escape', isComposing: false })
    expect(input).toHaveBeenCalledTimes(2)
  } finally { manager.dispose() }
})

it('native owner lookup reads only the requested current entry as unrelated native owners grow', async () => {
  fixture.views = []
  const window = { isDestroyed: () => false, contentView: { addChildView() {}, removeChildView() {} }, webContents: { isDestroyed: () => false, send() {} } }
  const manager = new BrowserViewManager(window as any, { defaultProfileId: () => 'default', resolvePartition: () => 'persist:private-native-cost' },
    new BrowserRefLedgerStore('unused-native-cost-ledger'), { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal() {} })
  try {
    await manager.create('requested', 'https://example.invalid/')
    manager.setBounds('requested', { x: 100, y: 70, width: 400, height: 300 })
    for (let index = 0; index < 32; index++) {
      const id = `unrelated-${index}`
      await manager.create(id, 'https://example.invalid/')
      manager.setBounds(id, { x: 600, y: 70, width: 100, height: 100 })
    }
    expect(fixture.views).toHaveLength(33)
    const current = fixture.views[0], unrelated = fixture.views.slice(1)
    expect(unrelated).toHaveLength(32)
    const unrelatedReads = unrelated.flatMap(view => [vi.spyOn(view, 'getBounds'), vi.spyOn(view, 'getVisible')])
    const bounds = vi.spyOn(current, 'getBounds'), visible = vi.spyOn(current, 'getVisible')
    const entries = Reflect.get(manager, 'entries') as Map<string, unknown>, scan = vi.spyOn(entries, 'values')
    for (let index = 0; index < 10; index++) expect(manager.nativeOwner('requested')).toEqual({
      browserId: 'requested', bounds: { x: 100, y: 70, width: 400, height: 300 }, view: current
    })
    expect(bounds).toHaveBeenCalledTimes(10); expect(visible).toHaveBeenCalledTimes(10)
    expect(scan).not.toHaveBeenCalled()
    expect(unrelatedReads.flatMap(read => read.mock.calls)).toEqual([])
    expect(manager.nativeOwner('missing')).toBeUndefined()
    scan.mockRestore()
  } finally { manager.dispose() }
})
