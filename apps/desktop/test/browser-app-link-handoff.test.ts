import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appLinkOutcome,
  appLinkRefusedMessage,
  browserWindowOpenOutcome,
  classifyBrowserTarget
} from '../src/main/browser-app-link.js'

/**
 * 守的缺陷：内置 Browser 里点飞书文档的 "Authorize in Feishu App" 什么都不发生。不只飞书——
 * 每一个 `slack:` / `vscode:` / `zoommtg:` / `mailto:` 在这里都是坏的。用户定的策略是
 * **「对齐一般浏览器，假定用户会自己把本应用当做浏览器」**。
 *
 * 每一条正向断言都配一条反向的。只证「应用链接被交出去」的实现，把 http(s) 也一起交出去照样全绿，
 * 而那是把用户的每一次普通导航都甩给系统浏览器——比原来的缺陷严重得多。
 */

const fakeElectron = vi.hoisted(() => {
  type Listener = (...args: any[]) => void

  class FakeWebContents {
    url = ''
    title = ''
    loading = false
    destroyed = false
    readonly listeners = new Map<string, Listener[]>()
    readonly navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    windowOpenHandler: null | ((details: { url: string }) => { action: string }) = null
    readonly setWindowOpenHandler = vi.fn((handler: (details: { url: string }) => { action: string }) => {
      this.windowOpenHandler = handler
    })
    readonly executeJavaScriptInIsolatedWorld = vi.fn(async () => true)
    readonly setZoomFactor = vi.fn()
    readonly enableDeviceEmulation = vi.fn()
    readonly disableDeviceEmulation = vi.fn()
    readonly send = vi.fn()
    readonly close = vi.fn()
    // 手搭的替身缺一个 slice 就抛 TypeError，而栈指向生产文件，看起来像组件回归。
    readonly session = {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn()
    }
    readonly on = vi.fn((event: string, listener: Listener) => {
      const bucket = this.listeners.get(event) ?? []
      bucket.push(listener)
      this.listeners.set(event, bucket)
      return this
    })
    readonly once = vi.fn(() => this)
    readonly removeListener = vi.fn(() => this)
    isDestroyed(): boolean { return this.destroyed }
    getURL(): string { return this.url }
    getTitle(): string { return this.title }
    isLoading(): boolean { return this.loading }
    async loadURL(next: string): Promise<void> { this.url = next }
    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args)
    }
  }

  class FakeWebContentsView {
    static readonly instances: FakeWebContentsView[] = []
    readonly webContents = new FakeWebContents()
    constructor() { FakeWebContentsView.instances.push(this) }
    setVisible(): void {}
    setBounds(): void {}
    setBorderRadius(): void {}
  }

  return { FakeWebContentsView }
})

vi.mock('electron', () => ({ WebContentsView: fakeElectron.FakeWebContentsView }))

const { BrowserViewManager } = await import('../src/main/browser-view-manager.js')
const { BrowserRefLedgerStore } = await import('../src/main/browser-ref-ledger-store.js')

const profiles = { defaultProfileId: () => 'default', resolvePartition: (id: string) => `persist:${id}` }

/**
 * 一个记账的应用链接宿主。`openExternal` 必须是假的——真的 `shell.openExternal` 会在跑测试的人脸上
 * 弹出飞书。记下 URL 而不是只数次数：判据要能说出交出去的是**哪一个**。
 */
function appLinkHost(remembered: Record<string, 'allow' | 'deny'> = {}) {
  const opened: string[] = []
  const saved: Array<{ scheme: string; choice: 'allow' | 'deny' }> = []
  return {
    opened,
    saved,
    remembered,
    rememberedSchemes: async () => remembered,
    rememberScheme: async (scheme: string, choice: 'allow' | 'deny') => {
      saved.push({ scheme, choice })
      remembered[scheme] = choice
    },
    openExternal: (target: string) => { opened.push(target) }
  }
}

function fakeWindow() {
  const sent: unknown[] = []
  return {
    sent,
    window: {
      isDestroyed: () => false,
      contentView: { addChildView() {}, removeChildView() {} },
      webContents: { isDestroyed: () => false, send: (_channel: string, event: unknown) => { sent.push(event) } }
    }
  }
}

/** 取这一格最近一次广播出去的快照——渲染进程看到的就是它，所以判据落在这里而不是私有字段。 */
function latest(fixture: ReturnType<typeof fakeWindow>) {
  const updates = fixture.sent.filter(
    (event): event is { type: 'updated'; browser: any } =>
      typeof event === 'object' && event !== null && (event as { type?: string }).type === 'updated'
  )
  expect(updates.length, '一次 updated 都没广播——判据没有靶子').toBeGreaterThan(0)
  return updates[updates.length - 1]!.browser
}

async function managerWith(host: ReturnType<typeof appLinkHost>) {
  fakeElectron.FakeWebContentsView.instances.length = 0
  const fixture = fakeWindow()
  const manager = new BrowserViewManager(
    fixture.window as never,
    profiles,
    new BrowserRefLedgerStore(join(mkdtempSync(join(tmpdir(), 'agentmux-applink-')), 'ledger.json')),
    host
  )
  await manager.create('b1', 'https://example.com/')
  const view = fakeElectron.FakeWebContentsView.instances[0]!
  return { manager, view, fixture }
}

/** 跑一次 `will-navigate`，返回它有没有被拦下。 */
function navigateTo(view: { webContents: { emit(event: string, ...args: unknown[]): void } }, url: string, isMainFrame = true, event = 'will-navigate') {
  const preventDefault = vi.fn()
  view.webContents.emit(event, { url, isMainFrame, preventDefault })
  return { prevented: preventDefault.mock.calls.length > 0 }
}

describe('应用链接的三段分类', () => {
  it('视图装得下的那些进视图，一个都不交给系统', () => {
    // 反向的一半：漏了这条，一个「非 about:blank 就交出去」的实现会让下面 hand-off 那条全绿，
    // 而那是把用户每一次普通导航都甩给系统浏览器。
    for (const url of ['https://example.com/', 'http://localhost:4173/', 'file:///tmp/x.html']) {
      expect(classifyBrowserTarget(url), url).toEqual({ kind: 'embed', scheme: null })
    }
  })

  it('伪 scheme 既不进视图也不交给系统', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<b>x', 'blob:https://example.com/abc']) {
      expect(classifyBrowserTarget(url), url).toEqual({ kind: 'refuse', scheme: null })
    }
    // `about:` 是浏览器自己的伪 scheme，不是任何一个应用的。递出去会得到一句
    // 「open about: links in another app?」——而 `about:blank` 是每一个无参 `window.open()` 的目标，
    // 等于每开一个空白页都弹一次。这一条是弹窗路那半边的测试反过来抓出来的。
    for (const url of ['about:blank', 'about:srcdoc']) {
      expect(classifyBrowserTarget(url), url).toEqual({ kind: 'refuse', scheme: null })
    }
    // 连 scheme 都解析不出来的东西，没有任何理由递给 shell.openExternal。
    expect(classifyBrowserTarget('not a url at all')).toEqual({ kind: 'refuse', scheme: null })
  })

  it('其余一律算应用链接，未知 scheme 也算——兜底不是白名单', () => {
    // 枚举得出的那几个是人人都想到的；`fictional-app` 是这条判据的要害：一般浏览器把未知 scheme
    // 交给 OS 判，我们枚举不完。把第三段写成白名单时，这一行会红。
    const cases: Array<[string, string]> = [
      ['lark://open', 'lark'],
      ['slack://channel?id=1', 'slack'],
      ['mailto:hi@example.com', 'mailto'],
      ['fictional-app://whatever', 'fictional-app']
    ]
    expect(cases.map(([url]) => classifyBrowserTarget(url)))
      .toEqual(cases.map(([, scheme]) => ({ kind: 'hand-off', scheme })))
  })
})

describe('记住的答案决定这一次怎么走', () => {
  it('没记过就问，而且一个字节都还没交出去', () => {
    const opened: string[] = []
    const outcome = appLinkOutcome('lark://open', 'lark', undefined, (t) => opened.push(t))
    expect(outcome).toEqual({ kind: 'ask', scheme: 'lark', url: 'lark://open' })
    // 承重的反向一半：`ask` 档要是顺手也开了，那一问就成了摆设——先斩后奏地问「刚才那下行吗」。
    expect(opened, '还没问就已经把它交出去了').toEqual([])
  })

  it('记过 allow 就直接开；记过 deny 就不开，且有话说', () => {
    const allowed: string[] = []
    expect(appLinkOutcome('lark://open', 'lark', 'allow', (t) => allowed.push(t)))
      .toEqual({ kind: 'opened', scheme: 'lark' })
    expect(allowed).toEqual(['lark://open'])

    const denied: string[] = []
    expect(appLinkOutcome('lark://open', 'lark', 'deny', (t) => denied.push(t)))
      .toEqual({ kind: 'refused', scheme: 'lark' })
    expect(denied, 'deny 记着却照样开了').toEqual([])
  })

  it('拒绝的话点名一个真能走到的地方', () => {
    const message = appLinkRefusedMessage('lark')
    expect(message).toContain('lark')
    // 房规（browser-automation-setting-reachable）：文案点名的位置要被证明存在且可达。
    // Settings › Browser 这一节是真的，用户当初也正是在那里回答的。
    expect(message, '没告诉人怎么改回来，等于一句无法行动的拒绝').toContain('Settings › Browser')
  })
})

describe('嵌入 frame 的应用链接', () => {
  it('飞书授权 iframe 的 lark 导航也走同一条交接路', async () => {
    const host = appLinkHost()
    const { manager, view, fixture } = await managerWith(host)

    const { prevented } = navigateTo(view, 'lark://applink.feishu.cn/client/security/bind_device', false, 'will-frame-navigate')
    await Promise.resolve()
    await Promise.resolve()

    expect(prevented).toBe(true)
    expect(latest(fixture).appLinkPrompt).toEqual({
      url: 'lark://applink.feishu.cn/client/security/bind_device',
      scheme: 'lark'
    })
    expect(host.opened).toEqual([])
    void manager
  })

  it('普通 child-frame http 导航仍由页面自己处理', async () => {
    const host = appLinkHost()
    const { view } = await managerWith(host)
    expect(navigateTo(view, 'https://example.com/frame', false).prevented).toBe(false)
  })
})

describe('导航路：闸门之前分流，闸门本身不变', () => {
  it('应用链接被拦下并挂出提问，没记过时不开', async () => {
    const host = appLinkHost()
    const { manager, view, fixture } = await managerWith(host)

    const { prevented } = navigateTo(view, 'lark://open?token=1')
    await Promise.resolve()
    await Promise.resolve()

    expect(prevented, '没拦住——页面会真的导航到一个装不下的地址').toBe(true)
    expect(latest(fixture).appLinkPrompt).toEqual({ url: 'lark://open?token=1', scheme: 'lark' })
    expect(host.opened, '还没问就交出去了').toEqual([])
  })

  it('记过 allow 的 scheme 直接交给系统，不再问', async () => {
    const host = appLinkHost({ lark: 'allow' })
    const { manager, view, fixture } = await managerWith(host)

    navigateTo(view, 'lark://open?token=2')
    await Promise.resolve()
    await Promise.resolve()

    expect(host.opened).toEqual(['lark://open?token=2'])
    expect(latest(fixture).appLinkPrompt, '记过 allow 还在问').toBeNull()
  })

  it('http(s) 与 file 照旧进视图：既不被拦，也不交给系统', async () => {
    const host = appLinkHost()
    const { view } = await managerWith(host)

    // 承重的反向一半。一个「非 about:blank 一律移交」的实现会让上面两条全绿，而它会把用户的
    // 每一次点击都甩给系统浏览器——内置浏览器从此什么都打不开。
    for (const url of ['https://example.com/next', 'http://localhost:4173/', 'file:///tmp/x.html']) {
      expect(navigateTo(view, url).prevented, `${url} 被拦下了`).toBe(false)
    }
    expect(host.opened, 'http(s)/file 被交给了系统浏览器').toEqual([])
  })

  it('伪 scheme 仍然死在原来的闸门上，且绝不递给系统', async () => {
    const host = appLinkHost()
    const { manager, view, fixture } = await managerWith(host)

    const { prevented } = navigateTo(view, 'javascript:alert(1)')
    await Promise.resolve()

    expect(prevented).toBe(true)
    expect(latest(fixture).error, '闸门那句话变了——它的行为本该逐字不变')
      .toContain('Unsupported browser URL protocol')
    expect(latest(fixture).appLinkPrompt, '伪 scheme 也去问用户了').toBeNull()
    expect(host.opened, 'javascript: 被交给了系统').toEqual([])
  })
})

describe('弹窗路：只截应用链接，其余交回 Chromium', () => {
  it('应用链接的 window.open 被截走，并按同一条路移交', () => {
    const handed: Array<[string, string]> = []
    expect(browserWindowOpenOutcome('lark://open?token=6', (u, s) => handed.push([u, s])))
      .toEqual({ action: 'deny' })
    expect(handed).toEqual([['lark://open?token=6', 'lark']])
  })

  it('http(s) 与 about:blank 的弹窗一律 allow，且一个字节都不移交', () => {
    // 承重的反向一半。`649df3a2` 删掉的那段正是把**每一个** window-open 都改道再 deny；一个
    // 「一律截走」的实现会让上一条全绿，而它就是把 649df3a2 修的那个 bug 重新引入。
    const handed: string[] = []
    for (const url of ['https://example.com/popup', 'http://localhost:4173/x', 'about:blank']) {
      expect(browserWindowOpenOutcome(url, (u) => handed.push(u)), url).toEqual({ action: 'allow' })
    }
    expect(handed, 'http(s) 的弹窗被当成应用链接交出去了').toEqual([])
  })

  it('伪 scheme 的弹窗也不插手：交回 Chromium，绝不移交', () => {
    // `refuse` 那一档走 allow 不是放行，是**不插手**——由 Chromium 按 opener 自己的规则处置，
    // 与今天逐字相同。要害在后半句：它绝不能掉进移交那条路。
    const handed: string[] = []
    for (const url of ['javascript:alert(1)', 'data:text/html,<b>x', 'not a url at all']) {
      expect(browserWindowOpenOutcome(url, (u) => handed.push(u)), url).toEqual({ action: 'allow' })
    }
    expect(handed, '伪 scheme 被递给了 shell.openExternal').toEqual([])
  })

  it('装在 view 上的 handler 与导航路共用同一份记住的答案，不是第二份判定', async () => {
    // 两个写入点收成一处投影：导航路上答过 allow 的 scheme，弹窗路直接开，不该再问一次。
    const host = appLinkHost({ lark: 'allow' })
    const { view, fixture } = await managerWith(host)
    const handler = view.webContents.windowOpenHandler
    expect(handler, 'handler 根本没装上——弹窗会开出一个没人管的窗口').not.toBeNull()

    expect(handler!({ url: 'lark://open?token=7' })).toEqual({ action: 'deny' })
    await Promise.resolve()
    await Promise.resolve()

    expect(host.opened).toEqual(['lark://open?token=7'])
    expect(latest(fixture).appLinkPrompt, '记过 allow 的 scheme 在弹窗路上又问了一次').toBeNull()
  })
})

describe('回答那一问', () => {
  it('答 Open 就开；勾了记住才落盘', async () => {
    const host = appLinkHost()
    const { manager, view, fixture } = await managerWith(host)
    navigateTo(view, 'lark://open?token=3')
    await Promise.resolve()
    await Promise.resolve()

    const snapshot = await manager.answerAppLink('b1', true, true)

    expect(host.opened).toEqual(['lark://open?token=3'])
    expect(host.saved).toEqual([{ scheme: 'lark', choice: 'allow' }])
    expect(snapshot.appLinkPrompt, '答完了还挂着那一问').toBeNull()
  })

  it('没勾记住就只答这一次：开了，但什么都没存', async () => {
    const host = appLinkHost()
    const { manager, view, fixture } = await managerWith(host)
    navigateTo(view, 'lark://open?token=4')
    await Promise.resolve()
    await Promise.resolve()

    await manager.answerAppLink('b1', true, false)

    expect(host.opened).toEqual(['lark://open?token=4'])
    // 反向的一半：一个「答了就记住」的实现会让上一条全绿，而它把「就这一次」变成了永久授权。
    expect(host.saved, '没勾记住却把选择存下来了').toEqual([])
  })

  it('答 Not now 不开，并留下一句能走到下一步的话', async () => {
    const host = appLinkHost()
    const { manager, view, fixture } = await managerWith(host)
    navigateTo(view, 'lark://open?token=5')
    await Promise.resolve()
    await Promise.resolve()

    const snapshot = await manager.answerAppLink('b1', false, true)

    expect(host.opened, '答了 Not now 还是开了').toEqual([])
    expect(host.saved).toEqual([{ scheme: 'lark', choice: 'deny' }])
    expect(snapshot.appLinkPrompt).toBeNull()
    expect(snapshot.error).toContain('Settings › Browser')
  })

  it('没有待答的提问时回答会抛，而不是默默开一个上次的地址', async () => {
    const host = appLinkHost()
    const { manager } = await managerWith(host)
    await expect(manager.answerAppLink('b1', true, false)).rejects.toThrow(/waiting for an answer/u)
    expect(host.opened).toEqual([])
  })
})
