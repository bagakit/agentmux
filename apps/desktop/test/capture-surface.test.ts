import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { crc32, deflateSync } from 'node:zlib'
import { CaptureSurface, type CaptureSurfaceSession } from '../src/main/capture-surface'
import { CAPTURE_SURFACE_CHANNEL, CAPTURE_SURFACE_EVENT } from '../src/shared/capture-surface'
import { pngFromBytes } from '@agentmux/native-desktop/image'

const electron = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => Promise<any>>(), windows: [] as any[], workbench: [] as any[],
  displays: [] as Array<{ id: number; bounds: { x: number; y: number; width: number; height: number } }>, cursor: { x: 0, y: 0 },
  screenListeners: new Map<string, Array<(...args: any[]) => void>>(), appListeners: new Map<string, Array<() => void>>(), focus: vi.fn(),
  focused: null as unknown, saves: [] as unknown[] }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Window extends EventEmitter {
    dead = false; visible = false; opacity = 1
    webContents = Object.assign(new EventEmitter(), { mainFrame: {}, setWindowOpenHandler: vi.fn(), send: vi.fn() })
    show = vi.fn(() => { this.visible = true }); showInactive = vi.fn(() => { this.visible = true }); focus = vi.fn()
    setAlwaysOnTop = vi.fn(); setVisibleOnAllWorkspaces = vi.fn(); setBounds = vi.fn()
    setOpacity = vi.fn((value: number) => { this.opacity = value })
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
const frames = () => ({ state: 'captured' as const, capturedAt: 1_700_000_000_000, displays: [
  { displayId: 1, frame: main, scale: 2, isMain: true, png: png(8, 6).toString('base64'), width: 8, height: 6, engine: 'fixture-engine' },
  { displayId: 7, frame: side, scale: 1, isMain: false, png: png(2, 2).toString('base64'), width: 2, height: 2, engine: 'fixture-engine' }] })
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
  electron.displays = [{ id: 1, bounds: main }, { id: 7, bounds: side }]
  ports = makePorts()
  surface = new CaptureSurface(ports)
})
afterEach(() => { surface.dispose(); vi.useRealTimers() })

function session(overrides: Partial<CaptureSurfaceSession> = {}): CaptureSurfaceSession {
  return { attachToDraft: true, expandable: true, returnFocus: false, complete: vi.fn(async () => {}), ...overrides }
}
async function opened(value = session()) {
  const outcome = surface.present(value)
  await vi.advanceTimersByTimeAsync(0)
  const overlays = await Promise.all(electron.windows.map(async window => {
    const call = (action: string, params: Record<string, unknown> = {}, event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }) =>
      electron.handlers.get(CAPTURE_SURFACE_CHANNEL)!(event, action, { requestId: input.requestId, ...params })
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
  expect(overlays[0]!.input).toMatchObject({ frame: main, scale: 2, attachToDraft: true, expandable: true, image: { width: 8, height: 6 } })
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
  expect(await outcome).toEqual({ state: 'completed' })
  expect(overlays.every(row => row.window.dead)).toBe(true)
})

it('a failed primary delivery keeps every overlay and reports the reason', async () => {
  const complete = vi.fn(async () => { throw new Error('Clipboard copy was not confirmed') })
  const { overlays } = await opened(session({ complete }))
  await overlays[0]!.call('select')
  expect(await overlays[0]!.call('finish', { image: result, selection })).toEqual({ status: 'failed', message: 'Clipboard copy was not confirmed' })
  expect(overlays.some(row => row.window.dead)).toBe(false)
})

it('Pin and Save PNG act on the selection and keep the overlays', async () => {
  const { overlays } = await opened()
  await overlays[0]!.call('select')
  await overlays[0]!.call('pin', { operationId: 'pin-1', image: result, selection })
  expect(ports.pin).toHaveBeenCalledExactlyOnceWith(result, 'pin-1', { x: 1, y: 1, width: 2, height: 1 })
  expect(await overlays[0]!.call('save-png', { image: result })).toEqual({ status: 'saved', path: '/chosen/shot.png' })
  expect(electron.saves).toEqual([[result, overlays[0]!.window, { capturedAt: 1_700_000_000_000 }]])
  expect(overlays.some(row => row.window.dead)).toBe(false)
})

it('expand ends the surface with the full frozen frame, the selection and the marks', async () => {
  const { overlays, outcome } = await opened()
  await overlays[0]!.call('select')
  const handoff = { shapes: [{ id: 'r', kind: 'rect' }], crop: selection, tool: 'rect' }
  await overlays[0]!.call('expand', { handoff })
  expect(await outcome).toEqual({ state: 'expanded', image: overlays[0]!.input.image, handoff,
    source: { rect: { x: 1, y: 1, width: 2, height: 1 }, scale: 2, capturedAt: 1_700_000_000_000 } })
  expect(overlays.every(row => row.window.dead)).toBe(true)
  expect(ports.returnFocus, 'the window editor takes over focus').not.toHaveBeenCalled()
})

it('Esc on any display cancels and closes every overlay', async () => {
  const { overlays, outcome } = await opened()
  await overlays[0]!.call('select')
  await overlays[1]!.call('cancel')
  expect(await outcome).toEqual({ state: 'cancelled' })
  expect(overlays.every(row => row.window.dead)).toBe(true)
})

it('a display without pixels shows its issue, cannot select, and the others stay selectable', async () => {
  const issued = frames()
  issued.displays[1] = { displayId: 7, frame: side, scale: 1, isMain: false, issue: 'macOS did not confirm this display' } as never
  ports.native.mockReturnValue({ captureDisplays: vi.fn(async () => issued) })
  const { overlays } = await opened()
  expect(overlays[1]!.input).toMatchObject({ issue: 'macOS did not confirm this display' })
  expect(overlays[1]!.input.image).toBeUndefined()
  expect(await overlays[1]!.call('select')).toBe(false)
  expect(await overlays[0]!.call('select')).toBe(true)
})

it('a display layout change ends the capture, while a work area change keeps it', async () => {
  const { overlays, outcome } = await opened()
  for (const listener of electron.screenListeners.get('display-metrics-changed')!) listener({}, {}, ['workArea'])
  expect(overlays.some(row => row.window.dead)).toBe(false)
  for (const listener of electron.screenListeners.get('display-metrics-changed')!) listener({}, {}, ['scaleFactor'])
  await expect(outcome).rejects.toMatchObject({ code: 'display_configuration_changed' })
  expect(overlays.every(row => row.window.dead)).toBe(true)
})

it('a crashed overlay renderer ends the capture', async () => {
  const { overlays, outcome } = await opened()
  overlays[1]!.window.webContents.emit('render-process-gone')
  await expect(outcome).rejects.toThrow('stopped responding')
  expect(overlays.every(row => row.window.dead)).toBe(true)
})

it('fades visible AgentMux windows out of the grab and restores them when the surface ends', async () => {
  const { EventEmitter } = await import('node:events')
  const workbench = Object.assign(new EventEmitter(), { dead: false, opacity: 1, isDestroyed: () => false, isVisible: () => true, isMinimized: () => false,
    focus: vi.fn(), setOpacity: vi.fn((value: number) => { workbench.opacity = value }) })
  const hidden = Object.assign(new EventEmitter(), { isDestroyed: () => false, isVisible: () => false, isMinimized: () => false, setOpacity: vi.fn() })
  electron.workbench = [workbench, hidden]; electron.focused = workbench
  const captureDisplays = vi.fn(async () => { expect(workbench.opacity, 'faded before the grab').toBe(0); return frames() })
  ports.native.mockReturnValue({ captureDisplays })
  const outcome = surface.present(session())
  await vi.advanceTimersByTimeAsync(299)
  expect(captureDisplays, 'macOS settles the fade before the grab').not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(captureDisplays).toHaveBeenCalledOnce()
  expect(hidden.setOpacity, 'a hidden window is not touched').not.toHaveBeenCalled()
  await electron.handlers.get(CAPTURE_SURFACE_CHANNEL)!({ sender: electron.windows[0]!.webContents, senderFrame: electron.windows[0]!.webContents.mainFrame }, 'cancel',
    { requestId: (await electron.handlers.get(CAPTURE_SURFACE_CHANNEL)!({ sender: electron.windows[0]!.webContents, senderFrame: electron.windows[0]!.webContents.mainFrame }, 'load')).requestId })
  await outcome
  expect(workbench.opacity).toBe(1)
  expect(workbench.focus, 'the window that had focus gets it back').toHaveBeenCalledOnce()
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
  await expect(surface.present(session())).rejects.toThrow('already in progress')
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
  await expect(handler(event, 'expand', { requestId: input.requestId, handoff: { shapes: [], crop: selection, tool: 'rect' } })).rejects.toThrow('returns its selection directly')
  await handler(event, 'finish', { requestId: input.requestId, image: result, selection })
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
