import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SystemScreenshotEditor } from '../src/main/system-screenshot-editor'
import { SYSTEM_SCREENSHOT_EDITOR_CHANNEL } from '../src/shared/system-screenshot-editor'
import { pngFromBytes } from '@agentmux/native-desktop/image'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const native = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => Promise<any>>(), windows: [] as any[], savePath: null as string | null, saveCalls: 0,
  saveNames: [] as string[], resized: [] as Array<{ width: number; height: number }>, focused: null as unknown,
  displays: [] as Array<{ bounds: { x: number; y: number; width: number; height: number }; workArea: { x: number; y: number; width: number; height: number } }> }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    nativeTheme: { shouldUseDarkColors: true },
    dialog: { showSaveDialog: async (_parent: unknown, options: { defaultPath: string }) => { native.saveCalls++; native.saveNames.push(options.defaultPath); return { canceled: native.savePath === null, filePath: native.savePath } } },
    nativeImage: { createFromBuffer: (bytes: Buffer) => ({ resize: (size: { width: number; height: number }) => { native.resized.push(size); return { toPNG: () => bytes } } }) },
    screen: { getDisplayMatching: (rect: { x: number; y: number }) => native.displays.find(display => rect.x >= display.bounds.x && rect.x < display.bounds.x + display.bounds.width
      && rect.y >= display.bounds.y && rect.y < display.bounds.y + display.bounds.height) ?? native.displays[0] },
    ipcMain: { handle: (channel: string, handler: (...args: any[]) => Promise<any>) => native.handlers.set(channel, handler),
      removeHandler: (channel: string) => native.handlers.delete(channel) },
    BrowserWindow: class extends EventEmitter {
      dead = false
      static getFocusedWindow() { return native.focused }
      webContents = Object.assign(new EventEmitter(), { mainFrame: {}, setWindowOpenHandler: vi.fn(), send: vi.fn() })
      show = vi.fn(); focus = vi.fn()
      loadFile = vi.fn(async () => { this.emit('ready-to-show') })
      loadURL = this.loadFile
      constructor(readonly options: unknown) { super(); native.windows.push(this) }
      isDestroyed() { return this.dead }
      close() { this.emit('close'); this.destroy() }
      destroy() { if (this.dead) return; this.dead = true; this.emit('closed') }
    }
  }
})

const image = pngFromBytes(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cWZkAAAAASUVORK5CYII=', 'base64'))
let editor: SystemScreenshotEditor
beforeEach(() => {
  native.windows = []; native.handlers.clear(); native.savePath = null; native.saveCalls = 0; native.saveNames = []; native.resized = []; native.focused = null
  native.displays = [{ bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 875 } },
    { bounds: { x: 1440, y: -200, width: 2560, height: 1440 }, workArea: { x: 1440, y: -200, width: 2560, height: 1400 } }]
  editor = new SystemScreenshotEditor()
})
afterEach(() => editor.dispose())
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
type Marks = import('../src/shared/system-screenshot-editor').ScreenshotEditMarks
async function open(complete = vi.fn(async () => {}), attachToDraft = false, marks?: Marks, source?: import('../src/shared/system-screenshot-editor').ScreenshotCaptureSource, returnFocus = false) {
  const closed = editor.edit(image, attachToDraft, complete, { ...(marks ?? {}), ...(source ? { source } : {}), ...(returnFocus ? { returnFocus } : {}) })
  await Promise.resolve()
  const window = native.windows.at(-1)
  const call = (action: string, params?: unknown, event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }) =>
    native.handlers.get(SYSTEM_SCREENSHOT_EDITOR_CHANNEL)!(event, action, params)
  const input = await call('load')
  return { window, closed, input, call, complete }
}

it('loads only its independent sandboxed image window with the shared theme, exact attachment label and handed-over marks', async () => {
  const marks: Marks = { initialState: { shapes: [{ id: 'mark', kind: 'rect' }] as never, crop: { x: 0, y: 0, width: 1, height: 1 } }, initialTool: 'arrow' }
  const current = await open(undefined, true, marks)
  expect(current.input.image).toEqual(image)
  expect(current.input.attachToDraft).toBe(true)
  expect(current.input).toMatchObject(marks)
  expect(current.input.theme.status).toBe('available')
  expect(current.window.options).toMatchObject({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  expect(current.window.options).not.toHaveProperty('parent')
  expect(current.window.options.webPreferences.preload).toContain('screenshot-editor.cjs')
  expect(current.window.show).toHaveBeenCalledOnce()
  const navigation = { preventDefault: vi.fn() }; current.window.webContents.emit('will-navigate', navigation)
  expect(navigation.preventDefault).toHaveBeenCalledOnce()
  expect(current.window.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' })
  await current.call('cancel', { requestId: current.input.requestId }); await current.closed
})

it('rejects another window and an embedded frame before reading or delivering the original image', async () => {
  const current = await open()
  await expect(current.call('load', undefined, { sender: {}, senderFrame: current.window.webContents.mainFrame })).rejects.toThrow('current window')
  await expect(current.call('load', undefined, { sender: current.window.webContents, senderFrame: {} })).rejects.toThrow('current window')
  expect(current.complete).not.toHaveBeenCalled()
  expect(current.window.dead).toBe(false)
})

it('refuses stale request identities and malformed PNGs without taking away the current editor', async () => {
  const current = await open()
  await expect(current.call('finish', { requestId: 'older-request', operationId: 'original-copy', image })).rejects.toThrow('no longer current')
  await expect(current.call('cancel', { requestId: 'older-request' })).rejects.toThrow('no longer current')
  await expect(current.call('finish', { requestId: current.input.requestId, operationId: 'bad-image', image: { ...image, width: 9 } })).rejects.toThrow('dimensions')
  expect(current.complete).not.toHaveBeenCalled()
  expect(current.window.dead).toBe(false)
})

it('keeps the original editor after a failed delivery and after an explicit successful copy', async () => {
  const complete = vi.fn().mockRejectedValueOnce(new Error('Clipboard is unavailable')).mockResolvedValueOnce(undefined)
  const current = await open(complete)
  const first = { requestId: current.input.requestId, operationId: 'first-copy', image }
  expect(await current.call('finish', first)).toEqual({ status: 'failed', message: 'Clipboard is unavailable' })
  expect(current.window.dead, 'failed delivery must retain the exact original editor').toBe(false)
  expect(await current.call('finish', first)).toEqual({ status: 'failed', message: 'Clipboard is unavailable' })
  expect(complete).toHaveBeenCalledOnce()
  expect(await current.call('finish', { ...first, operationId: 'explicit-second-copy' })).toEqual({ status: 'completed' })
  await current.closed
  expect(complete).toHaveBeenCalledTimes(2)
  expect(complete).toHaveBeenLastCalledWith(image)
  expect(current.window.dead, 'successful Copy keeps editing and independent outputs available').toBe(false)
  await current.call('cancel', { requestId: current.input.requestId })
})

it('returns the original completion receipt for duplicate operation IDs without replaying delivery', async () => {
  const waiting = deferred(), current = await open(vi.fn(() => waiting.promise))
  const params = { requestId: current.input.requestId, operationId: 'original-copy', image }
  const first = current.call('finish', params), repeated = current.call('finish', params)
  expect(await current.call('finish', { ...params, operationId: 'other-copy' })).toMatchObject({ status: 'failed' })
  expect(current.complete).toHaveBeenCalledOnce()
  await expect(current.call('finish', { ...params, image: { ...image, width: 3 } })).rejects.toThrow('cannot change its image')
  waiting.resolve()
  expect(await first).toEqual({ status: 'completed' })
  expect(await repeated, 'the original duplicate copy must receive the same successful receipt').toEqual({ status: 'completed' })
  await current.closed
  expect(current.window.dead).toBe(false)
  await current.call('cancel', { requestId: current.input.requestId })
})

it('allows Cancel during delivery and an earlier late result never closes the newer editor', async () => {
  const waiting = deferred(), first = await open(vi.fn(() => waiting.promise))
  const completion = first.call('finish', { requestId: first.input.requestId, operationId: 'original-copy', image })
  await first.call('cancel', { requestId: first.input.requestId }); await first.closed
  const second = await open()
  waiting.resolve(); await completion
  expect(second.window.dead, 'an earlier late delivery cannot close the newer image').toBe(false)
  expect(second.complete).not.toHaveBeenCalled()
  expect(await second.call('load')).toEqual(second.input)
})

it('keeps a copied image editable while another original capture opens its own editor', async () => {
  const first = await open()
  await first.call('finish', { requestId: first.input.requestId, operationId: 'first-completed-copy', image })
  await first.closed
  const second = await open()
  expect(first.window.dead, 'a completed Copy must not discard the retained image').toBe(false)
  expect(second.window.dead, 'a retained image must not prevent the next healthy capture editor').toBe(false)
  expect(await first.call('load')).toEqual(first.input)
  expect(await second.call('load')).toEqual(second.input)
  await first.call('cancel', { requestId: first.input.requestId })
  expect(second.window.dead).toBe(false)
})

it('settles the original edit and removes only its bridge when the editor is disposed or its renderer departs', async () => {
  const first = await open()
  first.window.webContents.emit('render-process-gone'); await first.closed
  const second = await open()
  editor.dispose(); await second.closed
  expect(native.handlers.has(SYSTEM_SCREENSHOT_EDITOR_CHANNEL)).toBe(false)
  await expect(editor.edit(image, false, async () => {})).rejects.toThrow('closed')
})

it('saves the processed PNG through the exact editor and keeps editing after save or cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-editor-export-'))
  try {
    const current = await open(undefined, true)
    const first = { requestId: current.input.requestId, image }
    expect(await current.call('save-png', first)).toEqual({ status: 'cancelled' })
    expect(current.window.dead).toBe(false)
    native.savePath = join(root, 'processed.png')
    const result = await current.call('save-png', first)
    expect(result.status).toBe('saved')
    expect((await readFile(native.savePath)).toString('base64')).toBe(image.dataUrl.split(',')[1])
    expect(current.complete, 'PNG save must not copy or attach to the draft').not.toHaveBeenCalled()
    expect(current.window.dead, 'PNG save must retain the exact editor').toBe(false)
    expect((await current.call('save-png', first)).status, 'every Save click opens its own save sheet').toBe('saved')
    expect(native.saveCalls).toBe(3)
    await current.call('cancel', { requestId: current.input.requestId }); await current.closed
  } finally { await rm(root, { recursive: true, force: true }) }
})


it('inspects the original file save receipt without replaying or retargeting its write', async () => {
  editor.dispose()
  const waiting = deferred(), saved = { status: 'saved' as const, file: { grantId: 'original-grant', path: 'chosen-original.json', revision: 'written-revision' } }
  const save = vi.fn(async () => { await waiting.promise; return saved })
  editor = new SystemScreenshotEditor(undefined, { pin: vi.fn(), originalFiles: () => ({ open: vi.fn(), inspect: vi.fn(), save }) })
  const current = await open(), params = { requestId: current.input.requestId, operationId: 'original-file-save', document: { content: 'original-content' } }
  expect(await current.call('original-operation', { ...params, operationId: 'missing-operation' })).toBeNull()
  const first = current.call('save-original', params)
  expect(await current.call('original-operation', params)).toEqual({ status: 'pending' })
  await expect(current.call('save-original', { ...params, document: { content: 'changed-content' } })).rejects.toThrow('cannot change')
  expect(save).toHaveBeenCalledOnce()
  waiting.resolve(); expect(await first).toEqual(saved)
  expect(await current.call('original-operation', params)).toEqual(saved)
  expect(await current.call('save-original', params)).toEqual(saved)
  expect(save, 'checking a lost response cannot replay the original file write').toHaveBeenCalledOnce()
  expect(current.window.dead).toBe(false)
})

it('returns an unknown original file write receipt while preserving independent context and image outputs', async () => {
  editor.dispose()
  const save = vi.fn(async () => { throw new Error('Receipt lost') }), copyText = vi.fn(async () => {})
  editor = new SystemScreenshotEditor(undefined, { pin: vi.fn(), copyText, originalFiles: () => ({ open: vi.fn(), inspect: vi.fn(), save }) })
  const current = await open(), params = { requestId: current.input.requestId, operationId: 'unknown-file-save', document: { content: 'original-content' } }
  expect(await current.call('save-original', params)).toMatchObject({ status: 'unknown' })
  expect(await current.call('original-operation', params)).toMatchObject({ status: 'unknown' })
  expect(save).toHaveBeenCalledOnce()
  const context = { requestId: current.input.requestId, operationId: 'context-original', text: 'Original context' }
  expect(await current.call('context', context)).toEqual({ status: 'completed' })
  expect(await current.call('context', context)).toEqual({ status: 'completed' })
  await expect(current.call('context', { ...context, text: 'Changed context' })).rejects.toThrow('cannot change')
  expect(copyText).toHaveBeenCalledExactlyOnceWith('Original context')
  expect(await current.call('finish', { requestId: current.input.requestId, operationId: 'independent-copy', image })).toEqual({ status: 'completed' })
  expect(current.window.dead).toBe(false)
})

const source = { rect: { x: 1600, y: 100, width: 400, height: 300 }, scale: 2, capturedAt: new Date(2026, 0, 2, 3, 4, 5).getTime() }

it('names the save by the capture time and saves at 1x by the capture scale only when asked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-editor-logical-'))
  try {
    native.savePath = join(root, 'logical.png')
    const current = await open(undefined, false, undefined, source)
    expect(current.input.source, 'the renderer receives the capture source to forward to pin and save').toEqual(source)
    expect((await current.call('save-png', { requestId: current.input.requestId, image })).status).toBe('saved')
    expect(native.resized, 'Save PNG keeps the captured pixels').toEqual([])
    expect((await current.call('save-png', { requestId: current.input.requestId, image, logicalSize: true })).status).toBe('saved')
    expect(native.resized).toHaveLength(1)
    expect(native.saveNames).toEqual(['Screenshot 2026-01-02 at 03.04.05.png', 'Screenshot 2026-01-02 at 03.04.05.png'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('refuses a 1x save without a capture scale and keeps the editor', async () => {
  const current = await open()
  await expect(current.call('save-png', { requestId: current.input.requestId, image, logicalSize: true })).rejects.toThrow('display scale')
  expect(native.saveCalls).toBe(0)
  expect(current.window.dead).toBe(false)
})

it('opens the editor centred on the display that holds the capture', async () => {
  await open(undefined, false, undefined, source)
  expect(native.windows.at(-1).options).toMatchObject({ x: 1440 + (2560 - 1040) / 2, y: -200 + (1400 - 760) / 2, width: 1040, height: 760 })
  native.displays[1]!.workArea = { x: 1440, y: -200, width: 900, height: 600 }
  await open(undefined, false, undefined, source)
  expect(native.windows.at(-1).options, 'a small work area clamps the editor inside it').toMatchObject({ x: 1440, y: -200, width: 900, height: 600 })
  await open()
  expect(native.windows.at(-1).options).not.toHaveProperty('x')
})

it('pins the edited image over its capture rectangle at the image logical size', async () => {
  editor.dispose()
  const pin = vi.fn(async () => ({ hostId: 'local', pinId: 'pin', state: 'open' as const, creationOperationId: 'pin-op', recordedOperation: null }))
  editor = new SystemScreenshotEditor(undefined, { pin })
  const current = await open(undefined, false, undefined, { ...source, scale: 0.5 })
  await current.call('pin', { requestId: current.input.requestId, operationId: 'pin-op', image })
  expect(pin).toHaveBeenCalledExactlyOnceWith(image, 'pin-op', { x: 1600, y: 100, width: 2, height: 2 })
  const plain = await open()
  await plain.call('pin', { requestId: plain.input.requestId, operationId: 'plain-pin', image })
  expect(pin.mock.calls[1], 'a pin without a capture source opens near the pointer').toEqual([image, 'plain-pin', undefined])
})

it('a repeated capture shortcut brings the newest editor forward with a notice', async () => {
  expect(editor.notice('Finish or cancel this screenshot first'), 'no editor means nothing to remind').toBe(false)
  const older = await open(), newer = await open()
  older.window.focus.mockClear(); newer.window.show.mockClear(); newer.window.focus.mockClear()
  expect(editor.notice('Finish or cancel this screenshot first')).toBe(true)
  expect(newer.window.webContents.send).toHaveBeenCalledExactlyOnceWith('screenshot:editor-notice', 'Finish or cancel this screenshot first')
  expect(newer.window.show).toHaveBeenCalledOnce(); expect(newer.window.focus).toHaveBeenCalledOnce()
  expect(older.window.webContents.send).not.toHaveBeenCalled(); expect(older.window.focus).not.toHaveBeenCalled()
})

it('closing the last editor of a capture taken from another app returns focus to that app', async () => {
  editor.dispose()
  const returnFocus = vi.fn()
  editor = new SystemScreenshotEditor(undefined, { pin: vi.fn(), returnFocus })
  const fromOtherApp = await open(undefined, false, undefined, undefined, true)
  native.focused = fromOtherApp.window
  await fromOtherApp.call('cancel', { requestId: fromOtherApp.input.requestId }); await fromOtherApp.closed
  expect(returnFocus).toHaveBeenCalledOnce()

  const fromAgentMux = await open()
  await fromAgentMux.call('cancel', { requestId: fromAgentMux.input.requestId }); await fromAgentMux.closed
  expect(returnFocus, 'a capture started inside AgentMux keeps AgentMux in front').toHaveBeenCalledOnce()

  const moved = await open(undefined, false, undefined, undefined, true)
  native.focused = { another: 'AgentMux window' }
  await moved.call('cancel', { requestId: moved.input.requestId }); await moved.closed
  expect(returnFocus, 'the user already moved to another AgentMux window').toHaveBeenCalledOnce()

  const first = await open(undefined, false, undefined, undefined, true), second = await open(undefined, false, undefined, undefined, true)
  native.focused = null
  await first.call('cancel', { requestId: first.input.requestId }); await first.closed
  expect(returnFocus, 'another editor is still open').toHaveBeenCalledOnce()
  await second.call('cancel', { requestId: second.input.requestId }); await second.closed
  expect(returnFocus).toHaveBeenCalledTimes(2)
})
