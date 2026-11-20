import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserProfileEnvironment } from '../src/main/browser-profile-environment.js'
import { BrowserCdpSession } from '../src/main/browser-cdp-session.js'
import {
  parseBrowserProfileControlResult,
  parseBrowserProfileEnvironment,
  type BrowserProfileEnvironment
} from '@agentmux/core/control'

const configured: BrowserProfileEnvironment = {
  userAgent: 'NativeProfile/1.0',
  acceptLanguages: ['fr-FR', 'fr'],
  timeZone: 'Pacific/Honolulu',
  locale: 'fr-FR',
  geolocation: { latitude: 12.34, longitude: 56.78, accuracy: 9 },
  hardwareConcurrency: 3,
  screen: { width: 1200, height: 800 },
  userAgentMetadata: {
    brands: [{ brand: 'NativeProfile', version: '1' }],
    fullVersionList: [{ brand: 'NativeProfile', version: '1.0.0.0' }],
    platform: 'ProbeOS',
    platformVersion: '1',
    architecture: 'arm',
    model: '',
    mobile: false
  }
}
function fixture(initial: BrowserProfileEnvironment | undefined = configured) {
  let settings = initial,
    ua = 'Native/150',
    devtools = false,
    destroyed = false
  const session = {
    getUserAgent: () => ua,
    setUserAgent: vi.fn((value: string) => {
      ua = value
    })
  }
  const contents = new EventEmitter() as EventEmitter & {
    debugger: EventEmitter & {
      attached: boolean
      attach: ReturnType<typeof vi.fn>
      detach: ReturnType<typeof vi.fn>
      isAttached: () => boolean
      sendCommand: ReturnType<typeof vi.fn>
    }
    isDestroyed: () => boolean
    isDevToolsOpened: () => boolean
    reload: ReturnType<typeof vi.fn>
  }
  const debuggerOwner = new EventEmitter() as typeof contents.debugger
  debuggerOwner.attached = false
  debuggerOwner.attach = vi.fn(() => {
    debuggerOwner.attached = true
  })
  debuggerOwner.detach = vi.fn(() => {
    debuggerOwner.attached = false
    debuggerOwner.emit('detach', {}, 'detach command')
  })
  debuggerOwner.isAttached = () => debuggerOwner.attached
  debuggerOwner.sendCommand = vi.fn(async (method: string, params?: any) =>
    method === 'Page.getFrameTree'
      ? { frameTree: { frame: { id: 'original-main-frame' } } }
      : method === 'Page.createIsolatedWorld'
        ? { executionContextId: 17 }
        : method === 'Runtime.evaluate'
          ? { result: { value: params?.contextId === 17 ? 12 : 997 } }
          : {}
  )
  contents.debugger = debuggerOwner
  contents.isDestroyed = () => destroyed
  contents.isDevToolsOpened = () => devtools
  contents.reload = vi.fn()
  const changed = vi.fn(),
    owner = createBrowserProfileEnvironment({
      session: () => session as any,
      settings: () => settings,
      defaultLanguage: () => 'en-US'
    })
  owner.subscribe(changed)
  const screen = vi.fn()
  const prepare = () => {
    owner.prepare('profile')
    return owner.preparePage('profile', 'browser', contents as any, {
      applyScreen: screen,
      isCurrent: () => true
    })
  }
  return {
    contents,
    session,
    owner,
    screen,
    changed,
    prepare,
    set: (next: BrowserProfileEnvironment | undefined) => {
      settings = next
      owner.prepare('profile')
      owner.applyPages('profile')
    },
    devtools: (open: boolean, nativeDetach = true) => {
      devtools = open
      if (open && nativeDetach) {
        debuggerOwner.attached = false
        debuggerOwner.emit('detach', {}, 'target closed by devtools')
      } else if (!open) contents.emit('devtools-closed')
    },
    destroy: () => {
      destroyed = true
      contents.emit('destroyed')
    }
  }
}
const cleanup: (() => void)[] = []
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn())
  vi.restoreAllMocks()
})
async function settled(predicate: () => boolean) {
  for (let turn = 0; turn < 300; turn++) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error('Original queued environment did not settle')
}

describe('one original Profile environment across native target scopes', () => {
  it('strictly carries supported native fields and rejects fingerprint getters, permission grants or malformed metadata', () => {
    expect(parseBrowserProfileEnvironment(configured)).toEqual(configured)
    for (const value of [
      { canvas: 'mask' },
      { fonts: [] },
      { timeZone: 'invalid/time-zone' },
      { locale: '' },
      { screen: { width: 0, height: 800 } },
      { hardwareConcurrency: 1.5 },
      { geolocation: { latitude: 91, longitude: 0, accuracy: 1 } },
      { geolocation: { latitude: 1, longitude: 2, accuracy: 3, allow: true } },
      { userAgentMetadata: { ...configured.userAgentMetadata, mobile: 'false' } }
    ])
      expect(() => parseBrowserProfileEnvironment(value)).toThrow()
  })
  it('applies through the original page debugger and publishes per-field native scope without fake subdocument or Worker promises', async () => {
    const f = fixture()
    cleanup.push(f.destroy)
    await f.prepare()
    const page = f.owner.inspect('profile')!.pages![0]!
    expect(page.status).toBe('applied')
    expect(page.browserId).toBe('browser')
    for (const field of Object.keys(configured))
      expect(page.fields[field as keyof BrowserProfileEnvironment]).toEqual({
        status: 'applied',
        scope: 'page-target'
      })
    expect(page.scope).toEqual({
      currentDocument: 'applied',
      futureNavigation: 'applied',
      subdocuments: 'unknown',
      workers: 'unknown',
      initialScripts: 'unknown'
    })
    const profile = {
      id: 'profile',
      revision: 'original-profile-token',
      label: 'Native profile',
      createdAt: 1,
      isDefault: true,
      source: null,
      environment: configured,
      environmentApplication: f.owner.inspect('profile')
    }
    const parsed = parseBrowserProfileControlResult('browser.profile.update', { revision: 1, profile }) as {
      profile: typeof profile
    }
    expect(parsed.profile.environmentApplication?.pages?.[0]).toEqual(page)
    expect(() =>
      parseBrowserProfileControlResult('browser.profile.update', {
        revision: 1,
        profile: {
          ...profile,
          environmentApplication: {
            ...profile.environmentApplication,
            pages: [{ ...page, scope: { ...page.scope, workers: 'applied' } }]
          }
        }
      })
    ).toThrow()
    expect(f.owner.inspect('profile')!.unsupported).toEqual(
      expect.arrayContaining(['native-canvas', 'native-webgl', 'native-fonts', 'tls'])
    )
    expect(f.contents.debugger.sendCommand).toHaveBeenCalledWith(
      'Emulation.setGeolocationOverride',
      configured.geolocation
    )
    expect(f.screen).toHaveBeenCalledOnce()
    expect(f.contents.reload).not.toHaveBeenCalled()
    expect(
      f.contents.debugger.sendCommand.mock.calls.some(
        ([method]) => method === 'Runtime.addBinding' || method === 'Page.addScriptToEvaluateOnNewDocument'
      )
    ).toBe(false)
  })
  it('a normal page program shares the environment lease and clearing native fields preserves that original consumer', async () => {
    const f = fixture()
    cleanup.push(f.destroy)
    await f.prepare()
    expect(BrowserCdpSession.hasOnlyBackgroundLeases(f.contents as any)).toBe(true)
    const program = BrowserCdpSession.attach(f.contents as any)
    expect(BrowserCdpSession.hasOnlyBackgroundLeases(f.contents as any)).toBe(false)
    expect(f.contents.debugger.attach).toHaveBeenCalledTimes(1)
    f.set(undefined)
    await settled(
      () =>
        f.owner.inspect('profile')?.pages?.[0]?.status === 'applied' &&
        f.contents.debugger.sendCommand.mock.calls.some(
          ([method]) => method === 'Emulation.clearGeolocationOverride'
        )
    )
    expect(f.contents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setHardwareConcurrencyOverride', {
      hardwareConcurrency: 12
    })
    expect(f.contents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', {
      userAgent: '',
      acceptLanguage: ''
    })
    expect(f.contents.debugger.isAttached()).toBe(true)
    await expect(program.sendCommand('DOM.getDocument')).resolves.toEqual({})
    program.detach()
    expect(f.contents.debugger.isAttached()).toBe(false)
  })
  it('a real native detach becomes unknown without stealing DevTools; closing reapplies the saved version without reload', async () => {
    const f = fixture()
    cleanup.push(f.destroy)
    await f.prepare()
    f.devtools(true)
    await settled(() => f.owner.inspect('profile')!.pages![0]!.status === 'unknown')
    f.set({ ...configured, locale: 'ja-JP' })
    await settled(() => f.owner.inspect('profile')!.pages![0]!.status === 'unknown')
    expect(f.contents.debugger.attach).toHaveBeenCalledTimes(1)
    f.devtools(false)
    await settled(() => f.owner.inspect('profile')!.pages![0]!.status === 'applied')
    expect(f.contents.debugger.attach).toHaveBeenCalledTimes(2)
    expect(f.contents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setLocaleOverride', {
      locale: 'ja-JP'
    })
    expect(f.contents.reload).not.toHaveBeenCalled()
  })
  it('an open DevTools surface alone does not revoke a healthy original native environment lease', async () => {
    const f = fixture()
    cleanup.push(f.destroy)
    await f.prepare()
    f.devtools(true, false)
    f.set({ ...configured, locale: 'ja-JP' })
    await settled(() => f.owner.inspect('profile')!.pages![0]!.status === 'applied')
    expect(f.contents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setLocaleOverride', {
      locale: 'ja-JP'
    })
    expect(f.contents.debugger.attach).toHaveBeenCalledTimes(1)
    expect(f.contents.debugger.detach).not.toHaveBeenCalled()
  })
  it('a late old native acknowledgement cannot continue old fields or publish over the newer Profile version', async () => {
    const f = fixture({ timeZone: 'Pacific/Honolulu', locale: 'fr-FR' })
    cleanup.push(f.destroy)
    let release!: () => void,
      entered = false
    const original = f.contents.debugger.sendCommand.getMockImplementation()!
    f.contents.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Emulation.setTimezoneOverride' && (params as any)?.timezoneId === 'Pacific/Honolulu') {
        entered = true
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return {}
      }
      return await original(method, params)
    })
    const first = f.prepare()
    await settled(() => entered)
    f.set({ locale: 'ja-JP' })
    release()
    await first
    await settled(() => f.owner.inspect('profile')!.pages![0]!.status === 'applied')
    const locales = f.contents.debugger.sendCommand.mock.calls
      .filter(([method]) => method === 'Emulation.setLocaleOverride')
      .map(([, params]) => params)
    expect(locales).toEqual([{ locale: 'ja-JP' }])
    expect(f.contents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setTimezoneOverride', {
      timezoneId: ''
    })
    expect(f.owner.inspect('profile')!.pages![0]!.status).toBe('applied')
  })
  it('a new saved session default cannot publish the old page acknowledgement as its current configuration', async () => {
    const f = fixture()
    cleanup.push(f.destroy)
    await f.prepare()
    const publications: any[] = []
    f.owner.subscribe(() => publications.push(f.owner.inspect('profile')))
    f.set({ ...configured, userAgent: 'NewSavedNative/2.0' })
    expect(f.contents.debugger.sendCommand).not.toHaveBeenCalledWith(
      'Emulation.setUserAgentOverride',
      expect.objectContaining({ userAgent: 'NewSavedNative/2.0' })
    )
    expect(
      publications.some(
        (value) =>
          value?.userAgent === 'NewSavedNative/2.0' &&
          value.pages?.some((page: any) => page.fields.userAgent?.status === 'applied')
      )
    ).toBe(false)
    await f.prepare()
  })
  it('a failed native field stays unknown while later supported fields and the healthy page remain usable', async () => {
    const f = fixture()
    cleanup.push(f.destroy)
    const original = f.contents.debugger.sendCommand.getMockImplementation()!
    f.contents.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Emulation.setLocaleOverride') throw new Error('Native locale unavailable')
      return await original(method, params)
    })
    await f.prepare()
    const page = f.owner.inspect('profile')!.pages![0]!
    expect(page.status).toBe('unknown')
    expect(page.fields.locale?.status).toBe('unknown')
    expect(page.fields.hardwareConcurrency?.status).toBe('applied')
    expect(f.contents.isDestroyed()).toBe(false)
    expect(f.contents.reload).not.toHaveBeenCalled()
    const program = BrowserCdpSession.attach(f.contents as any)
    await expect(program.sendCommand('DOM.getDocument')).resolves.toEqual({})
    program.detach()
  })
  it('an unavailable hardware baseline refuses only its override and keeps other native fields usable', async () => {
    const f = fixture()
    cleanup.push(f.destroy)
    const original = f.contents.debugger.sendCommand.getMockImplementation()!
    f.contents.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Runtime.evaluate') throw new Error('Original hardware baseline unavailable')
      return await original(method, params)
    })
    await f.prepare()
    const page = f.owner.inspect('profile')!.pages![0]!
    expect(page.fields.hardwareConcurrency?.status).toBe('unknown')
    expect(page.fields.locale?.status).toBe('applied')
    expect(page.fields.screen?.status).toBe('applied')
    expect(f.contents.debugger.sendCommand).not.toHaveBeenCalledWith(
      'Emulation.setHardwareConcurrencyOverride',
      expect.anything()
    )
    expect(f.contents.reload).not.toHaveBeenCalled()
  })
  it('restores the native isolated baseline rather than a page-defined main-world getter', async () => {
    const f = fixture({ hardwareConcurrency: 3 })
    cleanup.push(f.destroy)
    await f.prepare()
    f.set(undefined)
    await f.prepare()
    expect(f.contents.debugger.sendCommand).toHaveBeenCalledWith('Page.createIsolatedWorld', {
      frameId: 'original-main-frame',
      worldName: 'agentmux-profile-environment-baseline',
      grantUniveralAccess: false
    })
    expect(f.contents.debugger.sendCommand).toHaveBeenLastCalledWith(
      'Emulation.setHardwareConcurrencyOverride',
      { hardwareConcurrency: 12 }
    )
  })
  it('an absent isolated context stays hardware-unknown without falling back to the page world', async () => {
    const f = fixture()
    cleanup.push(f.destroy)
    const original = f.contents.debugger.sendCommand.getMockImplementation()!
    f.contents.debugger.sendCommand.mockImplementation(async (method, params) =>
      method === 'Page.createIsolatedWorld' ? {} : await original(method, params)
    )
    await f.prepare()
    const page = f.owner.inspect('profile')!.pages![0]!
    expect(page.fields.hardwareConcurrency?.status).toBe('unknown')
    expect(page.fields.locale?.status).toBe('applied')
    expect(f.contents.debugger.sendCommand).not.toHaveBeenCalledWith('Runtime.evaluate', expect.anything())
    expect(f.contents.debugger.sendCommand).not.toHaveBeenCalledWith(
      'Emulation.setHardwareConcurrencyOverride',
      expect.anything()
    )
  })
  it('a fresh target observes its missing baseline when the original document is ready and applies only the newest saved version', async () => {
    const f = fixture()
    cleanup.push(f.destroy)
    const original = f.contents.debugger.sendCommand.getMockImplementation()!
    let initial = true
    f.contents.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Runtime.evaluate' && initial) throw new Error('Inspected target navigated or closed')
      return await original(method, params)
    })
    await f.prepare()
    expect(f.owner.inspect('profile')!.pages![0]!.fields.hardwareConcurrency?.status).toBe('unknown')
    f.set({ ...configured, hardwareConcurrency: 5, locale: 'ja-JP' })
    await f.prepare()
    expect(f.owner.inspect('profile')!.pages![0]!.fields.hardwareConcurrency?.status).toBe('unknown')
    initial = false
    f.contents.emit('dom-ready')
    await settled(() => f.owner.inspect('profile')!.pages![0]!.status === 'applied')
    expect(f.contents.debugger.sendCommand).toHaveBeenLastCalledWith(
      'Emulation.setHardwareConcurrencyOverride',
      { hardwareConcurrency: 5 }
    )
    expect(f.contents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setLocaleOverride', {
      locale: 'ja-JP'
    })
    expect(f.contents.reload).not.toHaveBeenCalled()
  })
})
