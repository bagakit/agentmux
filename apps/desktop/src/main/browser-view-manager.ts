import { randomUUID } from 'node:crypto'
import { WebContentsView, type BrowserWindow } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  BROWSER_EVENT_CHANNEL,
  BROWSER_VIEWPORT_PRESETS,
  type BrowserAnnotationMarker,
  type BrowserBounds,
  type BrowserElementRect,
  type BrowserElementSelection,
  type BrowserEvent,
  type BrowserScreenshotCapture,
  type BrowserScriptRunReport,
  type BrowserSnapshot,
  type BrowserViewport
} from '../shared/contracts.js'
import { normalizeBrowserBounds } from '../shared/browser-bounds.js'
import { BrowserCdpSession } from './browser-cdp-session.js'
import { browserPngFromNativeImage } from './browser-image.js'
import { createBrowserPageDispatch } from './browser-page-dispatch.js'
import { browserRunOutcomeFromFailure } from './browser-run-outcome.js'
import { BrowserRefLedgerStore } from './browser-ref-ledger-store.js'
import {
  appLinkOutcome,
  appLinkRefusedMessage,
  browserWindowOpenOutcome,
  classifyBrowserTarget,
  type AppLinkSchemeChoice
} from './browser-app-link.js'
import { runBrowserScript } from './browser-script-runner.js'
import { sanitizeBrowserElementSelection } from './browser-selection.js'
import {
  BROWSER_SELECTION_WORLD_ID,
  buildBrowserAnnotationMarkerScript,
  buildBrowserDriveBadgeScript,
  buildCancelBrowserAnnotationMarkerScript,
  buildCancelBrowserDriveBadgeScript,
  buildBrowserElementSelectionScript,
  buildCancelBrowserElementSelectionScript
} from './browser-selection-script.js'

type BrowserEntry = {
  id: string
  view: WebContentsView
  profileId: string
  requestedUrl: string
  navigationId: string
  selectionRevision: number
  selectionOperation: number | null
  annotationRevision: number
  switchRevision: number
  pendingSwitch: PendingProfileSwitch | null
  bounds: BrowserBounds | null
  visible: boolean
  viewport: BrowserViewport
  error: string | null
  /**
   * 这一刻有没有一段 Agent 程序在驱动它。导航后重注角标要读它，`snapshot()` 也要——渲染进程据此
   * 在标签上认出是哪一格（见 `BrowserSnapshot.driving` 的说明）。
   *
   * 一个布尔够用，不必是计数：两次 run 不可能在同一个页面上重叠——`BrowserCdpSession.attach` 对
   * 已 attach 的 page 第二次会抛，`runScript` 第一件事就是它。
   */
  driving: boolean
  /** 这一页上待答的那个应用链接提问。回答掉或换页就清。 */
  appLinkPrompt: { url: string; scheme: string } | null
}

/** 本轮运行有没有被人接管，以及是被哪一下、什么时候。`at` 为 null 表示还没有。 */
type BrowserTakeover = { at: number | null; kind: string }

/**
 * 哪些 `input-event` 算「人伸手了」。
 *
 * **按白名单不按黑名单**，因为这个枚举里有 `mouseMove` / `mouseEnter` / `mouseLeave` /
 * `pointerMove` / `pointerRawUpdate`——**指针只是从这一格上飘过去**就会连发一串。黑名单漏掉
 * 其中一个，结果是人挪一下鼠标 Agent 就停，而且没人会注意到这是个 bug（只会觉得"这功能很吵"）；
 * 白名单漏掉一个，结果只是少认一种接管方式——保守、可发现。Electron 往枚举里加新成员时，
 * 这两个方向的代价差着一个数量级（MEMORY「禁止清单必漏」是同一族）。
 *
 * 为什么不用 `before-input-event`：那个只有键盘，而「人伸手抢方向盘」最常见的动作就是点一下。
 */
const HUMAN_INPUT_EVENT_TYPES = new Set([
  'mouseDown',
  'mouseUp',
  'mouseWheel',
  'keyDown',
  'rawKeyDown',
  'char',
  'touchStart',
  'pointerDown'
])

/**
 * 接管之后被拒绝的页面函数。**只有动作在里面，观察一概放行。**
 *
 * 放行观察不是宽容，是诚实：程序被打断之后最该做的事就是「看一眼现在页面什么样」再决定怎么
 * 报告。把 snapshot 也拦掉，它只能瞎猜着退出。而观察不改页面，跟人不会打架。
 *
 * `js` 和 `cdp` 两个逃生口按动作算——它们能做任何事，漏掉任何一个都等于没拦。`cdp` 还有一层：
 * 它把方法名原样透传，所以 `cdp('Input.dispatchMouseEvent', …)` 能发出真的原生输入，从而让程序
 * **触发自己的接管判据**。这不是安全问题（程序本来就能为所欲为），代价也是可接受的：它踩的是
 * 自己，结局是一个 `stopped` 加一句说明，不是静默乱点。
 */
const BROWSER_ACTION_PAGE_CALLS = new Set([
  'click',
  'fillInput',
  'typeText',
  'pressKey',
  'hover',
  'scroll',
  'gotoUrl',
  'js',
  'cdp'
])

/**
 * 被接管之后说给 Agent 听的那句话。说到**下一步**为止，而且那一步真能走通。
 *
 * 点名的恢复动作是「页面空出来之后再跑一次」，不是去 Settings 关自动化总开关——后者不成比例
 * （人从没要求禁用自动化），而且接管本来就是按次运行、自清的：下一次 `browser.run` 是干净的。
 *
 * 「之后的没跑」而不是「接管那一刻起什么都没跑」：输入到达时可能已经有一个页面调用在途，
 * 那一个会正常跑完——CDP 已经发出去了，拦不住也不该硬拦。承诺一个做不到的精确度比不承诺更糟。
 */
function takeoverMessage(takeover: BrowserTakeover, refused?: string): string {
  const what = refused === undefined ? 'the rest of the program' : `${refused}()`
  return (
    `Someone took control of this Browser (a real ${takeover.kind}) — the page is theirs now, so ${what} ` +
    'was refused. A page call already in flight when they reached in still finished; nothing after that ' +
    'ran. Your earlier actions did happen. Take a fresh snapshot() to see where things stand, and ' +
    'run the program again once the page is free.'
  )
}

/** Metadata retained while a hidden Browser native owner is released. */
type ReleasedBrowser = {
  id: string
  profileId: string
  requestedUrl: string
  viewport: BrowserViewport
}

type BrowserRestoreInput = {
  profileId: string
  viewport: BrowserViewport
}

type PendingProfileSwitch = {
  token: number
  profileId: string
  view: WebContentsView
  rejectCancellation(error: Error): void
  attached: boolean
  released: boolean
}

export interface BrowserProfileResolver {
  defaultProfileId(): string
  resolvePartition(profileId: string): string
}

/**
 * 应用链接移交要用到的两样外部能力。做成一个注入的接口而不是让 manager 自己 import electron +
 * ConfigStore：这个类必须能在没有 Electron 的单测里被直接质询（既有的 `profiles` / `refLedgers`
 * 就是同一个理由）。
 */
export interface AppLinkHost {
  /** 读这一刻记住的答案。每次现读而不是构造时快照一份——设置面改完不该等重启才生效。 */
  rememberedSchemes(): Promise<Record<string, AppLinkSchemeChoice>>
  /** 记住一个答案。只有用户勾了「记住」才会被调到。 */
  rememberScheme(scheme: string, choice: AppLinkSchemeChoice): Promise<void>
  openExternal(target: string): void
}

export const DEFAULT_BROWSER_ZOOM_FACTOR = 0.9
const BROWSER_SELECTION_TIMEOUT_MS = 120_000
const BROWSER_MARKER_MAX_COUNT = 50
const BROWSER_MARKER_MAX_COORDINATE = 10_000_000

export function assertAllowedBrowserUrl(value: string): string {
  if (value === 'about:blank') return value
  const url = new URL(value)
  if (url.protocol === 'file:') {
    if (!url.pathname || url.hostname) throw new Error('Unsupported browser file URL')
    return pathToFileURL(fileURLToPath(url)).toString()
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported browser URL protocol: ${url.protocol}`)
  }
  return url.toString()
}

export function normalizeBrowserUrl(value: string): string {
  const input = value.trim()
  if (!input || input === 'about:blank') return 'about:blank'
  if (input.startsWith('/') || input.startsWith('./') || input.startsWith('../') || input.startsWith('file://')) {
    const fileUrl = input.startsWith('file://') ? input : pathToFileURL(input).toString()
    return assertAllowedBrowserUrl(fileUrl)
  }
  if (/\s/.test(input) && !/^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(input)) {
    return `https://www.google.com/search?q=${encodeURIComponent(input)}`
  }
  const localAddress = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::|\/|$)/i.test(input)
  const hasProtocol = /^[A-Za-z][A-Za-z\d+.-]*:/.test(input)
  const withProtocol = localAddress ? `http://${input}` : hasProtocol ? input : `https://${input}`
  return assertAllowedBrowserUrl(withProtocol)
}

export class BrowserViewManager {
  private readonly entries = new Map<string, BrowserEntry>()
  private readonly releasedEntries = new Map<string, ReleasedBrowser>()

  constructor(
    private readonly window: BrowserWindow,
    private readonly profiles: BrowserProfileResolver,
    /**
     * ref 的跨轮/跨重启账本。和 `profiles` 一样从外面传进来，不给默认值：默认值要调
     * `app.getPath('userData')`，那会让这个类在**构造时**就绑死 Electron，而它此前只在真正开页面时才需要。
     */
    private readonly refLedgers: BrowserRefLedgerStore,
    /**
     * 应用链接的移交能力。和 `refLedgers` 同理从外面传进来：`shell.openExternal` 与读写 config 都会
     * 让这个类绑死 Electron/磁盘，而它此前只在真正开页面时才需要 Electron。
     *
     * `openExternal` 必须由调用方以箭头包一层或 `.bind(shell)` 传入——直接摘方法会丢掉原生 receiver
     * （本仓吃过这个亏）。
     */
    private readonly appLinks: AppLinkHost
  ) {}

  async create(id: string, rawUrl: string): Promise<BrowserSnapshot> {
    if (!id.trim()) throw new Error('Browser id is required')
    if (this.entries.has(id) || this.releasedEntries.has(id)) throw new Error(`Browser already exists: ${id}`)
    const url = normalizeBrowserUrl(rawUrl)
    const profileId = this.profiles.defaultProfileId()
    return await this.createEntry(id, url, profileId)
  }

  /**
   * Release only the Main-owned WebContentsView for a hidden Region. The Browser projection and its
   * URL/Profile/Viewport metadata remain in the Renderer; no `closed` event is emitted, so Region
   * identity cannot disappear as a side effect of a memory policy decision.
   */
  async release(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    this.cancelPendingSwitch(entry, new Error('Browser released during profile switch'))
    const contents = entry.view.webContents
    // `getURL()` is the last committed document. During an in-flight navigation it can still
    // point at the previous page, which would make a release/restore silently rewind the Browser
    // Region. `requestedUrl` is updated at the navigation boundary and is the durable projection
    // fact to retain while the native owner is gone.
    const requestedUrl = entry.requestedUrl
    const released: ReleasedBrowser = {
      id,
      profileId: entry.profileId,
      requestedUrl,
      viewport: entry.viewport
    }
    this.entries.delete(id)
    this.releasedEntries.set(id, released)
    if (!this.window.isDestroyed()) {
      try { this.window.contentView.removeChildView(entry.view) } catch { /* already detached */ }
    }
    if (!contents.isDestroyed()) contents.close()
  }

  /** Rebuild a previously released Browser native owner from its retained projection metadata. */
  async restore(id: string, input?: Partial<BrowserRestoreInput>): Promise<BrowserSnapshot> {
    if (this.entries.has(id)) return this.snapshot(this.entries.get(id)!)
    const released = this.releasedEntries.get(id)
    if (!released) throw new Error(`Unknown released browser: ${id}`)
    const profileId = input?.profileId ?? released.profileId
    // The retained Main descriptor is the only authoritative URL while the native owner is gone.
    // Renderer tab.url can lag did-start-navigation, so accepting it here could restore an older
    // committed page and silently change the Region's identity.
    const url = released.requestedUrl
    const viewport = input?.viewport ?? released.viewport
    if (!Object.hasOwn(BROWSER_VIEWPORT_PRESETS, viewport)) {
      throw new Error(`Unknown browser viewport: ${String(viewport)}`)
    }
    // Validate the profile before removing the retained descriptor. A failed restore must leave the
    // original profile ownership intact so deleting/repairing a profile cannot orphan this Region.
    this.resolvePartition(profileId)
    this.releasedEntries.delete(id)
    try {
      const snapshot = await this.createEntry(id, url, profileId, viewport)
      return snapshot
    } catch (error) {
      this.releasedEntries.set(id, { ...released, profileId, requestedUrl: url, viewport })
      throw error
    }
  }

  private async createEntry(
    id: string,
    url: string,
    profileId: string,
    viewport: BrowserViewport = 'responsive'
  ): Promise<BrowserSnapshot> {
    if (this.entries.has(id)) throw new Error(`Browser already exists: ${id}`)
    const view = this.createView(this.resolvePartition(profileId))
    const entry: BrowserEntry = {
      id,
      view,
      profileId,
      requestedUrl: url,
      navigationId: randomUUID(),
      selectionRevision: 0,
      selectionOperation: null,
      annotationRevision: 0,
      switchRevision: 0,
      pendingSwitch: null,
      bounds: null,
      visible: false,
      viewport,
      error: null,
      driving: false,
      appLinkPrompt: null
    }
    this.entries.set(id, entry)
    let childRegistrationAttempted = false
    try {
      childRegistrationAttempted = true
      this.window.contentView.addChildView(view)
      view.setVisible(false)
      this.attach(entry, view)
      this.emit(entry)
      void view.webContents.loadURL(url).catch((error) => {
        if (!this.owns(entry, view)) return
        entry.error = error instanceof Error ? error.message : String(error)
        this.emit(entry)
      })
      return this.snapshot(entry)
    } catch (error) {
      this.entries.delete(id)
      const cleanupErrors: unknown[] = []
      if (childRegistrationAttempted && !this.window.isDestroyed()) {
        try {
          this.window.contentView.removeChildView(view)
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError)
        }
      }
      if (!view.webContents.isDestroyed()) {
        try {
          view.webContents.close()
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError)
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], 'Browser creation and owner rollback failed')
      }
      throw error
    }
  }

  async navigate(id: string, rawUrl: string): Promise<BrowserSnapshot> {
    const entry = this.require(id)
    const url = normalizeBrowserUrl(rawUrl)
    this.cancelPendingSwitch(entry, new Error('Browser profile switch was superseded by navigation'))
    const view = entry.view
    entry.requestedUrl = url
    entry.error = null
    this.emit(entry)
    void view.webContents.loadURL(url).catch((error) => {
      if (!this.owns(entry, view)) return
      entry.error = error instanceof Error ? error.message : String(error)
      this.emit(entry)
    })
    return this.snapshot(entry)
  }

  async back(id: string): Promise<BrowserSnapshot> {
    const entry = this.require(id)
    this.cancelPendingSwitch(entry, new Error('Browser profile switch was superseded by navigation'))
    if (entry.view.webContents.navigationHistory.canGoBack()) {
      entry.view.webContents.navigationHistory.goBack()
    }
    return this.snapshot(entry)
  }

  async forward(id: string): Promise<BrowserSnapshot> {
    const entry = this.require(id)
    this.cancelPendingSwitch(entry, new Error('Browser profile switch was superseded by navigation'))
    if (entry.view.webContents.navigationHistory.canGoForward()) {
      entry.view.webContents.navigationHistory.goForward()
    }
    return this.snapshot(entry)
  }

  async reload(id: string): Promise<BrowserSnapshot> {
    const entry = this.require(id)
    this.cancelPendingSwitch(entry, new Error('Browser profile switch was superseded by reload'))
    entry.error = null
    entry.view.webContents.reload()
    return this.snapshot(entry)
  }

  async switchProfile(id: string, profileId: string): Promise<BrowserSnapshot> {
    const entry = this.require(id)
    const partition = this.resolvePartition(profileId)
    this.cancelPendingSwitch(entry, new Error('Browser profile switch was superseded'))
    if (entry.profileId === profileId) return this.snapshot(entry)

    const authoritativeView = entry.view
    // Keep profile switching consistent with release: the committed URL may lag the latest
    // navigation request while Chromium is loading.
    const url = assertAllowedBrowserUrl(entry.requestedUrl)
    const candidate = this.createView(partition)
    candidate.setVisible(false)
    let rejectCancellation!: (error: Error) => void
    const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject })
    const pending: PendingProfileSwitch = {
      token: ++entry.switchRevision,
      profileId,
      view: candidate,
      rejectCancellation,
      attached: false,
      released: false
    }

    let committed = false
    try {
      entry.pendingSwitch = pending
      this.window.contentView.addChildView(candidate)
      pending.attached = true
      this.attach(entry, candidate)
      await Promise.race([candidate.webContents.loadURL(url), cancellation])
      if (
        this.entries.get(id) !== entry ||
        entry.view !== authoritativeView ||
        entry.pendingSwitch !== pending ||
        entry.switchRevision !== pending.token ||
        authoritativeView.webContents.isDestroyed() ||
        candidate.webContents.isDestroyed()
      ) {
        throw new Error('Browser profile switch was superseded')
      }

      const zoomFactor = authoritativeView.webContents.getZoomFactor()
      candidate.webContents.setZoomFactor(zoomFactor)
      this.applyViewport(entry, candidate)
      if (entry.bounds) candidate.setBounds(entry.bounds)
      candidate.setVisible(entry.visible)
      this.window.contentView.removeChildView(authoritativeView)

      entry.pendingSwitch = null
      entry.view = candidate
      entry.profileId = profileId
      entry.requestedUrl = candidate.webContents.getURL() || url
      entry.navigationId = randomUUID()
      entry.selectionOperation = null
      entry.selectionRevision += 1
      entry.annotationRevision += 1
      entry.error = null
      committed = true
      if (!authoritativeView.webContents.isDestroyed()) authoritativeView.webContents.close()
      this.emit(entry)
      return this.snapshot(entry)
    } finally {
      if (!committed) {
        if (entry.pendingSwitch === pending) {
          entry.pendingSwitch = null
          entry.switchRevision += 1
        }
        this.releasePendingSwitch(pending)
      }
    }
  }

  openDevTools(id: string): void {
    this.require(id).view.webContents.openDevTools({ mode: 'detach', activate: true })
  }

  usesProfile(profileId: string): boolean {
    return [...this.entries.values()].some((entry) => (
      entry.profileId === profileId || entry.pendingSwitch?.profileId === profileId
    )) || [...this.releasedEntries.values()].some((entry) => entry.profileId === profileId)
  }

  setViewport(id: string, viewport: BrowserViewport): BrowserSnapshot {
    const entry = this.require(id)
    if (!Object.hasOwn(BROWSER_VIEWPORT_PRESETS, viewport)) {
      throw new Error(`Unknown browser viewport: ${String(viewport)}`)
    }
    entry.viewport = viewport
    this.applyViewport(entry)
    this.emit(entry)
    return this.snapshot(entry)
  }

  async captureScreenshot(id: string): Promise<BrowserScreenshotCapture> {
    const entry = this.require(id)
    const view = entry.view
    const navigationId = entry.navigationId
    const image = await view.webContents.capturePage()
    if (
      this.entries.get(id) !== entry ||
      entry.view !== view ||
      view.webContents.isDestroyed() ||
      entry.navigationId !== navigationId
    ) {
      throw new Error('Browser page changed while the screenshot was being captured')
    }
    return {
      browserId: id,
      navigationId,
      image: browserPngFromNativeImage(image)
    }
  }

  /**
   * 在这个 Browser 上跑一段 Agent 写的程序。
   *
   * 这里只做**四件事**：确认 Browser 还在、接上 CDP 会话、把页面函数的调用派发出去、把结局翻译成
   * 契约形状。程序本身在独立子进程里跑（`runBrowserScript`），页面能力由 `createBrowserPageDispatch`
   * 派发——那一层持有快照缓存与 ref 解析。
   *
   * **CDP 会话按次开关**，不常驻：Electron 的 debugger 与 DevTools 互斥，常驻等于永久占着用户的
   * DevTools（见 browser-cdp-session.ts 的说明）。`detach` 放在 finally 里，因为漏掉它的后果是
   * 静默的——用户此后再也打不开这个页面的 DevTools，而且没有任何提示。
   *
   * 翻译成四类结局是承重的：执行器的失败联合有四支，任何两支折成一支都会让 Agent 走错方向。
   * 特别是 `crashed` → `indeterminate`——进程死了意味着**做到哪一步不知道**，页面上可能已经点过
   * 一次了。把它报成普通失败，调用方就会重试，而那正是"下单被点两次"的来源。
   */
  async runScript(id: string, code: string): Promise<BrowserScriptRunReport> {
    const entry = this.require(id)
    const session = BrowserCdpSession.attach(entry.view.webContents)
    // 本轮自愈过的 ref 都记在这里。自愈按外观匹配，可能落在一个长得一样的**另一个**元素上，
    // 所以它不能只活在主进程的日志里——必须跟着结局回到 Agent 手上。
    const notes: string[] = []
    const takeover: BrowserTakeover = { at: null, kind: '' }
    const contents = entry.view.webContents
    const onInput = (_event: unknown, input: { type: string }): void => {
      // 只记第一次：要报的是「什么时候被接管的」，后来的每一下都不改变这个答案。
      if (takeover.at !== null || !HUMAN_INPUT_EVENT_TYPES.has(input.type)) return
      takeover.at = Date.now()
      takeover.kind = input.type
    }
    contents.on('input-event', onInput)
    entry.driving = true
    // 翻转必须各带一次 emit，否则这一位只有主进程自己知道，标签上的标记永远不动。开始与结束
    // 两处都要——只推开始的话，标记会一直停在"正在驱动"上，那比不画更糟。
    this.emit(entry)
    void this.showDriveBadge(entry, entry.view)
    try {
      const run = await runBrowserScript({ code, onPageCall: this.pageCallHandler(entry, session, notes, takeover) })
      // 会话中途没了，**压过程序自己的结局**。这一条是承重的：Agent 的程序里一个
      // `try { await click(ref) } catch {}` 完全是正常写法，而那个 catch 会把"会话没了"
      // 吞掉，程序照常 return——于是一次不知道点没点成的运行被报成 completed，
      // 而 `completed` 连个放警告的字段都没有。判在这一层，程序catch 不catch 都盖不住。
      const ended = session.endedReason
      if (ended !== null) {
        return {
          result: undefined,
          logs: run.logs,
          outcome: {
            kind: 'indeterminate',
            message:
              `The debugging session ended mid-run (${ended}) — opening DevTools on the page does that. ` +
              'An action may have half-completed. Look at the page before running anything again.'
          }
        }
      }
      // 被人接管过，同样压过程序自己的结局，而且**判在 `run.completed` 分叉之前**。
      //
      // 这个位置是承重的。放进 `run.completed` 分支里，只有「程序把拒绝 try/catch 吞了、照常
      // 跑完」的那一次会被降级；而程序**没有**吞的时候，拒绝是抛着出来的，落进
      // `browserRunOutcomeFromFailure` 报成 `script-failed`——**把人的动作记到 Agent 程序头上**，
      // 还叫 Agent 去改一段本来没错的代码。两条路必须汇到同一个结局。
      //
      // 为什么是 `stopped` 不是 `indeterminate`：我们精确地知道它做到哪一步了。拦在 onPageCall
      // 这道必经之路上，接管之前的动作都发生了，之后一个都没有。`indeterminate` 说的是"做到
      // 哪一步不知道"，而这里知道——报错了会让 Agent 以为页面处于未知状态，其实它 snapshot
      // 一下就看得清楚。
      if (takeover.at !== null) {
        // 返回值照常带回去，与自愈那一支同理：程序如果吞掉拒绝、拿观察看清了页面再 return，
        // 那份东西正是这次运行**唯一**还有价值的产出。丢掉它就是在逼 Agent 再跑一遍——而"再跑
        // 一遍"恰恰是我们刚刚告诉它现在不要做的事。程序没跑完时 `run.value` 不存在，这里就是
        // undefined，与其它失败支一致。
        return {
          result: run.completed ? run.value : undefined,
          logs: run.logs,
          outcome: { kind: 'stopped', message: takeoverMessage(takeover) }
        }
      }
      if (run.completed) {
        // 自愈过就不是 `completed`。程序确实跑完了，但**它作用在什么上不确定**——role+name+nth
        // 能匹配到一个长得一样的邻居。这正是 `indeterminate` 的含义（先看一眼页面，别盲目重试），
        // 也是 `completed` 这一支承载不了的：它连一个放警告的字段都没有。返回值照常带回去——
        // 那是程序真算出来的东西，丢掉它只会逼 Agent 再跑一遍。
        if (notes.length > 0) {
          return {
            result: run.value,
            logs: run.logs,
            outcome: { kind: 'indeterminate', message: notes.join('\n') }
          }
        }
        return { result: run.value, logs: run.logs, outcome: { kind: 'completed' } }
      }
      return { result: undefined, logs: run.logs, outcome: browserRunOutcomeFromFailure(run.failure) }
    } finally {
      // 监听器跟着这一次运行走，不跟着 entry 走。挂在整个 entry 生命周期上的话，人平时正常
      // 用这个浏览器就一直在写 `takeover`，下一次 run 一启动就以为自己被接管了。
      contents.removeListener('input-event', onInput)
      entry.driving = false
      this.emit(entry)
      void this.hideDriveBadge(entry.view)
      session.detach()
    }
  }

  /**
   * 角标注入与清除。
   *
   * **整段包在 try 里，不是只 `.catch()` 那个 Promise**：`executeJavaScriptInIsolatedWorld` 不存在
   * 或同步抛的时候，`.catch()` 根本还没挂上，异常会从这个 async 方法里漏成一个未处理的 rejection
   * ——而调用方是 `void`，于是一个纯装饰的角标能把进程搅成噪音甚至崩掉。提示失败就该无声。
   */
  private async showDriveBadge(entry: BrowserEntry, view: WebContentsView): Promise<void> {
    try {
      if (!this.owns(entry, view) || view.webContents.isDestroyed()) return
      await view.webContents.executeJavaScriptInIsolatedWorld(
        BROWSER_SELECTION_WORLD_ID,
        [{ code: buildBrowserDriveBadgeScript() }]
      )
    } catch {
      // 页面可能正好在导航、可能已经销毁。提示没注上不该打断这次运行。
    }
  }

  private async hideDriveBadge(view: WebContentsView): Promise<void> {
    try {
      if (view.webContents.isDestroyed()) return
      await view.webContents.executeJavaScriptInIsolatedWorld(
        BROWSER_SELECTION_WORLD_ID,
        [{ code: buildCancelBrowserDriveBadgeScript() }]
      )
    } catch {
      // 同上。清不掉最多留一个角标到下次导航，比抛出去好。
    }
  }

  /**
   * 页面函数真正干活的那一头。
   *
   * 这个方法是 `captureBrowserPageSnapshot` 与 `resolveBrowserRef` 的**唯一生产调用路径**——
   * 它们此前只有测试在 import，而"看起来完整、生产走别的路"正是本任务点名要防的陷阱。
   *
   * 这里只做**归属校验**（这个 entry 还是不是当前那个、view 还在不在），页面语义一概交给
   * `createBrowserPageDispatch`。归属留在这一层是因为只有 manager 知道 entry 有没有被换掉：
   * 换掉之后继续在旧 view 上派发，Agent 会在一个已经不属于这个 Browser 的页面上动手。
   */
  private pageCallHandler(
    entry: BrowserEntry,
    session: BrowserCdpSession,
    notes: string[],
    takeover: BrowserTakeover
  ): (name: string, args: unknown[]) => Promise<unknown> {
    const requireLive = (): WebContentsView => {
      const view = entry.view
      if (this.entries.get(entry.id) !== entry || view.webContents.isDestroyed()) {
        throw new Error(`Browser ${entry.id} went away while the script was running`)
      }
      return view
    }
    const dispatch = createBrowserPageDispatch({
      session,
      pageInfo: () => {
        const view = requireLive()
        return {
          url: view.webContents.getURL(),
          title: view.webContents.getTitle(),
          navigationId: entry.navigationId
        }
      },
      gotoUrl: async (url) => {
        await this.navigate(entry.id, url)
      },
      captureScreenshot: async () => await this.captureScreenshot(entry.id),
      readLedger: async () => await this.refLedgers.read(entry.id),
      writeLedger: async (ledger) => {
        await this.refLedgers.write(entry.id, ledger)
      },
      note: (text) => notes.push(text)
    })
    return async (name, args) => {
      requireLive()
      // 人接管之后，动作停、观察放行。拦在这里是因为这是主进程唯一的介入点——`runBrowserScript`
      // 不暴露 AbortSignal，程序跑在自己的子进程里；而每一次页面调用都要经过这道往返。
      if (takeover.at !== null && BROWSER_ACTION_PAGE_CALLS.has(name)) {
        throw new Error(takeoverMessage(takeover, name))
      }
      return await dispatch(name, args)
    }
  }

  /**
   * 一个应用链接想走。按已记住的答案决定这一次怎么办：记过 allow 就直接开，记过 deny 就说出来，
   * 没记过就把这一问挂上快照等人回答。
   *
   * 判定与「真的开」都在 `appLinkOutcome` 里，这里只负责把结局投影出去——让这里写成
   * `if (decision.shouldOpen) this.appLinks.openExternal(url)` 是**实测可被劫持**的形状，
   * 见 `window-security.ts` 里 `windowOpenOutcome` 的注释。
   */
  private async handOffAppLink(entry: BrowserEntry, url: string, scheme: string): Promise<void> {
    const view = entry.view
    const remembered = (await this.appLinks.rememberedSchemes())[scheme]
    // 读盘是异步的，这中间页面可能已经换掉或被顶掉。既有的每一处异步回写都先判这一句。
    if (!this.owns(entry, view)) return
    this.projectAppLinkOutcome(entry, appLinkOutcome(url, scheme, remembered, (target) => {
      this.appLinks.openExternal(target)
    }))
  }

  /** 把一次移交结局写进 entry 并广播。三档各自对应快照上不同的一组字段，不许有第二处这样写。 */
  private projectAppLinkOutcome(
    entry: BrowserEntry,
    outcome: ReturnType<typeof appLinkOutcome>
  ): void {
    entry.appLinkPrompt = outcome.kind === 'ask' ? { url: outcome.url, scheme: outcome.scheme } : null
    entry.error = outcome.kind === 'refused' ? appLinkRefusedMessage(outcome.scheme) : null
    this.emit(entry)
  }

  /**
   * 用户回答了那个提问。
   *
   * url 取自 entry 上挂着的那一次，不从渲染进程收——渲染进程回传 url 等于开了第二个事实源，
   * 页面可以在人回答之前又发起一次，两边就对不上了。
   */
  async answerAppLink(id: string, allow: boolean, remember: boolean): Promise<BrowserSnapshot> {
    const entry = this.require(id)
    const pending = entry.appLinkPrompt
    if (!pending) throw new Error('No app link is waiting for an answer on this Browser')
    const choice: AppLinkSchemeChoice = allow ? 'allow' : 'deny'
    if (remember) await this.appLinks.rememberScheme(pending.scheme, choice)
    // 记不记得住是两回事：这一次照答案走。传 choice 而不是 remembered，才让「只答这一次」成立。
    this.projectAppLinkOutcome(entry, appLinkOutcome(pending.url, pending.scheme, choice, (target) => {
      this.appLinks.openExternal(target)
    }))
    return this.snapshot(entry)
  }

  async selectElement(id: string): Promise<BrowserElementSelection | null> {
    const entry = this.require(id)
    const view = entry.view
    const navigationId = entry.navigationId
    entry.selectionOperation = null
    const preflightRevision = ++entry.selectionRevision
    await view.webContents.executeJavaScriptInIsolatedWorld(
      BROWSER_SELECTION_WORLD_ID,
      [{ code: buildCancelBrowserElementSelectionScript(preflightRevision) }]
    )
    if (
      this.entries.get(id) !== entry ||
      entry.view !== view ||
      view.webContents.isDestroyed() ||
      entry.navigationId !== navigationId ||
      entry.selectionRevision !== preflightRevision
    ) {
      return null
    }
    const operation = ++entry.selectionRevision
    entry.selectionOperation = operation
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const raw = await Promise.race([
        view.webContents.executeJavaScriptInIsolatedWorld(
          BROWSER_SELECTION_WORLD_ID,
          [{ code: buildBrowserElementSelectionScript(operation) }],
          true
        ),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Browser element selection timed out')), BROWSER_SELECTION_TIMEOUT_MS)
        })
      ])
      if (raw === null) return null
      if (
        this.entries.get(id) !== entry ||
        entry.view !== view ||
        view.webContents.isDestroyed() ||
        entry.navigationId !== navigationId ||
        entry.selectionOperation !== operation
      ) {
        throw new Error('Browser page changed while an element was being selected')
      }
      return {
        browserId: id,
        navigationId,
        ...sanitizeBrowserElementSelection(raw)
      }
    } finally {
      if (timeout) clearTimeout(timeout)
      if (entry.selectionOperation === operation) entry.selectionOperation = null
      if (this.entries.get(id) === entry && entry.view === view && !view.webContents.isDestroyed()) {
        void view.webContents.executeJavaScriptInIsolatedWorld(
          BROWSER_SELECTION_WORLD_ID,
          [{ code: buildCancelBrowserElementSelectionScript(operation) }]
        ).catch(() => {})
      }
    }
  }

  async cancelElementSelection(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry || entry.view.webContents.isDestroyed()) return
    entry.selectionOperation = null
    const revision = ++entry.selectionRevision
    await entry.view.webContents.executeJavaScriptInIsolatedWorld(
      BROWSER_SELECTION_WORLD_ID,
      [{ code: buildCancelBrowserElementSelectionScript(revision) }]
    )
  }

  async setAnnotationMarkers(
    id: string,
    navigationId: string,
    markers: readonly BrowserAnnotationMarker[]
  ): Promise<void> {
    const entry = this.require(id)
    const view = entry.view
    if (entry.navigationId !== navigationId) {
      return
    }
    if (!Array.isArray(markers) || markers.length > BROWSER_MARKER_MAX_COUNT) {
      throw new Error('Browser annotation marker count exceeds the limit')
    }
    const ids = new Set<string>()
    const indexes = new Set<number>()
    const normalized = Array.from(markers, (marker, index): BrowserAnnotationMarker => {
      if (
        !marker ||
        typeof marker.id !== 'string' ||
        !marker.id ||
        marker.id.length > 100 ||
        !Number.isInteger(marker.index) ||
        marker.index < 0 ||
        marker.index >= BROWSER_MARKER_MAX_COUNT ||
        typeof marker.isFixed !== 'boolean'
      ) {
        throw new Error(`Browser annotation marker ${index} is invalid`)
      }
      if (ids.has(marker.id) || indexes.has(marker.index)) {
        throw new Error(`Browser annotation marker ${index} duplicates an id or index`)
      }
      ids.add(marker.id)
      indexes.add(marker.index)
      return {
        id: marker.id,
        index: marker.index,
        isFixed: marker.isFixed,
        rectViewport: normalizeMarkerRect(marker.rectViewport),
        rectPage: normalizeMarkerRect(marker.rectPage)
      }
    })
    const revision = ++entry.annotationRevision
    await view.webContents.executeJavaScriptInIsolatedWorld(
      BROWSER_SELECTION_WORLD_ID,
      [{ code: buildBrowserAnnotationMarkerScript(normalized, revision) }]
    )
    if (
      this.entries.get(id) !== entry ||
      entry.view !== view ||
      view.webContents.isDestroyed() ||
      entry.navigationId !== navigationId ||
      entry.annotationRevision !== revision
    ) {
      if (this.entries.get(id) === entry && entry.view === view && !view.webContents.isDestroyed()) {
        void view.webContents.executeJavaScriptInIsolatedWorld(
          BROWSER_SELECTION_WORLD_ID,
          [{ code: buildCancelBrowserAnnotationMarkerScript(revision) }]
        ).catch(() => {})
      }
    }
  }

  setBounds(id: string, bounds: BrowserBounds | null): void {
    const entry = this.entries.get(id)
    if (!entry) return
    if (bounds === null) {
      entry.visible = false
      entry.view.setVisible(false)
      return
    }
    // 归一化与 renderer 侧共用一份判定（shared/browser-bounds.ts）。这一侧拿到 null 抛错而不是静默
    // 隐藏：矩形到了 main 还不可用，意味着上游算错了或有人绕过 renderer 直接发 IPC，隐藏会把 bug 埋掉。
    const normalized = normalizeBrowserBounds(bounds)
    if (!normalized) {
      throw new Error('Browser bounds must be finite with a positive size')
    }
    entry.bounds = normalized
    entry.visible = true
    entry.view.setBounds(entry.bounds)
    entry.view.setVisible(true)
  }

  close(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) {
      if (!this.releasedEntries.delete(id)) return
      this.send({ type: 'closed', id })
      return
    }
    this.cancelPendingSwitch(entry, new Error('Browser closed during profile switch'))
    if (!entry.view.webContents.isDestroyed()) {
      entry.selectionOperation = null
      const selectionRevision = ++entry.selectionRevision
      const annotationRevision = ++entry.annotationRevision
      void entry.view.webContents.executeJavaScriptInIsolatedWorld(
        BROWSER_SELECTION_WORLD_ID,
        [{ code: buildCancelBrowserElementSelectionScript(selectionRevision) }]
      ).catch(() => {})
      void entry.view.webContents.executeJavaScriptInIsolatedWorld(
        BROWSER_SELECTION_WORLD_ID,
        [{ code: buildBrowserAnnotationMarkerScript([], annotationRevision) }]
      ).catch(() => {})
    }
    this.entries.delete(id)
    this.window.contentView.removeChildView(entry.view)
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close()
    this.send({ type: 'closed', id })
  }

  dispose(): void {
    for (const id of [...this.entries.keys()]) this.close(id)
    for (const id of [...this.releasedEntries.keys()]) this.close(id)
  }

  private attach(entry: BrowserEntry, view: WebContentsView): void {
    const contents = view.webContents
    const guardNavigation = (event: { url: string; isMainFrame: boolean; preventDefault(): void }): void => {
      // 应用链接在闸门**之前**分流。闸门本身逐字不变：`lark://` 装不进 WebContentsView，它要的不是
      // 放行进视图，是改道给系统。两件事分开之后，`javascript:` 一类仍然原地死在闸门上。
      const target = classifyBrowserTarget(event.url)
      if (target.kind === 'hand-off') {
        event.preventDefault()
        if (!this.owns(entry, view)) return
        void this.handOffAppLink(entry, event.url, target.scheme!)
        return
      }
      // 普通 child-frame navigation belongs to the page. Only the application-link
      // branch above crosses the Browser boundary for embedded frames.
      if (!event.isMainFrame) return
      try {
        assertAllowedBrowserUrl(event.url)
      } catch (error) {
        event.preventDefault()
        if (!this.owns(entry, view)) return
        entry.error = error instanceof Error ? error.message : String(error)
        this.emit(entry)
      }
    }
    contents.on('will-navigate', guardNavigation)
    contents.on('will-redirect', guardNavigation)
    // 弹窗那条路。`649df3a2` 把整个 handler 删掉是为了保住原生 popup 语义，而缺席的代价是应用链接的
    // `window.open` 会真的开出一个装着 `lark:` 的窗口，没人管。这里回装，但只截应用链接——回调体就是
    // 一次转发，判定与副作用都在 `browserWindowOpenOutcome` 里（照 window-security.ts 那两个实测存活
    // 的变异：回调体里有语句就能改）。
    contents.setWindowOpenHandler(({ url }) =>
      browserWindowOpenOutcome(url, (target, scheme) => {
        if (!this.owns(entry, view)) return
        void this.handOffAppLink(entry, target, scheme)
      })
    )
    contents.on('did-finish-load', () => {
      if (!this.owns(entry, view)) return
      contents.setZoomFactor(DEFAULT_BROWSER_ZOOM_FACTOR)
      this.applyViewport(entry, view)
      // 导航把页面内的东西全冲掉了，角标也在其中。这一处已经是"导航后重新施加状态"的既有位置
      // （上面两行就是），所以角标挂在这里，而不是另起一套重注机制。
      if (entry.driving) void this.showDriveBadge(entry, view)
    })
    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || !this.owns(entry, view)) return
      let requestedUrl: string
      try {
        requestedUrl = assertAllowedBrowserUrl(details.url)
      } catch {
        // `will-navigate`/`will-redirect` owns rejection and error publication. Do not replace a
        // known-good projection with an unsupported target if an embedder emits this callback first.
        return
      }
      this.cancelPendingSwitch(entry, new Error('Browser profile switch was superseded by navigation'))
      entry.selectionOperation = null
      const selectionRevision = ++entry.selectionRevision
      const annotationRevision = ++entry.annotationRevision
      void contents.executeJavaScriptInIsolatedWorld(
        BROWSER_SELECTION_WORLD_ID,
        [{ code: buildCancelBrowserElementSelectionScript(selectionRevision) }]
      ).catch(() => {})
      void contents.executeJavaScriptInIsolatedWorld(
        BROWSER_SELECTION_WORLD_ID,
        [{ code: buildBrowserAnnotationMarkerScript([], annotationRevision) }]
      ).catch(() => {})
      entry.requestedUrl = requestedUrl
      entry.navigationId = randomUUID()
      entry.error = null
      this.emit(entry)
    })
    contents.on('did-start-loading', () => {
      if (!this.owns(entry, view)) return
      entry.error = null
      this.emit(entry)
    })
    contents.on('did-stop-loading', () => {
      if (!this.owns(entry, view)) return
      this.emit(entry)
    })
    contents.on('did-navigate', (_event, url) => {
      if (!this.owns(entry, view)) return
      entry.requestedUrl = url
      entry.error = null
      this.emit(entry)
    })
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame || !this.owns(entry, view)) return
      entry.requestedUrl = url
      this.emit(entry)
    })
    contents.on('page-title-updated', () => {
      if (!this.owns(entry, view)) return
      this.emit(entry)
    })
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 || !this.owns(entry, view)) return
      entry.requestedUrl = validatedURL || entry.requestedUrl
      entry.error = `${errorDescription} (${errorCode})`
      this.emit(entry)
    })
    contents.on('render-process-gone', (_event, details) => {
      if (!this.owns(entry, view)) return
      entry.error = `Browser renderer stopped: ${details.reason}`
      this.emit(entry)
    })
    contents.once('destroyed', () => {
      if (entry.pendingSwitch?.view === view) {
        this.cancelPendingSwitch(entry, new Error('Browser profile candidate was destroyed'))
        return
      }
      if (!this.owns(entry, view)) return
      this.cancelPendingSwitch(entry, new Error('Browser closed during profile switch'))
      if (this.entries.get(entry.id) !== entry || entry.view !== view) return
      this.entries.delete(entry.id)
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view)
      this.send({ type: 'closed', id: entry.id })
    })
  }

  private require(id: string): BrowserEntry {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`Unknown browser: ${id}`)
    return entry
  }

  private createView(partition: string): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    })
    view.webContents.session.setPermissionCheckHandler(() => false)
    view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    return view
  }

  private resolvePartition(profileId: string): string {
    if (!profileId.trim()) throw new Error('Browser profile id is required')
    const partition = this.profiles.resolvePartition(profileId)
    if (!partition.trim()) throw new Error(`Browser profile has no partition: ${profileId}`)
    return partition
  }

  private owns(entry: BrowserEntry, view: WebContentsView): boolean {
    return this.entries.get(entry.id) === entry && entry.view === view
  }

  private cancelPendingSwitch(entry: BrowserEntry, error: Error): void {
    entry.switchRevision += 1
    const pending = entry.pendingSwitch
    if (!pending) return
    entry.pendingSwitch = null
    pending.rejectCancellation(error)
    this.releasePendingSwitch(pending)
  }

  private releasePendingSwitch(pending: PendingProfileSwitch): void {
    if (pending.released) return
    pending.released = true
    if (pending.attached && !this.window.isDestroyed()) {
      this.window.contentView.removeChildView(pending.view)
      pending.attached = false
    }
    if (!pending.view.webContents.isDestroyed()) pending.view.webContents.close()
  }

  private applyViewport(entry: BrowserEntry, view = entry.view): void {
    const contents = view.webContents
    if (entry.viewport === 'responsive') {
      contents.disableDeviceEmulation()
      return
    }
    const size = BROWSER_VIEWPORT_PRESETS[entry.viewport]
    contents.enableDeviceEmulation({
      screenPosition: entry.viewport === 'desktop' ? 'desktop' : 'mobile',
      screenSize: size,
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 0,
      viewSize: size,
      scale: 1
    })
  }

  private snapshot(entry: BrowserEntry): BrowserSnapshot {
    const contents = entry.view.webContents
    return {
      id: entry.id,
      navigationId: entry.navigationId,
      profileId: entry.profileId,
      url: contents.getURL() || entry.requestedUrl,
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      viewport: entry.viewport,
      error: entry.error,
      driving: entry.driving,
      appLinkPrompt: entry.appLinkPrompt
    }
  }

  private emit(entry: BrowserEntry): void {
    if (this.entries.get(entry.id) !== entry || entry.view.webContents.isDestroyed()) return
    this.send({ type: 'updated', browser: this.snapshot(entry) })
  }

  private send(event: BrowserEvent): void {
    if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed()) {
      this.window.webContents.send(BROWSER_EVENT_CHANNEL, event)
    }
  }
}

function normalizeMarkerRect(value: BrowserElementRect): BrowserElementRect {
  if (
    !value ||
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y) ||
    !Number.isFinite(value.width) ||
    !Number.isFinite(value.height) ||
    value.width < 0 ||
    value.height < 0
  ) {
    throw new Error('Browser annotation marker geometry is invalid')
  }
  return {
    x: Math.min(BROWSER_MARKER_MAX_COORDINATE, Math.max(-BROWSER_MARKER_MAX_COORDINATE, value.x)),
    y: Math.min(BROWSER_MARKER_MAX_COORDINATE, Math.max(-BROWSER_MARKER_MAX_COORDINATE, value.y)),
    width: Math.min(BROWSER_MARKER_MAX_COORDINATE, value.width),
    height: Math.min(BROWSER_MARKER_MAX_COORDINATE, value.height)
  }
}
