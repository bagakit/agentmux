import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'
import ts from 'typescript'
import mainSource from '../src/main/ipc.ts?raw'

const bridge = vi.hoisted(() => { vi.stubGlobal('window', {}); return { api: null as AgentMuxPreloadApi | null,
  invoke: vi.fn(), quit: vi.fn(), create: vi.fn(), native: { captureScreenshot: vi.fn(), readClipboardText: vi.fn(),
    writeClipboardText: vi.fn(), writeClipboardImage: vi.fn(), dispose: vi.fn(async () => {}) } } })
vi.mock('electron', () => ({ app: { isPackaged: true, getAppPath: () => (new URL('file:///').pathname + "fixture/AgentMux.app/Contents/Resources/app"), once: bridge.quit },
  contextBridge: { exposeInMainWorld: (_key: string, api: AgentMuxPreloadApi) => { bridge.api = api } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), removeListener: vi.fn() }, webFrame: { getZoomFactor: () => 1 } }))
vi.mock('@agentmux/native-desktop', () => ({ NativeDesktop: class { constructor(options: unknown) { bridge.create(options); return bridge.native } } }))
import '../src/preload/index'
import { registerNativeDesktopIpc } from '../src/main/native-desktop-ipc'
import { getNativeDesktopOwner, resolvedNativeDesktopOptions } from '../src/main/native-desktop-owner'
import { readPastedImage } from '../src/main/pasted-image-read'
import { senderTrust, assertSenderTrusted } from '../src/main/ipc-sender-trust'
import { browserPngFromBytes } from '../src/main/browser-image'

const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6V8AAAAASUVORK5CYII=', 'base64')
const homes: string[] = []
afterEach(async () => {
  bridge.invoke.mockReset()
  for (const method of Object.values(bridge.native)) method.mockReset()
  await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'amux-native-consumers-')); homes.push(home)
  const trusted = {}, handlers = new Map<string, (...args: any[]) => any>()
  const native = vi.fn(getNativeDesktopOwner)
  // Execute the original Main registration, rather than a new test-only facade call.
  const source = ts.createSourceFile('ipc.ts', mainSource, ts.ScriptTarget.Latest, true)
  const calls: ts.CallExpression[] = []
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'registerNativeDesktopIpc') calls.push(node)
    ts.forEachChild(node, walk)
  }
  walk(source)
  expect(calls).toHaveLength(1)
  const code = ts.transpileModule(calls[0]!.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  new Function('registerNativeDesktopIpc', 'app', 'getNativeDesktopOwner', 'handleWithEvent', 'requireTrustedSender', code)(
    registerNativeDesktopIpc, { getPath: () => home }, native,
    (channel: string, handler: (...args: any[]) => any) => { handlers.set(channel, handler) },
    (channel: string, event: any) => assertSenderTrusted(senderTrust(channel as any, event.sender, trusted)))
  handlers.set('ui:readPastedImage', (_event, path: string) => readPastedImage(home, path))
  bridge.invoke.mockImplementation((channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: trusted }, ...args))
  return { api: bridge.api!.ui, native, home, trusted, handlers }
}

describe('existing preload and Main consumers of the native desktop owner', () => {
  it('shares one lazy exact application owner and disposes only its native connection', async () => {
    const f = await fixture()
    expect(f.native).not.toHaveBeenCalled()
    expect(bridge.native.captureScreenshot).not.toHaveBeenCalled()
    bridge.native.readClipboardText.mockResolvedValue('Original clipboard')
    expect(await f.api.readClipboardText()).toBe('Original clipboard')
    await f.api.writeClipboardText('Unchanged body\r\n  \0 😀')
    expect(bridge.native.writeClipboardText).toHaveBeenCalledExactlyOnceWith('Unchanged body\r\n  \0 😀')
    expect(bridge.create).toHaveBeenCalledExactlyOnceWith({ appPath: (new URL('file:///').pathname + "fixture/AgentMux.app/Contents/Resources/app/resources/AgentMux Native.app") })
    expect(resolvedNativeDesktopOptions()).toEqual({ appPath: (new URL('file:///').pathname + "fixture/AgentMux.app/Contents/Resources/app/resources/AgentMux Native.app") })
    expect(getNativeDesktopOwner()).toBe(getNativeDesktopOwner())
    expect(bridge.quit.mock.calls[0]![0]).toBe('will-quit')
    await bridge.quit.mock.calls[0]![1]()
    expect(bridge.native.dispose).toHaveBeenCalledOnce()
  })

  it('delivers native selection bytes through actual preload, IPC and existing pasted preview owner', async () => {
    const f = await fixture()
    bridge.native.captureScreenshot.mockResolvedValue({ state: 'captured', screenshot: {
      format: 'png', data: bytes.toString('base64'), width: 1, height: 1, scale: 2 } })
    const path = await f.api.captureScreenshot()
    expect(bridge.native.captureScreenshot).toHaveBeenCalledExactlyOnceWith({ mode: 'selection' })
    expect(await readFile(path!)).toEqual(bytes)
    expect(await f.api.readPastedImage(path!)).toEqual({ dataUrl: 'data:image/png;base64,' + bytes.toString('base64') })
    expect(bridge.invoke.mock.calls.map(call => call[0])).toEqual(['ui:captureScreenshot', 'ui:readPastedImage'])
  })

  it('copies the same processed Browser PNG through its existing IPC without an OS recapture', async () => {
    const f = await fixture(), image = browserPngFromBytes(bytes)
    await f.api.writeClipboardImage(image)
    expect(bridge.native.writeClipboardImage).toHaveBeenCalledExactlyOnceWith(image)
    expect(bridge.native.captureScreenshot).not.toHaveBeenCalled()
    expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith('ui:writeClipboardImage', image)
  })

  it('keeps clipboard errors and empty text distinct without any screen/AX query', async () => {
    const f = await fixture(), error = new Error('Original clipboard read failed')
    bridge.native.readClipboardText.mockRejectedValueOnce(error).mockResolvedValueOnce('')
    await expect(f.api.readClipboardText()).rejects.toBe(error)
    expect(await f.api.readClipboardText()).toBe('')
    expect(bridge.native.captureScreenshot).not.toHaveBeenCalled()
    bridge.native.writeClipboardImage.mockRejectedValueOnce(error)
    await expect(f.api.writeClipboardImage(browserPngFromBytes(bytes))).rejects.toBe(error)
  })

  it.each(['ui:captureScreenshot', 'ui:readClipboardText', 'ui:writeClipboardText', 'ui:writeClipboardImage'])('rejects a page sender before %s starts any native operation', async channel => {
    const f = await fixture()
    await expect(Promise.resolve().then(() => f.handlers.get(channel)!({ sender: {} }, 'untrusted'))).rejects.toThrow('Untrusted')
    expect(f.native).not.toHaveBeenCalled()
  })
})
