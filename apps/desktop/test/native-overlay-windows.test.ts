import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NativeOverlayWindows } from '../src/main/native-overlay-windows'
import { NATIVE_OVERLAY_FOCUS_CHANNEL } from '../src/shared/native-overlay'
import { NATIVE_BROWSER_INPUT_CHANNEL, NATIVE_BROWSER_VISIBILITY_CHANNEL } from '../src/shared/contracts'

const native = vi.hoisted(() => ({ ipc: null as unknown as EventEmitter, surfaces: [] as any[] }))
vi.mock('electron', async () => {
  native.ipc = new (await import('node:events')).EventEmitter()
  return { ipcMain: native.ipc }
})
vi.mock('../src/main/native-overlay-surfaces', () => ({ NativeOverlaySurfaces: class {
  regions: unknown[] = []
  dispose = vi.fn()
  refresh = vi.fn(async () => ({ projected: this.regions.length, capturedPixels: 0 }))
  forwardBrowserInput = vi.fn(() => true)
  resourceProcessIds = () => [this.window.pid]
  constructor(readonly window: any, readonly browsers: any, readonly warning: (message: string) => void, readonly input: (value: unknown) => void) { native.surfaces.push(this) }
  async update(regions: unknown[]) { this.regions = regions; return { projected: regions.length, capturedPixels: 0 } }
  hasProjectionInFocusedWindow() { return this.window.focused && this.regions.length > 0 }
} }))
function window(pid: number, zoom: number) {
  return Object.assign(new EventEmitter(), { pid, focused: false, isDestroyed: () => false,
    webContents: Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send: vi.fn(), getZoomFactor: () => zoom }) })
}
const pair = { windowId: 'original-window', documentGeneration: 'original-document' }
const main = window(1, 1), child = window(2, 1.5)
const box = { x: 10, y: 20, width: 100, height: 80 }
const region = { id: 'chrome-1', bounds: box, radius: 4 }
const view = {}, owner = { browserId: 'original-browser', bounds: box, view }
let registry: NativeOverlayWindows
const browsers = { visibleNativeBounds: vi.fn(), nativeOwner: vi.fn(), windowForView: vi.fn() }
beforeEach(() => {
  vi.clearAllMocks(); native.surfaces = []; main.focused = child.focused = false
  browsers.visibleNativeBounds.mockImplementation(host => host === child ? [box] : [])
  browsers.nativeOwner.mockImplementation((_id, host) => host === child ? owner : undefined)
  browsers.windowForView.mockImplementation(source => source === view ? child : main)
  registry = new NativeOverlayWindows(main as never, browsers as never, { windowForDocument(scope) {
    if (scope === undefined) return main as never
    if (scope.windowId === pair.windowId && scope.documentGeneration === pair.documentGeneration) return child as never
    throw new Error('Original native document is stale')
  } })
})
afterEach(() => registry.dispose())

it('publishes exact child geometry and scale while retaining the original Browser owner', async () => {
  expect(registry.visibility(pair)).toEqual({ revision: 0, bounds: [box], zoomFactor: 1.5, document: pair })
  expect(await registry.update([region], pair)).toEqual({ projected: 1, capturedPixels: 0 })
  expect(native.surfaces).toHaveLength(1)
  expect(native.surfaces[0].window).toBe(child)
  expect(native.surfaces[0].browsers.visibleNativeBounds()).toEqual([box])
  expect(native.surfaces[0].browsers.nativeOwner(owner.browserId)).toBe(owner)
  expect(browsers.nativeOwner).toHaveBeenLastCalledWith(owner.browserId, child)
  native.surfaces[0].input({ type: 'escape', browserId: owner.browserId, overlayId: region.id })
  expect(main.webContents.send).toHaveBeenLastCalledWith(NATIVE_BROWSER_INPUT_CHANNEL,
    { type: 'escape', browserId: owner.browserId, overlayId: region.id, document: pair })
})

it('refuses a stale native generation before allocating or changing a projection', async () => {
  await expect(registry.update([region], { ...pair, documentGeneration: 'replaced-document' })).rejects.toThrow('stale')
  expect(native.surfaces).toHaveLength(0)
  expect(browsers.visibleNativeBounds).not.toHaveBeenCalled()
})

it('updates only the actual changed native window consumer and routes original page input there', async () => {
  registry.visibility(); registry.visibility(pair)
  registry.visibilityChanged(child as never)
  expect(main.webContents.send).toHaveBeenCalledExactlyOnceWith(NATIVE_BROWSER_VISIBILITY_CHANNEL,
    { revision: 1, bounds: [box], zoomFactor: 1.5, document: pair })
  expect(native.surfaces[0].refresh).not.toHaveBeenCalled()
  expect(native.surfaces[1].refresh).toHaveBeenCalledTimes(1)
  expect(registry.forwardBrowserInput(owner as never, { type: 'escape' })).toBe(true)
  expect(native.surfaces[1].forwardBrowserInput).toHaveBeenCalledExactlyOnceWith(owner, { type: 'escape' })
  expect(native.surfaces[0].forwardBrowserInput).not.toHaveBeenCalled()
})

it('observes focused projections only through the original trusted bridge and exact child document', async () => {
  await registry.update([region], pair); child.focused = true
  const query = (sender: unknown, frame: unknown, scope = pair) => {
    const event = { sender, senderFrame: frame, returnValue: undefined }
    native.ipc.emit(NATIVE_OVERLAY_FOCUS_CHANNEL, event, scope); return event.returnValue
  }
  expect(query(main.webContents, main.webContents.mainFrame)).toBe(true)
  expect(query(child.webContents, child.webContents.mainFrame)).toBe(false)
  expect(query(main.webContents, main.webContents.mainFrame, { ...pair, documentGeneration: 'stale-document' })).toBe(false)
  child.focused = false
  expect(query(main.webContents, main.webContents.mainFrame)).toBe(false)
})

it('releases native resources and their document listeners when that original shell departs', () => {
  registry.visibility(pair)
  const surface = native.surfaces[0]
  expect(child.webContents.listenerCount('render-process-gone')).toBe(1)
  child.webContents.emit('render-process-gone')
  expect(surface.dispose).toHaveBeenCalledTimes(1)
  expect(child.webContents.listenerCount('render-process-gone')).toBe(0)
  expect(child.listenerCount('closed')).toBe(0)
  expect(registry.resourceProcessIds()).toEqual([])
  registry.dispose()
  expect(native.ipc.listenerCount(NATIVE_OVERLAY_FOCUS_CHANNEL)).toBe(0)
})

it('refreshes only the requested native host and preserves the original Root default', async () => {
  await registry.update([region]); await registry.update([region], pair)
  await registry.refresh()
  expect(native.surfaces[0].refresh).toHaveBeenCalledTimes(1)
  expect(native.surfaces[1].refresh).not.toHaveBeenCalled()
  await registry.refresh(child as never)
  expect(native.surfaces[0].refresh).toHaveBeenCalledTimes(1)
  expect(native.surfaces[1].refresh).toHaveBeenCalledTimes(1)
})
