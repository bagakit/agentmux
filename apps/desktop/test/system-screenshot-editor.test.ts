import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SystemScreenshotEditor } from '../src/main/system-screenshot-editor'
import { SYSTEM_SCREENSHOT_EDITOR_CHANNEL } from '../src/shared/system-screenshot-editor'
import { pngFromBytes } from '@agentmux/native-desktop/image'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const native = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => Promise<any>>(), windows: [] as any[], savePath: null as string | null, saveCalls: 0 }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    nativeTheme: { shouldUseDarkColors: true },
    dialog: { showSaveDialog: async () => { native.saveCalls++; return { canceled: native.savePath === null, filePath: native.savePath } } },
    ipcMain: { handle: (channel: string, handler: (...args: any[]) => Promise<any>) => native.handlers.set(channel, handler),
      removeHandler: (channel: string) => native.handlers.delete(channel) },
    BrowserWindow: class extends EventEmitter {
      dead = false
      webContents = Object.assign(new EventEmitter(), { mainFrame: {}, setWindowOpenHandler: vi.fn() })
      show = vi.fn(); focus = vi.fn()
      loadFile = vi.fn(async () => { this.emit('ready-to-show') })
      loadURL = this.loadFile
      constructor(readonly options: unknown) { super(); native.windows.push(this) }
      isDestroyed() { return this.dead }
      close() { this.destroy() }
      destroy() { if (this.dead) return; this.dead = true; this.emit('closed') }
    }
  }
})

const image = pngFromBytes(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cWZkAAAAASUVORK5CYII=', 'base64'))
let editor: SystemScreenshotEditor
beforeEach(() => { native.windows = []; native.handlers.clear(); native.savePath = null; native.saveCalls = 0; editor = new SystemScreenshotEditor() })
afterEach(() => editor.dispose())
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function open(complete = vi.fn(async () => {}), attachToDraft = false, initialIssue?: string) {
  const closed = editor.edit(image, attachToDraft, complete, initialIssue)
  await Promise.resolve()
  const window = native.windows.at(-1)
  const call = (action: string, params?: unknown, event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }) =>
    native.handlers.get(SYSTEM_SCREENSHOT_EDITOR_CHANNEL)!(event, action, params)
  const input = await call('load')
  return { window, closed, input, call, complete }
}

it('loads only its independent sandboxed image window with the shared theme and exact attachment label', async () => {
  const current = await open(undefined, true, 'Copied to clipboard. Draft attachment failed.')
  expect(current.input.image).toEqual(image)
  expect(current.input.attachToDraft).toBe(true)
  expect(current.input.initialIssue).toBe('Copied to clipboard. Draft attachment failed.')
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
    const first = { requestId: current.input.requestId, operationId: 'save-cancel', image }
    expect(await current.call('save-png', first)).toEqual({ status: 'cancelled' })
    expect(current.window.dead).toBe(false)
    native.savePath = join(root, 'processed.png')
    const next = { ...first, operationId: 'save-original-pixels' }
    const result = await current.call('save-png', next)
    expect(result.status).toBe('saved')
    expect((await readFile(native.savePath)).toString('base64')).toBe(image.dataUrl.split(',')[1])
    expect(current.complete, 'PNG save must not copy or attach to the draft').not.toHaveBeenCalled()
    expect(current.window.dead, 'PNG save must retain the exact editor').toBe(false)
    expect(await current.call('save-png', next)).toEqual(result)
    expect(native.saveCalls).toBe(2)
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
