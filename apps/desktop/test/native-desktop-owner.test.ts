import { beforeEach, describe, expect, it, vi } from 'vitest'
import { browserPngFromBytes } from '../src/main/browser-image'
import { registerNativeDesktopIpc } from '../src/main/native-desktop-ipc'

const host = vi.hoisted(() => {
  const fixture = { platform: 'darwin', packaged: true, appPath: '', once: vi.fn(), create: vi.fn(),
    native: { dispose: vi.fn(async () => {}), captureScreenshot: vi.fn(), readClipboardText: vi.fn(),
      writeClipboardText: vi.fn(), writeClipboardImage: vi.fn() },
    clipboard: { readText: vi.fn(), writeText: vi.fn(), writeImage: vi.fn() },
    createFromBuffer: vi.fn(), image: { isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }) } }
  vi.stubGlobal('process', new Proxy(process, {
    get: (target, key, receiver) => key === 'platform' ? fixture.platform : Reflect.get(target, key, receiver)
  }))
  return fixture
})
vi.mock('electron', () => ({ app: {
  get isPackaged() { return host.packaged }, getAppPath: () => host.appPath, once: host.once
}, clipboard: host.clipboard, nativeImage: { createFromBuffer: host.createFromBuffer } }))
vi.mock('@agentmux/native-desktop', () => ({ NativeDesktop: class {
  constructor(options: unknown) { host.create(options); return host.native }
} }))

beforeEach(() => {
  vi.resetModules()
  host.platform = 'darwin'
  host.packaged = true
  host.appPath = (new URL('file:///').pathname + "fixture/AgentMux.app/Contents/Resources/app")
  host.once.mockClear()
  host.create.mockClear()
  for (const method of Object.values(host.native)) method.mockReset()
  host.native.dispose.mockResolvedValue(undefined)
  host.native.readClipboardText.mockResolvedValue('Original native text')
  for (const method of Object.values(host.clipboard)) method.mockReset()
  host.clipboard.readText.mockReturnValue('Original Electron text')
  host.createFromBuffer.mockReset().mockReturnValue(host.image)
})

describe('the explicit native desktop launch profile', () => {
  it.each([
    { packaged: true, appPath: (new URL('file:///').pathname + "fixture/AgentMux.app/Contents/Resources/app"),
      expected: { appPath: (new URL('file:///').pathname + "fixture/AgentMux.app/Contents/Resources/app/resources/AgentMux Native.app") } },
    { packaged: false, appPath: (new URL('file:///').pathname + "fixture/source/apps/desktop"),
      expected: { executablePath: (new URL('file:///').pathname + "fixture/source/packages/native-desktop/macos/.build/debug/agentmux-native-macos") } }
  ])('keeps the packaged=$packaged identity lazy, exact and shared', async ({ packaged, appPath, expected }) => {
    host.packaged = packaged
    host.appPath = appPath
    const { getNativeDesktopOwner, resolvedNativeDesktopOptions } = await import('../src/main/native-desktop-owner')
    expect(host.create).not.toHaveBeenCalled()
    expect(host.once).not.toHaveBeenCalled()
    // These fixture paths do not exist: resolution uses the chosen profile, never artifact discovery.
    expect(resolvedNativeDesktopOptions()).toEqual(expected)
    const original = getNativeDesktopOwner()
    expect(getNativeDesktopOwner()).toBe(original)
    expect(host.create).toHaveBeenCalledExactlyOnceWith(expected)
    expect(host.once).toHaveBeenCalledExactlyOnceWith('will-quit', expect.any(Function))
    expect(host.native.dispose).not.toHaveBeenCalled()
    await host.once.mock.calls[0]![1]()
    expect(host.native.dispose).toHaveBeenCalledOnce()
  })
})

const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6V8AAAAASUVORK5CYII=', 'base64')
const image = browserPngFromBytes(bytes)
async function clipboardHandlers() {
  const { getDesktopNativeUiOwner } = await import('../src/main/native-desktop-owner')
  const handlers = new Map<string, (...args: any[]) => any>(), trust = vi.fn()
  registerNativeDesktopIpc({ capture: vi.fn(async () => null), native: getDesktopNativeUiOwner,
    handle: (channel, handler) => { handlers.set(channel, handler) }, trust })
  expect(host.create).not.toHaveBeenCalled()
  return { call: (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args), trust }
}

describe('the static Desktop UI clipboard platform owner', () => {
  it('macOS clipboard handlers consume the same native owner as the public port', async () => {
    const f = await clipboardHandlers()
    expect(await f.call('ui:readClipboardText')).toBe('Original native text')
    const text = 'Original body\r\n  \0 😀'
    await f.call('ui:writeClipboardText', text)
    await f.call('ui:writeClipboardImage', image)
    const { getDesktopNativeUiOwner, getNativeDesktopOwner } = await import('../src/main/native-desktop-owner')
    expect(getDesktopNativeUiOwner()).toBe(getNativeDesktopOwner())
    expect(host.create).toHaveBeenCalledOnce()
    expect(host.native.writeClipboardText).toHaveBeenCalledExactlyOnceWith(text)
    expect(host.native.writeClipboardImage).toHaveBeenCalledExactlyOnceWith(image)
    expect(host.native.captureScreenshot).not.toHaveBeenCalled()
    expect(host.clipboard.readText).not.toHaveBeenCalled()
    expect(host.clipboard.writeText).not.toHaveBeenCalled()
    expect(host.clipboard.writeImage).not.toHaveBeenCalled()
    expect(host.createFromBuffer).not.toHaveBeenCalled()
    expect(f.trust.mock.calls.map(call => call[0])).toEqual(['ui:readClipboardText', 'ui:writeClipboardText', 'ui:writeClipboardImage'])
  })

  it.each(['win32', 'linux'])('%s retains its original Electron clipboard and processed PNG through actual IPC handlers', async platform => {
    host.platform = platform
    const f = await clipboardHandlers()
    expect(await f.call('ui:readClipboardText')).toBe('Original Electron text')
    const text = 'Original platform text\r\n  \0 😀'
    await f.call('ui:writeClipboardText', text)
    await f.call('ui:writeClipboardImage', image)
    expect(host.clipboard.readText).toHaveBeenCalledExactlyOnceWith()
    expect(host.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(text)
    expect(host.createFromBuffer).toHaveBeenCalledExactlyOnceWith(bytes)
    expect(host.clipboard.writeImage).toHaveBeenCalledExactlyOnceWith(host.image)
    expect(host.native.readClipboardText).not.toHaveBeenCalled()
    expect(host.native.writeClipboardText).not.toHaveBeenCalled()
    expect(host.native.writeClipboardImage).not.toHaveBeenCalled()
    expect(host.native.captureScreenshot).not.toHaveBeenCalled()
    expect(host.create).not.toHaveBeenCalled()
    expect(host.once).not.toHaveBeenCalled()
  })

  it.each([
    ['ui:readClipboardText', 'readClipboardText', undefined],
    ['ui:writeClipboardText', 'writeClipboardText', 'Original write'],
    ['ui:writeClipboardImage', 'writeClipboardImage', image]
  ] as const)('a macOS native failure from %s remains the original error without Electron fallback', async (channel, method, input) => {
    const error = new Error('Original native operation is unconfirmed')
    host.native[method].mockRejectedValueOnce(error)
    const f = await clipboardHandlers()
    await expect(Promise.resolve().then(() => f.call(channel, input))).rejects.toBe(error)
    expect(host.native[method]).toHaveBeenCalledOnce()
    expect(host.clipboard.readText).not.toHaveBeenCalled()
    expect(host.clipboard.writeText).not.toHaveBeenCalled()
    expect(host.clipboard.writeImage).not.toHaveBeenCalled()
    expect(host.createFromBuffer).not.toHaveBeenCalled()
  })
})
