import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeOverlaySurfaces } from '../src/main/native-overlay-surfaces'

const fake = vi.hoisted(() => ({ views: [] as any[], load: null as Promise<void> | null, image: null as Promise<void> | null }))
vi.mock('electron', () => ({ WebContentsView: class {
  webContents = { loadURL: vi.fn(async () => {
    this.loadStates.push({ ownerWindow: this.ownerWindow, bounds: this.bounds && { ...this.bounds }, visible: this.visible })
    await fake.load
    this.documentLoaded = true
  }), executeJavaScript: vi.fn(async () => { await fake.image; this.contentLoaded = true }),
    setBackgroundThrottling: vi.fn((value: boolean) => {
      this.syncStates.push({ value, ownerWindow: this.ownerWindow, bounds: this.bounds && { ...this.bounds },
        visible: this.visible, documentLoaded: this.documentLoaded, contentLoaded: this.contentLoaded })
    }),
    setWindowOpenHandler: vi.fn(), on: vi.fn((name, callback) => { this.listeners[name] = callback }),
    isDestroyed: () => this.destroyed, getOSProcessId: () => 4201, close: vi.fn(() => { this.destroyed = true }) }
  listeners: Record<string, (...args: any[]) => void> = {}
  destroyed = false
  ownerWindow: unknown = null
  loadStates: { ownerWindow: unknown; bounds: any; visible: boolean }[] = []
  syncStates: { value: boolean; ownerWindow: unknown; bounds: any; visible: boolean; documentLoaded: boolean; contentLoaded: boolean }[] = []
  documentLoaded = false
  contentLoaded = false
  setBackgroundColor = vi.fn()
  bounds: any
  setBounds = vi.fn(bounds => { this.bounds = bounds })
  getBounds = () => this.bounds
  setBorderRadius = vi.fn()
  visible = false
  setVisible = vi.fn(value => { this.visible = value })
  getVisible = () => this.visible
  constructor() { fake.views.push(this) }
} }))

function fixture() {
  const contents = { capturePage: vi.fn(async () => ({ isEmpty: () => false, toPNG: () => Buffer.from('chrome-frame') })),
    getZoomFactor: () => 1.25, sendInputEvent: vi.fn(), isDestroyed: () => false, focus: vi.fn() }
  const window = { getContentBounds: () => ({ width: 1000, height: 700 }), webContents: contents,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }, isDestroyed: () => false }
  window.contentView.addChildView.mockImplementation(view => { view.ownerWindow = window })
  window.contentView.removeChildView.mockImplementation(view => { view.ownerWindow = null })
  const visible = vi.fn(() => [{ x: 100, y: 100, width: 600, height: 500 }])
  const warning = vi.fn(), pointer = vi.fn()
  return { owner: new NativeOverlaySurfaces(window as any, visible, warning, pointer), window, contents, visible, warning, pointer }
}
const float = { id: 'chrome-1', bounds: { x: 120, y: 150, width: 100, height: 80 }, radius: 8 }

beforeEach(() => { fake.views.length = 0; fake.load = null; fake.image = null })
describe('actual native Chrome owner', () => {
  it('synchronizes throttling once on the attached owner after document and content load, never during subsequent paints', async () => {
    let finishDocument!: () => void, finishContent!: () => void
    fake.load = new Promise(resolve => { finishDocument = resolve })
    fake.image = new Promise(resolve => { finishContent = resolve })
    const { owner, window, contents } = fixture()
    const pending = owner.update([float])
    expect(fake.views).toHaveLength(1)
    const view = fake.views[0]
    expect(view.ownerWindow).toBe(window)
    expect(view.getBounds()).toEqual(float.bounds)
    expect(view.webContents.setBackgroundThrottling).not.toHaveBeenCalled()
    expect(contents.capturePage).not.toHaveBeenCalled()
    finishDocument()
    await vi.waitFor(() => expect(view.webContents.executeJavaScript).toHaveBeenCalledTimes(1))
    expect(view.documentLoaded).toBe(true)
    expect(view.contentLoaded).toBe(false)
    expect(view.webContents.setBackgroundThrottling).not.toHaveBeenCalled()
    finishContent()
    expect(await pending).toEqual({ projected: 1, capturedPixels: 8000 })
    expect(view.syncStates).toEqual([{ value: false, ownerWindow: window, bounds: float.bounds,
      visible: true, documentLoaded: true, contentLoaded: true }])
    expect(view.webContents.setBackgroundThrottling.mock.calls).toEqual([[false]])
    expect(await owner.refresh()).toEqual({ projected: 1, capturedPixels: 8000 })
    expect(await owner.update([{ ...float, bounds: { ...float.bounds, x: 200 } }])).toEqual({ projected: 1, capturedPixels: 8000 })
    view.listeners['input-event']({}, { type: 'keyDown', keyCode: 'Escape' })
    await vi.waitFor(() => expect(contents.capturePage).toHaveBeenCalledTimes(4))
    expect(view.webContents.setBackgroundThrottling.mock.calls).toEqual([[false]])
    expect(fake.views).toHaveLength(1)
    expect(view.setVisible.mock.calls).toEqual([[true]])
    expect(contents.focus).not.toHaveBeenCalled()
    owner.dispose()
  })
  it('cannot synchronize or route a late document after its native owner is removed', async () => {
    let finishDocument!: () => void
    fake.load = new Promise(resolve => { finishDocument = resolve })
    const { owner, contents } = fixture()
    const pending = owner.update([float])
    expect(fake.views).toHaveLength(1)
    const view = fake.views[0]
    expect(await owner.update([])).toEqual({ projected: 0, capturedPixels: 0 })
    finishDocument()
    expect(await pending).toEqual({ projected: 0, capturedPixels: 8000 })
    expect(view.webContents.setBackgroundThrottling).not.toHaveBeenCalled()
    expect(contents.capturePage).not.toHaveBeenCalled()
    view.listeners['input-event']({}, { type: 'mouseDown', x: 5, y: 7, button: 'left' })
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
    expect(view.ownerWindow).toBeNull()
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
    owner.dispose()
  })
  it('cannot synchronize or route late content after its native owner is removed', async () => {
    let finishContent!: () => void
    fake.image = new Promise(resolve => { finishContent = resolve })
    const { owner, contents } = fixture()
    const pending = owner.update([float])
    await vi.waitFor(() => expect(contents.capturePage).toHaveBeenCalledTimes(1))
    expect(fake.views).toHaveLength(1)
    const view = fake.views[0]
    expect(await owner.update([])).toEqual({ projected: 0, capturedPixels: 0 })
    finishContent()
    expect(await pending).toEqual({ projected: 0, capturedPixels: 8000 })
    expect(view.webContents.setBackgroundThrottling).not.toHaveBeenCalled()
    view.listeners['input-event']({}, { type: 'mouseDown', x: 5, y: 7, button: 'left' })
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
    expect(view.ownerWindow).toBeNull()
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
    owner.dispose()
  })
  it('a rejected document cannot be synchronized and reports degradation while retaining page input ownership', async () => {
    fake.load = Promise.reject(new Error('Chrome document load rejected'))
    const { owner, contents } = fixture()
    expect(await owner.update([float])).toMatchObject({ projected: 0, warning: expect.stringContaining('Browser remains available') })
    expect(fake.views).toHaveLength(1)
    const view = fake.views[0]
    expect(view.webContents.setBackgroundThrottling).not.toHaveBeenCalled()
    expect(contents.capturePage).not.toHaveBeenCalled()
    expect(view.webContents.executeJavaScript).not.toHaveBeenCalled()
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
    expect(contents.focus).not.toHaveBeenCalled()
    owner.dispose()
  })
  it('a synchronization failure uses the existing paint warning and cleanup without taking Browser input', async () => {
    let finishDocument!: () => void
    fake.load = new Promise(resolve => { finishDocument = resolve })
    const { owner, contents } = fixture()
    const pending = owner.update([float])
    expect(fake.views).toHaveLength(1)
    const view = fake.views[0]
    view.webContents.setBackgroundThrottling.mockImplementationOnce(() => { throw new Error('Platform synchronization rejected') })
    finishDocument()
    expect(await pending).toMatchObject({ projected: 0, warning: expect.stringContaining('Browser remains available') })
    expect(view.webContents.setBackgroundThrottling).toHaveBeenCalledExactlyOnceWith(false)
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
    view.listeners['input-event']({}, { type: 'mouseDown', x: 5, y: 7, button: 'left' })
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
    expect(contents.focus).not.toHaveBeenCalled()
    expect(await owner.update([])).toEqual({ projected: 0, capturedPixels: 0 })
    expect(await owner.refresh()).toEqual({ projected: 0, capturedPixels: 0 })
    owner.dispose()
  })
  it('attaches the Chrome to its owner with actual clipped bounds before its document starts loading', async () => {
    const { owner, window, contents, visible } = fixture()
    visible.mockReturnValue([{ x: 0, y: 0, width: 1000, height: 700 }])
    const requested = { ...float, bounds: { x: 940, y: 650, width: 200, height: 100 } }
    const actual = { x: 940, y: 650, width: 60, height: 50 }
    expect(await owner.update([requested])).toEqual({ projected: 1, capturedPixels: 3000 })
    expect(fake.views).toHaveLength(1)
    const view = fake.views[0]
    // Captured synchronously by the Electron double at the production loadURL boundary,
    // not inferred from its final attachment or invocation-order numbers. Native frames
    // remain a separate canonical product proof.
    expect(view.loadStates).toHaveLength(1)
    expect(view.loadStates[0].ownerWindow).toBe(window)
    expect(view.loadStates[0].bounds).toEqual(actual)
    expect(view.loadStates[0].visible).toBe(true)
    expect(view.webContents.loadURL).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^data:text\/html,/))
    expect(contents.capturePage).toHaveBeenCalledExactlyOnceWith(actual)
    expect(view.setVisible.mock.calls).toEqual([[true]])
    expect(contents.focus).not.toHaveBeenCalled()
    owner.dispose()
  })
  it('relays only ordinary native outside pointer coordinates while retaining page input and focus', async () => {
    const { owner, pointer, contents, warning } = fixture()
    const page = { x: 100, y: 100, width: 600, height: 500 }
    owner.forwardBrowserPointer(page, { type: 'mouseDown', x: 300, y: 50, button: 'left' } as Electron.MouseInputEvent)
    expect(pointer).not.toHaveBeenCalled()
    await owner.update([float])
    owner.forwardBrowserPointer(page, { type: 'mouseDown', x: 300, y: 50, button: 'left' } as Electron.MouseInputEvent)
    expect(pointer.mock.calls).toEqual([[{ x: 320, y: 120, button: 0 }]])
    owner.forwardBrowserPointer(page, { type: 'mouseDown', x: 25, y: 57, button: 'left' } as Electron.MouseInputEvent)
    owner.forwardBrowserPointer(page, { type: 'mouseMove', x: 300, y: 50 } as Electron.MouseInputEvent)
    owner.forwardBrowserPointer(page, { type: 'mouseDown', x: -1, y: 50, button: 'left' } as Electron.MouseInputEvent)
    expect(pointer).toHaveBeenCalledTimes(1)
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
    expect(contents.focus).not.toHaveBeenCalled()
    expect(contents.capturePage).toHaveBeenCalledTimes(1)
    pointer.mockImplementationOnce(() => { throw new Error('Renderer notice transport closed') })
    expect(() => owner.forwardBrowserPointer(page, { type: 'mouseDown', x: 300, y: 50, button: 'left' } as Electron.MouseInputEvent)).not.toThrow()
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('outside-click notice could not reach'))
    owner.dispose()
    owner.forwardBrowserPointer(page, { type: 'mouseDown', x: 300, y: 50, button: 'left' } as Electron.MouseInputEvent)
    expect(pointer).toHaveBeenCalledTimes(2)
  })
  it('zero floats do no Browser traversal, native allocation, capture or polling', async () => {
    const { owner, visible, contents } = fixture()
    expect(await owner.update([])).toEqual({ projected: 0, capturedPixels: 0 })
    expect(await owner.refresh()).toEqual({ projected: 0, capturedPixels: 0 })
    expect(visible).not.toHaveBeenCalled()
    expect(contents.capturePage).not.toHaveBeenCalled()
    expect(fake.views).toEqual([])
    expect(owner.resourceProcessIds()).toEqual([])
  })
  it('an unrelated float does not allocate or touch any Browser view', async () => {
    const { owner, contents, pointer } = fixture()
    expect(await owner.update([{ ...float, bounds: { x: 5, y: 5, width: 30, height: 30 } }])).toEqual({ projected: 0, capturedPixels: 0 })
    expect(contents.capturePage).not.toHaveBeenCalled()
    expect(fake.views).toEqual([])
    owner.forwardBrowserPointer({ x: 100, y: 100, width: 600, height: 500 }, { type: 'mouseDown', x: 300, y: 50, button: 'left' } as Electron.MouseInputEvent)
    expect(pointer.mock.calls).toEqual([[{ x: 320, y: 120, button: 0 }]])
  })
  it('captures only the intersecting original Chrome rectangle and disposes on close', async () => {
    const { owner, contents, window } = fixture()
    expect(await owner.update([float])).toEqual({ projected: 1, capturedPixels: 8000 })
    expect(contents.capturePage).toHaveBeenCalledExactlyOnceWith(float.bounds)
    expect(fake.views).toHaveLength(1)
    expect(owner.resourceProcessIds()).toEqual([4201])
    const view = fake.views[0]
    expect(view.setBorderRadius).toHaveBeenCalledWith(8)
    expect(view.webContents.executeJavaScript.mock.calls[0][0]).toContain(Buffer.from('chrome-frame').toString('base64'))
    expect(await owner.update([])).toEqual({ projected: 0, capturedPixels: 0 })
    expect(window.contentView.removeChildView).toHaveBeenCalledWith(view)
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
    expect(owner.resourceProcessIds()).toEqual([])
  })
  it('projects a real modal scrim as transparency, never a full-window Chrome bitmap', async () => {
    const { owner, contents } = fixture()
    expect(await owner.update([{ ...float, bounds: { x: 0, y: 0, width: 1000, height: 700 }, scrim: 'rgba(0, 0, 0, 0.2)' }])).toEqual({ projected: 1, capturedPixels: 0 })
    expect(contents.capturePage).not.toHaveBeenCalled()
    expect(fake.views).toHaveLength(1)
    expect(fake.views[0].webContents.executeJavaScript.mock.calls[0][0]).toContain('rgba(0, 0, 0, 0.2)')
    expect(fake.views[0].webContents.setBackgroundThrottling.mock.calls).toEqual([[false]])
    const moved={...float,bounds:{x:20,y:30,width:800,height:600},scrim:'rgba(0, 0, 0, 0.3)'}
    expect(await owner.update([moved])).toEqual({projected:1,capturedPixels:0})
    expect(fake.views[0].getBounds()).toEqual(moved.bounds)
    expect(fake.views[0].webContents.setBackgroundThrottling.mock.calls).toEqual([[false]])
    contents.sendInputEvent.mockClear()
    fake.views[0].listeners['input-event']({}, {type:'mouseDown',x:5,y:7,button:'left'})
    expect(contents.sendInputEvent).toHaveBeenCalledWith({type:'mouseDown',x:25,y:37,button:'left'})
  })
  it('real native pointer and keyboard input goes to the original Renderer at current window coordinates', async () => {
    const { owner, contents } = fixture()
    await owner.update([float])
    expect(fake.views).toHaveLength(1)
    const view = fake.views[0]
    view.listeners['input-event']({}, { type: 'mouseDown', x: 5, y: 7, button: 'left' })
    expect(contents.sendInputEvent).toHaveBeenCalledWith({ type: 'mouseDown', x: 125, y: 157, button: 'left' })
    expect(contents.focus).toHaveBeenCalledTimes(1)
    await owner.update([{ ...float, bounds: { ...float.bounds, x: 200 } }])
    view.listeners['input-event']({}, { type: 'mouseUp', x: 5, y: 7, button: 'left' })
    view.listeners['input-event']({}, { type: 'keyDown', keyCode: 'Escape' })
    expect(contents.sendInputEvent.mock.calls.map(call => call[0])).toEqual([
      { type: 'mouseDown', x: 125, y: 157, button: 'left' },
      { type: 'mouseUp', x: 205, y: 157, button: 'left' }, { type: 'keyDown', keyCode: 'Escape' }
    ])
    owner.dispose()
  })
  it('paint failure reports degradation while preserving the Browser and cleaning the failed Chrome owner', async () => {
    const { owner, contents } = fixture()
    contents.capturePage.mockRejectedValueOnce(new Error('compositor unavailable'))
    const receipt = await owner.update([float])
    expect(receipt.projected).toBe(0)
    expect(receipt.warning).toContain('Browser remains available')
    expect(fake.views).toHaveLength(1)
    expect(fake.views[0].webContents.close).toHaveBeenCalledTimes(1)
  })
  it('pending or failed repaint cannot route a stale picture to the new source position', async () => {
    const { owner, contents } = fixture()
    await owner.update([float])
    expect(fake.views).toHaveLength(1)
    const view = fake.views[0]
    let reject!: (error: Error) => void
    contents.capturePage.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    const moved = owner.update([{ ...float, bounds: { ...float.bounds, x: 200 } }])
    await vi.waitFor(() => expect(contents.capturePage).toHaveBeenCalledTimes(2))
    expect(view.getBounds()).toEqual(float.bounds)
    view.listeners['input-event']({}, { type: 'mouseDown', x: 5, y: 7, button: 'left' })
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
    reject(new Error('Compositor unavailable'))
    expect(await moved).toMatchObject({ projected: 0, warning: expect.stringContaining('Browser remains available') })
    view.listeners['input-event']({}, { type: 'mouseDown', x: 5, y: 7, button: 'left' })
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
  })
  it('a closed projection late failure cannot delete or leak a reopened same-id native owner', async () => {
    const {owner,contents,warning}=fixture()
    let fail!:(error:Error)=>void
    contents.capturePage.mockImplementationOnce(()=>new Promise((_resolve,reject)=>{fail=reject}))
    const old=owner.update([float])
    await vi.waitFor(()=>expect(contents.capturePage).toHaveBeenCalledTimes(1))
    await owner.update([])
    expect(await owner.update([float])).toEqual({projected:1,capturedPixels:8000})
    expect(fake.views).toHaveLength(2)
    const replacement=fake.views[1]
    fail(new Error('Old closed compositor response'))
    expect(await old).toEqual({projected:1,capturedPixels:8000})
    expect(warning).not.toHaveBeenCalled()
    expect(replacement.webContents.close).not.toHaveBeenCalled()
    expect(owner.resourceProcessIds()).toEqual([4201])
    owner.dispose()
    expect(replacement.webContents.close).toHaveBeenCalledTimes(1)
    expect(owner.resourceProcessIds()).toEqual([])
  })
})
