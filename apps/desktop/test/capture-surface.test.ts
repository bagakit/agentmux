import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { crc32, deflateSync } from 'node:zlib'
import { CaptureSurface, type CaptureSurfaceSession } from '../src/main/capture-surface'
import { CAPTURE_SURFACE_CHANNEL, CAPTURE_SURFACE_EVENT } from '../src/shared/capture-surface'
import { pngFromBytes } from '@agentmux/native-desktop/image'

const electron = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => Promise<any>>(), windows: [] as any[], workbench: [] as any[],
  displays: [] as Array<{ id: number; bounds: { x: number; y: number; width: number; height: number }; displayFrequency?: number; scaleFactor?: number }>, cursor: { x: 0, y: 0 },
  screenListeners: new Map<string, Array<(...args: any[]) => void>>(), appListeners: new Map<string, Array<() => void>>(), focus: vi.fn(),
  focused: null as unknown, saves: [] as unknown[] }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Window extends EventEmitter {
    dead = false; visible = false; opacity = 1
    webContents = Object.assign(new EventEmitter(), { mainFrame: {}, setWindowOpenHandler: vi.fn(), send: vi.fn() })
    show = vi.fn(() => { this.visible = true }); showInactive = vi.fn(() => { this.visible = true }); focus = vi.fn()
    setAlwaysOnTop = vi.fn(); setVisibleOnAllWorkspaces = vi.fn(); setBounds = vi.fn()
    setOpacity = vi.fn((value: number) => { this.opacity = value }); getOpacity = () => this.opacity
    loadFile = vi.fn(async () => { this.emit('ready-to-show') }); loadURL = this.loadFile
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
const frames = () => ({ state: 'captured' as const, capturedAt: 1_700_000_000_000, displays: [
  { displayId: 1, frame: main, scale: 2, safeTop: 0, windows: [front, across, beyond], png: png(8, 6).toString('base64'), width: 8, height: 6, engine: 'fixture-engine' },
  { displayId: 7, frame: side, scale: 1, safeTop: 0, windows: [across], png: png(2, 2).toString('base64'), width: 2, height: 2, engine: 'fixture-engine' }] })
const result = pngFromBytes(png(4, 2))

let surface: CaptureSurface, ports: ReturnType<typeof makePorts>
function makePorts() {
  return { native: vi.fn(() => ({ captureDisplays: vi.fn(async () => frames()) })), appearance: () => ({ terminalTheme: 'graphite' as const }),
    pin: vi.fn(async (..._args: unknown[]) => ({ state: 'open' } as never)), copyText: vi.fn(async (_text: string) => {}), returnFocus: vi.fn() }
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  electron.handlers.clear(); electron.windows = []; electron.workbench = []; electron.screenListeners.clear(); electron.appListeners.clear(); electron.saves = []
  electron.focus.mockClear(); electron.focused = null; electron.cursor = { x: -1, y: 0 }
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

it('fades visible AgentMux windows out of the grab and restores them when the surface ends', async () => {
  const { EventEmitter } = await import('node:events')
  const shown = (opacity: number) => {
    const window = Object.assign(new EventEmitter(), { dead: false, opacity, isDestroyed: () => false, isVisible: () => true, isMinimized: () => false,
      focus: vi.fn(), getOpacity: () => window.opacity, setOpacity: vi.fn((value: number) => { window.opacity = value }) })
    return window
  }
  // A pin the person set to 40%, and a window that is already fully transparent.
  const workbench = shown(1), pin = shown(0.4), clear = shown(0)
  const hidden = Object.assign(new EventEmitter(), { isDestroyed: () => false, isVisible: () => false, isMinimized: () => false, getOpacity: () => 1, setOpacity: vi.fn() })
  electron.workbench = [workbench, pin, clear, hidden]; electron.focused = workbench
  const opacityAtGrab: number[][] = []
  const captureDisplays = vi.fn(async () => { opacityAtGrab.push([workbench.opacity, pin.opacity]); return frames() })
  ports.native.mockReturnValue({ captureDisplays })
  const outcome = surface.present(session())
  await vi.advanceTimersByTimeAsync(33)
  expect(captureDisplays, 'the included exposure happens before fading').toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1)
  expect(captureDisplays, 'the excluded exposure waits only two compositor frames').toHaveBeenCalledTimes(2)
  expect(opacityAtGrab, 'each exposure has the right host opacity').toEqual([[1, 0.4], [0, 0]])
  expect(captureDisplays.mock.calls).toEqual([[{ includeHostWindows: true }], [{ includeHostWindows: false }]])
  expect(hidden.setOpacity, 'a hidden window is not touched').not.toHaveBeenCalled()
  expect(clear.setOpacity, 'a window already at opacity 0 is not touched').not.toHaveBeenCalled()
  await electron.handlers.get(CAPTURE_SURFACE_CHANNEL)!({ sender: electron.windows[0]!.webContents, senderFrame: electron.windows[0]!.webContents.mainFrame }, 'cancel',
    { requestId: (await electron.handlers.get(CAPTURE_SURFACE_CHANNEL)!({ sender: electron.windows[0]!.webContents, senderFrame: electron.windows[0]!.webContents.mainFrame }, 'load')).requestId })
  await outcome
  expect(workbench.opacity).toBe(1)
  expect(pin.opacity, 'a pin comes back at its own opacity, not 100%').toBe(0.4)
  expect(clear.opacity).toBe(0)
  expect(workbench.focus, 'the window that had focus gets it back').toHaveBeenCalledOnce()
})

it('grabs at once when no AgentMux window was on screen, and waits two frames of the slowest display when one was', async () => {
  const { EventEmitter } = await import('node:events')
  const captureDisplays = vi.fn(async () => frames())
  ports.native.mockReturnValue({ captureDisplays })
  // Hidden, minimized and already transparent windows are not in the grab, so they cost no settle.
  const quiet = (visible: boolean, minimized: boolean, opacity: number) => Object.assign(new EventEmitter(), { isDestroyed: () => false, isVisible: () => visible,
    isMinimized: () => minimized, getOpacity: () => opacity, setOpacity: vi.fn() })
  electron.workbench = [quiet(false, false, 1), quiet(true, true, 1), quiet(true, false, 0)]
  const first = surface.present(session())
  await vi.advanceTimersByTimeAsync(0)
  expect(captureDisplays, 'nothing faded, so the grab does not wait').toHaveBeenCalledOnce()
  expect(electron.windows, 'the same frozen frame is ready without a needless compositor wait').toHaveLength(2)
  const readyWindow = electron.windows[0]!
  let loaded = false
  void electron.handlers.get(CAPTURE_SURFACE_CHANNEL)!({ sender: readyWindow.webContents, senderFrame: readyWindow.webContents.mainFrame }, 'load').then(() => { loaded = true }, () => {})
  await vi.advanceTimersByTimeAsync(0)
  expect(loaded, 'the frozen input, not only an early native request, is ready at once').toBe(true)
  surface.dispose(); await first
  surface = new CaptureSurface(ports)
  electron.displays = [{ id: 1, bounds: main, scaleFactor: 2, displayFrequency: 120 }, { id: 7, bounds: side, scaleFactor: 1, displayFrequency: 30 }]
  electron.workbench = [quiet(true, false, 1)]
  const second = surface.present(session())
  await vi.advanceTimersByTimeAsync(66)
  expect(captureDisplays, 'only the included exposure is ready before two 30 Hz frames').toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(captureDisplays).toHaveBeenCalledTimes(3)
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
    expect(timing).toMatchObject({ settleMs: 0, displays: 2 })
    expect([timing.framesMs, ...timing.presentedMs, timing.shownMs].every((value: unknown) => typeof value === 'number' && value >= 0), JSON.stringify(timing)).toBe(true)
    expect(timing.presentedMs).toHaveLength(2)
  } finally { info.mockRestore() }
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
  await vi.advanceTimersByTimeAsync(34)
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
  await vi.advanceTimersByTimeAsync(34)
  expect(electron.windows, 'the healthy exposure still opens its overlays').toHaveLength(2)
  const window = electron.windows[0]!, event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const input = await electron.handlers.get(CAPTURE_SURFACE_CHANNEL)!(event, 'load')
  expect(input.background, 'a failed source never silently replaces the requested exposure').toBe('included')
  expect(await electron.handlers.get(CAPTURE_SURFACE_CHANNEL)!(event, 'select', { requestId: input.requestId })).toBe(false)
  await electron.handlers.get(CAPTURE_SURFACE_CHANNEL)!(event, 'switch-background', { requestId: input.requestId })
  expect(window.webContents.send).toHaveBeenCalledWith(CAPTURE_SURFACE_EVENT, { kind: 'background', background: 'excluded' })
  expect(input.backgrounds.included).toMatchObject({ issue: 'first exposure denied' })
  expect(input.backgrounds.excluded.image).toBeDefined()
  await electron.handlers.get(CAPTURE_SURFACE_CHANNEL)!(event, 'cancel', { requestId: input.requestId })
  expect(await outcome).toEqual({ state: 'cancelled' })
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

it.each(['missing', 'scale'] as const)('rejects a %s display in the current frozen layout without leaving faded windows', async kind => {
  if (kind === 'missing') {
    const captured = frames(); captured.displays.pop()
    ports.native.mockReturnValue({ captureDisplays: vi.fn(async () => captured) })
  } else electron.displays[0]!.scaleFactor = 1
  const outcome = surface.present(session())
  void outcome.catch(() => {})
  await vi.advanceTimersByTimeAsync(0)
  expect(electron.windows, 'mismatched frames never become overlays').toHaveLength(0)
  await expect(outcome).rejects.toMatchObject({ code: 'display_configuration_changed' })
})

it('a locked issue display cannot replace the selected display background', async () => {
  const captured = frames(); captured.displays[1] = { ...captured.displays[1]!, png: undefined, width: undefined, height: undefined, engine: undefined, issue: 'side display unavailable' } as never
  electron.workbench = [{ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, getOpacity: () => 1, setOpacity: vi.fn() }]
  ports.native.mockReturnValue({ captureDisplays: vi.fn().mockResolvedValueOnce(captured).mockResolvedValueOnce(frames()) })
  const { overlays } = await opened(session(), 34)
  await overlays[0]!.call('select')
  await overlays[1]!.call('switch-background')
  expect(overlays[1]!.window.webContents.send).toHaveBeenCalledWith(CAPTURE_SURFACE_EVENT, expect.objectContaining({ kind: 'notice' }))
  expect(overlays[0]!.window.webContents.send).not.toHaveBeenCalledWith(CAPTURE_SURFACE_EVENT, expect.objectContaining({ kind: 'background' }))
})
