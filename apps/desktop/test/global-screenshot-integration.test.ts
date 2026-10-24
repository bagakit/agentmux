import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pngBytes, pngFromBytes } from '@agentmux/native-desktop/image'
import { GlobalScreenshot } from '../src/main/global-screenshot'
import { ScreenCapture } from '../src/main/screen-capture'
import { SystemScreenshotEditor } from '../src/main/system-screenshot-editor'
import { readPastedImage } from '../src/main/pasted-image-read'
import { pastedDirectory } from '../src/main/pasted-directory'
import { SCREENSHOT_ATTACHMENT_RECEIVER } from '../src/shared/screenshot-attachment'
import { SYSTEM_SCREENSHOT_EDITOR_CHANNEL, type SystemScreenshotEditorInput } from '../src/shared/system-screenshot-editor'
import type { BrowserPng } from '../src/shared/contracts'

// Only Electron's lifecycle/IPC and the native physical IO are controlled.
// All three screenshot owners, generated original-frame calls, PNG validation
// and durable pasted-image publication/readback are the production modules.
const electron = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => Promise<any>>(), windows: [] as any[] }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    nativeTheme: { shouldUseDarkColors: true },
    ipcMain: {
      handle: (channel: string, handler: (...args: any[]) => Promise<any>) => electron.handlers.set(channel, handler),
      removeHandler: (channel: string) => electron.handlers.delete(channel)
    },
    BrowserWindow: class extends EventEmitter {
      dead = false
      webContents = Object.assign(new EventEmitter(), { mainFrame: {}, setWindowOpenHandler: vi.fn() })
      show = vi.fn(); focus = vi.fn()
      loadFile = vi.fn(async () => { this.emit('ready-to-show') })
      loadURL = this.loadFile
      constructor(readonly options: unknown) { super(); electron.windows.push(this) }
      isDestroyed() { return this.dead }
      close() { this.destroy() }
      destroy() { if (this.dead) return; this.dead = true; this.emit('closed') }
    }
  }
})

const originalBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6V8AAAAASUVORK5CYII=', 'base64')
const editedBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const original = pngFromBytes(originalBytes), edited = pngFromBytes(editedBytes)
const homes: string[] = [], editors: SystemScreenshotEditor[] = []
beforeEach(() => { electron.windows = []; electron.handlers.clear() })
afterEach(async () => {
  editors.splice(0).forEach(editor => editor.dispose())
  await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(focused = true, cancelled = false) {
  const home = await mkdtemp(join(tmpdir(), 'amux-screenshot-composition-')); homes.push(home)
  const native = {
    captureScreenshot: vi.fn(async () => cancelled ? { state: 'cancelled' as const } : {
      state: 'captured' as const, completionAction: 'edit' as const,
      screenshot: { format: 'png' as const, data: originalBytes.toString('base64'), width: 1, height: 1, scale: 1 }
    }),
    writeClipboardImage: vi.fn(async (_image: BrowserPng) => {})
  }
  const identity = { windowId: 'original-workbench', documentGeneration: 'original-document' }
  const receiver = { prepare: vi.fn((_operationId: string) => identity), complete: vi.fn(async (_operationId: string, _path: string | null) => {}) }
  const frame = { executeJavaScript: vi.fn(async (code: string) =>
    new Function('window', 'return ' + code)({ [SCREENSHOT_ATTACHMENT_RECEIVER]: receiver })) }
  const contents = { isDestroyed: () => false, mainFrame: frame }
  const workbench = { isDestroyed: () => false, isFocused: () => true, isMinimized: () => false }
  const focusedWindow = vi.fn(() => focused ? workbench : null), reportIssue = vi.fn()
  const editor = new SystemScreenshotEditor(); editors.push(editor)
  const capture = new ScreenCapture({ home, native: () => native, edit: editor.edit.bind(editor), reportIssue })
  const action = new GlobalScreenshot({ contents, focusedWindow, windowForDocument: () => workbench,
    capture: capture.capture.bind(capture), reportIssue } as never)
  async function editing() {
    await vi.waitFor(() => expect(electron.windows).toHaveLength(1))
    const window = electron.windows[0]
    const invoke = (action: string, params?: unknown) => electron.handlers.get(SYSTEM_SCREENSHOT_EDITOR_CHANNEL)!(
      { sender: window.webContents, senderFrame: window.webContents.mainFrame }, action, params)
    const input: SystemScreenshotEditorInput = await invoke('load')
    return { window, invoke, input }
  }
  return { home, native, identity, receiver, frame, contents, focusedWindow, reportIssue, action, editing }
}

it('delivers only the edited final PNG through clipboard, durable file and the original draft operation', async () => {
  const f = await fixture(), pending = f.action.run(), current = await f.editing()
  expect(f.native.captureScreenshot).toHaveBeenCalledExactlyOnceWith({ mode: 'selection', allowEditing: true })
  expect(current.input).toMatchObject({ image: original, attachToDraft: true })
  expect(edited.dataUrl).not.toBe(current.input.image.dataUrl)
  expect(f.native.writeClipboardImage).not.toHaveBeenCalled()
  expect(f.receiver.complete).not.toHaveBeenCalled()
  expect(await readdir(f.home)).toEqual([])

  // A later focus or document cannot receive this capture's result.
  const laterFrame = { executeJavaScript: vi.fn() }
  f.contents.mainFrame = laterFrame as never
  f.focusedWindow.mockReturnValue(null)
  expect(await current.invoke('finish', { requestId: current.input.requestId, operationId: 'edited-final', image: edited })).toEqual({ status: 'completed' })
  await pending

  expect(f.native.captureScreenshot).toHaveBeenCalledOnce()
  expect(f.native.writeClipboardImage).toHaveBeenCalledExactlyOnceWith(edited)
  expect(f.receiver.complete).toHaveBeenCalledOnce()
  const [operationId, path] = f.receiver.complete.mock.calls[0]!
  expect(operationId).toBe(f.receiver.prepare.mock.calls[0]![0])
  expect(path).toBeTruthy()
  const savedBytes = await readFile(path!)
  expect(savedBytes).toEqual(editedBytes)
  expect(savedBytes).toEqual(pngBytes(f.native.writeClipboardImage.mock.calls[0]![0]))
  expect(await readPastedImage(f.home, path!)).toEqual({ dataUrl: edited.dataUrl })
  expect(await readdir(pastedDirectory(f.home))).toHaveLength(1)
  expect(laterFrame.executeJavaScript).not.toHaveBeenCalled()
  expect(current.window.isDestroyed()).toBe(true)
  expect(f.reportIssue).not.toHaveBeenCalled()
})

it('the same edit IPC completes a clipboard-only global screenshot with no draft or saved image', async () => {
  const f = await fixture(false), pending = f.action.run(), current = await f.editing()
  expect(current.input).toMatchObject({ image: original, attachToDraft: false })
  expect(f.frame.executeJavaScript).not.toHaveBeenCalled()
  expect(f.native.writeClipboardImage).not.toHaveBeenCalled()
  expect(await current.invoke('finish', { requestId: current.input.requestId, operationId: 'clipboard-final', image: edited })).toEqual({ status: 'completed' })
  await pending
  expect(f.native.captureScreenshot).toHaveBeenCalledExactlyOnceWith({ mode: 'selection', allowEditing: true })
  expect(f.native.writeClipboardImage).toHaveBeenCalledExactlyOnceWith(edited)
  expect(f.receiver.complete).not.toHaveBeenCalled()
  expect(await readdir(f.home)).toEqual([])
  expect(f.reportIssue).not.toHaveBeenCalled()
})

it.each(['selection', 'editor'])('cancelling the %s delivers no pixels and releases only the original draft preparation', async stage => {
  const f = await fixture(true, stage === 'selection'), pending = f.action.run()
  if (stage === 'editor') {
    const current = await f.editing()
    await current.invoke('cancel', { requestId: current.input.requestId })
    expect(current.window.isDestroyed()).toBe(true)
  }
  await pending
  expect(f.native.captureScreenshot).toHaveBeenCalledExactlyOnceWith({ mode: 'selection', allowEditing: true })
  expect(f.native.writeClipboardImage).not.toHaveBeenCalled()
  expect(f.receiver.complete).toHaveBeenCalledExactlyOnceWith(f.receiver.prepare.mock.calls[0]![0], null)
  expect(await readdir(f.home)).toEqual([])
  expect(electron.windows).toHaveLength(stage === 'editor' ? 1 : 0)
  expect(f.reportIssue).not.toHaveBeenCalled()
})
