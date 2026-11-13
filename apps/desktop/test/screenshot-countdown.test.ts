import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ScreenshotCountdown } from '../src/main/screenshot-countdown'
import { SCREENSHOT_COUNTDOWN_TICK } from '../src/shared/screenshot-countdown'

const electron = vi.hoisted(() => ({ handler: null as null | ((...args: any[]) => unknown), windows: [] as any[],
  shortcuts: new Map<string, () => void>(), escapeTaken: false }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    nativeTheme: { shouldUseDarkColors: true },
    ipcMain: { handle: (_: string, handler: any) => { electron.handler = handler }, removeHandler: () => { electron.handler = null } },
    globalShortcut: {
      register: (key: string, callback: () => void) => { if (electron.escapeTaken) return false; electron.shortcuts.set(key, callback); return true },
      unregister: (key: string) => { electron.shortcuts.delete(key) }
    },
    screen: { getCursorScreenPoint: () => ({ x: 2000, y: 10 }), getDisplayNearestPoint: () => ({ workArea: { x: 1440, y: 0, width: 1920, height: 1080 } }) },
    BrowserWindow: class extends EventEmitter {
      dead = false
      webContents = Object.assign(new EventEmitter(), { mainFrame: {}, setWindowOpenHandler: vi.fn(), send: vi.fn() })
      showInactive = vi.fn(); show = vi.fn(); focus = vi.fn(); setAlwaysOnTop = vi.fn(); setVisibleOnAllWorkspaces = vi.fn()
      constructor(readonly options: any) { super(); electron.windows.push(this) }
      loadFile = vi.fn(async () => { this.webContents.emit('did-finish-load') }); loadURL = this.loadFile
      isDestroyed() { return this.dead }
      destroy() { if (!this.dead) { this.dead = true; this.emit('closed') } }
    }
  }
})

let owner: ScreenshotCountdown
beforeEach(() => { vi.useFakeTimers(); electron.windows = []; electron.shortcuts.clear(); electron.escapeTaken = false; owner = new ScreenshotCountdown(() => ({ terminalTheme: 'graphite' })) })
afterEach(() => { owner.dispose(); vi.useRealTimers() })
const ticks = (window: any) => window.webContents.send.mock.calls.filter(([channel]: [string]) => channel === SCREENSHOT_COUNTDOWN_TICK).map(([, seconds]: [string, number]) => seconds)

it('counts down each second in an unfocusable window at the bottom of the pointer display, then starts selection', async () => {
  const waiting = owner.wait(3), window = electron.windows[0]
  expect(window.options).toMatchObject({ focusable: false, frame: false, transparent: true, alwaysOnTop: true, show: false, skipTaskbar: true,
    x: 1440 + (1920 - 176) / 2, y: 1080 - 132 - 48 })
  // Without skipTransformProcessType Electron turns the whole app into a UIElement and the Dock icon never returns.
  expect(window.setVisibleOnAllWorkspaces).toHaveBeenCalledExactlyOnceWith(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  await vi.advanceTimersByTimeAsync(0)
  expect(window.showInactive, 'the countdown never takes focus from the app being captured').toHaveBeenCalledOnce()
  expect(window.show).not.toHaveBeenCalled(); expect(window.focus).not.toHaveBeenCalled()
  const load = () => electron.handler!({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, 'load') as { seconds: number }
  expect(load().seconds, 'the page reads the full delay when it loads').toBe(3)
  expect(ticks(window)).toEqual([])
  await vi.advanceTimersByTimeAsync(2000)
  expect(ticks(window)).toEqual([2, 1])
  expect(load().seconds).toBe(1)
  let settled = false; void waiting.then(() => { settled = true })
  await vi.advanceTimersByTimeAsync(999)
  expect(settled, 'selection does not start before the full delay').toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await expect(waiting).resolves.toBe(true)
  expect(window.dead, 'the countdown closes before selection starts').toBe(true)
  expect(electron.shortcuts.has('Escape'), 'Esc is released with the countdown').toBe(false)
})

it('Cancel, Esc and closing the window each resolve without starting selection', async () => {
  const cancelled = owner.wait(5), first = electron.windows[0]
  await vi.advanceTimersByTimeAsync(1000)
  electron.handler!({ sender: first.webContents, senderFrame: first.webContents.mainFrame }, 'cancel')
  await expect(cancelled).resolves.toBe(false)
  expect(first.dead).toBe(true)

  const escaped = owner.wait(10)
  await vi.advanceTimersByTimeAsync(0)
  electron.shortcuts.get('Escape')!()
  await expect(escaped).resolves.toBe(false)
  expect(electron.shortcuts.has('Escape')).toBe(false)

  const closed = owner.wait(3), third = electron.windows[2]
  await vi.advanceTimersByTimeAsync(0)
  third.destroy()
  await expect(closed).resolves.toBe(false)
  await vi.advanceTimersByTimeAsync(5000)
  expect(ticks(third), 'a cancelled countdown never ticks again').toEqual([])
})

it('accepts only the exact countdown window, one countdown at a time and listed delays', async () => {
  await expect(owner.wait(4 as never)).rejects.toThrow('3, 5 or 10')
  const waiting = owner.wait(3), window = electron.windows[0]
  await expect(owner.wait(5)).rejects.toThrow('already running')
  expect(() => electron.handler!({ sender: {}, senderFrame: window.webContents.mainFrame }, 'cancel'), 'another sender with a borrowed frame').toThrow('current countdown window')
  expect(() => electron.handler!({ sender: window.webContents, senderFrame: {} }, 'cancel')).toThrow('current countdown window')
  expect(() => electron.handler!({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, 'start')).toThrow('invalid')
  expect(window.dead).toBe(false)
  await vi.advanceTimersByTimeAsync(3000)
  await expect(waiting).resolves.toBe(true)
})

it('keeps Cancel when another owner holds Esc and leaves that owner registered', async () => {
  electron.escapeTaken = true
  const waiting = owner.wait(3), window = electron.windows[0]
  await vi.advanceTimersByTimeAsync(3000)
  await expect(waiting).resolves.toBe(true)
  expect(window.dead).toBe(true)
  const unregister = vi.spyOn((await import('electron')).globalShortcut, 'unregister')
  const second = owner.wait(3); await vi.advanceTimersByTimeAsync(3000); await second
  expect(unregister, 'Esc it never registered is not removed').not.toHaveBeenCalled()
})
