import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ScreenshotSourcePicker } from '../src/main/screenshot-source-picker'

const electron = vi.hoisted(() => ({ handler: null as null | ((...args: any[]) => Promise<any>), windows: [] as any[] }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return { nativeTheme: { shouldUseDarkColors: true }, ipcMain: { handle: (_: string, handler: any) => { electron.handler = handler }, removeHandler: () => { electron.handler = null } },
    BrowserWindow: class extends EventEmitter {
      dead = false
      webContents = Object.assign(new EventEmitter(), { mainFrame: {}, setWindowOpenHandler: vi.fn() })
      show = vi.fn(); focus = vi.fn()
      constructor(readonly options: unknown) { super(); electron.windows.push(this) }
      loadFile = vi.fn(async () => { this.emit('ready-to-show') }); loadURL = this.loadFile
      isDestroyed() { return this.dead }
      close() { this.destroy() }
      destroy() { if (!this.dead) { this.dead = true; this.emit('closed') } }
    } }
})
let owner: ScreenshotSourcePicker
const request = vi.fn()
beforeEach(() => { electron.windows = []; request.mockReset(); owner = new ScreenshotSourcePicker({ native: () => ({ request }) as any, appearance: () => ({ terminalTheme: 'graphite' }) }) })
afterEach(() => owner.dispose())
async function open(kind: 'display' | 'window') {
  const selected = owner.choose(kind), window = electron.windows.at(-1)
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const call = (action: string, input?: unknown, sender = event) => electron.handler!(sender, action, input)
  const input = await call('load')
  return { selected, window, call, input }
}

it('selects the exact original display key rather than the first or similarly labelled display', async () => {
  request.mockResolvedValue({ displays: [{ id: 34, width: 1440, height: 900, scale: 2, isMain: true }, { id: 90, width: 1280, height: 800, scale: 1, isMain: false }] })
  const current = await open('display'), list = await current.call('list', { requestId: current.input.requestId })
  expect(list.choices).toHaveLength(2)
  expect(list.choices[0].detail).toContain('2880 × 1800 px')
  await current.call('select', { requestId: current.input.requestId, key: list.choices[1].key })
  expect(await current.selected, 'the selected key must preserve its exact OS display identity').toEqual({ mode: 'display', displayId: 90 })
  expect(current.window.dead).toBe(true)
})

it('keeps process birth and window identity across same-name applications', async () => {
  request.mockImplementation(async (method, input) => method === 'listApps' ? { apps: [
    { name: 'Editor', pid: 40, processStartedAt: 100 }, { name: 'Editor', pid: 60, processStartedAt: 200 }
  ] } : { windows: [{ id: input.app === 'pid:60' ? 900 : 800, title: 'Untitled', width: 700, height: 500 }] })
  const current = await open('window'), apps = await current.call('list', { requestId: current.input.requestId })
  const windows = await current.call('windows', { requestId: current.input.requestId, key: apps.choices[1].key })
  expect(request).toHaveBeenLastCalledWith('listWindows', { app: 'pid:60', processStartedAt: 200 })
  await current.call('select', { requestId: current.input.requestId, key: windows.choices[0].key })
  expect(await current.selected).toEqual({ mode: 'window', app: 'pid:60', processStartedAt: 200, windowId: 900 })
})

it('rejects stale source requests and embedded frames without changing a healthy selection', async () => {
  const current = await open('display')
  await expect(current.call('list', { requestId: 'old-request' })).rejects.toThrow('no longer current')
  await expect(current.call('load', undefined, { sender: current.window.webContents, senderFrame: {} })).rejects.toThrow('original window')
  expect(request).not.toHaveBeenCalled()
  expect(current.window.dead).toBe(false)
  await current.call('cancel', { requestId: current.input.requestId })
  expect(await current.selected).toBe(null)
})

it('allows source cancellation while an original discovery read remains pending', async () => {
  let release!: (value: unknown) => void
  request.mockReturnValue(new Promise(done => { release = done }))
  const current = await open('display'), reading = current.call('list', { requestId: current.input.requestId })
  await current.call('cancel', { requestId: current.input.requestId })
  expect(await current.selected).toBe(null)
  release({ displays: [{ id: 90, width: 1280, height: 800, scale: 1, isMain: false }] })
  await reading
  expect(current.window.dead).toBe(true)
  expect(electron.windows).toHaveLength(1)
})

it('keeps healthy display sources when another has incomplete geometry', async () => {
  request.mockResolvedValue({ displays: [{ id: 34, width: 1000, height: 800, scale: 1 }, { id: 50, width: 0, height: 800, scale: 2 }] })
  const current = await open('display'), list = await current.call('list', { requestId: current.input.requestId })
  expect(list.choices).toHaveLength(1); expect(list.issues).toHaveLength(1)
  expect(current.window.dead).toBe(false)
})
