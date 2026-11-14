import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pngBytes, pngFromBytes } from '@agentmux/native-desktop/image'
import { GlobalScreenshot } from '../src/main/global-screenshot'
import { ScreenCapture } from '../src/main/screen-capture'
import { SystemScreenshotEditor } from '../src/main/system-screenshot-editor'
import { CaptureSurface } from '../src/main/capture-surface'
import { CAPTURE_SURFACE_CHANNEL, type CaptureBackground, type CaptureSurfaceInput } from '../src/shared/capture-surface'
import { readPastedImage } from '../src/main/pasted-image-read'
import { pastedDirectory } from '../src/main/pasted-directory'
import { SCREENSHOT_ATTACHMENT_RECEIVER } from '../src/shared/screenshot-attachment'
import { SYSTEM_SCREENSHOT_EDITOR_CHANNEL, type SystemScreenshotEditorInput } from '../src/shared/system-screenshot-editor'
import type { BrowserPng } from '../src/shared/contracts'

// Only Electron's lifecycle/IPC and the native physical IO are controlled.
// The capture surface, window editor, capture and global screenshot owners, generated original-frame calls,
// PNG validation and durable pasted-image publication/readback are the production modules.
const electron = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => Promise<any>>(), windows: [] as any[], workbench: [] as any[] }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    nativeTheme: { shouldUseDarkColors: true },
    app: { focus: vi.fn(), once: vi.fn(), removeListener: vi.fn() },
    screen: { getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1, height: 1 }, scaleFactor: 1 }], getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ id: 1 }), getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }), on: vi.fn(), removeListener: vi.fn() },
    ipcMain: {
      handle: (channel: string, handler: (...args: any[]) => Promise<any>) => electron.handlers.set(channel, handler),
      removeHandler: (channel: string) => electron.handlers.delete(channel)
    },
    BrowserWindow: class extends EventEmitter {
      dead = false
      webContents = Object.assign(new EventEmitter(), { mainFrame: {}, setWindowOpenHandler: vi.fn(), send: vi.fn() })
      visible = false; opacity = 1; contentProtected = false; protectionAtShow: boolean[] = []
      show = vi.fn(() => { this.visible = true }); showInactive = vi.fn(() => { this.protectionAtShow.push(this.contentProtected); this.visible = true }); focus = vi.fn(); setAlwaysOnTop = vi.fn(); setVisibleOnAllWorkspaces = vi.fn(); setBounds = vi.fn()
      setOpacity = vi.fn((value: number) => { this.opacity = value })
      getOpacity() { return this.opacity }
      setContentProtection = vi.fn((value: boolean) => { this.contentProtected = value })
      isContentProtected() { return this.contentProtected }
      static getFocusedWindow() { return null }
      // The capture surface only reads host opacity; tests that need a second exposure opt into visible hosts.
      static getAllWindows() { return electron.workbench }
      isVisible() { return this.visible }
      isMinimized() { return false }
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
const homes: string[] = [], owners: Array<{ dispose(): void }> = []
beforeEach(() => { electron.windows = []; electron.workbench = []; electron.handlers.clear() })
afterEach(async () => {
  owners.splice(0).forEach(owner => owner.dispose())
  await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(focused = true, fromOtherApp = false) {
  const home = await mkdtemp(join(tmpdir(), 'amux-screenshot-composition-')); homes.push(home)
  const native = {
    captureDisplays: vi.fn(async () => ({ state: 'captured' as const, capturedAt: 1_700_000_000_000,
      timing: { contentMs: 1, windowListMs: 1, responseSerializationMs: 1, totalMs: 3, lazyConnectionMs: 1, socketReadMs: 1, jsonParseMs: 1, requestMs: 4, validationMs: 1 }, displays: [{ displayId: 1, frame: { x: 0, y: 0, width: 1, height: 1 },
      scale: 1, safeTop: 0, windows: [], timing: { captureMs: 1, pngMs: 1, base64Ms: 0, totalMs: 2 }, png: originalBytes.toString('base64'), width: 1, height: 1, engine: 'fixture-engine' }] })),
    captureScreenshot: vi.fn(),
    writeClipboardImage: vi.fn(async (_image: BrowserPng) => {})
  }
  const identity = { windowId: 'original-workbench', documentGeneration: 'original-document' }
  const receiver = { prepare: vi.fn((_operationId: string) => identity), complete: vi.fn(async (_operationId: string, _path: string | null) => {}) }
  const frame = { executeJavaScript: vi.fn(async (code: string) =>
    new Function('window', 'return ' + code)({ [SCREENSHOT_ATTACHMENT_RECEIVER]: receiver })) }
  const contents = { isDestroyed: () => false, mainFrame: frame }
  const workbench = { isDestroyed: () => false, isFocused: () => true, isMinimized: () => false }
  const focusedWindow = vi.fn(() => focused ? workbench : null), reportIssue = vi.fn()
  const surfaceFocus = vi.fn(), editor = new SystemScreenshotEditor(), surface = new CaptureSurface({ native: () => native, appearance: () => ({ terminalTheme: 'graphite' }),
    pin: vi.fn(), copyText: vi.fn(), returnFocus: surfaceFocus })
  owners.push(editor, surface)
  const capture = new ScreenCapture({ home, native: () => native, appActive: () => !fromOtherApp, edit: editor.edit.bind(editor), present: surface.present.bind(surface), reportIssue })
  const action = new GlobalScreenshot({ contents, focusedWindow, windowForDocument: () => workbench,
    capture: (attach: boolean, background: CaptureBackground) => capture.capture(attach, 'selection', {}, background), remindPending: () => {}, reportIssue } as never)
  async function overlay(index = 0) {
    await vi.waitFor(() => expect(electron.windows.length).toBeGreaterThan(index))
    const window = electron.windows[index]
    const invoke = (action: string, params?: unknown) => electron.handlers.get(CAPTURE_SURFACE_CHANNEL)!(
      { sender: window.webContents, senderFrame: window.webContents.mainFrame }, action, params && typeof params === 'object' ? { background: input.background, ...params } : params)
    const input: CaptureSurfaceInput = await invoke('load')
    await invoke('select', { requestId: input.requestId })
    return { window, invoke, input }
  }
  async function editing(index = 1) {
    await vi.waitFor(() => expect(electron.windows.length).toBeGreaterThan(index))
    const window = electron.windows[index]
    const invoke = (action: string, params?: unknown) => electron.handlers.get(SYSTEM_SCREENSHOT_EDITOR_CHANNEL)!(
      { sender: window.webContents, senderFrame: window.webContents.mainFrame }, action, params)
    const input: SystemScreenshotEditorInput = await invoke('load')
    return { window, invoke, input }
  }
  return { home, native, identity, receiver, frame, contents, focusedWindow, reportIssue, action, overlay, editing, surfaceFocus }
}

const selection = { x: 0, y: 0, width: 1, height: 1 }

it('Done on the overlay delivers its processed selection through clipboard, durable file and the original draft operation', async () => {
  const f = await fixture(), pending = f.action.run(), current = await f.overlay()
  expect(f.native.captureDisplays).toHaveBeenCalledOnce()
  expect(f.native.captureScreenshot, 'no native picker').not.toHaveBeenCalled()
  expect(current.input).toMatchObject({ backgrounds: { included: { image: original } }, attachToDraft: true })
  expect(f.native.writeClipboardImage).not.toHaveBeenCalled()
  expect(f.receiver.complete).not.toHaveBeenCalled()

  // A later focus or document cannot receive this capture's result.
  const laterFrame = { executeJavaScript: vi.fn() }
  f.contents.mainFrame = laterFrame as never
  f.focusedWindow.mockReturnValue(null)
  expect(await current.invoke('finish', { requestId: current.input.requestId, image: edited, selection })).toEqual({ status: 'completed' })
  // Checked before waiting, so a delivery that never ends the surface fails here instead of timing out.
  expect(current.window.isDestroyed(), 'Done closed the overlay').toBe(true)
  await pending

  expect(f.native.writeClipboardImage).toHaveBeenCalledExactlyOnceWith(edited)
  expect(f.receiver.complete).toHaveBeenCalledOnce()
  const [operationId, path] = f.receiver.complete.mock.calls[0]!
  expect(operationId).toBe(f.receiver.prepare.mock.calls[0]![0])
  const savedBytes = await readFile(path!)
  expect(savedBytes).toEqual(editedBytes)
  expect(savedBytes).toEqual(pngBytes(f.native.writeClipboardImage.mock.calls[0]![0]))
  expect(await readPastedImage(f.home, path!)).toEqual({ dataUrl: edited.dataUrl })
  expect(await readdir(pastedDirectory(f.home))).toHaveLength(1)
  expect(laterFrame.executeJavaScript).not.toHaveBeenCalled()
  expect(current.window.isDestroyed()).toBe(true)
  expect(electron.windows, 'no window editor opened').toHaveLength(1)
  expect(f.reportIssue).not.toHaveBeenCalled()
})

it('a clipboard-only global screenshot copies the processed selection with no draft or saved image', async () => {
  const f = await fixture(false), pending = f.action.run(), current = await f.overlay()
  expect(current.input).toMatchObject({ backgrounds: { included: { image: original } }, attachToDraft: false })
  expect(f.frame.executeJavaScript).not.toHaveBeenCalled()
  expect(await current.invoke('finish', { requestId: current.input.requestId, image: edited, selection })).toEqual({ status: 'completed' })
  // Checked before waiting, so a delivery that never ends the surface fails here instead of timing out.
  expect(current.window.isDestroyed(), 'Done closed the overlay').toBe(true)
  await pending
  expect(f.native.writeClipboardImage).toHaveBeenCalledExactlyOnceWith(edited)
  expect(f.receiver.complete).not.toHaveBeenCalled()
  expect(await readdir(f.home)).toEqual([])
  expect(f.reportIssue).not.toHaveBeenCalled()
})

it('⌘E moves the marks into the window editor, whose Copy is the one delivery to the original draft', async () => {
  const f = await fixture(), pending = f.action.run(), current = await f.overlay()
  const handoff = { shapes: [{ id: 'mark', kind: 'rect', color: '#ff0000', width: 2, x: 0, y: 0, w: 1, h: 1 }], crop: selection, tool: 'rect' }
  await current.invoke('expand', { requestId: current.input.requestId, handoff })
  expect(current.window.isDestroyed()).toBe(true)
  const editor = await f.editing()
  expect(editor.input).toMatchObject({ image: original, attachToDraft: true, initialState: { shapes: handoff.shapes, crop: selection }, initialTool: 'rect',
    source: { rect: { x: 0, y: 0, width: 1, height: 1 }, scale: 1, capturedAt: 1_700_000_000_000 } })
  expect(f.native.writeClipboardImage).not.toHaveBeenCalled()
  expect(await editor.invoke('finish', { requestId: editor.input.requestId, operationId: 'edited-final', image: edited })).toEqual({ status: 'completed' })
  await editor.invoke('cancel', { requestId: editor.input.requestId })
  await pending
  expect(f.native.captureDisplays, 'nothing is re-captured').toHaveBeenCalledOnce()
  expect(f.native.writeClipboardImage).toHaveBeenCalledExactlyOnceWith(edited)
  expect(await readFile(f.receiver.complete.mock.calls[0]![1]!)).toEqual(editedBytes)
})

it.each(['overlay', 'editor'])('cancelling the %s delivers no pixels and releases only the original draft preparation', async stage => {
  const f = await fixture(), pending = f.action.run(), current = await f.overlay()
  if (stage === 'editor') {
    await current.invoke('expand', { requestId: current.input.requestId, handoff: { shapes: [], crop: selection, tool: 'rect' } })
    const editor = await f.editing()
    await editor.invoke('cancel', { requestId: editor.input.requestId })
    expect(editor.window.isDestroyed()).toBe(true)
  } else await current.invoke('cancel', { requestId: current.input.requestId })
  await pending
  expect(current.window.isDestroyed()).toBe(true)
  expect(f.native.writeClipboardImage).not.toHaveBeenCalled()
  expect(f.receiver.complete).toHaveBeenCalledExactlyOnceWith(f.receiver.prepare.mock.calls[0]![0], null)
  expect(await readdir(f.home)).toEqual([])
  expect(electron.windows).toHaveLength(stage === 'editor' ? 2 : 1)
  expect(f.reportIssue).not.toHaveBeenCalled()
})

it('Retake from the window editor captures again for the same draft and returns to the same editor on cancel', async () => {
  const f = await fixture(), pending = f.action.run(), first = await f.overlay()
  const handoff = { shapes: [{ id: 'mark', kind: 'rect', color: '#ff0000', width: 2, x: 0, y: 0, w: 1, h: 1 }], crop: selection, tool: 'rect' }
  await first.invoke('expand', { requestId: first.input.requestId, handoff })
  const editor = await f.editing()
  expect(editor.input.retakable).toBe(true)
  electron.workbench = [editor.window]
  const cancelled = editor.invoke('retake', { requestId: editor.input.requestId })
  const second = await f.overlay(2)
  expect(second.window.setContentProtection).toHaveBeenCalledExactlyOnceWith(true)
  expect(second.window.isContentProtected()).toBe(true)
  expect(editor.window.opacity, 'the old editor keeps its exact prior opacity in both frozen frames').toBe(1)
  expect(editor.window.setOpacity, 'retake never writes host opacity').not.toHaveBeenCalled()
  expect(f.native.captureDisplays, 'a retake with the visible editor freezes both backgrounds').toHaveBeenCalledTimes(3)
  expect(second.input, 'the same consumer: the original draft and ⌘E').toMatchObject({ attachToDraft: true, expandable: true })
  await second.invoke('cancel', { requestId: second.input.requestId })
  expect(await cancelled).toEqual({ status: 'cancelled' })
  expect([editor.window.isDestroyed(), editor.window.opacity], 'the same editor is back').toEqual([false, 1])
  expect(await editor.invoke('load'), 'with its original marks').toMatchObject({ requestId: editor.input.requestId, initialState: { shapes: handoff.shapes, crop: selection } })
  expect(f.receiver.complete, 'the draft is still waiting').not.toHaveBeenCalled()

  const completed = editor.invoke('retake', { requestId: editor.input.requestId })
  const third = await f.overlay(3)
  expect(await third.invoke('finish', { requestId: third.input.requestId, image: edited, selection })).toEqual({ status: 'completed' })
  expect(third.window.isDestroyed(), 'Done closed the overlay').toBe(true)
  expect(await completed).toEqual({ status: 'completed' })
  await pending
  expect(editor.window.isDestroyed(), 'the old editor closes once the new capture delivered').toBe(true)
  expect(f.native.writeClipboardImage).toHaveBeenCalledExactlyOnceWith(edited)
  expect(f.receiver.complete, 'one delivery to the original draft operation').toHaveBeenCalledExactlyOnceWith(f.receiver.prepare.mock.calls[0]![0], expect.any(String))
  expect(await readFile(f.receiver.complete.mock.calls[0]![1]!)).toEqual(editedBytes)
  expect(editor.window.setOpacity, 'the complete retake lifecycle never writes host opacity').not.toHaveBeenCalled()
  expect(f.reportIssue).not.toHaveBeenCalled()
})

it('a retake that expands again replaces the old editor, and the capture ends with the new one', async () => {
  const f = await fixture(), pending = f.action.run(), first = await f.overlay()
  await first.invoke('expand', { requestId: first.input.requestId, handoff: { shapes: [], crop: selection, tool: 'rect' } })
  const old = await f.editing()
  const retaken = old.invoke('retake', { requestId: old.input.requestId })
  const second = await f.overlay(2)
  await second.invoke('expand', { requestId: second.input.requestId, handoff: { shapes: [], crop: selection, tool: 'arrow' } })
  const next = await f.editing(3)
  expect(await retaken).toEqual({ status: 'completed' })
  expect([old.window.isDestroyed(), next.input.initialTool, next.input.retakable], 'the new editor takes over and can retake too').toEqual([true, 'arrow', true])
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(f.receiver.complete, 'the original draft still waits for the new editor').not.toHaveBeenCalled()
  expect(await next.invoke('finish', { requestId: next.input.requestId, operationId: 'retaken-final', image: edited })).toEqual({ status: 'completed' })
  await next.invoke('cancel', { requestId: next.input.requestId })
  await pending
  expect(f.native.writeClipboardImage).toHaveBeenCalledExactlyOnceWith(edited)
  expect(await readFile(f.receiver.complete.mock.calls[0]![1]!)).toEqual(editedBytes)
})

it('a retake started in the window editor gives focus back to that editor, not to the app the capture came from', async () => {
  const f = await fixture(false, true), pending = f.action.run(), first = await f.overlay()
  await first.invoke('expand', { requestId: first.input.requestId, handoff: { shapes: [], crop: selection, tool: 'rect' } })
  const editor = await f.editing()
  const retaken = editor.invoke('retake', { requestId: editor.input.requestId })
  const second = await f.overlay(2)
  await second.invoke('cancel', { requestId: second.input.requestId })
  expect(await retaken).toEqual({ status: 'cancelled' })
  expect(f.surfaceFocus, 'the cancelled retake returns to the editor, which keeps the capture').not.toHaveBeenCalled()
  await editor.invoke('cancel', { requestId: editor.input.requestId })
  await pending
})

it('the selection the window editor delivers is where the next capture opens', async () => {
  const f = await fixture(), pending = f.action.run(), first = await f.overlay()
  const crop = { x: 0, y: 0, width: 1, height: 1 }
  await first.invoke('expand', { requestId: first.input.requestId, handoff: { shapes: [], crop, tool: 'rect' } })
  const editor = await f.editing()
  expect(await editor.invoke('finish', { requestId: editor.input.requestId, operationId: 'editor-copy', image: edited })).toEqual({ status: 'completed' })
  await editor.invoke('cancel', { requestId: editor.input.requestId })
  await pending
  const next = f.action.run(), second = await f.overlay(2)
  expect(second.input.initialCrop, 'the next capture opens on the selection the window editor delivered').toEqual(crop)
  await second.invoke('cancel', { requestId: second.input.requestId })
  await next
})

it('a retake after the editor already copied keeps the same consumer: the clipboard only, no second draft file', async () => {
  const f = await fixture(), pending = f.action.run(), first = await f.overlay()
  await first.invoke('expand', { requestId: first.input.requestId, handoff: { shapes: [], crop: selection, tool: 'rect' } })
  const editor = await f.editing()
  expect(await editor.invoke('finish', { requestId: editor.input.requestId, operationId: 'first-copy', image: edited })).toEqual({ status: 'completed' })
  await pending
  expect(f.receiver.complete).toHaveBeenCalledOnce()
  const retaken = editor.invoke('retake', { requestId: editor.input.requestId })
  const second = await f.overlay(2)
  expect(second.input.attachToDraft, 'the retaken overlay no longer offers to attach to the delivered draft').toBe(false)
  expect(await second.invoke('finish', { requestId: second.input.requestId, image: original, selection })).toEqual({ status: 'completed' })
  expect(second.window.isDestroyed(), 'Done closed the overlay').toBe(true)
  expect(await retaken).toEqual({ status: 'completed' })
  expect(editor.window.isDestroyed()).toBe(true)
  expect(f.native.writeClipboardImage.mock.calls.map(call => call[0]), 'the retake copies like a later Copy').toEqual([edited, original])
  expect(f.receiver.complete, 'the original draft received its one image').toHaveBeenCalledOnce()
  expect(await readdir(pastedDirectory(f.home)), 'no second draft file').toHaveLength(1)
  expect(f.reportIssue).not.toHaveBeenCalled()
})
