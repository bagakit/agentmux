import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ScreenshotSourcePicker } from '../src/main/screenshot-source-picker'

const electron = vi.hoisted(() => ({ handler: null as null | ((...args: any[]) => Promise<any>), windows: [] as any[], resized: [] as unknown[] }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return { nativeTheme: { shouldUseDarkColors: true },
    nativeImage: { createFromBuffer: (bytes: Buffer) => ({ isEmpty: () => bytes.length === 0, resize: (options: { width: number }) => {
      electron.resized.push(options); return { getSize: () => ({ width: options.width, height: 150 }), toDataURL: () => 'data:image/png;base64,' + bytes.toString('base64') } } }) },
    ipcMain: { handle: (_: string, handler: any) => { electron.handler = handler }, removeHandler: () => { electron.handler = null } },
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
const request = vi.fn(), captureScreenshot = vi.fn()
beforeEach(() => {
  electron.windows = []; electron.resized = []; request.mockReset(); captureScreenshot.mockReset()
  captureScreenshot.mockImplementation(async (target: { displayId?: number; windowId?: number }) =>
    ({ state: 'captured', screenshot: { format: 'png', data: Buffer.from('pixels-' + (target.displayId ?? target.windowId)).toString('base64'), width: 480, height: 300, scale: 2 } }))
  owner = new ScreenshotSourcePicker({ native: () => ({ request, captureScreenshot }) as any, appearance: () => ({ terminalTheme: 'graphite' }) })
})
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

const pixels = (id: number) => 'data:image/png;base64,' + Buffer.from('pixels-' + id).toString('base64')

it('previews each listed display through its exact native identity at 240 px, once per key', async () => {
  request.mockResolvedValue({ displays: [{ id: 34, width: 1440, height: 900, scale: 2, isMain: true }, { id: 90, width: 1280, height: 800, scale: 1 }] })
  const current = await open('display'), list = await current.call('list', { requestId: current.input.requestId })
  expect(list.choices.map((choice: { preview: boolean }) => choice.preview)).toEqual([true, true])
  const second = await current.call('thumbnail', { requestId: current.input.requestId, key: list.choices[1].key })
  expect(second).toEqual({ dataUrl: pixels(90), width: 240, height: 150 })
  expect(captureScreenshot).toHaveBeenCalledExactlyOnceWith({ mode: 'display', displayId: 90 })
  expect(electron.resized).toEqual([{ width: 240, quality: 'good' }])
  expect(await current.call('thumbnail', { requestId: current.input.requestId, key: list.choices[1].key }), 'a repeated read reuses the one capture').toEqual(second)
  expect(captureScreenshot).toHaveBeenCalledOnce()
  await expect(current.call('thumbnail', { requestId: current.input.requestId, key: 'made-up' })).rejects.toThrow('exact source')
  await expect(current.call('thumbnail', { requestId: 'old-request', key: list.choices[0].key })).rejects.toThrow('no longer current')
  expect(captureScreenshot).toHaveBeenCalledOnce()
})

it('runs at most four thumbnail captures at once and previews only the first twelve windows', async () => {
  const windows = Array.from({ length: 14 }, (_, index) => ({ id: 500 + index, title: 'Window ' + index, width: 800, height: 500 }))
  request.mockImplementation(async (method: string) => method === 'listApps' ? { apps: [{ name: 'Editor', pid: 40, processStartedAt: 100 }] } : { windows })
  const current = await open('window'), apps = await current.call('list', { requestId: current.input.requestId })
  expect(apps.choices[0].preview, 'application rows have no preview').toBe(false)
  await expect(current.call('thumbnail', { requestId: current.input.requestId, key: apps.choices[0].key })).rejects.toThrow('exact source')
  const list = await current.call('windows', { requestId: current.input.requestId, key: apps.choices[0].key })
  expect(list.choices.filter((choice: { preview: boolean }) => choice.preview)).toHaveLength(12)
  expect(list.choices.at(-1).preview).toBe(false)
  let active = 0, peak = 0
  const releases: Array<() => void> = []
  captureScreenshot.mockImplementation(async (target: { windowId: number }) => {
    active++; peak = Math.max(peak, active)
    await new Promise<void>(resolve => releases.push(resolve))
    active--
    return { state: 'captured', screenshot: { format: 'png', data: Buffer.from('pixels-' + target.windowId).toString('base64'), width: 800, height: 500, scale: 1 } }
  })
  const reads = list.choices.slice(0, 6).map((choice: { key: string }) => current.call('thumbnail', { requestId: current.input.requestId, key: choice.key }))
  await vi.waitFor(() => expect(captureScreenshot).toHaveBeenCalledTimes(4))
  expect(active).toBe(4)
  while (releases.length) { releases.shift()!(); await new Promise(resolve => setTimeout(resolve, 0)) }
  await vi.waitFor(() => expect(captureScreenshot).toHaveBeenCalledTimes(6))
  while (releases.length) { releases.shift()!(); await new Promise(resolve => setTimeout(resolve, 0)) }
  const results = await Promise.all(reads)
  expect(peak).toBe(4)
  expect(results.map((result: { dataUrl: string }) => result.dataUrl)).toEqual(windows.slice(0, 6).map(row => pixels(row.id)))
  expect(captureScreenshot.mock.calls.map(([target]) => target)).toEqual(windows.slice(0, 6).map(row => ({ mode: 'window', app: 'pid:40', processStartedAt: 100, windowId: row.id })))
})

it('a failed, cancelled or empty preview is a placeholder and the source stays selectable', async () => {
  request.mockResolvedValue({ displays: [34, 35, 36, 37].map(id => ({ id, width: 1000, height: 600, scale: 1 })) })
  const current = await open('display'), list = await current.call('list', { requestId: current.input.requestId })
  captureScreenshot.mockRejectedValueOnce(new Error('Screen Recording permission is missing'))
    .mockResolvedValueOnce({ state: 'failed', error: { code: 'denied', message: 'denied' } })
    .mockResolvedValueOnce({ state: 'captured', screenshot: { format: 'png', data: '', width: 1, height: 1, scale: 1 } })
  for (const choice of list.choices.slice(0, 3)) expect(await current.call('thumbnail', { requestId: current.input.requestId, key: choice.key })).toBeNull()
  expect(captureScreenshot).toHaveBeenCalledTimes(3)
  // Fill the four capture slots, queue one more, then choose a source: the queued preview never captures.
  const releases: Array<() => void> = []
  captureScreenshot.mockImplementation(() => new Promise(resolve => releases.push(() => resolve({ state: 'cancelled' }))))
  request.mockResolvedValueOnce({ displays: [40, 41, 42, 43].map(id => ({ id, width: 1000, height: 600, scale: 1 })) })
  const more = await current.call('list', { requestId: current.input.requestId })
  const busy = [list.choices[3], ...more.choices.slice(0, 3)].map((choice: { key: string }) => current.call('thumbnail', { requestId: current.input.requestId, key: choice.key }))
  await vi.waitFor(() => expect(releases).toHaveLength(4))
  const queued = current.call('thumbnail', { requestId: current.input.requestId, key: more.choices[3].key })
  await current.call('select', { requestId: current.input.requestId, key: list.choices[0].key })
  expect(await current.selected).toEqual({ mode: 'display', displayId: 34 })
  while (releases.length) releases.shift()!()
  await Promise.all(busy)
  expect(await queued, 'a preview queued before the source was chosen resolves as a placeholder').toBeNull()
  expect(captureScreenshot, 'no capture starts after the selection closed').toHaveBeenCalledTimes(7)
  expect(await current.call('thumbnail', { requestId: current.input.requestId, key: list.choices[3].key }).catch(() => 'refused'), 'a closed selection refuses new previews').toBe('refused')
})
