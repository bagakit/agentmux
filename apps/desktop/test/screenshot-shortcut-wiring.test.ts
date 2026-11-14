import { afterEach, expect, it, vi } from 'vitest'
import ts from 'typescript'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'
import mainSource from '../src/main/ipc.ts?raw'
import startupSource from '../src/renderer/src/main.tsx?raw'
import { ScreenCapture } from '../src/main/screen-capture'
import type { CaptureSurfaceSession } from '../src/main/capture-surface'
import { pngFromBytes } from '@agentmux/native-desktop/image'
import { GlobalScreenshot } from '../src/main/global-screenshot'
import { registerNativeDesktopIpc } from '../src/main/native-desktop-ipc'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const bridge = vi.hoisted(() => {
  vi.stubGlobal('window', {})
  return { api: null as AgentMuxPreloadApi | null, invoke: vi.fn(), listeners: new Map<string, Set<(...args: unknown[]) => void>>() }
})
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_key: string, api: AgentMuxPreloadApi) => { bridge.api = api } },
  ipcRenderer: { invoke: bridge.invoke,
    on: (channel: string, listener: (...args: unknown[]) => void) => { const set = bridge.listeners.get(channel) ?? new Set(); set.add(listener); bridge.listeners.set(channel, set) },
    removeListener: (channel: string, listener: (...args: unknown[]) => void) => bridge.listeners.get(channel)?.delete(listener) },
  webFrame: { getZoomFactor: () => 1 }
}))
import '../src/preload/index'
import { registerScreenshotShortcut } from '../src/main/screenshot-shortcut'
import { SCREENSHOT_SHORTCUT_ACCELERATOR, SCREENSHOT_SHORTCUT_ALTERNATE, screenshotShortcutAccelerator } from '../src/shared/screenshot-shortcut'

const homes: string[] = []
afterEach(async () => { bridge.listeners.clear(); bridge.invoke.mockReset(); await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
function nodes(source: string, name: string) {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, name.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const all: ts.Node[] = []
  function walk(node: ts.Node) { all.push(node); ts.forEachChild(node, walk) }
  walk(file)
  return { file, all }
}
// The extracted statements run in a Function body, so the module-only `import.meta` becomes a parameter.
const transpile = (source: string) => ts.transpileModule(source.replaceAll('import.meta', 'importMeta'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText

/** Execute the production composition, registration and preload with controlled physical IO. */
async function mainFixture() {
  const source = nodes(mainSource, 'ipc.ts'), home = await mkdtemp(join(tmpdir(), 'amux-global-wiring-')); homes.push(home)
  const names = ['returnScreenshotFocus', 'copyScreenshotText', 'captureSurface', 'screenshotEditor', 'reportScreenshotIssue', 'screenCapture', 'globalScreenshot', 'screenshotShortcut']
  const statements = names.map(name => {
    const matches = source.all.filter((node): node is ts.VariableStatement => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(source.file) === name))
    expect(matches).toHaveLength(1); return matches[0]!.getText(source.file)
  })
  const nativeRegistration = source.all.filter((node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText(source.file) === 'registerNativeDesktopIpc')
  const statusHandlers = source.all.filter((node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText(source.file) === 'handleWithEvent' &&
    ts.isStringLiteral(node.arguments[0]!) && node.arguments[0]!.text === 'ui:screenshotShortcutStatus')
  expect(nativeRegistration).toHaveLength(1); expect(statusHandlers).toHaveLength(1)
  const register = vi.fn((_key: string, _callback: () => void) => true), unregister = vi.fn()
  const trusted = {}, handlers = new Map<string, (...args: any[]) => any>()
  let destroyed = false
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6V8AAAAASUVORK5CYII=', 'base64')
  const native = { captureScreenshot: vi.fn(async () => ({ state: 'captured', screenshot: { format: 'png', data: bytes.toString('base64'), width: 1, height: 1, scale: 1 } })),
    writeClipboardImage: vi.fn(async () => {}), readClipboardText: vi.fn(), writeClipboardText: vi.fn() }
  const receiver = { prepare: vi.fn(() => null as object | null), complete: vi.fn(async () => {}) }
  const frame = { executeJavaScript: vi.fn(async (code: string) => new Function('window', 'return ' + code)({ agentmuxScreenshotAttachment: receiver })) }
  const contents = { isDestroyed: () => destroyed, mainFrame: frame,
    send: vi.fn((channel: string, ...args: unknown[]) => { for (const listener of bridge.listeners.get(channel) ?? []) listener({}, ...args) }) }
  const nativeWindow = { isDestroyed: () => false, isFocused: () => true, isMinimized: () => false, hide: vi.fn(), minimize: vi.fn(), close: vi.fn() }
  const editorOptions: Array<{ returnFocus?(): void }> = [], application = { getPath: () => home, hide: vi.fn() }, pins = { hasOpenPins: vi.fn(() => false) }
  // The overlay stand-in answers Done with the frozen selection, the way the shared editor does on a real overlay.
  const surfaceOptions: Array<{ returnFocus(): void }> = [], presented: CaptureSurfaceSession[] = []
  const surface = class { constructor(options: { returnFocus(): void }) { surfaceOptions.push(options) }
    async present(session: CaptureSurfaceSession) { presented.push(session); await session.complete(pngFromBytes(bytes), { rect: { x: 0, y: 0, width: 1, height: 1 }, scale: 1, capturedAt: 1 }, 'fixture'); return { state: 'completed' } }
    notice = vi.fn(() => false); dispose = vi.fn() }
  const body = statements.join('\n') + '\n' + nativeRegistration[0]!.getText(source.file) + '\n' + statusHandlers[0]!.getText(source.file)
  const original = new Function('CaptureSurface', 'getNativeDesktopOwner', 'ScreenCapture', 'GlobalScreenshot', 'SystemScreenshotEditor', 'registerScreenshotShortcut', 'registerNativeDesktopIpc', 'process', 'globalShortcut',
    'app', 'getDesktopNativeUiOwner', 'contents', 'args', 'BrowserWindow', 'config', 'handleWithEvent', 'importMeta', 'pinScreenshot', 'inspectScreenshotPin', 'screenshotPins',
    transpile(body) + '\nreturn { screenshotShortcut, globalScreenshot }')(
    surface, () => native, ScreenCapture, GlobalScreenshot, class { constructor(_appearance: unknown, options: { returnFocus?(): void }) { editorOptions.push(options) } edit = vi.fn(); notice = vi.fn(); dispose = vi.fn() },
    registerScreenshotShortcut, registerNativeDesktopIpc, { platform: 'darwin' }, { register, unregister }, application, () => native, contents,
    { workbenchWindows: { windowForDocument: () => nativeWindow } }, { getFocusedWindow: () => nativeWindow }, { appearance: {} },
    (channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler), { dirname: home }, vi.fn(), vi.fn(), pins)
  bridge.invoke.mockImplementation((channel: string) => Promise.resolve(handlers.get(channel)!({ sender: trusted })))
  return { ...original, register, unregister, native, receiver, contents, home, bytes, handlers, nativeWindow, application, pins, presented,
    returnFocus: () => editorOptions[0]!.returnFocus!(), surfaceReturnFocus: () => surfaceOptions[0]!.returnFocus(), markDestroyed: () => { destroyed = true } }
}

it('the actual Main callback captures and copies with no Composer, without a Renderer shortcut dependency', async () => {
  const f = await mainFixture()
  const run = vi.spyOn(f.globalScreenshot, 'run')
  f.register.mock.calls[0]![1](); expect(run).toHaveBeenCalledOnce(); await run.mock.results[0]!.value
  expect(f.presented).toEqual([expect.objectContaining({ attachToDraft: false, expandable: true })])
  expect(f.native.captureScreenshot, 'no native picker').not.toHaveBeenCalled()
  expect(f.native.writeClipboardImage).toHaveBeenCalledOnce()
  expect(f.receiver.complete).not.toHaveBeenCalled()
  expect(f.contents.send).not.toHaveBeenCalled()
  expect(await bridge.api!.ui.screenshotShortcutStatus()).toMatchObject({ state: 'registered', accelerator: SCREENSHOT_SHORTCUT_ACCELERATOR })
  f.screenshotShortcut.dispose()
  expect(f.unregister.mock.calls).toEqual([[SCREENSHOT_SHORTCUT_ACCELERATOR], [screenshotShortcutAccelerator(SCREENSHOT_SHORTCUT_ALTERNATE.chord)]])
})

it('the registered shortcut callback threads one timing request through prepare capture and present', async () => {
  const f = await mainFixture()
  const run = vi.spyOn(f.globalScreenshot, 'run')
  f.register.mock.calls[0]![1]()
  await run.mock.results[0]!.value
  const timing = (f.presented[0] as CaptureSurfaceSession & { timing?: unknown }).timing
  expect(timing).toMatchObject({ requestId: expect.any(String), callbackToPrepareMs: expect.any(Number), prepareMs: expect.any(Number), screenCaptureMs: expect.any(Number), presentMs: expect.any(Number) })
  expect(run.mock.calls[0]![1]).toBe(timing)
  f.screenshotShortcut.dispose()
})

it('the Main native composition and actual preload retain the explicit Capture button destination', async () => {
  const f = await mainFixture(), path = await bridge.api!.ui.captureScreenshot()
  expect(await readFile(path!)).toEqual(f.bytes)
  expect(f.native.writeClipboardImage).toHaveBeenCalledOnce()
  f.screenshotShortcut.dispose()
})

it('the original Main callback still copies when the Root Renderer is destroyed', async () => {
  const f = await mainFixture(); f.markDestroyed()
  const run = vi.spyOn(f.globalScreenshot, 'run')
  f.register.mock.calls[0]![1](); expect(run).toHaveBeenCalledOnce(); await run.mock.results[0]!.value
  expect(f.presented).toHaveLength(1)
  expect(f.native.writeClipboardImage).toHaveBeenCalledOnce()
  expect(f.receiver.prepare).not.toHaveBeenCalled()
  f.screenshotShortcut.dispose()
})

it('the actual trusted startup installs the optional attachment receiver once', () => {
  const source = nodes(startupSource, 'main.tsx')
  const calls = source.all.filter((node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText(source.file) === 'installScreenshotAttachmentReceiver')
  expect(calls).toHaveLength(1)
  const install = vi.fn(), host = {}
  new Function('installScreenshotAttachmentReceiver', 'window', transpile(calls[0]!.getText(source.file)))(install, host)
  expect(install).toHaveBeenCalledExactlyOnceWith(host)
})

it('focus return is the app-wide macOS ⌘H: it hides AgentMux, including the workbench, and keeps it when a pin is open', async () => {
  const f = await mainFixture()
  f.surfaceReturnFocus()
  expect(f.application.hide, 'the capture surface and the window editor share one focus return').toHaveBeenCalledOnce()
  f.application.hide.mockClear()
  f.returnFocus()
  expect(f.application.hide, 'one app.hide(), the same as ⌘H').toHaveBeenCalledOnce()
  // app.hide() hides every AgentMux window, so a visible but unfocused workbench is hidden too and returns from the Dock.
  // No window is hidden, minimized or closed one by one.
  expect(f.nativeWindow.hide).not.toHaveBeenCalled(); expect(f.nativeWindow.minimize).not.toHaveBeenCalled(); expect(f.nativeWindow.close).not.toHaveBeenCalled()
  f.pins.hasOpenPins.mockReturnValue(true)
  f.returnFocus()
  expect(f.application.hide, 'an open pin keeps AgentMux on screen').toHaveBeenCalledOnce()
  f.screenshotShortcut.dispose()
})
