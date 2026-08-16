import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function png(width = 2, height = 3): Buffer {
  const value = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(value)
  value.writeUInt32BE(13, 8)
  value.write('IHDR', 12, 'ascii')
  value.writeUInt32BE(width, 16)
  value.writeUInt32BE(height, 20)
  value[24] = 8
  value[25] = 6
  return value
}

const fakeElectron = vi.hoisted(() => {
  type Listener = (...args: any[]) => void

  class FakeWebContents {
    url = ''
    title = ''
    loading = false
    destroyed = false
    zoomFactor = 1
    deviceEmulation: Record<string, unknown> | null = null
    readonly disableDeviceEmulation = vi.fn(() => { this.deviceEmulation = null })
    readonly enableDeviceEmulation = vi.fn((parameters: Record<string, unknown>) => {
      this.deviceEmulation = parameters
    })
    readonly openDevTools = vi.fn()
    executeJavaScriptInIsolatedWorldImpl = async (_worldId: number, scripts: Array<{ code: string }>) =>
      scripts[0]?.code.includes('Select an element') ? null : true
    readonly executeJavaScriptInIsolatedWorld = vi.fn(async (
      worldId: number,
      scripts: Array<{ code: string }>
    ) => await this.executeJavaScriptInIsolatedWorldImpl(worldId, scripts))
    capturePageImpl = async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 2, height: 3 }),
      toPNG: () => png()
    })
    readonly capturePage = vi.fn(async () => await this.capturePageImpl())
    readonly session = {
      checkHandler: null as null | ((...args: any[]) => boolean),
      requestHandler: null as null | ((...args: any[]) => void),
      setPermissionCheckHandler: vi.fn((handler: (...args: any[]) => boolean) => {
        this.session.checkHandler = handler
      }),
      setPermissionRequestHandler: vi.fn((handler: (...args: any[]) => void) => {
        this.session.requestHandler = handler
      })
    }
    readonly listeners = new Map<string, Listener[]>()
    readonly navigationHistory = {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: vi.fn(),
      goForward: vi.fn()
    }
    windowOpenHandler: null | ((details: { url: string }) => { action: string }) = null
    loadURLImpl = async (url: string): Promise<void> => { this.finishLoad(url) }

    on(event: string, listener: Listener) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
      return this
    }

    once(event: string, listener: Listener) {
      const wrapped: Listener = (...args) => {
        this.removeListener(event, wrapped)
        listener(...args)
      }
      return this.on(event, wrapped)
    }

    removeListener(event: string, listener: Listener) {
      this.listeners.set(event, (this.listeners.get(event) ?? []).filter((item) => item !== listener))
      return this
    }

    emit(event: string, ...args: any[]) {
      for (const listener of this.listeners.get(event) ?? []) listener({}, ...args)
    }

    emitDetails(event: string, details: Record<string, unknown>) {
      for (const listener of this.listeners.get(event) ?? []) listener(details)
    }

    setWindowOpenHandler(handler: (details: { url: string }) => { action: string }) {
      this.windowOpenHandler = handler
    }
    setZoomFactor(value: number) { this.zoomFactor = value }
    getZoomFactor() { return this.zoomFactor }

    finishLoad(url: string) {
      this.loading = true
      this.emitDetails('did-start-navigation', { url, isSameDocument: false, isMainFrame: true })
      this.emit('did-start-loading')
      this.zoomFactor = 1
      this.url = url
      this.title = url === 'about:blank' ? '' : new URL(url).hostname
      this.emit('did-navigate', url)
      this.loading = false
      this.emit('did-finish-load')
      this.emit('did-stop-loading')
    }

    async loadURL(url: string) { await this.loadURLImpl(url) }

    getURL() { return this.url }
    getTitle() { return this.title }
    isLoading() { return this.loading }
    isDestroyed() { return this.destroyed }
    reload() {
      this.emitDetails('did-start-navigation', { url: this.url, isSameDocument: false, isMainFrame: true })
      this.emit('did-start-loading')
      this.zoomFactor = 1
      this.emit('did-finish-load')
      this.emit('did-stop-loading')
    }
    close() { this.destroyed = true; this.emit('destroyed') }
  }

  class FakeWebContentsView {
    static instances: FakeWebContentsView[] = []
    static nextLoadURLImpl: null | ((contents: FakeWebContents, url: string) => Promise<void>) = null
    readonly webContents = new FakeWebContents()
    readonly partition: string | undefined
    // 整份 webPreferences 都留着，不只挑 partition 出来。沙箱开关（contextIsolation/sandbox/
    // nodeIntegration）是这个内嵌浏览器唯一挡住"任意 URL 的页面拿到 Node 能力"的东西，而这个 fake
    // 此前只读 partition、把另外三个字段直接丢掉——于是把三个开关**各自**翻反，24 条测试照旧全绿。
    // 丢掉的字段等于没人守的字段，所以这里存整份，让下面那条断言够得着。
    readonly webPreferences: Record<string, unknown> | undefined
    visible = true
    bounds = { x: 0, y: 0, width: 0, height: 0 }

    constructor(options?: { webPreferences?: Record<string, unknown> }) {
      FakeWebContentsView.instances.push(this)
      this.webPreferences = options?.webPreferences
      this.partition = options?.webPreferences?.partition as string | undefined
      const nextLoadURLImpl = FakeWebContentsView.nextLoadURLImpl
      FakeWebContentsView.nextLoadURLImpl = null
      if (nextLoadURLImpl) {
        this.webContents.loadURLImpl = async (url) => await nextLoadURLImpl(this.webContents, url)
      }
    }

    setVisible(value: boolean) { this.visible = value }
    setBounds(value: typeof this.bounds) { this.bounds = value }
  }

  return { FakeWebContentsView }
})

// `app` 只为 BrowserRefLedgerStore 的默认路径参数而在：本文件每次都显式给路径，所以它不会被读到。
// 不给的话，那条 import 在 mock 的命名空间里取不到名字。
vi.mock('electron', () => ({
  WebContentsView: fakeElectron.FakeWebContentsView,
  app: { getPath: () => tmpdir() }
}))

import {
  assertAllowedBrowserUrl,
  BrowserViewManager,
  type BrowserProfileResolver,
  DEFAULT_BROWSER_ZOOM_FACTOR,
  normalizeBrowserUrl
} from '../src/main/browser-view-manager.js'
import { BrowserRefLedgerStore } from '../src/main/browser-ref-ledger-store.js'
import { normalizeBrowserBounds } from '../src/shared/browser-bounds.js'

const profiles: BrowserProfileResolver = {
  defaultProfileId: () => 'default',
  resolvePartition: (profileId) => {
    const partition = {
      default: 'persist:browser-default',
      personal: 'persist:browser-personal',
      work: 'persist:browser-work'
    }[profileId]
    if (!partition) throw new Error(`Unknown browser profile: ${profileId}`)
    return partition
  }
}

function browserManager(window: ReturnType<typeof fakeWindow>['window']): BrowserViewManager {
  // ref 账本指向一个临时路径：本文件判的是 view 生命周期，不判持久化。给真路径会让这些用例
  // 往用户的 userData 里写文件。
  return new BrowserViewManager(window as never, profiles, new BrowserRefLedgerStore(
    join(mkdtempSync(join(tmpdir(), 'agentmux-bvm-')), 'ref-ledger.json')
  ), appLinkHost())
}

/**
 * 一个记账的应用链接宿主。`openExternal` **必须**是假的——真的 `shell.openExternal` 会在跑测试的
 * 人脸上弹出飞书。记下来而不是只数次数：判据要能说出交出去的是**哪个** URL。
 */
function appLinkHost(remembered: Record<string, 'allow' | 'deny'> = {}) {
  const opened: string[] = []
  const saved: Array<{ scheme: string; choice: 'allow' | 'deny' }> = []
  return {
    opened,
    saved,
    rememberedSchemes: async () => remembered,
    rememberScheme: async (scheme: string, choice: 'allow' | 'deny') => {
      saved.push({ scheme, choice })
      remembered[scheme] = choice
    },
    openExternal: (target: string) => { opened.push(target) }
  }
}

function fakeWindow() {
  const children: InstanceType<typeof fakeElectron.FakeWebContentsView>[] = []
  const sent: unknown[] = []
  return {
    children,
    sent,
    window: {
      contentView: {
        addChildView(view: InstanceType<typeof fakeElectron.FakeWebContentsView>) { children.push(view) },
        removeChildView(view: InstanceType<typeof fakeElectron.FakeWebContentsView>) {
          const index = children.indexOf(view)
          if (index >= 0) children.splice(index, 1)
        }
      },
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send(_channel: string, value: unknown) { sent.push(value) }
      }
    }
  }
}

describe('BrowserViewManager', () => {
  it('normalizes only embeddable web URLs', () => {
    expect(normalizeBrowserUrl('example.com')).toBe('https://example.com/')
    expect(normalizeBrowserUrl('localhost:4173')).toBe('http://localhost:4173/')
    expect(normalizeBrowserUrl('agent runtime docs')).toBe('https://www.google.com/search?q=agent%20runtime%20docs')
    expect(normalizeBrowserUrl('about:blank')).toBe('about:blank')
    expect(normalizeBrowserUrl('file:///etc/passwd')).toBe('file:///etc/passwd')
    expect(() => normalizeBrowserUrl('javascript:alert(1)')).toThrow('Unsupported browser URL protocol')
    expect(() => assertAllowedBrowserUrl('mailto:hello@example.com')).toThrow('Unsupported browser URL protocol')
  })

  /**
   * 交给原生视图的矩形**逐字节**等于共用判定的答案——这一侧的「壳有没有偷偷再动一手」（#712）。
   *
   * 为什么单独一条而不是靠上面那条生命周期用例：它只喂了一个 `{800.2, 500.8}` 的大矩形，于是壳里在
   * 共用调用之后再补一道地板（真实发生过的绕法是 `const M = Math` 加 `M.max(7, …)`）对它毫无影响，
   * 三个 suite 67 条全绿而任何窄于地板的 Region 被静默拉宽。normalization 那份的结构层按 `Math.xxx()`
   * 的**形状**判，别名写法逃得掉，所以那一层顶不住这个。
   *
   * 期望值取自 {@link normalizeBrowserBounds}：这一条要判的性质就是「壳交出去的 === 共用判定算出来
   * 的」，恒等关系才是被断言的东西。共用判定自己的取值正确性由 browser-bounds-normalization 那份用写死
   * 的字面量钉着，两份合起来才完整。窄矩形在场的自检写在最后一行，防「两边都恒 null」式的假绿。
   */
  it('forwards the shared decision byte-for-byte instead of re-clamping in the shell', async () => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    await manager.create('browser-forward', 'https://example.com')
    const view = fixture.children[0]!

    // 每个都挑成「随手补一道地板/取整就会被打破」的形状；前三条是 #712 的靶子本身。
    const forwarded = [
      { x: 4, y: 9, width: 3, height: 260 },
      { x: 4, y: 9, width: 260, height: 2 },
      { x: 0, y: 0, width: 1, height: 1 },
      { x: -0.6, y: -5, width: 40, height: 40 },
      { x: 10.4, y: 20.6, width: 800.2, height: 500.8 }
    ]
    for (const bounds of forwarded) {
      manager.setBounds('browser-forward', { ...bounds })
      expect(view.bounds, `${JSON.stringify(bounds)} 交给原生视图的不是共用判定的答案`)
        .toEqual(normalizeBrowserBounds(bounds))
    }

    // 判据没有落空：清单里真有「窄到会被地板改写」的可用矩形。没有这一条，上面的循环在共用判定被改成
    // 恒 null 时会变成 setBounds 全走隐藏分支、view.bounds 停在旧值——那时它比较的是两个陈旧值。
    const narrow = forwarded
      .map((bounds) => normalizeBrowserBounds(bounds))
      .filter((value): value is NonNullable<typeof value> => value !== null)
      .filter((value) => value.width < 7 || value.height < 7)
    expect(narrow.length, '没有任何窄矩形，这一条抓不到 #712 那种重夹').toBeGreaterThan(0)
  })

  it('owns WebContentsView bounds, navigation, and close lifecycle', async () => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)

    const created = await manager.create('browser-1', 'about:blank')
    const view = fixture.children[0]!
    expect(created).toMatchObject({ id: 'browser-1', profileId: 'default', url: 'about:blank' })
    expect(manager.usesProfile('default')).toBe(true)
    expect(manager.usesProfile('work')).toBe(false)
    expect(view.partition).toBe('persist:browser-default')
    // 沙箱三开关。这个内嵌浏览器会 loadURL 用户/Agent 递来的任意 URL，所以「渲染进程拿不到 Node」是
    // 它唯一的隔离边界：`nodeIntegration` 一旦为真、或 `contextIsolation`/`sandbox` 任一为假，一个恶意
    // 页面就能越出渲染进程。此前这三个值只写在生产代码里、无人断言——把任意一个翻反，这个文件 24 条
    // 照旧全绿。钉死取值（不是「有这个键」）才是检测器。
    expect(view.webPreferences).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    })
    expect(view.visible).toBe(false)
    expect(view.webContents.zoomFactor).toBe(DEFAULT_BROWSER_ZOOM_FACTOR)
    expect(view.webContents.disableDeviceEmulation).toHaveBeenCalled()
    expect(view.webContents.session.checkHandler?.(view.webContents, 'media', 'https://example.com', {})).toBe(false)
    const permissionCallback = vi.fn()
    view.webContents.session.requestHandler?.(view.webContents, 'notifications', permissionCallback, {})
    expect(permissionCallback).toHaveBeenCalledOnce()
    expect(permissionCallback).toHaveBeenCalledWith(false)

    manager.setBounds('browser-1', { x: 10.4, y: 20.6, width: 800.2, height: 500.8 })
    expect(view.visible).toBe(true)
    expect(view.bounds).toEqual({ x: 10, y: 21, width: 800, height: 501 })
    manager.setBounds('browser-1', null)
    expect(view.visible).toBe(false)

    expect(manager.setViewport('browser-1', 'mobile')).toMatchObject({ viewport: 'mobile' })
    expect(view.webContents.enableDeviceEmulation).toHaveBeenLastCalledWith({
      screenPosition: 'mobile',
      screenSize: { width: 390, height: 844 },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 0,
      viewSize: { width: 390, height: 844 },
      scale: 1
    })
    expect(manager.setViewport('browser-1', 'desktop')).toMatchObject({ viewport: 'desktop' })
    expect(view.webContents.enableDeviceEmulation).toHaveBeenLastCalledWith(expect.objectContaining({
      screenPosition: 'desktop',
      viewSize: { width: 1280, height: 800 }
    }))
    expect(manager.setViewport('browser-1', 'responsive')).toMatchObject({ viewport: 'responsive' })
    expect(view.webContents.deviceEmulation).toBeNull()
    expect(() => manager.setViewport('browser-1', 'watch' as never)).toThrow('Unknown browser viewport')

    manager.openDevTools('browser-1')
    expect(view.webContents.openDevTools).toHaveBeenCalledWith({ mode: 'detach', activate: true })

    await expect(manager.captureScreenshot('browser-1')).resolves.toEqual({
      browserId: 'browser-1',
      navigationId: expect.any(String),
      image: {
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${png().toString('base64')}`,
        width: 2,
        height: 3,
        byteLength: png().byteLength
      }
    })

    expect(await manager.navigate('browser-1', 'example.com')).toMatchObject({
      url: 'https://example.com/',
      title: 'example.com'
    })
    expect(view.webContents.zoomFactor).toBe(DEFAULT_BROWSER_ZOOM_FACTOR)

    await manager.reload('browser-1')
    expect(view.webContents.zoomFactor).toBe(DEFAULT_BROWSER_ZOOM_FACTOR)

    manager.close('browser-1')
    expect(manager.usesProfile('default')).toBe(false)
    expect(fixture.children).toHaveLength(0)
    expect(view.webContents.isDestroyed()).toBe(true)
    expect(() => manager.setBounds('browser-1', null)).not.toThrow()
    expect(() => manager.setBounds('browser-1', { x: 0, y: 0, width: 100, height: 100 }))
      .not.toThrow()
  })

  it('releases a hidden native owner without deleting the Browser Region and restores its projection', async () => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    const created = await manager.create('browser-release', 'https://example.com/page')
    const view = fixture.children[0]!
    manager.setViewport('browser-release', 'mobile')
    manager.setBounds('browser-release', { x: 2, y: 3, width: 400, height: 500 })
    fixture.sent.length = 0

    await manager.release('browser-release')

    expect(fixture.children).toEqual([])
    expect(view.webContents.isDestroyed()).toBe(true)
    expect(manager.usesProfile('default')).toBe(true)
    // A budget release is not a user close: no closed event may remove the Region projection.
    expect(fixture.sent).toEqual([])
    await expect(manager.restore('browser-release', {
      profileId: created.profileId,
      viewport: 'mobile'
    })).resolves.toMatchObject({
      id: 'browser-release',
      profileId: 'default',
      url: 'https://example.com/page',
      viewport: 'mobile',
      navigationId: expect.not.stringMatching(created.navigationId)
    })
    expect(fixture.children).toHaveLength(1)
    expect(fixture.children[0]!.partition).toBe('persist:browser-default')
    expect(manager.usesProfile('default')).toBe(true)
    manager.close('browser-release')
    expect(manager.usesProfile('default')).toBe(false)
  })

  it('restores the latest navigation target when release races an in-flight load', async () => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    await manager.create('browser-release-loading', 'https://example.com/first')
    const view = fixture.children[0]!
    let finishNavigation!: () => void
    view.webContents.loadURLImpl = async (url) => await new Promise<void>((resolve) => {
      finishNavigation = () => {
        // Keep this callback pending until after release to model Chromium's old native owner.
        view.webContents.finishLoad(url)
        resolve()
      }
    })

    await manager.navigate('browser-release-loading', 'https://example.com/next')
    // The did-start-navigation callback is the path used by links/history, where `navigate()` is
    // not involved in setting the projection target before Chromium commits the page.
    view.webContents.emitDetails('did-start-navigation', {
      url: 'https://example.com/next#loading',
      isSameDocument: false,
      isMainFrame: true
    })
    await manager.release('browser-release-loading')
    finishNavigation()

    await expect(manager.restore('browser-release-loading', {
      // A stale Renderer snapshot must not override Main's retained navigation target.
      profileId: 'default',
      viewport: 'responsive'
    })).resolves.toMatchObject({
      id: 'browser-release-loading',
      url: 'https://example.com/next#loading'
    })
    manager.close('browser-release-loading')
  })

  it('keeps released Browser profile ownership and allows retry after restore validation failure', async () => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    await manager.create('browser-release-failure', 'https://example.com')
    await manager.release('browser-release-failure')
    await expect(manager.restore('browser-release-failure', {
      profileId: 'unknown',
      viewport: 'responsive'
    })).rejects.toThrow('Unknown browser profile: unknown')
    expect(manager.usesProfile('default')).toBe(true)
    await expect(manager.restore('browser-release-failure', {
      profileId: 'work',
      viewport: 'responsive'
    })).resolves.toMatchObject({ profileId: 'work' })
    manager.close('browser-release-failure')
  })

  it.each(['addChildView', 'attach', 'emit', 'snapshot'] as const)(
    'atomically releases an unpublished Browser when %s fails during create',
    async (failurePoint) => {
      const fixture = fakeWindow()
      const manager = browserManager(fixture.window)
      const id = `browser-create-${failurePoint}`
      const internals = manager as unknown as Record<
        'attach' | 'emit' | 'snapshot',
        (...args: unknown[]) => unknown
      >
      const internalFailurePoint = failurePoint === 'addChildView' ? null : failurePoint
      const original = internalFailurePoint ? internals[internalFailurePoint] : null
      if (failurePoint === 'addChildView') {
        vi.spyOn(fixture.window.contentView, 'addChildView').mockImplementationOnce((view) => {
          fixture.children.push(view)
          throw new Error(`${failurePoint} failed`)
        })
      } else if (failurePoint === 'snapshot') {
        let snapshotCalls = 0
        fakeElectron.FakeWebContentsView.nextLoadURLImpl = async () => await new Promise<void>(() => {})
        internals.snapshot = (...args) => {
          snapshotCalls += 1
          if (snapshotCalls === 2) throw new Error(`${failurePoint} failed`)
          return original!(...args)
        }
      } else {
        internals[failurePoint] = () => { throw new Error(`${failurePoint} failed`) }
      }

      const instanceCount = fakeElectron.FakeWebContentsView.instances.length
      await expect(manager.create(id, 'https://example.com')).rejects.toThrow(`${failurePoint} failed`)
      const failedView = fakeElectron.FakeWebContentsView.instances[instanceCount]!
      if (internalFailurePoint && original) internals[internalFailurePoint] = original

      expect(fixture.children).toEqual([])
      expect(failedView.webContents.isDestroyed()).toBe(true)
      expect(fixture.sent).not.toContainEqual({ type: 'closed', id })
      await expect(manager.create(id, 'about:blank')).resolves.toMatchObject({ id })
      expect(fixture.children).toHaveLength(1)
      manager.close(id)
    }
  )

  it('atomically switches profile after loading a hidden candidate with the latest view state', async () => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    const created = await manager.create('browser-profile', 'https://example.com/page')
    const original = fixture.children[0]!
    manager.setBounds('browser-profile', { x: 1, y: 2, width: 300, height: 200 })
    original.webContents.zoomFactor = 1.1
    let finishCandidate!: () => void
    fakeElectron.FakeWebContentsView.nextLoadURLImpl = async (contents, url) => await new Promise<void>((resolve) => {
      finishCandidate = () => {
        contents.finishLoad(url)
        resolve()
      }
    })

    const pending = manager.switchProfile('browser-profile', 'work')
    const candidate = fixture.children[1]!
    expect(manager.usesProfile('work')).toBe(true)
    expect(fixture.children).toEqual([original, candidate])
    expect(original.webContents.isDestroyed()).toBe(false)
    expect(original.visible).toBe(true)
    expect(candidate.visible).toBe(false)
    expect(candidate.partition).toBe('persist:browser-work')
    // 换 profile 造出的那个候选 view 也走同一道门。今天两处都调 `createView`，所以这条断言在同一个实现
    // 上和上面那条一起红；留它是因为它守的是**另一件事**：换 profile 若哪天自己 new 一个 WebContentsView
    // （比如为了带别的 partition 而绕过 createView），create 那条断言看不见，而用户浏览的正是这个候选。
    expect(candidate.webPreferences).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    })

    manager.setBounds('browser-profile', { x: 10.4, y: 20.6, width: 800.2, height: 500.8 })
    manager.setBounds('browser-profile', null)
    manager.setViewport('browser-profile', 'mobile')
    expect(original.visible).toBe(false)
    original.webContents.zoomFactor = 1.25
    finishCandidate()

    await expect(pending).resolves.toMatchObject({
      id: 'browser-profile',
      profileId: 'work',
      url: 'https://example.com/page',
      viewport: 'mobile',
      navigationId: expect.not.stringMatching(created.navigationId)
    })
    expect(manager.usesProfile('default')).toBe(false)
    expect(manager.usesProfile('work')).toBe(true)
    expect(fixture.children).toEqual([candidate])
    expect(original.webContents.isDestroyed()).toBe(true)
    expect(candidate.visible).toBe(false)
    expect(candidate.bounds).toEqual({ x: 10, y: 21, width: 800, height: 501 })
    expect(candidate.webContents.zoomFactor).toBe(1.25)
    expect(candidate.webContents.enableDeviceEmulation).toHaveBeenLastCalledWith(expect.objectContaining({
      screenPosition: 'mobile',
      viewSize: { width: 390, height: 844 }
    }))
  })

  it('keeps the authoritative view when profile resolution or candidate loading fails', async () => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    await manager.create('browser-profile-failure', 'https://example.com/page')
    const original = fixture.children[0]!

    await expect(manager.switchProfile('browser-profile-failure', 'unknown'))
      .rejects.toThrow('Unknown browser profile: unknown')
    expect(fixture.children).toEqual([original])

    fakeElectron.FakeWebContentsView.nextLoadURLImpl = async () => {
      throw new Error('candidate load failed')
    }
    const pending = manager.switchProfile('browser-profile-failure', 'personal')
    const candidate = fixture.children[1]!
    await expect(pending).rejects.toThrow('candidate load failed')

    expect(fixture.children).toEqual([original])
    expect(original.webContents.isDestroyed()).toBe(false)
    expect(candidate.webContents.isDestroyed()).toBe(true)
    expect(manager.setViewport('browser-profile-failure', 'responsive')).toMatchObject({
      profileId: 'default',
      error: null
    })
  })

  it('cancels and releases pending profile candidates on authoritative navigation, reload, and close', async () => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    await manager.create('browser-profile-cancel', 'https://example.com/page')
    const original = fixture.children[0]!
    const deferNextCandidate = () => {
      fakeElectron.FakeWebContentsView.nextLoadURLImpl = async () => await new Promise<void>(() => {})
    }

    deferNextCandidate()
    const navigationSwitch = manager.switchProfile('browser-profile-cancel', 'work')
    const navigationRejection = expect(navigationSwitch).rejects.toThrow('superseded by navigation')
    const navigationCandidate = fixture.children[1]!
    await manager.navigate('browser-profile-cancel', 'https://example.com/next')
    await navigationRejection
    expect(navigationCandidate.webContents.isDestroyed()).toBe(true)
    expect(fixture.children).toEqual([original])

    deferNextCandidate()
    const reloadSwitch = manager.switchProfile('browser-profile-cancel', 'personal')
    const reloadRejection = expect(reloadSwitch).rejects.toThrow('superseded by reload')
    const reloadCandidate = fixture.children[1]!
    await manager.reload('browser-profile-cancel')
    await reloadRejection
    expect(reloadCandidate.webContents.isDestroyed()).toBe(true)
    expect(fixture.children).toEqual([original])

    deferNextCandidate()
    const closeSwitch = manager.switchProfile('browser-profile-cancel', 'work')
    const closeRejection = expect(closeSwitch).rejects.toThrow('closed during profile switch')
    const closeCandidate = fixture.children[1]!
    manager.close('browser-profile-cancel')
    await closeRejection
    expect(closeCandidate.webContents.isDestroyed()).toBe(true)
    expect(fixture.children).toHaveLength(0)
  })

  it('fences late owner callbacks after a profile switch', async () => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    await manager.create('browser-profile-fence', 'https://example.com/first')
    const original = fixture.children[0]!
    let rejectOldNavigation!: (error: Error) => void
    original.webContents.loadURLImpl = async () => await new Promise<void>((_resolve, reject) => {
      rejectOldNavigation = reject
    })

    await manager.navigate('browser-profile-fence', 'https://example.com/late')
    const switched = await manager.switchProfile('browser-profile-fence', 'work')
    const current = fixture.children[0]!
    fixture.sent.length = 0

    rejectOldNavigation(new Error('late old-view failure'))
    original.webContents.title = 'Stale title'
    original.webContents.emit('page-title-updated')
    original.webContents.emit('did-fail-load', -105, 'STALE_FAILURE', 'https://stale.invalid/', true)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(fixture.children).toEqual([current])
    expect(current.webContents.getURL()).toBe(switched.url)
    expect(manager.setViewport('browser-profile-fence', 'responsive')).toMatchObject({
      profileId: 'work',
      url: switched.url,
      error: null
    })
    expect(fixture.sent).not.toContainEqual({ type: 'closed', id: 'browser-profile-fence' })
  })

  it('leaves popup and opener behavior to Chromium', async () => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)

    await manager.create('browser-native-window-open', 'https://example.com')

    expect(fixture.children[0]!.webContents.windowOpenHandler).toBeNull()
  })

  it('allows controlled local files but blocks unsupported page navigation and redirects', async () => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    await manager.create('browser-guarded', 'https://example.com')
    const view = fixture.children[0]!
    const navigate = view.webContents.listeners.get('will-navigate')![0]!
    const redirect = view.webContents.listeners.get('will-redirect')![0]!
    const blockedNavigation = {
      url: 'file:///etc/passwd',
      isMainFrame: true,
      preventDefault: vi.fn()
    }
    const blockedRedirect = {
      url: 'javascript:alert(1)',
      isMainFrame: true,
      preventDefault: vi.fn()
    }

    navigate(blockedNavigation)
    redirect(blockedRedirect)

    expect(blockedNavigation.preventDefault).not.toHaveBeenCalled()
    expect(blockedRedirect.preventDefault).toHaveBeenCalledOnce()

    const allowedNavigation = {
      url: 'https://agentmux.example.test/docs',
      isMainFrame: true,
      preventDefault: vi.fn()
    }
    navigate(allowedNavigation)
    expect(allowedNavigation.preventDefault).not.toHaveBeenCalled()
  })

  it('projects loading, title, load failure, and renderer loss as Browser events', async () => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    await manager.create('browser-events', 'https://example.com')
    const view = fixture.children[0]!

    expect(fixture.sent).toContainEqual({
      type: 'updated',
      browser: expect.objectContaining({ id: 'browser-events', loading: true })
    })
    expect(fixture.sent).toContainEqual({
      type: 'updated',
      browser: expect.objectContaining({
        id: 'browser-events',
        title: 'example.com',
        loading: false
      })
    })

    view.webContents.title = 'AgentMux Docs'
    view.webContents.emit('page-title-updated')
    expect(fixture.sent.at(-1)).toEqual({
      type: 'updated',
      browser: expect.objectContaining({ title: 'AgentMux Docs' })
    })

    view.webContents.emit('did-fail-load', -105, 'NAME_NOT_RESOLVED', 'https://missing.invalid/', true)
    expect(fixture.sent.at(-1)).toEqual({
      type: 'updated',
      browser: expect.objectContaining({ error: 'NAME_NOT_RESOLVED (-105)' })
    })

    view.webContents.emit('render-process-gone', { reason: 'crashed' })
    expect(fixture.sent.at(-1)).toEqual({
      type: 'updated',
      browser: expect.objectContaining({ error: 'Browser renderer stopped: crashed' })
    })
  })

  it('releases an externally destroyed WebContentsView before publishing closed', async () => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    await manager.create('browser-destroyed', 'https://example.com')
    const view = fixture.children[0]!
    fixture.sent.length = 0

    view.webContents.close()

    expect(fixture.children).toHaveLength(0)
    expect(fixture.sent).toEqual([{ type: 'closed', id: 'browser-destroyed' }])
    expect(() => manager.setBounds('browser-destroyed', null)).not.toThrow()
  })

  it('rejects a screenshot that completes after the page navigation changes', async () => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    const created = await manager.create('browser-capture', 'https://example.com')
    const view = fixture.children[0]!
    let resolveCapture!: (image: Awaited<ReturnType<typeof view.webContents.capturePage>>) => void
    view.webContents.capturePageImpl = async () => await new Promise((resolve) => { resolveCapture = resolve })

    const pending = manager.captureScreenshot('browser-capture')
    view.webContents.emitDetails('did-start-navigation', {
      url: 'https://example.com/next',
      isSameDocument: false,
      isMainFrame: true
    })
    expect(fixture.sent.at(-1)).toEqual({
      type: 'updated',
      browser: expect.objectContaining({
        id: 'browser-capture',
        navigationId: expect.not.stringMatching(created.navigationId)
      })
    })
    resolveCapture({
      isEmpty: () => false,
      getSize: () => ({ width: 2, height: 3 }),
      toPNG: () => Buffer.from('late-browser-png')
    })

    await expect(pending).rejects.toThrow('Browser page changed while the screenshot was being captured')
  })

  it('rotates navigation identity for same-document main-frame navigation', async () => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    const created = await manager.create('browser-same-document', 'https://example.com/page')
    const view = fixture.children[0]!

    view.webContents.emitDetails('did-start-navigation', {
      url: 'https://example.com/page#details',
      isSameDocument: true,
      isMainFrame: true
    })
    view.webContents.url = 'https://example.com/page#details'
    view.webContents.emit('did-navigate-in-page', 'https://example.com/page#details', true)

    expect(fixture.sent.at(-1)).toEqual({
      type: 'updated',
      browser: expect.objectContaining({
        id: 'browser-same-document',
        url: 'https://example.com/page#details',
        navigationId: expect.not.stringMatching(created.navigationId)
      })
    })
  })

  it('does not rotate navigation identity for subframe navigation', async () => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    const created = await manager.create('browser-subframe', 'https://example.com/page')
    const view = fixture.children[0]!

    view.webContents.emitDetails('did-start-navigation', {
      url: 'https://frames.example.test/ad',
      isSameDocument: false,
      isMainFrame: false
    })

    expect(fixture.sent.at(-1)).toEqual({
      type: 'updated',
      browser: expect.objectContaining({ navigationId: created.navigationId })
    })
  })

  it('rejects a capture after close even when the id is recreated', async () => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    await manager.create('browser-recreated', 'https://example.com/first')
    const firstView = fixture.children[0]!
    let resolveCapture!: (image: Awaited<ReturnType<typeof firstView.webContents.capturePage>>) => void
    firstView.webContents.capturePageImpl = async () => await new Promise((resolve) => { resolveCapture = resolve })

    const pending = manager.captureScreenshot('browser-recreated')
    manager.close('browser-recreated')
    await manager.create('browser-recreated', 'https://example.com/second')
    resolveCapture({
      isEmpty: () => false,
      getSize: () => ({ width: 2, height: 3 }),
      toPNG: () => Buffer.from('old-browser-png')
    })

    await expect(pending).rejects.toThrow('Browser page changed while the screenshot was being captured')
  })

  it('returns only the sanitized Main-owned element selection contract', async () => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    const created = await manager.create('browser-selection', 'https://example.com/page')
    const view = fixture.children[0]!
    view.webContents.executeJavaScriptInIsolatedWorldImpl = async (_worldId, scripts) => (
      scripts[0]?.code.includes('Select an element')
        ? {
            pageTitle: 'Secret docs',
            pageUrl: 'https://user:password@example.com/page?token=secret#private',
            tagName: 'button',
            role: 'button',
            accessibleName: 'Open docs',
            selector: 'main > button',
            text: 'Open docs',
            nearbyText: ['Documentation'],
            attributes: { onclick: 'steal()', 'aria-label': 'Open docs' },
            html: '<button onclick="steal()" aria-label="Open docs">Open docs</button>',
            rectViewport: { x: 1, y: 2, width: 3, height: 4 },
            rectPage: { x: 5, y: 6, width: 3, height: 4 },
            isFixed: false
          }
        : true
    )

    await expect(manager.selectElement('browser-selection')).resolves.toEqual({
      browserId: 'browser-selection',
      navigationId: created.navigationId,
      pageTitle: 'Secret docs',
      pageUrl: 'https://example.com/page',
      tagName: 'button',
      role: 'button',
      accessibleName: 'Open docs',
      selector: 'main > button',
      text: 'Open docs',
      nearbyText: ['Documentation'],
      attributes: { 'aria-label': 'Open docs' },
      html: '<button aria-label="Open docs">Open docs</button>',
      rectViewport: { x: 1, y: 2, width: 3, height: 4 },
      rectPage: { x: 5, y: 6, width: 3, height: 4 },
      isFixed: false
    })
  })

  it('does not start selection after a newer cancel wins the preflight race', async () => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    await manager.create('browser-selection-race', 'https://example.com/page')
    const view = fixture.children[0]!
    let resolvePreflight!: (value: boolean) => void
    let delayFirstCancel = true
    view.webContents.executeJavaScriptInIsolatedWorldImpl = async (_worldId, scripts) => {
      const script = scripts[0]?.code ?? ''
      if (delayFirstCancel && script.includes('const barrier =')) {
        delayFirstCancel = false
        return await new Promise<boolean>((resolve) => { resolvePreflight = resolve })
      }
      return script.includes('Select an element') ? null : true
    }
    view.webContents.executeJavaScriptInIsolatedWorld.mockClear()

    const pending = manager.selectElement('browser-selection-race')
    await manager.cancelElementSelection('browser-selection-race')
    resolvePreflight(true)

    await expect(pending).resolves.toBeNull()
    expect(view.webContents.executeJavaScriptInIsolatedWorld.mock.calls.filter((call) => (
      call[1][0]?.code.includes('Select an element')
    ))).toHaveLength(0)
  })

  it('validates annotation identity and geometry before isolated-world injection', async () => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    const created = await manager.create('browser-markers', 'https://example.com/page')
    const view = fixture.children[0]!
    view.webContents.executeJavaScriptInIsolatedWorld.mockClear()

    await manager.setAnnotationMarkers('browser-markers', created.navigationId, [{
      id: 'annotation-1',
      index: 0,
      rectViewport: { x: -20_000_000, y: 2, width: 3, height: 4 },
      rectPage: { x: 5, y: 6, width: 3, height: 4 },
      isFixed: false
    }])

    expect(view.webContents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledOnce()
    const script = view.webContents.executeJavaScriptInIsolatedWorld.mock.calls[0]?.[1][0]?.code
    expect(script).toContain('annotation-1')
    expect(script).toContain('"x":-10000000')
    await expect(manager.setAnnotationMarkers('browser-markers', 'stale-navigation', []))
      .resolves.toBeUndefined()
    await expect(manager.setAnnotationMarkers('browser-markers', created.navigationId, [{
      id: 'annotation-2',
      index: 0,
      rectViewport: { x: Number.NaN, y: 0, width: 1, height: 1 },
      rectPage: { x: 0, y: 0, width: 1, height: 1 },
      isFixed: false
    }])).rejects.toThrow('geometry is invalid')
    await expect(manager.setAnnotationMarkers('browser-markers', created.navigationId, [{
      id: 'duplicate',
      index: 0,
      rectViewport: { x: 0, y: 0, width: 1, height: 1 },
      rectPage: { x: 0, y: 0, width: 1, height: 1 },
      isFixed: false
    }, {
      id: 'duplicate',
      index: 1,
      rectViewport: { x: 1, y: 1, width: 1, height: 1 },
      rectPage: { x: 1, y: 1, width: 1, height: 1 },
      isFixed: false
    }])).rejects.toThrow('duplicates an id or index')
    const sparse = Array.from({ length: 1 }) as never
    await expect(manager.setAnnotationMarkers('browser-markers', created.navigationId, sparse))
      .rejects.toThrow('marker 0 is invalid')
  })
})
