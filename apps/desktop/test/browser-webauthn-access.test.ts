import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWebAuthnOwner } from '../src/main/browser-webauthn-accounts.js'

// Actual module / installed handlers / original callback. These Source doubles do
// not prove a physical HID device, OS menu, platform credential, or blocklist bypass.
const native = vi.hoisted(() => {
  type Listener = (...args: any[]) => void
  class Emitter {
    listeners = new Map<string, Listener[]>()
    on(event: string, listener: Listener) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); return this }
    removeListener(event: string, listener: Listener) { this.listeners.set(event, (this.listeners.get(event) ?? []).filter(value => value !== listener)); return this }
    emit(event: string, ...args: any[]) { for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args) }
    listenerCount(event: string) { return this.listeners.get(event)?.length ?? 0 }
  }
  class Session extends Emitter {
    check: any
    request: any
    device: any
    setPermissionCheckHandler = vi.fn((handler: any) => { this.check = handler })
    setPermissionRequestHandler = vi.fn((handler: any) => { this.request = handler })
    setDevicePermissionHandler = vi.fn((handler: any) => { this.device = handler })
  }
  let nextFrame = 1
  class Frame {
    frameTreeNodeId = nextFrame++
    frameToken = `frame-${this.frameTreeNodeId}`
    parent: Frame | null = null
    detached = false
    destroyed = false
    url = 'https://frame.example.invalid/auth'
    origin = 'https://frame.example.invalid'
    isDestroyed() { return this.destroyed }
  }
  const frameContents = new Map<Frame, Contents>()
  class Contents extends Emitter {
    destroyed = false
    focus = vi.fn()
    constructor(readonly session: Session) { super() }
    isDestroyed() { return this.destroyed }
  }
  class Window extends Emitter {
    destroyed = false
    visible = true
    minimized = false
    focused = true
    focus = vi.fn()
    show = vi.fn()
    restore = vi.fn()
    isDestroyed() { return this.destroyed }
    isVisible() { return this.visible }
    isMinimized() { return this.minimized }
    isFocused() { return this.focused }
  }
  type Item = { label?: string; enabled?: boolean; type?: string; click?: () => void }
  class Menu {
    static instances: Menu[] = []
    static fail = false
    options: any
    popup = vi.fn((options: any) => { this.options = options; if (Menu.fail) throw new Error('native menu unavailable') })
    closePopup = vi.fn(() => this.options?.callback())
    constructor(readonly items: Item[]) { Menu.instances.push(this) }
    static buildFromTemplate(items: Item[]) { return new Menu(items) }
  }
  return { Session, Frame, Contents, Window, Menu, frameContents, fromFrame: vi.fn((frame: Frame) => frameContents.get(frame)) }
})
vi.mock('electron', () => ({ Menu: native.Menu, webContents: { fromFrame: native.fromFrame } }))
import { registerBrowserWebAuthnAccess, cancelBrowserWebAuthnAccess } from '../src/main/browser-webauthn-access.js'
import { acquireBrowserWebAuthnWindowMenu, releaseBrowserWebAuthnWindowMenu } from '../src/main/browser-webauthn-window-menu.js'

const releases: Array<() => void> = []
beforeEach(() => {
  vi.useFakeTimers()
  native.Menu.instances.length = 0
  native.Menu.fail = false
  native.frameContents.clear()
  native.fromFrame.mockClear()
})
afterEach(() => {
  for (const release of releases.splice(0).reverse()) release()
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
})

function fixture(session = new native.Session(), window = new native.Window()) {
  const contents = new native.Contents(session)
  const frame = new native.Frame()
  native.frameContents.set(frame, contents)
  const state = { current: true, bounds: { x: 12, y: 34, width: 234.5, height: 180 } as Electron.Rectangle | null }
  const owner: BrowserWebAuthnOwner = {
    window: window as never,
    get bounds() { return state.bounds },
    isCurrent: () => state.current,
    report: vi.fn()
  }
  return { session, contents, frame, window, owner, state }
}
type Fixture = ReturnType<typeof fixture>
function register(f: Fixture, resolver = (contents: unknown) => contents === f.contents ? f.owner : null) {
  const release = registerBrowserWebAuthnAccess(f.session as never, resolver)
  releases.push(release)
  return release
}
function device(deviceId: string, usagePage = 0xf1d0, name = deviceId): Electron.HIDDevice {
  return { deviceId, name, vendorId: 1, productId: 2, collections: [{ usagePage, usage: 1, type: 1, children: [], inputReports: [], outputReports: [], featureReports: [] }] }
}
const devices = [device('first-original-id'), device('second-original-id'), device('non-fido-id', 1)]
function request(f: Fixture, list = devices, frame: InstanceType<typeof native.Frame> | null = f.frame, callback = vi.fn()) {
  const event = { preventDefault: vi.fn() }
  f.session.emit('select-hid-device', event, { frame, deviceList: list }, callback)
  return { event, callback, menu: native.Menu.instances.at(-1) }
}
function item(menu: InstanceType<typeof native.Menu>, label: string) {
  const result = menu.items.find(value => value.label === label)
  expect(result, '真实菜单必须含有指定设备或取消项').toBeDefined()
  expect(result!.click).toBeTypeOf('function')
  return result!
}
function assertClean(f: Fixture) {
  expect(f.contents.listenerCount('did-start-navigation')).toBe(0)
  expect(f.contents.listenerCount('destroyed')).toBe(0)
  expect(f.contents.listenerCount('render-process-gone')).toBe(0)
  expect(f.session.listenerCount('hid-device-removed')).toBe(0)
  expect(f.window.listenerCount('closed')).toBe(0)
  for (const event of ['focus', 'show', 'restore', 'hide', 'minimize']) expect(f.window.listenerCount(event)).toBe(0)
}

describe('Browser WebAuthn access original Session and request', () => {
  it('uses actual requesting securityOrigin for HTTPS and explicit HTTP loopback only', () => {
    const f = fixture(); register(f)
    const origins = ['https://one.example.invalid', 'https://two.example.invalid:9443', 'http://localhost:8888', 'http://127.0.0.1:8888', 'http://[::1]:8888',
      'http://ordinary.example.invalid', 'ftp://localhost', 'file://localhost/secret', 'custom://localhost', 'http://localhost.example.invalid', 'null', '', undefined]
    expect(origins.map(origin => f.session.check(f.contents, 'hid', 'https://unrelated.example.invalid', { securityOrigin: origin, isMainFrame: false })))
      .toEqual([true, true, true, true, true, false, false, false, false, false, false, false, false])
    expect(f.session.check(f.contents, 'hid', 'https://frame.example.invalid', { requestingUrl: 'https://frame.example.invalid', isMainFrame: true })).toBe(false)
  })

  it('denies every other permission and unowned, retired, foreign-Session contents', () => {
    const f = fixture(); register(f)
    expect(['clipboard-read', 'usb', 'serial', 'notifications', 'media', 'openExternal'].map(permission => f.session.check(f.contents, permission, f.frame.origin, { securityOrigin: f.frame.origin })))
      .toEqual([false, false, false, false, false, false])
    expect(f.session.check(null, 'hid', f.frame.origin, { securityOrigin: f.frame.origin })).toBe(false)
    expect(f.session.check(new native.Contents(f.session), 'hid', f.frame.origin, { securityOrigin: f.frame.origin })).toBe(false)
    const foreign = fixture(); expect(f.session.check(foreign.contents, 'hid', f.frame.origin, { securityOrigin: f.frame.origin })).toBe(false)
    f.state.current = false
    expect(f.session.check(f.contents, 'hid', f.frame.origin, { securityOrigin: f.frame.origin })).toBe(false)
    const callback = vi.fn(); f.session.request(f.contents, 'media', callback, { requestingUrl: f.frame.url, isMainFrame: true })
    expect(callback.mock.calls).toEqual([[false]])
  })

  it('device policy requires hid, trusted actual origin and numeric FIDO collection', () => {
    const f = fixture(); register(f)
    const inputs = [
      { deviceType: 'hid', origin: 'https://one.example.invalid', device: device('https') },
      { deviceType: 'hid', origin: 'http://localhost:8123', device: device('loopback') },
      { deviceType: 'hid', origin: 'http://ordinary.example.invalid', device: device('ordinary') },
      { deviceType: 'hid', origin: 'ftp://localhost', device: device('ftp') },
      { deviceType: 'usb', origin: 'https://one.example.invalid', device: device('usb') },
      { deviceType: 'serial', origin: 'https://one.example.invalid', device: device('serial') },
      { deviceType: 'hid', origin: 'https://one.example.invalid', device: device('non-fido', 1) },
      { deviceType: 'hid', origin: 'https://one.example.invalid', device: { collections: [] } },
      { deviceType: 'hid', origin: 'https://one.example.invalid', device: { collections: [{ usagePage: '61904' }] } }
    ]
    expect(inputs.map(input => f.session.device(input))).toEqual([true, true, false, false, false, false, false, false, false])
  })

  it('empty native list and non-FIDO list cancel once without claiming hardware availability', () => {
    const f = fixture(); register(f)
    const empty = request(f, []), unrelated = request(f, [devices[2]!])
    expect(empty.event.preventDefault).toHaveBeenCalledOnce()
    expect(empty.callback.mock.calls).toEqual([[null]])
    expect(unrelated.callback.mock.calls).toEqual([[null]])
    expect(native.Menu.instances).toEqual([])
    expect(f.owner.report).toHaveBeenCalledWith(expect.stringContaining('尚未确认'))
    assertClean(f)
  })

  it('continues the sole FIDO candidate from the same request even while background', () => {
    const f = fixture(); register(f); f.window.focused = false; f.window.visible = false; f.state.bounds = null
    const r = request(f, [devices[2]!, devices[1]!])
    expect(r.callback.mock.calls).toEqual([['second-original-id']])
    expect(native.Menu.instances).toEqual([])
    expect(f.window.focus).not.toHaveBeenCalled(); expect(f.contents.focus).not.toHaveBeenCalled()
    assertClean(f)
  })

  it('multiple FIDO candidates use original frame/window and only human choice resolves', () => {
    const f = fixture(); register(f)
    const r = request(f)
    expect(r.callback).not.toHaveBeenCalled()
    expect(r.menu!.items.map(value => value.label ?? value.type)).toEqual(['选择安全密钥', `来源：${f.frame.origin}`, 'separator', 'first-original-id', 'second-original-id', 'separator', '取消'])
    expect(r.menu!.options).toMatchObject({ window: f.window, frame: f.frame, x: 129, y: 66 })
    f.window.focused = false // A native menu itself can blur its original window.
    vi.advanceTimersByTime(250)
    expect(r.callback).not.toHaveBeenCalled()
    item(r.menu!, 'second-original-id').click!()
    item(r.menu!, 'first-original-id').click!(); r.menu!.options.callback()
    expect(r.callback.mock.calls).toEqual([['second-original-id']])
    assertClean(f)
  })

  it('snapshots original device IDs and labels before shown or background event objects change', () => {
    const shown = fixture(); register(shown)
    const shownDevices = [device('original-shown-one', 0xf1d0, 'Original shown key'), device('original-shown-two')]
    const first = request(shown, shownDevices)
    shownDevices[0]!.deviceId = 'replacement-shown-id'; shownDevices[0]!.name = 'Replacement shown name'
    item(first.menu!, 'Original shown key').click!()
    expect(first.callback.mock.calls).toEqual([['original-shown-one']])
    assertClean(shown)

    const hidden = fixture(); register(hidden); hidden.window.visible = false; hidden.window.focused = false
    const hiddenDevices = [device('original-hidden-one', 0xf1d0, 'Original waiting key'), device('original-hidden-two')]
    const pending = request(hidden, hiddenDevices)
    expect(pending.callback).not.toHaveBeenCalled(); expect(native.Menu.instances).toHaveLength(1)
    hiddenDevices[0]!.deviceId = 'replacement-hidden-id'; hiddenDevices[0]!.name = 'Replacement waiting name'
    hidden.window.visible = true; hidden.window.focused = true; hidden.window.emit('focus')
    const restoredMenu = native.Menu.instances[1]!
    expect(restoredMenu.items.filter(value => value.click).map(value => value.label)).toEqual(['Original waiting key', 'original-hidden-two', '取消'])
    item(restoredMenu, 'Original waiting key').click!()
    expect(pending.callback.mock.calls).toEqual([['original-hidden-one']])
    assertClean(hidden)
  })

  it('background and temporary hidden owner retain exact request and use dynamic bounds without focus calls', () => {
    const f = fixture(); register(f); f.window.visible = false; f.window.focused = false; f.state.bounds = null
    const r = request(f)
    vi.advanceTimersByTime(1000)
    expect(native.Menu.instances).toEqual([]); expect(r.callback).not.toHaveBeenCalled()
    f.window.visible = true; f.window.focused = true; f.state.bounds = { x: 80, y: 120, width: 234.5, height: 90 }; f.window.emit('focus')
    const firstMenu = native.Menu.instances[0]!
    expect(firstMenu.options).toMatchObject({ frame: f.frame, window: f.window, x: 197, y: 152 })
    f.window.visible = false; f.window.emit('hide'); firstMenu.options.callback()
    expect(firstMenu.closePopup).toHaveBeenCalledOnce()
    expect(r.callback).not.toHaveBeenCalled()
    f.window.visible = true; f.window.emit('show')
    expect(native.Menu.instances).toHaveLength(2)
    item(native.Menu.instances[1]!, '取消').click!()
    expect(r.callback.mock.calls).toEqual([[null]])
    expect(f.window.focus).not.toHaveBeenCalled(); expect(f.window.show).not.toHaveBeenCalled(); expect(f.window.restore).not.toHaveBeenCalled(); expect(f.contents.focus).not.toHaveBeenCalled()
    assertClean(f)
  })

  it('foreign account-menu lease keeps device request pending, and stale hide callback cannot release a new menu', () => {
    const f = fixture(); register(f)
    const foreign = {}
    expect(acquireBrowserWebAuthnWindowMenu(f.window as never, foreign)).toBe(true)
    const r = request(f); vi.advanceTimersByTime(250)
    expect(native.Menu.instances).toEqual([]); expect(r.callback).not.toHaveBeenCalled()
    releaseBrowserWebAuthnWindowMenu(f.window as never, foreign); vi.advanceTimersByTime(250)
    expect(native.Menu.instances).toHaveLength(1)
    const first = native.Menu.instances[0]!
    f.window.visible = false; f.window.emit('hide')
    expect(first.closePopup).toHaveBeenCalledOnce(); expect(r.callback).not.toHaveBeenCalled()
    expect(acquireBrowserWebAuthnWindowMenu(f.window as never, foreign)).toBe(true)
    f.window.visible = true; first.options.callback(); vi.advanceTimersByTime(250)
    expect(native.Menu.instances).toHaveLength(1) // Old callback did not release the peer lease.
    releaseBrowserWebAuthnWindowMenu(f.window as never, foreign); vi.advanceTimersByTime(250)
    const second = native.Menu.instances[1]!
    expect(second.options.frame).toBe(f.frame)
    first.options.callback()
    expect(acquireBrowserWebAuthnWindowMenu(f.window as never, foreign)).toBe(false)
    item(second, 'second-original-id').click!()
    expect(r.callback.mock.calls).toEqual([['second-original-id']])
    assertClean(f)
  })

  it('native dismissal or cancellation settles once and removes every pending listener/timer', () => {
    const f = fixture(); register(f)
    const r = request(f); r.menu!.options.callback(); r.menu!.options.callback(); cancelBrowserWebAuthnAccess(f.contents as never)
    expect(r.callback.mock.calls).toEqual([[null]])
    assertClean(f); expect(vi.getTimerCount()).toBe(0)
  })

  it('cross-document navigation of original frame or ancestor cancels, sibling navigation does not', () => {
    const f = fixture(); const ancestor = new native.Frame(); f.frame.parent = ancestor; register(f)
    const r = request(f)
    f.contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false, frame: new native.Frame() })
    expect(r.callback).not.toHaveBeenCalled()
    f.contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: true, frame: f.frame })
    expect(r.callback).not.toHaveBeenCalled()
    f.contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false, frame: ancestor })
    item(r.menu!, 'first-original-id').click!()
    expect(r.callback.mock.calls).toEqual([[null]])
    assertClean(f)
  })

  it('stale frame token, origin, ancestry or owner never dispatches a selected device', () => {
    const mutations: Array<(f: Fixture) => void> = [f => { f.frame.frameToken = 'replacement' }, f => { f.frame.origin = 'https://new.example.invalid' },
      f => { f.frame.parent = new native.Frame() }, f => { f.frame.detached = true }, f => { f.state.current = false }, f => { native.frameContents.delete(f.frame) }]
    const callbacks = mutations.map(mutate => {
      const f = fixture(); register(f); const r = request(f); mutate(f); item(r.menu!, 'first-original-id').click!(); assertClean(f); return r.callback.mock.calls
    })
    expect(callbacks).toEqual([[[null]], [[null]], [[null]], [[null]], [[null]], [[null]]])
  })

  it('insecure source, missing frame, malformed duplicate device IDs and ambiguous ownership reject', () => {
    const f = fixture(); register(f)
    const missing = request(f, devices, null)
    f.frame.url = 'ftp://localhost/auth'; f.frame.origin = 'ftp://localhost'
    const insecure = request(f)
    f.frame.url = 'https://frame.example.invalid/auth'; f.frame.origin = 'https://frame.example.invalid'
    const duplicate = request(f, [device('duplicate'), device('duplicate')])
    const malformed = request(f, [device(''), device('valid')])
    register(f, contents => contents === f.contents ? { ...f.owner } : null)
    const ambiguous = request(f)
    expect([missing, insecure, duplicate, malformed, ambiguous].map(r => r.callback.mock.calls)).toEqual([[[null]], [[null]], [[null]], [[null]], [[null]]])
    expect(native.Menu.instances).toEqual([])
  })

  it('removed devices cannot be selected, and removal of all original candidates cancels', () => {
    const f = fixture(); register(f)
    const r = request(f)
    f.session.emit('hid-device-removed', {}, { frame: f.frame, device: devices[0] })
    item(r.menu!, 'first-original-id').click!()
    expect(r.callback.mock.calls).toEqual([[null]])
    const next = request(f)
    f.session.emit('hid-device-removed', {}, { frame: new native.Frame(), device: devices[0] })
    expect(next.callback).not.toHaveBeenCalled()
    f.session.emit('hid-device-removed', {}, { frame: f.frame, device: devices[0] })
    f.session.emit('hid-device-removed', {}, { frame: f.frame, device: devices[1] })
    expect(next.callback.mock.calls).toEqual([[null]])
    assertClean(f)
  })

  it('one original window queues independent Browser requests without replacing the peer menu', () => {
    const a = fixture(), b = fixture(a.session, a.window); register(a); register(b)
    const first = request(a), second = request(b)
    expect(native.Menu.instances).toHaveLength(1)
    expect(second.callback).not.toHaveBeenCalled(); expect(first.callback).not.toHaveBeenCalled()
    item(first.menu!, 'second-original-id').click!(); vi.advanceTimersByTime(250)
    expect(native.Menu.instances).toHaveLength(2)
    expect(native.Menu.instances[1]!.options.frame).toBe(b.frame)
    item(native.Menu.instances[1]!, 'first-original-id').click!()
    expect(first.callback.mock.calls).toEqual([['second-original-id']]); expect(second.callback.mock.calls).toEqual([['first-original-id']])
    assertClean(a); assertClean(b)
  })

  it('a new same-contents request cancels only the old request and preserves callback reentry', () => {
    const f = fixture(); register(f)
    let reentrant: ReturnType<typeof request> | undefined
    const callback = vi.fn(() => { reentrant = request(f) })
    request(f, devices, f.frame, callback)
    const overtaken = request(f)
    expect(callback.mock.calls).toEqual([[null]])
    expect(overtaken.callback.mock.calls).toEqual([[null]])
    expect(reentrant!.callback).not.toHaveBeenCalled()
    item(reentrant!.menu!, 'first-original-id').click!()
    expect(reentrant!.callback.mock.calls).toEqual([['first-original-id']])
    assertClean(f)
  })

  it('timeout, destroyed contents, renderer crash and closed window terminate only that original request', () => {
    const cancellations: Array<(f: Fixture) => void> = [() => vi.advanceTimersByTime(60_000), f => f.contents.emit('destroyed'),
      f => f.contents.emit('render-process-gone'), f => f.window.emit('closed')]
    expect(cancellations.map(cancel => {
      const f = fixture(); register(f); f.window.focused = false; const r = request(f); cancel(f); assertClean(f); return r.callback.mock.calls
    })).toEqual([[[null]], [[null]], [[null]], [[null]]])
  })

  it('native popup and notice/callback failures still terminate without retaining work', () => {
    const f = fixture(); register(f); native.Menu.fail = true
    ;(f.owner.report as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('notice failed') })
    const callback = vi.fn(() => { throw new Error('native callback failed') })
    expect(() => request(f, devices, f.frame, callback)).not.toThrow()
    expect(callback.mock.calls).toEqual([[null]])
    assertClean(f); expect(vi.getTimerCount()).toBe(0)
  })

  it('shared Session installs policies exactly once, resolver references release only their own requests', () => {
    const a = fixture(), b = fixture(a.session)
    const resolveA = (contents: unknown) => contents === a.contents ? a.owner : null
    const releaseA = register(a, resolveA), releaseAgain = register(a, resolveA), releaseB = register(b)
    expect(a.session.setPermissionCheckHandler).toHaveBeenCalledOnce(); expect(a.session.setPermissionRequestHandler).toHaveBeenCalledOnce(); expect(a.session.setDevicePermissionHandler).toHaveBeenCalledOnce()
    expect(a.session.listenerCount('select-hid-device')).toBe(1)
    const first = request(a), second = request(b)
    releaseA(); releaseA(); expect(first.callback).not.toHaveBeenCalled()
    releaseAgain(); expect(first.callback.mock.calls).toEqual([[null]]); expect(second.callback).not.toHaveBeenCalled()
    expect(a.session.check(b.contents, 'hid', b.frame.origin, { securityOrigin: b.frame.origin })).toBe(true)
    expect(a.session.setDevicePermissionHandler).toHaveBeenCalledOnce()
    releaseB(); expect(second.callback.mock.calls).toEqual([[null]])
    expect(a.session.listenerCount('select-hid-device')).toBe(0)
    expect(a.session.check).toBeNull(); expect(a.session.request).toBeNull(); expect(a.session.device).toBeNull()
    expect(a.session.setDevicePermissionHandler.mock.calls).toHaveLength(2)
    assertClean(a); assertClean(b)
  })

  it('last release detaches old policies before callback registers a fresh Session owner', () => {
    const f = fixture(); const release = register(f)
    const r = request(f, devices, f.frame, vi.fn(() => { register(f) }))
    release()
    expect(r.callback.mock.calls).toEqual([[null]])
    expect(f.session.listenerCount('select-hid-device')).toBe(1)
    expect(f.session.setDevicePermissionHandler.mock.calls.map(call => call[0] === null)).toEqual([false, true, false])
    expect(f.session.check(f.contents, 'hid', f.frame.origin, { securityOrigin: f.frame.origin })).toBe(true)
    const fresh = request(f, [devices[0]!]); expect(fresh.callback.mock.calls).toEqual([['first-original-id']])
    assertClean(f)
  })
})
