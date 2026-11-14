import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { crc32, deflateSync } from 'node:zlib'
import { join } from 'node:path'
import ipc from '../src/main/ipc.ts?raw'
import { CaptureSurface, type CaptureSurfaceSession, type CaptureSurfaceTiming } from '../src/main/capture-surface'
import { CAPTURE_SURFACE_CHANNEL, CAPTURE_SURFACE_EVENT } from '../src/shared/capture-surface'
import { pngFromBytes } from '@agentmux/native-desktop/image'

const electron = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => Promise<any>>(), windows: [] as any[], workbench: [] as any[],
  displays: [] as Array<{ id: number; bounds: { x: number; y: number; width: number; height: number }; displayFrequency?: number; scaleFactor?: number }>, cursor: { x: 0, y: 0 },
  screenListeners: new Map<string, Array<(...args: any[]) => void>>(), appListeners: new Map<string, Array<() => void>>(), focus: vi.fn(),
  focused: null as unknown, saves: [] as unknown[], loadWindow: undefined as (() => Promise<void>) | undefined }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Window extends EventEmitter {
    dead = false; visible = false; opacity = 1; contentProtected = false; protectionAtShow: boolean[] = []
    webContents = Object.assign(new EventEmitter(), { mainFrame: {}, setWindowOpenHandler: vi.fn(), send: vi.fn() })
    show = vi.fn(() => { this.visible = true }); showInactive = vi.fn(() => { this.protectionAtShow.push(this.contentProtected); this.visible = true }); focus = vi.fn()
    setAlwaysOnTop = vi.fn(); setVisibleOnAllWorkspaces = vi.fn(); setBounds = vi.fn()
    setContentProtection = vi.fn((value: boolean) => { this.contentProtected = value }); isContentProtected = () => this.contentProtected
    setOpacity = vi.fn((value: number) => { this.opacity = value }); getOpacity = () => this.opacity
    loadFile = vi.fn(async () => { await electron.loadWindow?.(); this.emit('ready-to-show') }); loadURL = this.loadFile
    constructor(readonly options: any) { super(); electron.windows.push(this) }
    static getFocusedWindow() { return electron.focused }
    static getAllWindows() { return [...electron.workbench, ...electron.windows] }
    isDestroyed() { return this.dead }
    isVisible() { return this.visible }
    isMinimized() { return false }
    destroy() { if (this.dead) return; this.dead = true; this.emit('closed') }
  }
  const on = (map: Map<string, Array<(...args: any[]) => void>>) => (name: string, listener: (...args: any[]) => void) => { map.set(name, [...(map.get(name) ?? []), listener]) }
  const off = (map: Map<string, Array<(...args: any[]) => void>>) => (name: string, listener: (...args: any[]) => void) => { map.set(name, (map.get(name) ?? []).filter(row => row !== listener)) }
  return {
    BrowserWindow: Window,
    nativeTheme: { shouldUseDarkColors: true },
    dialog: { showSaveDialog: async () => ({ canceled: true }) },
    ipcMain: { handle: (channel: string, handler: (...args: any[]) => Promise<any>) => electron.handlers.set(channel, handler), removeHandler: (channel: string) => electron.handlers.delete(channel) },
    screen: { getAllDisplays: () => electron.displays, getCursorScreenPoint: () => electron.cursor,
      getDisplayNearestPoint: (point: { x: number; y: number }) => electron.displays.find(({ bounds }) => point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + bounds.height) ?? electron.displays[0],
      on: on(electron.screenListeners), removeListener: off(electron.screenListeners) },
    app: { focus: electron.focus, once: on(electron.appListeners as never), removeListener: off(electron.appListeners as never) }
  }
})
vi.mock('../src/main/screenshot-files', () => ({ saveScreenshotPng: vi.fn(async (...args: unknown[]) => { electron.saves.push(args); return { status: 'saved', path: '/chosen/shot.png' } }) }))

function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]), size = Buffer.alloc(4), crc = Buffer.alloc(4)
    size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body))
    return Buffer.concat([size, body, crc])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 0
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width + 1) * height))), chunk('IEND', Buffer.alloc(0))])
}
const main = { x: 0, y: 0, width: 4, height: 3 }, side = { x: -2, y: -1, width: 2, height: 2 }
// Global Quartz points, front to back: one inside the main display, one across both displays, one past the main display's right edge.
const front = { windowId: 3, frame: { x: 1, y: 0.5, width: 2, height: 1 }, owner: 'Editor' }
const across = { windowId: 5, frame: { x: -1, y: -1, width: 3, height: 2 } }
const beyond = { windowId: 9, frame: { x: 4, y: 0, width: 2, height: 2 } }
const nativeTiming = { contentMs: 1, windowListMs: 1, responseSerializationMs: 1, totalMs: 3, lazyConnectionMs: 1, socketReadMs: 1, jsonParseMs: 1, requestMs: 4, validationMs: 1 }
const displayTiming = { captureMs: 1, pngMs: 1, base64Ms: 0, totalMs: 2 }
const frames = () => ({ state: 'captured' as const, capturedAt: 1_700_000_000_000, timing: nativeTiming, displays: [
  { displayId: 1, frame: main, scale: 2, safeTop: 0, windows: [front, across, beyond], timing: displayTiming, png: png(8, 6).toString('base64'), width: 8, height: 6, engine: 'fixture-engine' },
  { displayId: 7, frame: side, scale: 1, safeTop: 0, windows: [across], timing: displayTiming, png: png(2, 2).toString('base64'), width: 2, height: 2, engine: 'fixture-engine' }] })
const result = pngFromBytes(png(4, 2))

let surface: CaptureSurface, ports: ReturnType<typeof makePorts>
function makePorts() {
  return { native: vi.fn(() => ({ captureDisplays: vi.fn(async () => frames()) })), appearance: () => ({ terminalTheme: 'graphite' as const }),
    pin: vi.fn(async (..._args: unknown[]) => ({ state: 'open' } as never)), copyText: vi.fn(async (_text: string) => {}), returnFocus: vi.fn(),
    recordTiming: vi.fn(async (_timing: CaptureSurfaceTiming) => {}) }
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  electron.handlers.clear(); electron.windows = []; electron.workbench = []; electron.screenListeners.clear(); electron.appListeners.clear(); electron.saves = []
  electron.focus.mockClear(); electron.focused = null; electron.cursor = { x: -1, y: 0 }; electron.loadWindow = undefined
  electron.displays = [{ id: 1, bounds: main, scaleFactor: 2 }, { id: 7, bounds: side, scaleFactor: 1 }]
  ports = makePorts()
  surface = new CaptureSurface(ports)
})
afterEach(() => { surface.dispose(); vi.useRealTimers() })

function session(overrides: Partial<CaptureSurfaceSession> = {}): CaptureSurfaceSession {
  return { attachToDraft: true, expandable: true, returnFocus: false, complete: vi.fn(async () => {}), ...overrides }
}
async function opened(value = session(), settle = 0) {
  const before = electron.windows.length, outcome = surface.present(value)
  await vi.advanceTimersByTimeAsync(settle)
  // Only this capture's overlays; an earlier capture's windows are closed.
  const overlays = await Promise.all(electron.windows.slice(before).map(async window => {
    const call = (action: string, params: Record<string, unknown> = {}, event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }) =>
      electron.handlers.get(CAPTURE_SURFACE_CHANNEL)!(event, action, { requestId: input.requestId, background: input.background, ...params })
    const input = await electron.handlers.get(CAPTURE_SURFACE_CHANNEL)!({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, 'load')
    return { window, input, call }
  }))
  return { outcome, overlays, session: value }
}
const selection = { x: 2, y: 2, width: 4, height: 2 }

it('captures every display once and opens one transparent overlay per display at its exact bounds', async () => {
  const captureDisplays = vi.fn(async () => frames())
  ports.native.mockReturnValue({ captureDisplays })
  const { overlays } = await opened()
  expect(captureDisplays).toHaveBeenCalledOnce()
  expect(overlays.map(row => row.input.displayId)).toEqual([1, 7])
  for (const [index, bounds] of [main, side].entries()) {
    const { window } = overlays[index]!
    expect(window.options).toMatchObject({ ...bounds, show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, roundedCorners: false,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, enableLargerThanScreen: true })
    expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver')
    expect(window.setBounds, 'bounds are set again after the first paint').toHaveBeenLastCalledWith(bounds)
    expect(window.setBounds).toHaveBeenCalledTimes(2)
  }
  expect(overlays[0]!.input).toMatchObject({ frame: main, scale: 2, attachToDraft: true, expandable: true, background: 'included', backgrounds: { included: { image: { width: 8, height: 6 } } } })
})

it('protects every overlay before its renderer loads or any show path', async () => {
  const { overlays } = await opened()
  for (const { window } of overlays) {
    expect(window.setContentProtection).toHaveBeenCalledExactlyOnceWith(true)
    expect(window.isContentProtected()).toBe(true)
    expect(window.setContentProtection.mock.invocationCallOrder[0]!, 'protection precedes Renderer loading and input release')
      .toBeLessThan(window.loadFile.mock.invocationCallOrder[0]!)
    expect(window.showInactive, 'no unprotected shell was shown').not.toHaveBeenCalled()
  }
  for (const overlay of overlays) await overlay.call('presented')
  for (const { window } of overlays) {
    expect(window.protectionAtShow).toEqual([true])
    expect(window.setContentProtection.mock.invocationCallOrder[0]!).toBeLessThan(window.showInactive.mock.invocationCallOrder[0]!)
  }
})

function pending<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}
const loadEvent = (window: any) => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame })

it('boots hidden overlay renderers while both current exposures are pending and releases only their new inputs', async () => {
  const included = pending<ReturnType<typeof frames>>(), excluded = pending<ReturnType<typeof frames>>()
  electron.workbench = [{ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, getOpacity: () => 1, setOpacity: vi.fn() }]
  const captureDisplays = vi.fn().mockImplementationOnce(() => included.promise).mockImplementationOnce(() => excluded.promise)
  ports.native.mockReturnValue({ captureDisplays })
  const outcome = surface.present(session({ background: 'excluded' }))
  await vi.advanceTimersByTimeAsync(0)
  expect(electron.windows, 'Renderer preparation does not wait for native pixels').toHaveLength(2)
  expect(electron.windows.every(window => window.loadFile.mock.calls.length === 1 && !window.visible), 'both hidden renderers load during the first exposure').toBe(true)
  const window = electron.windows[0]!, handler = electron.handlers.get(CAPTURE_SURFACE_CHANNEL)!
  let received = false
  const input = handler(loadEvent(window), 'load').then(value => { received = true; return value }, error => { received = true; return { loadFailed: error.message } })
  await vi.advanceTimersByTimeAsync(1600)
  expect(received, 'an early load waits for this capture, not a previous frame').toBe(false)
  expect(electron.windows.every(window => !window.visible), 'fallback cannot expose shells before the new data exists').toBe(true)
  included.resolve(frames())
  await vi.advanceTimersByTimeAsync(0)
  expect(captureDisplays).toHaveBeenCalledTimes(2)
  expect(received, 'the excluded background is part of the same original input').toBe(false)
  expect(electron.windows.every(window => !window.visible), 'prepared overlays never enter either grab').toBe(true)
  const second = frames(); second.capturedAt += 100
  excluded.resolve(second)
  await vi.advanceTimersByTimeAsync(0)
  const loaded = await input
  expect(loaded.background).toBe('excluded')
  expect(loaded.backgrounds.excluded.capturedAt).toBe(second.capturedAt)
  for (const overlay of electron.windows) {
    const value = await handler(loadEvent(overlay), 'load')
    await handler(loadEvent(overlay), 'presented', { requestId: value.requestId, background: value.background })
  }
  expect(electron.windows.every(window => window.showInactive.mock.calls.length === 1)).toBe(true)
  expect(ports.recordTiming).toHaveBeenCalledWith(expect.objectContaining({ includedMs: expect.any(Number), excludedMs: expect.any(Number), dataReadyMs: expect.any(Number) }))
  await handler(loadEvent(window), 'cancel', { requestId: loaded.requestId })
  expect(await outcome).toEqual({ state: 'cancelled' })
})

it('cancel releases an early load and a late result cannot grab, revive or replace the next capture', async () => {
  const late = pending<ReturnType<typeof frames>>()
  const captureDisplays = vi.fn().mockImplementationOnce(() => late.promise).mockResolvedValue(frames())
  ports.native.mockReturnValue({ captureDisplays })
  electron.workbench = [{ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, getOpacity: () => 1, setOpacity: vi.fn() }]
  const outcome = surface.present(session())
  await vi.advanceTimersByTimeAsync(0)
  expect(electron.windows).toHaveLength(2)
  let released = false
  const old = electron.windows[0]!, loaded = electron.handlers.get(CAPTURE_SURFACE_CHANNEL)!(loadEvent(old), 'load').then(() => { released = true; return 'unexpected input' }, error => { released = true; return error.message })
  old.destroy()
  await vi.advanceTimersByTimeAsync(0)
  expect(released, 'cancel releases load before the old native producer returns').toBe(true)
  expect(await loaded).toContain('no longer current')
  expect(await outcome).toEqual({ state: 'cancelled' })
  const next = await opened()
  const count = electron.windows.length, nativeCalls = captureDisplays.mock.calls.length
  expect(nativeCalls, 'the cancelled request used one exposure and the visible-host replacement used two').toBe(3)
  late.resolve({ ...frames(), capturedAt: 0 })
  await vi.advanceTimersByTimeAsync(0)
  expect(captureDisplays, 'the cancelled request cannot start another native exposure').toHaveBeenCalledTimes(nativeCalls)
  expect(electron.windows, 'the old producer creates no late overlay').toHaveLength(count)
  expect(next.overlays.every(overlay => !overlay.window.dead && overlay.input.backgrounds.included.capturedAt !== 0)).toBe(true)
  expect(old.showInactive).not.toHaveBeenCalled()
})

it.each(['native', 'renderer'] as const)('a %s startup failure releases early loads and destroys only the current hidden overlays', async failing => {
  const native = pending<ReturnType<typeof frames>>(), renderer = pending<void>()
  ports.native.mockReturnValue({ captureDisplays: vi.fn(() => native.promise) })
  if (failing === 'renderer') electron.loadWindow = () => renderer.promise
  const outcome = surface.present(session()).then(() => 'unexpected success', error => error.message)
  await vi.advanceTimersByTimeAsync(0)
  const loaded = electron.handlers.get(CAPTURE_SURFACE_CHANNEL)!(loadEvent(electron.windows[0]!), 'load').then(() => 'unexpected input', error => error.message)
  if (failing === 'native') native.reject(new Error('native startup failed'))
  else renderer.reject(new Error('renderer startup failed'))
  await vi.advanceTimersByTimeAsync(0)
  expect(electron.windows.every(window => window.dead && !window.visible), 'failed preparation never leaves a live hidden overlay').toBe(true)
  expect(await loaded).toContain('no longer current')
  expect(await outcome).toContain(failing + ' startup failed')
  native.resolve(frames())
})

it('rejects frames that match a changed current layout but no longer match the prepared overlay bounds', async () => {
  const native = pending<ReturnType<typeof frames>>()
  ports.native.mockReturnValue({ captureDisplays: vi.fn(() => native.promise) })
  const outcome = surface.present(session()).then(() => 'unexpected success', error => error.code)
  await vi.advanceTimersByTimeAsync(0)
  const moved = { ...main, x: 1 }, captured = frames()
  electron.displays[0]!.bounds = moved; captured.displays[0]!.frame = moved
  native.resolve(captured)
  await vi.advanceTimersByTimeAsync(0)
  expect(electron.windows.every(window => window.dead && !window.visible)).toBe(true)
  expect(await outcome).toBe('display_configuration_changed')
})

it('gives each overlay its windows in frozen-frame pixels, clipped to that display, front to back', async () => {
  const { overlays } = await opened()
  expect(overlays[0]!.input.backgrounds.included.windows, 'scale 2 from the main origin; the across window is clipped and the one past the edge is dropped')
    .toEqual([{ x: 2, y: 1, width: 4, height: 2 }, { x: 0, y: 0, width: 4, height: 2 }])
  expect(overlays[1]!.input.backgrounds.included.windows, 'scale 1 from the side origin, clipped at its right and bottom').toEqual([{ x: 1, y: 0, width: 1, height: 2 }])
})

it('shows every overlay together only after each one presented, then focuses the display under the pointer', async () => {
  const { overlays } = await opened()
  await overlays[0]!.call('presented')
  expect(overlays.every(row => row.window.showInactive.mock.calls.length === 0), 'one presented display does not show the frozen desktop yet').toBe(true)
  await overlays[1]!.call('presented')
  expect(overlays.every(row => row.window.showInactive.mock.calls.length === 1)).toBe(true)
  expect(overlays[1]!.window.focus, 'the pointer is on display 7').toHaveBeenCalledOnce()
  expect(overlays[0]!.window.focus).not.toHaveBeenCalled()
})

it('shows the overlays after the fallback when a renderer never reports presented', async () => {
  const { overlays } = await opened()
  await overlays[0]!.call('presented')
  await vi.advanceTimersByTimeAsync(1499)
  expect(overlays[1]!.window.showInactive).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(overlays.every(row => row.window.showInactive.mock.calls.length === 1)).toBe(true)
})

it('the first display to select owns the selection and locks the others to view only', async () => {
  const { overlays } = await opened()
  expect(await overlays[0]!.call('select')).toBe(true)
  expect(overlays[1]!.window.webContents.send).toHaveBeenCalledExactlyOnceWith(CAPTURE_SURFACE_EVENT, { kind: 'locked' })
  expect(overlays[0]!.window.webContents.send).not.toHaveBeenCalled()
  expect(await overlays[1]!.call('select'), 'a locked display cannot take the selection').toBe(false)
  await expect(overlays[1]!.call('save-png', { image: result }), 'nor output it').rejects.toThrow('Only the display that holds the selection')
})

it('primary delivery runs the session delivery once with the selection in global points and closes every overlay', async () => {
  const { overlays, outcome, session: s } = await opened()
  await overlays[0]!.call('select')
  expect(await overlays[0]!.call('finish', { image: result, selection })).toEqual({ status: 'completed' })
  expect(s.complete).toHaveBeenCalledExactlyOnceWith(result, { rect: { x: 1, y: 1, width: 2, height: 1 }, scale: 2, capturedAt: 1_700_000_000_000 }, 'fixture-engine')
  expect(overlays.every(row => row.window.dead), 'a confirmed primary delivery closes every overlay').toBe(true)
  expect(await outcome).toEqual({ state: 'completed' })
})

it('a selection on a display left of and above the main one keeps its negative global origin', async () => {
  const { overlays, session: s } = await opened()
  await overlays[1]!.call('select')
  await overlays[1]!.call('finish', { image: pngFromBytes(png(1, 1)), selection: { x: 1, y: 0, width: 1, height: 1 } })
  expect(s.complete).toHaveBeenCalledExactlyOnceWith(expect.anything(), { rect: { x: -1, y: -1, width: 1, height: 1 }, scale: 1, capturedAt: 1_700_000_000_000 }, 'fixture-engine')
})

it('a failed primary delivery keeps every overlay and reports the reason', async () => {
  const complete = vi.fn(async () => { throw new Error('Clipboard copy was not confirmed') })
  const { overlays } = await opened(session({ complete }))
  await overlays[0]!.call('select')
  expect(await overlays[0]!.call('finish', { image: result, selection })).toEqual({ status: 'failed', message: 'Clipboard copy was not confirmed' })
  expect(overlays.some(row => row.window.dead)).toBe(false)
})

it('Save PNG and an unconfirmed Pin act on the selection and keep the overlays', async () => {
  const { overlays } = await opened()
  await overlays[0]!.call('select')
  expect(await overlays[0]!.call('save-png', { image: result })).toEqual({ status: 'saved', path: '/chosen/shot.png' })
  expect(electron.saves).toEqual([[result, overlays[0]!.window, { capturedAt: 1_700_000_000_000 }]])
  for (const recordedOperation of [{ state: 'failed', message: 'The pin window did not open' }, { state: 'unknown', message: null }, null]) {
    ports.pin.mockResolvedValueOnce({ state: 'unknown', recordedOperation } as never)
    expect(await overlays[0]!.call('pin', { operationId: 'pin-1', image: result, selection }), 'the receipt reaches the overlay status').toMatchObject({ recordedOperation })
    expect(overlays.some(row => row.window.dead), `a pin receipt of ${recordedOperation?.state ?? 'none'} keeps the selection`).toBe(false)
  }
  expect(ports.pin).toHaveBeenLastCalledWith(result, 'pin-1', { x: 1, y: 1, width: 2, height: 1 })
})

it('a confirmed Pin opens on the selection and closes the capture surface like Done', async () => {
  const { overlays, outcome } = await opened(session({ returnFocus: true }))
  await overlays[0]!.call('select')
  ports.pin.mockResolvedValueOnce({ state: 'open', recordedOperation: { state: 'completed', effect: 'opened', message: null } } as never)
  expect(await overlays[0]!.call('pin', { operationId: 'pin-1', image: result, selection })).toMatchObject({ recordedOperation: { state: 'completed' } })
  expect(ports.pin).toHaveBeenCalledExactlyOnceWith(result, 'pin-1', { x: 1, y: 1, width: 2, height: 1 })
  expect(overlays.every(row => row.window.dead), 'the pin is the final output; the surface no longer shows the same selection under it').toBe(true)
  expect(await outcome).toEqual({ state: 'completed' })
  expect(ports.returnFocus, 'focus returns as for Done').toHaveBeenCalledOnce()
})

it('expand ends the surface with the full frozen frame, the selection and the marks', async () => {
  const { overlays, outcome } = await opened()
  await overlays[0]!.call('select')
  const handoff = { shapes: [{ id: 'r', kind: 'rect' }], crop: selection, tool: 'rect' }
  await overlays[0]!.call('expand', { handoff })
  expect(overlays.every(row => row.window.dead), 'the window editor replaces every overlay').toBe(true)
  expect(await outcome).toEqual({ state: 'expanded', image: overlays[0]!.input.backgrounds.included.image, handoff, delivered: expect.any(Function),
    source: { rect: { x: 1, y: 1, width: 2, height: 1 }, scale: 2, capturedAt: 1_700_000_000_000 } })
  expect(overlays.every(row => row.window.dead)).toBe(true)
  expect(ports.returnFocus, 'the window editor takes over focus').not.toHaveBeenCalled()
})

it('Esc on any display cancels and closes every overlay', async () => {
  const { overlays, outcome } = await opened()
  await overlays[0]!.call('select')
  await overlays[1]!.call('cancel')
  expect(overlays.every(row => row.window.dead), 'Esc closes every overlay').toBe(true)
  expect(await outcome).toEqual({ state: 'cancelled' })
})

it('a display without pixels shows its issue, cannot select, and the others stay selectable', async () => {
  const issued = frames()
  issued.displays[1] = { displayId: 7, frame: side, scale: 1, issue: 'macOS did not confirm this display' } as never
  ports.native.mockReturnValue({ captureDisplays: vi.fn(async () => issued) })
  const { overlays } = await opened()
  expect(overlays[1]!.input).toMatchObject({ backgrounds: { included: { issue: 'macOS did not confirm this display' } } })
  expect(overlays[1]!.input.backgrounds.included.image).toBeUndefined()
  expect(await overlays[1]!.call('select')).toBe(false)
  expect(await overlays[0]!.call('select')).toBe(true)
})

it('a display layout change ends the capture, while a work area change keeps it', async () => {
  const { overlays, outcome } = await opened()
  for (const listener of electron.screenListeners.get('display-metrics-changed')!) listener({}, {}, ['workArea'])
  expect(overlays.some(row => row.window.dead)).toBe(false)
  for (const listener of electron.screenListeners.get('display-metrics-changed')!) listener({}, {}, ['scaleFactor'])
  expect(overlays.every(row => row.window.dead), 'a scale change closes every overlay').toBe(true)
  await expect(outcome).rejects.toMatchObject({ code: 'display_configuration_changed' })
})

it('a crashed overlay renderer ends the capture', async () => {
  const { overlays, outcome } = await opened()
  overlays[1]!.window.webContents.emit('render-process-gone')
  expect(overlays.every(row => row.window.dead), 'a crashed renderer closes every overlay').toBe(true)
  await expect(outcome).rejects.toThrow('stopped responding')
})

it('keeps every host at its exact prior opacity throughout both exposures and when the surface ends', async () => {
  const { EventEmitter } = await import('node:events')
  const shown = (opacity: number): any => {
    const window = Object.assign(new EventEmitter(), { dead: false, opacity, isDestroyed: () => false, isVisible: () => true, isMinimized: () => false,
      focus: vi.fn(), getOpacity: () => window.opacity, setOpacity: vi.fn((value: number) => { window.opacity = value }) })
    return window
  }
  // A pin the person set to 40%, and a window that is already fully transparent.
  const workbench = shown(1), pin = shown(0.4), clear = shown(0), hidden = shown(0.8), minimized = shown(0.6)
  hidden.isVisible = () => false; minimized.isMinimized = () => true
  electron.workbench = [workbench, pin, clear, hidden, minimized]; electron.focused = workbench
  const opacityAtGrab: number[][] = []
  const captureDisplays = vi.fn(async () => { opacityAtGrab.push([workbench.opacity, pin.opacity, clear.opacity, hidden.opacity, minimized.opacity]); return frames() })
  ports.native.mockReturnValue({ captureDisplays })
  const outcome = surface.present(session())
  await vi.advanceTimersByTimeAsync(0)
  expect(captureDisplays, 'native exclusion needs no opacity settling delay').toHaveBeenCalledTimes(2)
  expect(opacityAtGrab, 'both exposures retain every exact original host opacity').toEqual([[1, 0.4, 0, 0.8, 0.6], [1, 0.4, 0, 0.8, 0.6]])
  expect(captureDisplays.mock.calls).toEqual([[{ includeHostWindows: true }], [{ includeHostWindows: false }]])
  for (const host of electron.workbench) expect(host.setOpacity, 'capture never writes host opacity').not.toHaveBeenCalled()
  await electron.handlers.get(CAPTURE_SURFACE_CHANNEL)!({ sender: electron.windows[0]!.webContents, senderFrame: electron.windows[0]!.webContents.mainFrame }, 'cancel',
    { requestId: (await electron.handlers.get(CAPTURE_SURFACE_CHANNEL)!({ sender: electron.windows[0]!.webContents, senderFrame: electron.windows[0]!.webContents.mainFrame }, 'load')).requestId })
  await outcome
  expect([workbench.opacity, pin.opacity, clear.opacity, hidden.opacity, minimized.opacity]).toEqual([1, 0.4, 0, 0.8, 0.6])
  for (const host of electron.workbench) expect(host.setOpacity, 'cancellation does not restore opacity that was never changed').not.toHaveBeenCalled()
  expect(workbench.focus, 'the window that had focus gets it back').toHaveBeenCalledOnce()
})

it('grabs at once and requests a second exposure only for a visible, unminimized, non-transparent host', async () => {
  const { EventEmitter } = await import('node:events')
  const captureDisplays = vi.fn(async () => frames())
  ports.native.mockReturnValue({ captureDisplays })
  const quiet = (visible: boolean, minimized: boolean, opacity: number) => Object.assign(new EventEmitter(), { isDestroyed: () => false, isVisible: () => visible,
    isMinimized: () => minimized, getOpacity: () => opacity, setOpacity: vi.fn() })
  electron.workbench = [quiet(false, false, 1), quiet(true, true, 1), quiet(true, false, 0)]
  const first = surface.present(session())
  await vi.advanceTimersByTimeAsync(0)
  expect(captureDisplays, 'hidden, minimized and already transparent hosts need no second exposure').toHaveBeenCalledOnce()
  expect(electron.windows, 'the frozen frame is ready without a compositor wait').toHaveLength(2)
  const readyWindow = electron.windows[0]!
  let loaded = false
  void electron.handlers.get(CAPTURE_SURFACE_CHANNEL)!({ sender: readyWindow.webContents, senderFrame: readyWindow.webContents.mainFrame }, 'load').then(() => { loaded = true }, () => {})
  await vi.advanceTimersByTimeAsync(0)
  expect(loaded, 'the frozen input, not only an early native request, is ready at once').toBe(true)
  surface.dispose(); await first
  surface = new CaptureSurface(ports)
  const host = quiet(true, false, 0.65)
  electron.workbench = [host]
  const second = surface.present(session())
  await vi.advanceTimersByTimeAsync(0)
  expect(captureDisplays, 'the excluded exposure starts immediately after the included one').toHaveBeenCalledTimes(3)
  expect(host.setOpacity, 'neither exposure nor cleanup writes host opacity').not.toHaveBeenCalled()
  surface.dispose(); await second
})

it('logs one timing line from present() to frames, each display painted and shown', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  try {
    const { overlays } = await opened()
    expect(info, 'nothing is logged before the overlays show').not.toHaveBeenCalled()
    await overlays[0]!.call('presented'); await overlays[1]!.call('presented')
    expect(info).toHaveBeenCalledOnce()
    const [line] = info.mock.calls[0]! as [string]
    expect(line.startsWith('capture-surface timing ')).toBe(true)
    const timing = JSON.parse(line.slice('capture-surface timing '.length))
    expect(timing).toMatchObject({ displays: 2 })
    expect([timing.framesMs, ...timing.presentedMs, timing.shownMs].every((value: unknown) => typeof value === 'number' && value >= 0), JSON.stringify(timing)).toBe(true)
    expect(timing.presentedMs).toHaveLength(2)
    expect(timing).toMatchObject({ schema: 'agentmux.capture-timing.v1', includedMs: expect.any(Number), excludedMs: null,
      windowsStartedMs: expect.any(Number), windowsLoadedMs: [expect.any(Number), expect.any(Number)], dataReadyMs: expect.any(Number) })
    expect(ports.recordTiming).toHaveBeenCalledExactlyOnceWith(timing)
    expect(ports.recordTiming.mock.invocationCallOrder[0]!).toBeGreaterThan(Math.max(...overlays.map(overlay => overlay.window.showInactive.mock.invocationCallOrder[0])))
  } finally { info.mockRestore() }
})

it.each(['throw', 'reject'] as const)('a timing writer that will %s only warns after showing and never blocks screenshot delivery', async failure => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  ports.recordTiming.mockImplementationOnce(() => { if (failure === 'throw') throw new Error('disk unavailable'); return Promise.reject(new Error('disk unavailable')) })
  try {
    const { overlays, outcome, session } = await opened()
    void outcome.catch(() => {})
    expect(ports.recordTiming, 'writing is absent from the image preparation critical path').not.toHaveBeenCalled()
    await overlays[0]!.call('presented'); await overlays[1]!.call('presented')
    await vi.advanceTimersByTimeAsync(0)
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('disk unavailable'))
    expect(overlays.every(overlay => overlay.window.visible && !overlay.window.dead)).toBe(true)
    await overlays[0]!.call('select')
    await overlays[0]!.call('finish', { image: result, selection })
    expect(session.complete).toHaveBeenCalledOnce()
    expect(await outcome).toEqual({ state: 'completed' })
  } finally { warning.mockRestore() }
})

it('the production IPC timing port writes only the latest small diagnostic after earlier writes settle, and recovers from write failure', async () => {
  const from = '  let captureTimingWrite = Promise.resolve()', until = '  // The editor returns focus only'
  expect(ipc.split(from), 'the production registration is unambiguous').toHaveLength(2)
  const registration = ipc.slice(ipc.indexOf(from), ipc.indexOf(until, ipc.indexOf(from)))
  const first = pending<void>(), paths: string[] = [], contents: string[] = []
  const writeFile = vi.fn((path: string, content: string) => { paths.push(path); contents.push(content); return paths.length === 1 ? first.promise : Promise.resolve() })
  let actual: { recordTiming(timing: unknown): Promise<void> } | undefined
  const bind = new Function('CaptureSurface', 'getNativeDesktopOwner', 'config', 'pinScreenshot', 'copyScreenshotText', 'returnScreenshotFocus', 'writeFile', 'join', 'app', registration)
  bind(class { constructor(ports: typeof actual) { actual = ports } }, ports.native, { appearance: {} }, ports.pin, ports.copyText, ports.returnFocus, writeFile, join, { getPath: () => '/private-fixture-data' })
  expect(actual, 'the actual Main registration supplies the production timing port').toBeDefined()
  const old = actual!.recordTiming({ schema: 'first' }).catch(error => error.message)
  const latest = actual!.recordTiming({ schema: 'latest' })
  await Promise.resolve(); await Promise.resolve()
  expect(paths).toEqual(['/private-fixture-data/capture-timing.json'])
  first.reject(new Error('disk busy'))
  expect(await old).toBe('disk busy')
  await latest
  expect(paths).toEqual(['/private-fixture-data/capture-timing.json', '/private-fixture-data/capture-timing.json'])
  expect(contents.map(content => JSON.parse(content))).toEqual([{ schema: 'first' }, { schema: 'latest' }])
})

it('returns focus to the previous app once when the capture started elsewhere', async () => {
  const { overlays, outcome } = await opened(session({ returnFocus: true }))
  await overlays[0]!.call('cancel')
  await overlays[1]!.call('cancel').catch(() => {})
  await outcome
  expect(ports.returnFocus).toHaveBeenCalledOnce()
})

it('refuses another window, an embedded frame and a stale request', async () => {
  const { overlays } = await opened()
  const handler = electron.handlers.get(CAPTURE_SURFACE_CHANNEL)!
  await expect(handler({ sender: {}, senderFrame: {} }, 'select', { requestId: overlays[0]!.input.requestId })).rejects.toThrow('does not belong')
  await expect(handler({ sender: overlays[0]!.window.webContents, senderFrame: {} }, 'select', { requestId: overlays[0]!.input.requestId })).rejects.toThrow('does not belong')
  await expect(overlays[0]!.call('select', { requestId: overlays[1]!.input.requestId })).rejects.toThrow('no longer current')
})

it('a second capture while one is open is refused and the notice brings the selection display forward', async () => {
  const { overlays } = await opened()
  await overlays[0]!.call('select')
  const second = surface.present(session()).then(() => 'opened', (error: Error) => error.message)
  await vi.advanceTimersByTimeAsync(0)
  expect(await Promise.race([second, Promise.resolve('still opening')]), 'refused at once, with no second surface').toContain('already in progress')
  expect(electron.windows, 'no second overlay set').toHaveLength(2)
  expect(surface.notice('Finish or cancel this screenshot first')).toBe(true)
  expect(overlays[0]!.window.webContents.send).toHaveBeenCalledWith(CAPTURE_SURFACE_EVENT, { kind: 'notice', message: 'Finish or cancel this screenshot first' })
  expect(overlays[0]!.window.focus).toHaveBeenCalled()
})

it('the public selection returns the processed selection as captured, or cancelled', async () => {
  const pending = surface.captureSelection(false)
  await vi.advanceTimersByTimeAsync(0)
  const window = electron.windows[0]!, event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const handler = electron.handlers.get(CAPTURE_SURFACE_CHANNEL)!, input = await handler(event, 'load')
  expect(input.expandable).toBe(false)
  await handler(event, 'select', { requestId: input.requestId })
  await expect(handler(event, 'expand', { requestId: input.requestId, background: input.background, handoff: { shapes: [], crop: selection, tool: 'rect' } })).rejects.toThrow('returns its selection directly')
  await handler(event, 'finish', { requestId: input.requestId, background: input.background, image: result, selection })
  expect(await pending).toEqual({ state: 'captured', engine: 'fixture-engine', selectionRect: { x: 1, y: 1, width: 2, height: 1 },
    screenshot: { format: 'png', data: result.dataUrl.split(',')[1], width: 4, height: 2, scale: 2 } })
  const cancelled = surface.captureSelection(false)
  await vi.advanceTimersByTimeAsync(0)
  const next = electron.windows.at(-1)!, nextEvent = { sender: next.webContents, senderFrame: next.webContents.mainFrame }
  await handler(nextEvent, 'cancel', { requestId: (await handler(nextEvent, 'load')).requestId })
  expect(await cancelled).toEqual({ state: 'cancelled' })
})

it('the public selection reports a failed native grab as failed with its code', async () => {
  ports.native.mockReturnValue({ captureDisplays: vi.fn(async () => { throw Object.assign(new Error('Screen recording is not allowed'), { code: 'permission_denied' }) }) })
  expect(await surface.captureSelection(false)).toEqual({ state: 'failed', error: { code: 'permission_denied', message: 'Screen recording is not allowed' } })
})

// The remembered selection: display 1 at 2x, frame pixels 2, 2, 4 × 2 are global points 1, 1, 2 × 1.
async function delivered(overlay = 0, rect = selection) {
  const { overlays, outcome } = await opened()
  await overlays[overlay]!.call('select')
  expect(await overlays[overlay]!.call('finish', { image: result, selection: rect })).toEqual({ status: 'completed' })
  // Checked before waiting, so a delivery that never ends the capture fails here instead of timing out.
  expect(overlays.every(row => row.window.dead), 'the delivery ended the capture').toBe(true)
  await outcome
}

it('the next capture opens on the last delivered selection, only on that display', async () => {
  const first = await opened()
  expect(first.overlays.map(row => row.input.initialCrop), 'nothing is remembered before a delivery').toEqual([undefined, undefined])
  await first.overlays[0]!.call('cancel'); await first.outcome
  await delivered()
  const { overlays } = await opened()
  expect(overlays[0]!.input.initialCrop, 'the same frame pixels on the same display').toEqual(selection)
  expect(overlays[1]!.input.initialCrop, 'every other display opens without one').toBeUndefined()
  expect(await overlays[1]!.call('select'), 'opening on it claims nothing').toBe(true)
  await overlays[1]!.call('finish', { image: pngFromBytes(png(1, 1)), selection: { x: 1, y: 0, width: 1, height: 1 } })
  const next = await opened()
  expect(next.overlays.map(row => row.input.initialCrop), 'the newest delivery replaces it').toEqual([undefined, { x: 1, y: 0, width: 1, height: 1 }])
})

it('a window editor delivery is the selection the next capture opens on', async () => {
  await delivered()
  const expanded = await opened()
  await expanded.overlays[0]!.call('select')
  await expanded.overlays[0]!.call('expand', { handoff: { shapes: [], crop: { x: 0, y: 0, width: 8, height: 6 }, tool: 'rect' } })
  const outcome = await expanded.outcome
  if (outcome.state !== 'expanded') throw new Error('the expand ends the surface as expanded')
  const unchanged = await opened()
  expect(unchanged.overlays[0]!.input.initialCrop, 'expanding alone remembers nothing new').toEqual(selection)
  await unchanged.overlays[0]!.call('cancel'); await unchanged.outcome
  outcome.delivered()
  const next = await opened()
  expect(next.overlays[0]!.input.initialCrop, 'once the window editor delivers, its selection is remembered').toEqual({ x: 0, y: 0, width: 8, height: 6 })
})

it('cancel, expand, Save PNG, Pin and a failed delivery remember nothing', async () => {
  await delivered()
  const cancelled = await opened()
  await cancelled.overlays[0]!.call('select')
  await cancelled.overlays[0]!.call('save-png', { image: result })
  await cancelled.overlays[0]!.call('pin', { operationId: 'pin-1', image: result, selection: { x: 0, y: 0, width: 2, height: 2 } })
  await cancelled.overlays[0]!.call('cancel'); await cancelled.outcome
  const expanded = await opened()
  expect(expanded.overlays[0]!.input.initialCrop, 'Save PNG, Pin and cancel kept the delivered selection').toEqual(selection)
  await expanded.overlays[0]!.call('select')
  await expanded.overlays[0]!.call('expand', { handoff: { shapes: [], crop: { x: 0, y: 0, width: 8, height: 6 }, tool: 'rect' } }); await expanded.outcome
  const failing = await opened(session({ complete: vi.fn(async () => { throw new Error('Clipboard copy was not confirmed') }) }))
  expect(failing.overlays[0]!.input.initialCrop, 'expand kept the delivered selection').toEqual(selection)
  await failing.overlays[0]!.call('select')
  expect(await failing.overlays[0]!.call('finish', { image: result, selection: { x: 0, y: 0, width: 2, height: 2 } })).toMatchObject({ status: 'failed' })
  await failing.overlays[0]!.call('cancel'); await failing.outcome
  const { overlays } = await opened()
  expect(overlays[0]!.input.initialCrop, 'a failed delivery kept the delivered selection').toEqual(selection)
})

it.each([
  ['the display moved', { id: 1, bounds: { ...main, x: 4 } }, { ...main, x: 4 }, 2],
  ['the display resized', { id: 1, bounds: { ...main, width: 5 } }, { ...main, width: 5 }, 2],
  ['the display scale changed', { id: 1, bounds: main, scaleFactor: 2 }, main, 1],
  ['the display id changed', { id: 3, bounds: main }, main, 2]
] as const)('a changed display layout gives no remembered selection: %s', async (_case, display, frame, scale) => {
  await delivered()
  electron.displays = [{ ...display, scaleFactor: scale }, { id: 7, bounds: side, scaleFactor: 1 }]
  ports.native.mockReturnValue({ captureDisplays: vi.fn(async () => ({ ...frames(), displays: [
    { displayId: display.id, frame, scale, windows: [], png: png(frame.width * scale, frame.height * scale).toString('base64'), width: frame.width * scale, height: frame.height * scale, engine: 'fixture-engine' },
    frames().displays[1]!] })) })
  const { overlays } = await opened()
  expect(overlays.map(row => row.input.initialCrop)).toEqual([undefined, undefined])
})

it('the public selection capture uses the same remembered selection', async () => {
  await delivered()
  const pending = surface.captureSelection(false)
  await vi.advanceTimersByTimeAsync(0)
  const window = electron.windows.at(-2)!, event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const handler = electron.handlers.get(CAPTURE_SURFACE_CHANNEL)!, input = await handler(event, 'load')
  expect(input.initialCrop).toEqual(selection)
  await handler(event, 'select', { requestId: input.requestId })
  await handler(event, 'finish', { requestId: input.requestId, background: input.background, image: result, selection: { x: 0, y: 0, width: 4, height: 4 } })
  expect(window.dead, 'the delivery ended the capture').toBe(true)
  expect(await pending).toMatchObject({ state: 'captured', selectionRect: { x: 0, y: 0, width: 2, height: 2 } })
  const { overlays } = await opened()
  expect(overlays[0]!.input.initialCrop, 'a public delivery is remembered too').toEqual({ x: 0, y: 0, width: 4, height: 4 })
})

it('the display that carries the remembered selection takes the keys', async () => {
  await delivered()
  const { overlays } = await opened()
  await overlays[0]!.call('presented'); await overlays[1]!.call('presented')
  expect(overlays[0]!.window.focus, 'Enter and the arrows reach the remembered selection, not the display under the pointer').toHaveBeenCalledOnce()
  expect(overlays[1]!.window.focus).not.toHaveBeenCalled()
})

it('the chosen initial background delivers its own pixels, timestamp and engine', async () => {
  const first = frames(), second = frames(); second.capturedAt += 50
  second.displays[0] = { ...second.displays[0]!, png: png(8, 6).toString('base64'), engine: 'excluded-engine', windows: [] }
  // Make a visible host so both physical exposures are needed.
  electron.workbench = [{ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, getOpacity: () => 0.7, setOpacity: vi.fn() }]
  const captureDisplays = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
  ports.native.mockReturnValue({ captureDisplays })
  const value = session({ background: 'excluded' }), outcome = surface.present(value)
  await vi.advanceTimersByTimeAsync(0)
  const window = electron.windows[0]!, event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const invoke = (action: string, params: unknown = {}) => electron.handlers.get(CAPTURE_SURFACE_CHANNEL)!(event, action, params)
  const input = await invoke('load')
  expect(input.background).toBe('excluded')
  expect(input.backgrounds.included.windows).not.toEqual(input.backgrounds.excluded.windows)
  await invoke('select', { requestId: input.requestId })
  await expect(invoke('finish', { requestId: input.requestId, background: 'included', image: result, selection })).rejects.toThrow('background changed')
  expect(value.complete).not.toHaveBeenCalled()
  await invoke('finish', { requestId: input.requestId, background: 'excluded', image: result, selection })
  expect(value.complete).toHaveBeenCalledExactlyOnceWith(result, expect.objectContaining({ capturedAt: second.capturedAt }), 'excluded-engine')
  expect(await outcome).toEqual({ state: 'completed' })
})

it('a failed requested exposure preserves the original mode and offers the other usable background', async () => {
  electron.workbench = [{ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, getOpacity: () => 1, setOpacity: vi.fn() }]
  ports.native.mockReturnValue({ captureDisplays: vi.fn().mockRejectedValueOnce(new Error('first exposure denied')).mockResolvedValueOnce(frames()) })
  const outcome = surface.present(session())
  void outcome.catch(() => {})
  await vi.advanceTimersByTimeAsync(0)
  expect(electron.windows, 'the healthy exposure still opens its overlays').toHaveLength(2)
  const window = electron.windows[0]!, event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const input = await electron.handlers.get(CAPTURE_SURFACE_CHANNEL)!(event, 'load')
  expect(input.background, 'a failed source never silently replaces the requested exposure').toBe('included')
  expect(await electron.handlers.get(CAPTURE_SURFACE_CHANNEL)!(event, 'select', { requestId: input.requestId })).toBe(false)
  await electron.handlers.get(CAPTURE_SURFACE_CHANNEL)!(event, 'switch-background', { requestId: input.requestId, background: 'excluded' })
  expect(window.webContents.send).toHaveBeenCalledWith(CAPTURE_SURFACE_EVENT, { kind: 'background', background: 'excluded' })
  expect(input.backgrounds.included).toMatchObject({ issue: 'first exposure denied' })
  expect(input.backgrounds.excluded.image).toBeDefined()
  await electron.handlers.get(CAPTURE_SURFACE_CHANNEL)!(event, 'cancel', { requestId: input.requestId })
  expect(await outcome).toEqual({ state: 'cancelled' })
})

it('an unavailable requested excluded background never silently substitutes included pixels', async () => {
  electron.workbench = [{ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, getOpacity: () => 1, setOpacity: vi.fn() }]
  ports.native.mockReturnValue({ captureDisplays: vi.fn().mockResolvedValueOnce(frames()).mockRejectedValueOnce(new Error('native excluded background unavailable')) })
  const { overlays } = await opened(session({ background: 'excluded' }))
  const input = overlays[0]!.input
  expect(input.background).toBe('excluded')
  expect(input.backgrounds.excluded.image).toBeUndefined()
  expect(input.backgrounds.excluded.issue).toBe('native excluded background unavailable')
  expect(input.backgrounds.included.image).toBeDefined()
  expect(await overlays[0]!.call('select'), 'the requested but unavailable source cannot be selected').toBe(false)
  await overlays[0]!.call('switch-background', { background: 'included' })
  expect(await overlays[0]!.call('select'), 'only an explicit background change selects the healthy included source').toBe(true)
})

it('a cancelled older delivery cannot overwrite a newer capture selection', async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const first = await opened(session({ complete: async () => held }))
  await first.overlays[0]!.call('select')
  const late = first.overlays[0]!.call('finish', { image: result, selection })
  await first.overlays[0]!.call('cancel'); await first.outcome
  const newer = { x: 0, y: 0, width: 4, height: 2 }
  await delivered(0, newer)
  release(); await late
  const next = await opened()
  expect(next.overlays[0]!.input.initialCrop, 'only the current completed capture owns remembered selection').toEqual(newer)
})

it.each(['missing', 'scale'] as const)('rejects a %s display in the current frozen layout without touching host windows', async kind => {
  if (kind === 'missing') {
    const captured = frames(); captured.displays.pop()
    ports.native.mockReturnValue({ captureDisplays: vi.fn(async () => captured) })
  } else electron.displays[0]!.scaleFactor = 1
  const outcome = surface.present(session())
  void outcome.catch(() => {})
  await vi.advanceTimersByTimeAsync(0)
  expect(electron.windows, 'both prepared shells are accounted for').toHaveLength(2)
  expect(electron.windows.every(window => window.dead && !window.visible), 'mismatched frames never become visible overlays').toBe(true)
  await expect(outcome).rejects.toMatchObject({ code: 'display_configuration_changed' })
})

it('a locked issue display cannot replace the selected display background', async () => {
  const captured = frames(); captured.displays[1] = { ...captured.displays[1]!, png: undefined, width: undefined, height: undefined, engine: undefined, issue: 'side display unavailable' } as never
  electron.workbench = [{ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, getOpacity: () => 1, setOpacity: vi.fn() }]
  ports.native.mockReturnValue({ captureDisplays: vi.fn().mockResolvedValueOnce(captured).mockResolvedValueOnce(frames()) })
  const { overlays } = await opened(session())
  await overlays[0]!.call('select')
  await overlays[1]!.call('switch-background', { background: 'excluded' })
  expect(overlays[1]!.window.webContents.send).toHaveBeenCalledWith(CAPTURE_SURFACE_EVENT, expect.objectContaining({ kind: 'notice' }))
  expect(overlays[0]!.window.webContents.send).not.toHaveBeenCalledWith(CAPTURE_SURFACE_EVENT, expect.objectContaining({ kind: 'background' }))
})

it('the selected display switches only to the named frozen background without recapturing or changing opacity', async () => {
  const first = frames(), second = frames(); second.capturedAt += 50
  second.displays = second.displays.map(frame => ({ ...frame, engine: 'excluded-engine', windows: [] }))
  const host = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, getOpacity: () => .65, setOpacity: vi.fn() }
  electron.workbench = [host]
  const captureDisplays = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
  ports.native.mockReturnValue({ captureDisplays })
  const { overlays, session: value } = await opened(session())
  await overlays[0]!.call('select')
  await overlays[0]!.call('switch-background', { background: 'included' })
  expect(overlays[0]!.window.webContents.send).toHaveBeenLastCalledWith(CAPTURE_SURFACE_EVENT, { kind: 'background', background: 'included' })
  await overlays[0]!.call('switch-background', { background: 'excluded' })
  for (const overlay of overlays) expect(overlay.window.webContents.send).toHaveBeenLastCalledWith(CAPTURE_SURFACE_EVENT, { kind: 'background', background: 'excluded' })
  expect(captureDisplays, 'switching consumes the two original exposures').toHaveBeenCalledTimes(2)
  expect(host.setOpacity, 'switching never changes the window stack or transparency').not.toHaveBeenCalled()
  await expect(overlays[0]!.call('finish', { background: 'excluded', image: result, selection })).resolves.toEqual({ status: 'completed' })
  expect(value.complete).toHaveBeenCalledWith(result, expect.objectContaining({ capturedAt: second.capturedAt }), 'excluded-engine')
})

it('a missing target background keeps the selected display finishable on its original source', async () => {
  const first = frames(), second = frames()
  second.displays[0] = { ...second.displays[0]!, issue: 'excluded display unavailable', png: undefined, engine: undefined } as never
  electron.workbench = [{ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, getOpacity: () => 1, setOpacity: vi.fn() }]
  const captureDisplays = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
  ports.native.mockReturnValue({ captureDisplays })
  const { overlays } = await opened(session())
  await overlays[0]!.call('select')
  await overlays[0]!.call('switch-background', { background: 'excluded' })
  expect(overlays[0]!.window.webContents.send).toHaveBeenLastCalledWith(CAPTURE_SURFACE_EVENT, { kind: 'notice', message: 'excluded display unavailable' })
  expect(captureDisplays).toHaveBeenCalledTimes(2)
  await expect(overlays[0]!.call('finish', { image: result, selection })).resolves.toEqual({ status: 'completed' })
})

it('an in-flight primary output keeps its original background until completion', async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const { overlays } = await opened(session({ complete: async () => held }))
  await overlays[0]!.call('select')
  const output = overlays[0]!.call('finish', { image: result, selection })
  await overlays[0]!.call('switch-background', { background: 'excluded' })
  expect(overlays[0]!.window.webContents.send).toHaveBeenLastCalledWith(CAPTURE_SURFACE_EVENT, expect.objectContaining({ kind: 'notice', message: expect.stringContaining('output is still in progress') }))
  release(); await expect(output).resolves.toEqual({ status: 'completed' })
})

it('an invalid background choice refuses only that request and keeps the current capture healthy', async () => {
  const { overlays } = await opened()
  await expect(overlays[0]!.call('switch-background', { background: 'unknown' })).rejects.toThrow('exact frozen screenshot background')
  await overlays[0]!.call('select')
  await expect(overlays[0]!.call('finish', { image: result, selection })).resolves.toEqual({ status: 'completed' })
})
