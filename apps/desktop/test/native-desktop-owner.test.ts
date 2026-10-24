import { beforeEach, describe, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({ packaged: true, appPath: '', once: vi.fn(), create: vi.fn(),
  native: { dispose: vi.fn(async () => {}) } }))
vi.mock('electron', () => ({ app: {
  get isPackaged() { return host.packaged }, getAppPath: () => host.appPath, once: host.once
} }))
vi.mock('@agentmux/native-desktop', () => ({ NativeDesktop: class {
  constructor(options: unknown) { host.create(options); return host.native }
} }))

beforeEach(() => {
  vi.resetModules()
  host.once.mockClear()
  host.create.mockClear()
  host.native.dispose.mockClear()
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
