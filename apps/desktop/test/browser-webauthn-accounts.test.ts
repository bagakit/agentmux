import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWebAuthnOwner } from '../src/main/browser-webauthn-accounts.js'

// Source-only Electron boundaries. This exercises the installed Session event and original
// callback, not a virtual authenticator, real OS menu, signing, or system-key availability.
const native = vi.hoisted(() => {
  type Listener = (...args: any[]) => void
  class Emitter {
    listeners = new Map<string, Listener[]>()
    on(event: string, listener: Listener) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); return this }
    once(event: string, listener: Listener) {
      const once = (...args: any[]) => { this.removeListener(event, once); listener(...args) }
      return this.on(event, once)
    }
    removeListener(event: string, listener: Listener) { this.listeners.set(event, (this.listeners.get(event) ?? []).filter(value => value !== listener)); return this }
    emit(event: string, ...args: any[]) { for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args) }
    listenerCount(event: string) { return this.listeners.get(event)?.length ?? 0 }
  }
  class Session extends Emitter {
    setPermissionCheckHandler = vi.fn()
    setPermissionRequestHandler = vi.fn()
    setDevicePermissionHandler = vi.fn()
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
    url = 'https://page.example.invalid/'
    mainFrame = new Frame()
    navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    executeJavaScriptInIsolatedWorld = vi.fn(async () => true)
    enableDeviceEmulation = vi.fn()
    disableDeviceEmulation = vi.fn()
    setZoomFactor = vi.fn()
    setBackgroundThrottling = vi.fn()
    getBackgroundThrottling = vi.fn(() => true)
    setWindowOpenHandler = vi.fn()
    constructor(readonly session = new Session()) { super(); frameContents.set(this.mainFrame, this) }
    isDestroyed() { return this.destroyed }
    getURL() { return this.url }
    getTitle() { return '' }
    isLoading() { return false }
    getZoomFactor() { return 1 }
    async loadURL(url: string) {
      this.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false, frame: this.mainFrame })
      this.url = url
      this.mainFrame.url = url
      this.mainFrame.origin = new URL(url).origin
      this.emit('did-finish-load')
    }
    close() { this.destroyed = true; this.emit('destroyed') }
  }
  class Window extends Emitter {
    destroyed = false
    visible = true
    minimized = false
    focused = true
    focus = vi.fn()
    show = vi.fn()
    restore = vi.fn()
    webContents = { isDestroyed: () => false, send: vi.fn() }
    contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
    isDestroyed() { return this.destroyed }
    isVisible() { return this.visible }
    isMinimized() { return this.minimized }
    isFocused() { return this.focused }
  }
  class View {
    static instances: View[] = []
    static sessions = new Map<string, Session>()
    webContents: Contents
    visible = false
    bounds = { x: 0, y: 0, width: 0, height: 0 }
    constructor(options: { webPreferences: { partition: string } }) {
      const partition = options.webPreferences.partition
      let session = View.sessions.get(partition)
      if (!session) { session = new Session(); View.sessions.set(partition, session) }
      this.webContents = new Contents(session)
      View.instances.push(this)
    }
    setVisible(value: boolean) { this.visible = value }
    getVisible() { return this.visible }
    getBounds() { return this.bounds }
    setBounds(value: typeof this.bounds) { this.bounds = value }
  }
  type Item = { label?: string; enabled?: boolean; type?: string; click?: () => void }
  class Menu extends Emitter {
    static instances: Menu[] = []
    static buildError = false
    static popupError = false
    options: any
    popup = vi.fn((options: any) => { this.options = options; if (Menu.popupError) throw new Error('popup failed') })
    closePopup = vi.fn((_window: Window) => this.options?.callback())
    constructor(readonly items: Item[]) { super(); Menu.instances.push(this) }
    static buildFromTemplate(items: Item[]) { if (Menu.buildError) throw new Error('menu failed'); return new Menu(items) }
  }
  return { Session, Frame, Contents, Window, View, Menu, frameContents, fromFrame: vi.fn((frame: Frame) => frameContents.get(frame)) }
})

vi.mock('electron', () => ({ Menu: native.Menu, webContents: { fromFrame: native.fromFrame }, WebContentsView: native.View, app: { getPath: () => tmpdir() } }))
import { registerBrowserWebAuthnAccounts, cancelBrowserWebAuthnAccounts } from '../src/main/browser-webauthn-accounts.js'
import { BrowserViewManager } from '../src/main/browser-view-manager.js'
import { BrowserRefLedgerStore } from '../src/main/browser-ref-ledger-store.js'
import { acquireBrowserWebAuthnWindowMenu, releaseBrowserWebAuthnWindowMenu } from '../src/main/browser-webauthn-window-menu.js'

const releases: Array<() => void> = []
const temporaryRoots: string[] = []
beforeEach(() => {
  vi.useFakeTimers()
  native.Menu.instances.length = 0
  native.Menu.buildError = false
  native.Menu.popupError = false
  native.View.instances.length = 0
  native.View.sessions.clear()
  native.frameContents.clear()
  native.fromFrame.mockClear()
})
afterEach(() => {
  for (const release of releases.splice(0).reverse()) release()
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(session = new native.Session(), window = new native.Window()) {
  const contents = new native.Contents(session)
  const frame = contents.mainFrame
  const current = { value: true }
  const owner: BrowserWebAuthnOwner = {
    window: window as never,
    bounds: { x: 40, y: 70, width: 400, height: 200 },
    isCurrent: () => current.value,
    report: vi.fn()
  }
  return { session, window, contents, frame, current, owner }
}
type Fixture = ReturnType<typeof fixture>
function register(f: Fixture, resolver = (contents: unknown) => contents === f.contents ? f.owner : null) {
  const release = registerBrowserWebAuthnAccounts(f.session as never, resolver)
  releases.push(release)
  return release
}
const accounts = [
  { credentialId: 'original-account-one', displayName: '第一账户' },
  { credentialId: 'original-account-two', name: 'second@example.invalid' }
]
function request(f: Fixture, values: Electron.WebAuthnAccount[] = accounts, frame: InstanceType<typeof native.Frame> | null = f.frame, callback = vi.fn()) {
  const event = { preventDefault: vi.fn() }
  f.session.emit('select-webauthn-account', event, { relyingPartyId: 'rp.example.invalid', frame, accounts: values }, callback)
  return { callback, event, menu: native.Menu.instances.at(-1) }
}
function accountItem(menu: InstanceType<typeof native.Menu>, label = '第一账户') {
  const item = menu.items.find(item => item.label === label)
  expect(item, '菜单必须实际含有账户项').toBeDefined()
  expect(item!.click).toBeTypeOf('function')
  return item!
}
function assertClean(f: Fixture) {
  expect(f.contents.listenerCount('did-start-navigation')).toBe(0)
  expect(f.contents.listenerCount('destroyed')).toBe(0)
  expect(f.contents.listenerCount('render-process-gone')).toBe(0)
  expect(f.window.listenerCount('closed')).toBe(0)
  expect(f.window.listenerCount('hide')).toBe(0)
  expect(f.window.listenerCount('minimize')).toBe(0)
  expect(f.window.listenerCount('focus')).toBe(0)
  expect(f.window.listenerCount('show')).toBe(0)
  expect(f.window.listenerCount('restore')).toBe(0)
}

describe('原 Session 的 WebAuthn 账户选择', () => {
  it.each(['visible', 'hidden-page', 'hidden-window', 'minimized', 'unfocused'] as const)('单合法账户 %s 直接继续同一原请求，不加菜单批准或抢焦点', mode => {
    const f = fixture(); register(f)
    if (mode === 'hidden-page') f.owner.bounds = null
    if (mode === 'hidden-window') f.window.visible = false
    if (mode === 'minimized') f.window.minimized = true
    if (mode === 'unfocused') f.window.focused = false
    f.frame.url = 'about:blank'
    const r = request(f, [accounts[0]!])
    expect(r.event.preventDefault).not.toHaveBeenCalled()
    expect(r.callback.mock.calls).toEqual([['original-account-one']])
    expect(native.Menu.instances).toEqual([])
    expect(f.window.focus).not.toHaveBeenCalled()
    expect(f.window.show).not.toHaveBeenCalled()
    expect(f.window.restore).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    assertClean(f)
  })

  it.each(['empty', 'whitespace', 'duplicate'] as const)('%s 非法候选不删除后猜单个账户', mode => {
    const f = fixture(); register(f)
    const values = mode === 'duplicate' ? [accounts[0]!, { ...accounts[1]!, credentialId: accounts[0]!.credentialId }]
      : [accounts[0]!, { credentialId: mode === 'empty' ? '' : '   ', name: 'invalid@example.invalid' }]
    const r = request(f, values)
    expect(r.callback.mock.calls).toEqual([[null]])
    expect(native.Menu.instances).toEqual([])
    expect(f.owner.report).toHaveBeenCalledWith(expect.stringContaining('候选无效'))
    assertClean(f)
  })

  it('多账户只回传用户点中的原凭据，后来的详情变动不串账户', () => {
    const f = fixture(); register(f)
    const supplied = accounts.map(value => ({ ...value }))
    const r = request(f, supplied)
    expect(r.callback).not.toHaveBeenCalled()
    expect(r.menu!.items.map(item => item.label ?? item.type)).toEqual([
      '选择 rp.example.invalid 的账户', '来源：https://frame.example.invalid', 'separator', '第一账户', 'second@example.invalid', 'separator', '取消'
    ])
    expect(r.menu!.options).toMatchObject({ window: f.window, frame: f.frame, x: 240, y: 102 })
    supplied[1]!.credentialId = 'foreign-mutated-account'
    accountItem(r.menu!, 'second@example.invalid').click!()
    expect(r.callback.mock.calls).toEqual([['original-account-two']])
  })

  it('超长和控制字符元数据保持紧凑，同名账户仍回原 ID，菜单不展示 credentialId', () => {
    const f = fixture(); register(f)
    const sameName = `长${'名'.repeat(250)}尾`
    f.frame.origin = `https://${'o'.repeat(200)}.example.invalid`
    const values = [{ credentialId: 'private-id-one', displayName: sameName }, { credentialId: 'private-id-two', displayName: sameName }]
    const r = request(f, values)
    const labels = r.menu!.items.map(item => item.label ?? '')
    expect(labels[3]).toHaveLength(160)
    expect(labels[3]).toBe(labels[4])
    expect(labels[3]).toContain('…')
    expect(labels[3]).toMatch(/尾$/)
    expect(labels[1]).toHaveLength(163)
    expect(labels.join(' ')).not.toContain('private-id-')
    expect(labels.join(' ')).not.toContain('\n')
    expect(labels.join(' ')).not.toContain('\u202e')
    r.menu!.items[4]!.click!()
    expect(r.callback.mock.calls).toEqual([['private-id-two']])
    const short = request(f, [{ credentialId: 'private-id-three', displayName: 'A\n\u202e&B' }, accounts[1]!])
    expect(short.menu!.items[3]!.label).toBe('A  &&B')
    short.menu!.items[3]!.click!()
    expect(short.callback.mock.calls).toEqual([['private-id-three']])
  })

  it('空账户必须取消且局部告知，不打开空菜单', () => {
    const f = fixture(); register(f)
    const r = request(f, [])
    expect(r.callback.mock.calls).toEqual([[null]])
    expect(native.Menu.instances).toEqual([])
    expect(f.owner.report).toHaveBeenCalledWith(expect.stringContaining('没有提供可选账户'))
  })

  it.each(['close', 'cancel', 'timeout'] as const)('%s 只取消一次并清掉原监听与计时器', mode => {
    const f = fixture(); register(f)
    const r = request(f)
    if (mode === 'close') r.menu!.options.callback()
    if (mode === 'cancel') accountItem(r.menu!, '取消').click!()
    if (mode === 'timeout') vi.advanceTimersByTime(60_000)
    expect(r.callback.mock.calls).toEqual([[null]])
    if (mode === 'timeout') expect(f.owner.report).toHaveBeenCalledWith(expect.stringContaining('超时'))
    r.menu!.options.callback()
    accountItem(r.menu!).click!()
    expect(r.callback.mock.calls).toEqual([[null]])
    assertClean(f)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('macOS MenuWillClose 在 itemSelected 前不抢走真实点选', () => {
    const f = fixture(); register(f)
    const r = request(f)
    r.menu!.emit('menu-will-close')
    expect(r.callback).not.toHaveBeenCalled()
    accountItem(r.menu!).click!()
    r.menu!.options.callback()
    expect(r.callback.mock.calls).toEqual([['original-account-one']])
  })

  it.each(['null-frame', 'missing-contents', 'foreign-session', 'no-owner'] as const)('%s 不能借其他 Browser 选账户', mode => {
    const f = fixture()
    if (mode !== 'no-owner') register(f)
    else register(f, () => null)
    if (mode === 'missing-contents') native.frameContents.delete(f.frame)
    if (mode === 'foreign-session') native.frameContents.set(f.frame, new native.Contents())
    const r = request(f, accounts, mode === 'null-frame' ? null : f.frame)
    expect(r.callback.mock.calls).toEqual([[null]])
    expect(native.Menu.instances).toEqual([])
  })

  it.each(['stale-owner', 'detached', 'destroyed-frame'] as const)('%s 真正失效，不到另一个工作面弹选择', mode => {
    const f = fixture(); register(f)
    if (mode === 'stale-owner') f.current.value = false
    if (mode === 'detached') f.frame.detached = true
    if (mode === 'destroyed-frame') f.frame.destroyed = true
    const r = request(f)
    expect(r.callback.mock.calls).toEqual([[null]])
    expect(native.Menu.instances).toEqual([])
    if (mode !== 'detached' && mode !== 'destroyed-frame') expect(f.owner.report).toHaveBeenCalledTimes(1)
  })

  it.each(['hidden-page', 'hidden-window', 'minimized', 'unfocused'] as const)('%s 保留 pending，原 owner 恢复后只弹一次，用当前 bounds 且不抢焦点', mode => {
    const f = fixture(); register(f)
    let bounds = mode === 'hidden-page' ? null : { x: 40, y: 70, width: 400, height: 200 }
    Object.defineProperty(f.owner, 'bounds', { get: () => bounds })
    if (mode === 'hidden-window') f.window.visible = false
    if (mode === 'minimized') f.window.minimized = true
    if (mode === 'unfocused') f.window.focused = false
    const r = request(f)
    const unrelated = fixture()
    vi.advanceTimersByTime(1_000)
    expect(r.callback).not.toHaveBeenCalled()
    expect(native.Menu.instances).toEqual([])
    expect(f.owner.report.mock.calls).toEqual([[expect.stringContaining('正在等待')]])
    expect(native.fromFrame.mock.calls.map(call => call[0])).not.toContain(unrelated.frame)
    bounds = { x: 90, y: 130, width: 250, height: 24 }
    f.window.visible = true; f.window.minimized = false; f.window.focused = true
    f.window.emit('focus'); f.window.emit('show'); f.window.emit('restore')
    vi.advanceTimersByTime(1_000)
    expect(native.Menu.instances).toHaveLength(1)
    const menu = native.Menu.instances[0]!
    expect(menu.popup).toHaveBeenCalledTimes(1)
    expect(menu.options).toMatchObject({ window: f.window, frame: f.frame, x: 215, y: 154 })
    expect(f.window.focus).not.toHaveBeenCalled()
    expect(f.window.show).not.toHaveBeenCalled()
    expect(f.window.restore).not.toHaveBeenCalled()
    accountItem(menu, 'second@example.invalid').click!()
    expect(r.callback.mock.calls).toEqual([['original-account-two']])
    assertClean(f)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['timeout', 'unregister', 'navigation', 'owner', 'detached'] as const)('后台等待期间 %s 真正收尾，恢复不能重新弹出', mode => {
    const f = fixture(); const release = register(f)
    f.window.focused = false
    const r = request(f)
    if (mode === 'timeout') vi.advanceTimersByTime(60_000)
    if (mode === 'unregister') release()
    if (mode === 'navigation') f.contents.emit('did-start-navigation', { isMainFrame: true, frame: f.frame })
    if (mode === 'owner') { f.current.value = false; vi.advanceTimersByTime(250) }
    if (mode === 'detached') { f.frame.detached = true; vi.advanceTimersByTime(250) }
    expect(r.callback.mock.calls).toEqual([[null]])
    f.window.focused = true; f.window.emit('focus')
    vi.advanceTimersByTime(1_000)
    expect(native.Menu.instances).toEqual([])
    assertClean(f)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['owner', 'url', 'origin', 'token', 'parent', 'from-frame'] as const)('回点重验 %s，旧点选不能作用新文档或 view/profile/navigation', mode => {
    const f = fixture(); register(f)
    const r = request(f)
    if (mode === 'owner') f.current.value = false
    if (mode === 'url') f.frame.url = 'https://frame.example.invalid/new-document'
    if (mode === 'origin') f.frame.origin = 'https://different.example.invalid'
    if (mode === 'token') f.frame.frameToken = 'replacement-frame'
    if (mode === 'parent') f.frame.parent = new native.Frame()
    if (mode === 'from-frame') native.frameContents.set(f.frame, new native.Contents(f.session))
    accountItem(r.menu!).click!()
    expect(r.callback.mock.calls).toEqual([[null]])
    expect(f.owner.report).toHaveBeenCalledWith(expect.stringContaining('已改变'))
  })

  it.each(['main', 'request-frame', 'ancestor'] as const)('%s 导航即使同 URL 也取消，无关 iframe 保留选择', mode => {
    const f = fixture(); register(f)
    const ancestor = new native.Frame(); f.frame.parent = ancestor
    const r = request(f)
    f.contents.emit('did-start-navigation', { isMainFrame: false, frame: new native.Frame(), url: f.frame.url })
    expect(r.callback).not.toHaveBeenCalled()
    f.contents.emit('did-start-navigation', { isMainFrame: mode === 'main', frame: mode === 'ancestor' ? ancestor : f.frame, url: f.frame.url })
    expect(r.callback.mock.calls).toEqual([[null]])
    assertClean(f)
  })

  it.each(['detached', 'destroyed', 'replaced-owner'] as const)('无导航事件的 %s 在相关 pending 检查内结束，不扫其他 Browser', mode => {
    const f = fixture(); register(f)
    const r = request(f)
    const unrelated = fixture()
    if (mode === 'detached') f.frame.detached = true
    if (mode === 'destroyed') f.frame.destroyed = true
    if (mode === 'replaced-owner') f.current.value = false
    vi.advanceTimersByTime(250)
    expect(r.callback.mock.calls).toEqual([[null]])
    expect(native.fromFrame.mock.calls.map(call => call[0])).not.toContain(unrelated.frame)
    assertClean(f)
  })

  it.each(['destroyed', 'render-process-gone', 'closed'] as const)('%s 生命周期收尾 exact-once', event => {
    const f = fixture(); register(f)
    const r = request(f)
    if (event === 'destroyed' || event === 'render-process-gone') f.contents.emit(event)
    else f.window.emit(event)
    expect(r.callback.mock.calls).toEqual([[null]])
    r.menu!.options.callback()
    expect(r.callback.mock.calls).toEqual([[null]])
    assertClean(f)
  })

  it('菜单自己的窗口 blur 不取消用户选择', () => {
    const f = fixture(); register(f)
    const r = request(f)
    f.window.emit('blur')
    f.window.focused = false
    vi.advanceTimersByTime(500)
    expect(r.callback).not.toHaveBeenCalled()
    expect(native.Menu.instances).toHaveLength(1)
    expect(r.menu!.popup).toHaveBeenCalledTimes(1)
    accountItem(r.menu!).click!()
    expect(r.callback.mock.calls).toEqual([['original-account-one']])
  })

  it.each(['hide', 'minimize', 'hidden-page'] as const)('已开菜单的 %s 原生 dismiss 保留原请求，旧菜单回调不结束恢复后的选择', mode => {
    const f = fixture(); register(f)
    const r = request(f)
    const old = r.menu!
    if (mode === 'hide') f.window.visible = false
    if (mode === 'minimize') f.window.minimized = true
    if (mode === 'hidden-page') f.owner.bounds = null
    f.window.emit(mode)
    vi.advanceTimersByTime(250)
    expect(old.closePopup.mock.calls).toEqual([[f.window]])
    const other = {}
    expect(acquireBrowserWebAuthnWindowMenu(f.window as never, other)).toBe(true)
    releaseBrowserWebAuthnWindowMenu(f.window as never, other)
    old.options.callback()
    expect(r.callback).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(native.Menu.instances).toHaveLength(1)
    f.window.visible = true; f.window.minimized = false; f.window.focused = true
    f.owner.bounds = { x: 20, y: 60, width: 200, height: 80 }
    f.window.emit('focus'); vi.advanceTimersByTime(500)
    expect(native.Menu.instances).toHaveLength(2)
    const restored = native.Menu.instances[1]!
    expect(restored.popup).toHaveBeenCalledTimes(1)
    old.options.callback(); accountItem(old).click!(); accountItem(old, '取消').click!()
    expect(r.callback).not.toHaveBeenCalled()
    accountItem(restored, 'second@example.invalid').click!()
    expect(r.callback.mock.calls).toEqual([['original-account-two']])
    assertClean(f)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('后台返回不重置原60秒预算', () => {
    const f = fixture(); register(f)
    f.window.focused = false
    const r = request(f)
    vi.advanceTimersByTime(59_750)
    f.window.focused = true; f.window.emit('focus')
    expect(native.Menu.instances).toHaveLength(1)
    vi.advanceTimersByTime(250)
    expect(r.callback.mock.calls).toEqual([[null]])
    expect(f.owner.report).toHaveBeenCalledWith(expect.stringContaining('超时'))
    assertClean(f)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('窗口 hide 的原生 dismiss callback 先于窗口事件也保留原请求', () => {
    const f = fixture(); register(f)
    const r = request(f)
    f.window.visible = false
    r.menu!.options.callback()
    const other = {}
    expect(acquireBrowserWebAuthnWindowMenu(f.window as never, other)).toBe(true)
    releaseBrowserWebAuthnWindowMenu(f.window as never, other)
    f.window.emit('hide')
    expect(r.callback).not.toHaveBeenCalled()
    expect(r.menu!.closePopup).not.toHaveBeenCalled()
    f.window.visible = true; f.window.emit('show')
    expect(native.Menu.instances).toHaveLength(2)
    r.menu!.options.callback()
    expect(r.callback).not.toHaveBeenCalled()
    accountItem(native.Menu.instances[1]!, 'second@example.invalid').click!()
    expect(r.callback.mock.calls).toEqual([['original-account-two']])
    assertClean(f)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('同窗口的 foreign token 阻止账户菜单，旧token release 不释放新选择', () => {
    const f = fixture(); register(f)
    const first = {}, second = {}
    releases.push(() => releaseBrowserWebAuthnWindowMenu(f.window as never, second))
    expect(acquireBrowserWebAuthnWindowMenu(f.window as never, first)).toBe(true)
    const r = request(f)
    expect(r.callback).not.toHaveBeenCalled()
    expect(native.Menu.instances).toEqual([])
    releaseBrowserWebAuthnWindowMenu(f.window as never, first)
    expect(acquireBrowserWebAuthnWindowMenu(f.window as never, second)).toBe(true)
    releaseBrowserWebAuthnWindowMenu(f.window as never, first)
    vi.advanceTimersByTime(250)
    expect(native.Menu.instances).toEqual([])
    expect(r.callback).not.toHaveBeenCalled()
    releaseBrowserWebAuthnWindowMenu(f.window as never, second)
    vi.advanceTimersByTime(250)
    expect(native.Menu.instances).toHaveLength(1)
    accountItem(native.Menu.instances[0]!).click!()
    expect(r.callback.mock.calls).toEqual([['original-account-one']])
    const next = {}
    expect(acquireBrowserWebAuthnWindowMenu(f.window as never, next)).toBe(true)
    releaseBrowserWebAuthnWindowMenu(f.window as never, next)
    assertClean(f)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('同 displayName 的账户显示不同 name，缺失名字用局部序号，不展示凭据 ID', () => {
    const f = fixture(); register(f)
    const r = request(f, [
      { credentialId: 'private-one', displayName: '账户', name: 'one@example.invalid' },
      { credentialId: 'private-two', displayName: '账户', name: 'two@example.invalid' },
      { credentialId: 'private-three' }
    ])
    expect(r.menu!.items.slice(3, 6).map(item => item.label)).toEqual(['账户 · one@example.invalid', '账户 · two@example.invalid', '账户 3'])
    accountItem(r.menu!, '账户 · two@example.invalid').click!()
    expect(r.callback.mock.calls).toEqual([['private-two']])
    const longPrefix = 'same-prefix-'.repeat(20)
    const long = request(f, [
      { credentialId: 'private-long-one', displayName: '同名', name: `${longPrefix}one@example.invalid` },
      { credentialId: 'private-long-two', displayName: '同名', name: `${longPrefix}two@example.invalid` }
    ])
    expect(long.menu!.items[3]!.label).toContain('…')
    expect(long.menu!.items[3]!.label).toContain('one@example.invalid')
    expect(long.menu!.items[4]!.label).toContain('two@example.invalid')
    long.menu!.items[4]!.click!()
    expect(long.callback.mock.calls).toEqual([['private-long-two']])
  })

  it.each(['build', 'popup', 'resolver'] as const)('%s throw 不能留下永久 pending', mode => {
    const f = fixture()
    register(f, mode === 'resolver' ? () => { throw new Error('resolver failed') } : undefined)
    native.Menu.buildError = mode === 'build'
    native.Menu.popupError = mode === 'popup'
    const r = request(f)
    expect(r.callback.mock.calls).toEqual([[null]])
    assertClean(f)
    expect(vi.getTimerCount()).toBe(0)
    const other = {}
    expect(acquireBrowserWebAuthnWindowMenu(f.window as never, other)).toBe(true)
    releaseBrowserWebAuthnWindowMenu(f.window as never, other)
  })

  it('notice 或原 callback 抛异常仍先清状态，回调不重复且下一次可继续', () => {
    const f = fixture(); register(f)
    f.owner.report = vi.fn(() => { throw new Error('notice failed') })
    const callback = vi.fn(() => { throw new Error('native callback failed') })
    const r = request(f, accounts, f.frame, callback)
    expect(() => accountItem(r.menu!).click!()).not.toThrow()
    expect(callback.mock.calls).toEqual([['original-account-one']])
    assertClean(f)
    const next = request(f)
    accountItem(next.menu!, '取消').click!()
    expect(next.callback.mock.calls).toEqual([[null]])
  })

  it('同 Session 的多个 manager / 同 resolver 重复注册只有一个真实 listener，注销只收本 owner', () => {
    const first = fixture(); const second = fixture(first.session)
    const resolver = (contents: unknown) => contents === first.contents ? first.owner : null
    const releaseFirst = register(first, resolver)
    const releaseFirstAgain = register(first, resolver)
    const releaseSecond = register(second)
    expect(first.session.listenerCount('select-webauthn-account')).toBe(1)
    const a = request(first); const b = request(second)
    expect(native.Menu.instances.length).toBe(2)
    releaseFirst()
    expect(a.callback).not.toHaveBeenCalled()
    releaseFirstAgain()
    expect(a.callback.mock.calls).toEqual([[null]])
    expect(b.callback).not.toHaveBeenCalled()
    expect(first.session.listenerCount('select-webauthn-account')).toBe(1)
    accountItem(b.menu!).click!()
    expect(b.callback.mock.calls).toEqual([['original-account-one']])
    releaseSecond()
    expect(first.session.listenerCount('select-webauthn-account')).toBe(0)
  })

  it('两个 resolver 都认同一个 contents 时取消，不猜 owner 或重复 callback', () => {
    const f = fixture(); register(f)
    const otherOwner = { ...f.owner, window: new native.Window() as never, report: vi.fn() }
    register(f, () => otherOwner)
    const r = request(f)
    expect(r.callback.mock.calls).toEqual([[null]])
    expect(native.Menu.instances).toEqual([])
    expect(f.owner.report).toHaveBeenCalledTimes(1)
    expect(otherOwner.report).toHaveBeenCalledTimes(1)
  })

  it('同 contents 新请求替换旧菜单；旧 close callback 不能结束新选择', () => {
    const f = fixture(); register(f)
    const a = request(f); const b = request(f)
    expect(a.callback.mock.calls).toEqual([[null]])
    expect(b.callback).not.toHaveBeenCalled()
    a.menu!.options.callback()
    accountItem(b.menu!, 'second@example.invalid').click!()
    expect(b.callback.mock.calls).toEqual([['original-account-two']])
  })

  it('旧 callback 只改变 owner 时，incoming 重验失败不开新菜单', () => {
    const f = fixture(); register(f)
    const a = request(f, accounts, f.frame, vi.fn(() => { f.current.value = false }))
    const incoming = request(f)
    expect(a.callback.mock.calls).toEqual([[null]])
    expect(incoming.callback.mock.calls).toEqual([[null]])
    expect(native.Menu.instances.length).toBe(1)
    expect(f.owner.report).toHaveBeenCalledWith(expect.stringContaining('已改变'))
    assertClean(f)
  })

  it('同 window 不同 contents 拒绝新请求并提示，原选择保留；cancel 只影响指定 contents', () => {
    const first = fixture(); const second = fixture(first.session, first.window)
    register(first); register(second)
    const a = request(first); const b = request(second)
    expect(native.Menu.instances.length).toBe(1)
    expect(b.callback.mock.calls).toEqual([[null]])
    expect(second.owner.report).toHaveBeenCalledWith(expect.stringContaining('另一个 Browser'))
    cancelBrowserWebAuthnAccounts(second.contents as never)
    expect(a.callback).not.toHaveBeenCalled()
    accountItem(a.menu!).click!()
    expect(a.callback.mock.calls).toEqual([['original-account-one']])
  })

  it('不同 window 选择独立，原 callback 重入也不覆盖悬挂请求', () => {
    const first = fixture(); const second = fixture(first.session)
    register(first); register(second)
    let nested: ReturnType<typeof request> | undefined
    const a = request(first, accounts, first.frame, vi.fn(() => { nested = request(first) }))
    const b = request(second)
    const incoming = request(first)
    expect(a.callback.mock.calls).toEqual([[null]])
    expect(incoming.callback.mock.calls).toEqual([[null]])
    expect(nested!.callback).not.toHaveBeenCalled()
    expect(b.callback).not.toHaveBeenCalled()
    accountItem(nested!.menu!, 'second@example.invalid').click!()
    accountItem(b.menu!).click!()
    expect(nested!.callback.mock.calls).toEqual([['original-account-two']])
    expect(b.callback.mock.calls).toEqual([['original-account-one']])
  })

  it('真实 BrowserViewManager.create → Session event → hide/resume/close 的产品入口闭合', async () => {
    const root = mkdtempSync(join(tmpdir(), 'amx-webauthn-owning-')); temporaryRoots.push(root)
    const window = new native.Window()
    const manager = new BrowserViewManager(window as never,
      { defaultProfileId: () => 'default', resolvePartition: profile => `persist:webauthn-test-${profile}` },
      new BrowserRefLedgerStore(join(root, 'ledger.json')),
      { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: () => {} })
    releases.push(() => manager.dispose())
    await manager.create('browser-one', 'https://one.example.invalid/')
    await manager.create('browser-two', 'https://two.example.invalid/')
    const [first, second] = native.View.instances
    expect(native.View.instances.length).toBe(2)
    expect(first!.webContents.session).toBe(second!.webContents.session)
    expect(first!.webContents.session.listenerCount('select-webauthn-account')).toBe(1)
    expect(first!.webContents.session.listenerCount('select-hid-device')).toBe(1)
    manager.setBounds('browser-one', { x: 20, y: 80, width: 320, height: 200 })
    manager.setBounds('browser-two', { x: 380, y: 80, width: 320, height: 200 })
    const f = { session: first!.webContents.session, contents: first!.webContents, frame: first!.webContents.mainFrame } as Fixture
    const r = request(f)
    expect(r.callback).not.toHaveBeenCalled()
    expect(r.menu!.options).toMatchObject({ window, x: 180, y: 112 })
    manager.setBounds('browser-two', null)
    expect(r.callback).not.toHaveBeenCalled()
    manager.setBounds('browser-one', null)
    expect(first!.visible).toBe(false)
    vi.advanceTimersByTime(250)
    expect(r.menu!.closePopup.mock.calls).toEqual([[window]])
    r.menu!.options.callback()
    expect(r.callback).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    manager.setBounds('browser-one', { x: 70, y: 100, width: 234.5, height: 120 })
    vi.advanceTimersByTime(250)
    const resumed = native.Menu.instances.at(-1)!
    expect(resumed.options).toMatchObject({ window, x: 188, y: 132 })
    accountItem(resumed, 'second@example.invalid').click!()
    expect(r.callback.mock.calls).toEqual([['original-account-two']])
    const updates = window.webContents.send.mock.calls.map(call => call[1] as { type?: string; browser?: { id: string; activity?: { warning?: string } } })
      .filter(event => event.type === 'updated' && event.browser?.id === 'browser-one')
    expect(updates.length).toBeGreaterThan(0)
    expect(updates.some(update => update.browser?.activity?.warning?.includes('正在等待'))).toBe(true)
    const closing = request(f)
    manager.close('browser-one')
    expect(closing.callback.mock.calls).toEqual([[null]])
    closing.menu!.options.callback()
    expect(closing.callback).toHaveBeenCalledTimes(1)
    manager.dispose()
    expect(first!.webContents.session.listenerCount('select-webauthn-account')).toBe(0)
    expect(first!.webContents.session.listenerCount('select-hid-device')).toBe(0)
  })

  it.each(['account-first', 'device-first'] as const)('真实 BVM Session %s 两认证事件在同窗口轮流呈现，旧菜单不能释放新选择', async order => {
    const root = mkdtempSync(join(tmpdir(), 'amx-webauthn-window-')); temporaryRoots.push(root)
    const window = new native.Window()
    const manager = new BrowserViewManager(window as never,
      { defaultProfileId: () => 'default', resolvePartition: profile => `persist:webauthn-window-${profile}` },
      new BrowserRefLedgerStore(join(root, 'ledger.json')),
      { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: () => {} })
    releases.push(() => manager.dispose())
    await manager.create('original-browser', 'https://generic-auth.example.invalid/')
    manager.setBounds('original-browser', { x: 20, y: 80, width: 320, height: 200 })
    const view = native.View.instances.at(-1)!
    const f = { session: view.webContents.session, contents: view.webContents, frame: view.webContents.mainFrame } as Fixture
    const deviceCallback = vi.fn()
    const devices = [
      { deviceId: 'source-device-one', name: '通用安全密钥一', collections: [{ usagePage: 0xf1d0 }] },
      { deviceId: 'source-device-two', name: '通用安全密钥二', collections: [{ usagePage: 0xf1d0 }] }
    ]
    const deviceRequest = () => f.session.emit('select-hid-device', { preventDefault: vi.fn() }, { frame: f.frame, deviceList: devices }, deviceCallback)
    let account: ReturnType<typeof request>
    if (order === 'account-first') { account = request(f); deviceRequest() }
    else { deviceRequest(); account = request(f) }
    expect(native.Menu.instances).toHaveLength(1)
    expect(account.callback).not.toHaveBeenCalled()
    expect(deviceCallback).not.toHaveBeenCalled()
    const first = native.Menu.instances[0]!
    accountItem(first, order === 'account-first' ? '第一账户' : '通用安全密钥一').click!()
    vi.advanceTimersByTime(250)
    expect(native.Menu.instances).toHaveLength(2)
    const second = native.Menu.instances[1]!
    expect(second.options).toMatchObject({ window, frame: f.frame, x: 180, y: 112 })
    expect(second.popup).toHaveBeenCalledTimes(1)
    first.options.callback(); accountItem(first, '取消').click!()
    expect(order === 'account-first' ? deviceCallback : account.callback).not.toHaveBeenCalled()
    accountItem(second, order === 'account-first' ? '通用安全密钥二' : 'second@example.invalid').click!()
    expect(account.callback.mock.calls).toEqual([[order === 'account-first' ? 'original-account-one' : 'original-account-two']])
    expect(deviceCallback.mock.calls).toEqual([[order === 'account-first' ? 'source-device-two' : 'source-device-one']])
    expect(window.focus).not.toHaveBeenCalled()
    expect(window.show).not.toHaveBeenCalled()
    const token = {}
    expect(acquireBrowserWebAuthnWindowMenu(window as never, token)).toBe(true)
    releaseBrowserWebAuthnWindowMenu(window as never, token)
    manager.dispose()
    expect(f.session.listenerCount('select-webauthn-account')).toBe(0)
    expect(f.session.listenerCount('select-hid-device')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
