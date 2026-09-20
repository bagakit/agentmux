import { randomUUID } from 'node:crypto'
import { WebContentsView, type BrowserWindow, type WebContents } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BROWSER_PAGE_MUTATING_CAPABILITY_NAMES, browserPageCapabilityNames } from '@agentmux/core'
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
  type BrowserViewport,
  type BrowserOperator,
  type BrowserActivityState
} from '../shared/contracts.js'
import type { AgentMuxControlErrorCode } from '@agentmux/core/control'
import type { BrowserOperation, BrowserOperationStep, BrowserReplayPlan, BrowserReplayStep } from '../shared/browser-operation.js'
import { normalizeBrowserBounds } from '../shared/browser-bounds.js'
import { BrowserCdpSession } from './browser-cdp-session.js'
import { browserPngFromNativeImage } from './browser-image.js'
import { createBrowserPageDispatch } from './browser-page-dispatch.js'
import { browserOperationPhaseFromOutcome, browserRunOutcomeFromFailure } from './browser-run-outcome.js'
import { BrowserRefLedgerStore } from './browser-ref-ledger-store.js'
import {
  appLinkOutcome,
  appLinkRefusedMessage,
  browserWindowOpenOutcome,
  classifyBrowserTarget,
  type AppLinkSchemeChoice
} from './browser-app-link.js'
import { runBrowserScript } from './browser-script-runner.js'
import { buildReplayScript } from './browser-replay-compiler.js'
import type { BrowserOperationJournal } from './browser-operation-journal.js'
import { BrowserStepEvidenceStore, pageStepEvidence, recordBrowserStepEvidence, screenshotStepEvidence } from './browser-step-evidence.js'
import type { BrowserStepEvidenceContent, BrowserStepEvidenceRead } from '../shared/browser-step-evidence.js'
import type { BrowserPageSnapshot } from '../shared/contracts.js'
import { BrowserResultArtifactStore } from './browser-result-artifact.js'
import type { BrowserResultContext } from '../shared/browser-result-artifact.js'
import { BrowserDemonstrationCapture } from './browser-demonstration-capture.js'
import type { BrowserDemonstrationRecorder } from './browser-demonstration-recorder.js'
import type { BrowserDemonstrationDraft, BrowserDemonstrationState } from '../shared/browser-demonstration.js'
import { sanitizeBrowserElementSelection } from './browser-selection.js'
import {
  BROWSER_SELECTION_WORLD_ID,
  buildBrowserAnnotationMarkerScript,
  buildCancelBrowserAnnotationMarkerScript,
  buildBrowserElementSelectionScript,
  buildCancelBrowserElementSelectionScript
} from './browser-selection-script.js'

type BrowserEntry = {
  id: string
  readonly workspaceId: string | null
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
   * 这一刻有没有一段 Agent 程序在驱动它。`snapshot()` 读取它——渲染进程据此
   * 在标签上认出是哪一格（见 `BrowserSnapshot.driving` 的说明）。
   *
   * 一个布尔够用，不必是计数：两次 run 不可能在同一个页面上重叠——`BrowserCdpSession.attach` 对
   * 已 attach 的 page 第二次会抛，`runScript` 第一件事就是它。
   */
  driving: boolean
  /** 这一页上待答的那个应用链接提问。回答掉或换页就清。 */
  appLinkPrompt: { url: string; scheme: string } | null
  activity: BrowserActivityState
  humanControl: boolean
  activeRun: { operationId: string; stop: () => void } | undefined
  runInFlight: boolean
  demonstration?: BrowserDemonstrationState
}

/** 本轮运行有没有被人接管，以及是被哪一下、什么时候。`at` 为 null 表示还没有。 */
type BrowserTakeover = { at: number | null; kind: string }

const BROWSER_WAIT_PAGE_CALLS = new Set(browserPageCapabilityNames('wait'))

function summarizeBrowserValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(${value.length})`
  if (typeof value === 'object') return 'object'
  return typeof value
}

function safeBrowserUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return 'about:blank'
  }
}

function startBrowserOperationStep(operation: BrowserOperation, method: string, args: unknown[]): BrowserOperationStep {
  const sensitive = method === 'fillInput' || method === 'typeText' || method === 'js' || method === 'cdp'
  const replay: BrowserReplayStep = {
    method,
    url: safeBrowserUrl(operation.url),
    args: sensitive
      ? []
      : (typeof args[0] === 'string' && args[0].startsWith('@') ? args.slice(1) : args)
          .map((arg) => typeof arg === 'string' && arg.length > 120 ? '[redacted]' : arg),
    ...(method === 'fillInput' || method === 'typeText' ? { inputKey: 'value', blockedReason: 'Sensitive input is requested again at replay time.' } : {}),
    ...(method === 'js' || method === 'cdp' ? { blockedReason: 'Opaque page code or protocol input requires explicit review.' } : {})
  }
  const step: BrowserOperationStep = {
    sequence: operation.steps.length + 1,
    method,
    label: method,
    startedAt: Date.now(),
    status: 'running',
    ...(typeof args[0] === 'string' && args[0].startsWith('@') ? { ref: args[0] } : {}),
    replay
  }
  operation.steps.push(step)
  operation.summary = `Running ${method}`
  return step
}

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
 * 人工接管之后要拒绝的那些页面调用——**取自 core 的能力表，不在这里手抄**。
 *
 * 此前这是本文件里一个手写的 9 个名字的 Set。它与真正注入的那份清单
 * （`BROWSER_PAGE_FUNCTION_NAMES`）是同一份事实的两个副本，而副本漂移时**没有任何东西会红**：
 * 新增一个动作类能力却忘了往这个 Set 里加，意味着人拿回页面之后 Agent 仍然能改它——一个
 * 悄悄放宽了的闸门，不是一次报错。
 *
 * 现在按 `effect` 从能力表派生（`act` ∪ `navigate`）。放行观察不是宽容，是诚实：程序被打断
 * 之后最该做的事就是「看一眼现在页面什么样」再决定怎么报告。把 snapshot 也拦掉，它只能瞎猜
 * 着退出；而观察不改页面，跟人不会打架。
 *
 * `js` 和 `cdp` 在表里按 `act` 计，所以自动在内——它们能做任何事，漏掉任何一个都等于没拦。
 * `cdp` 还有一层：它把方法名原样透传，所以 `cdp('Input.dispatchMouseEvent', …)` 能发出真的
 * 原生输入，从而让程序**触发自己的接管判据**。这不是安全问题（程序本来就能为所欲为），
 * 代价也可接受：它踩的是自己，结局是一个 `stopped` 加一句说明，不是静默乱点。
 */
const BROWSER_ACTION_PAGE_CALLS = BROWSER_PAGE_MUTATING_CAPABILITY_NAMES

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
  workspaceId: string | null
  profileId: string
  requestedUrl: string
  viewport: BrowserViewport
}

type BrowserRestoreInput = {
  workspaceId: string | null
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
  openExternal(target: string): void | Promise<void>
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
  private demonstrationCapture: { entry: BrowserEntry; view: WebContentsView; contents: WebContents; capture: BrowserDemonstrationCapture } | null = null

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
    private readonly appLinks: AppLinkHost,
    private readonly operationJournal?: BrowserOperationJournal,
    private readonly stepEvidence?: BrowserStepEvidenceStore,
    private readonly resultArtifacts?: BrowserResultArtifactStore,
    private readonly demonstrations?: BrowserDemonstrationRecorder
  ) {}

  resourceOwnerCounts(): { browserViews: number; releasedBrowserViews: number } {
    return {
      browserViews: [...this.entries.values()].filter((entry) => !entry.view.webContents.isDestroyed()).length,
      releasedBrowserViews: this.releasedEntries.size
    }
  }

  /** Actual OS owners, including out-of-process frames; a shared PID is reported only once. */
  resourceProcessIds(): number[] {
    const pids = new Set<number>()
    for (const { view } of this.entries.values()) {
      if (view.webContents.isDestroyed()) continue
      for (const frame of view.webContents.mainFrame.framesInSubtree) {
        if (!frame.detached && frame.osProcessId > 0) pids.add(frame.osProcessId)
      }
    }
    return [...pids]
  }

  async create(id: string, rawUrl: string, workspaceId: string | null = null): Promise<BrowserSnapshot> {
    if (!id.trim()) throw new Error('Browser id is required')
    // A repeated recovery handshake addresses this owner, not a new navigation/profile choice.
    const existing = this.entries.get(id)
    if (existing) {
      this.assertWorkspaceBinding(existing.workspaceId, workspaceId)
      return this.snapshot(existing)
    }
    if (this.releasedEntries.has(id)) return await this.restore(id, { workspaceId })
    const url = normalizeBrowserUrl(rawUrl)
    const profileId = this.profiles.defaultProfileId()
    return await this.createEntry(id, url, profileId, 'responsive', workspaceId)
  }

  /**
   * Release only the Main-owned WebContentsView for a hidden Region. The Browser projection and its
   * URL/Profile/Viewport metadata remain in the Renderer; no `closed` event is emitted, so Region
   * identity cannot disappear as a side effect of a memory policy decision.
   */
  async release(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    void this.releaseDemonstrationCapture(entry)
    this.cancelPendingSwitch(entry, new Error('Browser released during profile switch'))
    const contents = entry.view.webContents
    // `getURL()` is the last committed document. During an in-flight navigation it can still
    // point at the previous page, which would make a release/restore silently rewind the Browser
    // Region. `requestedUrl` is updated at the navigation boundary and is the durable projection
    // fact to retain while the native owner is gone.
    const requestedUrl = entry.requestedUrl
    const released: ReleasedBrowser = {
      id,
      workspaceId: entry.workspaceId,
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
    const existing = this.entries.get(id)
    if (existing) {
      this.assertWorkspaceBinding(existing.workspaceId, input?.workspaceId ?? null)
      return this.snapshot(existing)
    }
    const released = this.releasedEntries.get(id)
    if (!released) throw new Error(`Unknown released browser: ${id}`)
    this.assertWorkspaceBinding(released.workspaceId, input?.workspaceId ?? null)
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
      const snapshot = await this.createEntry(id, url, profileId, viewport, released.workspaceId)
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
    viewport: BrowserViewport = 'responsive',
    workspaceId: string | null = null
  ): Promise<BrowserSnapshot> {
    if (this.entries.has(id)) throw new Error(`Browser already exists: ${id}`)
    const view = this.createView(this.resolvePartition(profileId))
    const entry: BrowserEntry = {
      id,
      workspaceId,
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
      appLinkPrompt: null,
      activity: { operation: null, control: 'human' },
      humanControl: false,
      activeRun: undefined,
      runInFlight: false
    }
    this.entries.set(id, entry)
    let childRegistrationAttempted = false
    try {
      childRegistrationAttempted = true
      // BrowserWindow's original Renderer is child 0. Browsers sit above it and below native Chrome.
      this.window.contentView.addChildView(view)
      view.setVisible(false)
      this.attach(entry, view)
      this.emit(entry)
      if (this.demonstrations) void this.getDemonstration(id).catch(() => {
        if (!this.owns(entry, view) || this.demonstrationCapture?.entry === entry) return
        entry.demonstration = { draft: null, warning: 'The saved demonstration could not be read. The Browser remains usable; reopen its activity details to retry.' }
        this.emit(entry)
      })
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

      void this.releaseDemonstrationCapture(entry)
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
  /**
   * @param operationId 这次操作的 identity，由调用方给（协议的 `browser.run` 可选字段）。
   *   给了才可能「在飞期间凭 id 查询/取消」：Control 是一问一答，主进程铸的 id 只随终局回执露出，
   *   那时已无可取消。缺席时由 journal 铸——**铸造点仍只有一处**（journal 的 `makeId`），
   *   这里绝不再补一个 `randomUUID()` 兜底：两个铸造点会让查询用的 id 与记录里的 id 分岔，
   *   而分岔时两边各自看起来都正常（MEMORY：读的 key 与写的 key 必须只判一次）。
   */
  async runScript(id: string, code: string, operator?: BrowserOperator, replayOf?: string, operationId?: string): Promise<BrowserScriptRunReport> {
    const entry = this.require(id)
    // Capture releases its native/CDP owner before its first await. Durable draft writes do not gate a healthy run.
    void this.releaseDemonstrationCapture(entry)
    const resultNavigationId = entry.navigationId
    if (entry.humanControl) {
      // 带类型化的码，不是一句散文：调用方要能把「人在用这一页」与「出故障了」分开，并且知道恢复
      // 动作是**人明确交还控制**，不是重试。裸 Error 会让两者在机读侧长得一模一样。
      throw Object.assign(
        new Error('Human control is still active for this Browser. Explicitly return control before running another Agent program.'),
        { code: 'BROWSER_HUMAN_CONTROL_ACTIVE' satisfies AgentMuxControlErrorCode }
      )
    }
    if (entry.runInFlight || entry.activeRun) {
      throw new Error('Another Browser operation is already running. Wait for it to finish or stop it before starting another program.')
    }
    entry.runInFlight = true
    // attach 抛是**常规路径**，不是意外：用户开着 DevTools 就必然抛（见 browser-cdp-session.ts）。
    // 所以这个 flag 的复位不能只挂在成功之后——attach 在 try 外面抛一次，flag 就永久卡住，
    // 此后每次 run 都报"另一个操作正在运行"，而 `activeRun` 是空的、连能停的东西都没有，
    // 只有销毁重建这个 view 才能恢复。失败自己是可恢复的，别把它变成不可恢复的。
    let session: BrowserCdpSession
    try {
      session = BrowserCdpSession.attach(entry.view.webContents)
    } catch (error) {
      entry.runInFlight = false
      throw error
    }
    // 本轮自愈过的 ref 都记在这里。自愈按外观匹配，可能落在一个长得一样的**另一个**元素上，
    // 所以它不能只活在主进程的日志里——必须跟着结局回到 Agent 手上。
    const notes: string[] = []
    const takeover: BrowserTakeover = { at: null, kind: '' }
    const stopController = new AbortController()
    let stopRequested = false
    const localOperation: BrowserOperation = {
      // 调用方给了 id 就用它；没给才由 journal 铸（`start` 的 `input.id?.trim() || this.makeId()`）。
      // 这里不写 `?? randomUUID()`：那会是第二个铸造点，而它造出来的 id 与 journal 记下的那个可能
      // 不是同一个——查询按一个、记录按另一个，两边各自看起来都正常。
      //
      // 没有 journal 时（只在测试里）这个分支要给一个值才能构成 BrowserOperation，所以用空串占位，
      // 由下面 `operation = ... : localOperation` 那条路承担。空串不会被当成合法 id：journal 的
      // `input.id?.trim() ||` 对空串取假，正是靠这个落回铸造点。
      id: operationId ?? '',
      browserId: id,
      operator: operator ?? { id: 'agent:unknown', name: 'Agent' },
      startedAt: Date.now(),
      phase: 'preparing',
      summary: 'Preparing browser program',
      url: entry.requestedUrl,
      steps: [],
      ...(replayOf ? { replayOf } : {})
    }
    let operation: BrowserOperation
    try {
      operation = this.operationJournal
        ? await this.operationJournal.start({
            ...(localOperation.id ? { id: localOperation.id } : {}),
            browserId: id,
            operator: localOperation.operator,
            summary: localOperation.summary,
            url: localOperation.url,
            ...(localOperation.replayOf ? { replayOf: localOperation.replayOf } : {})
          })
        : localOperation
    } catch (error) {
      entry.runInFlight = false
      throw error
    }
    entry.activity = { operation, control: 'agent' }
    const contents = entry.view.webContents
    const onInput = (_event: unknown, input: { type: string }): void => {
      // 只记第一次：要报的是「什么时候被接管的」，后来的每一下都不改变这个答案。
      if (takeover.at !== null || !HUMAN_INPUT_EVENT_TYPES.has(input.type)) return
      takeover.at = Date.now()
      takeover.kind = input.type
      entry.humanControl = true
      operation.phase = 'human'
      operation.summary = 'Human took control of the Browser'
      operation.warning = takeoverMessage(takeover)
      entry.driving = false
      entry.activity = { operation, control: 'human', warning: operation.warning }
      void this.operationJournal?.setPhase(operation.id, 'human', { summary: operation.summary, warning: operation.warning })
      this.emit(entry)
    }
    contents.on('input-event', onInput)
    entry.driving = true
    entry.activeRun = {
      operationId: operation.id,
      stop: () => {
        if (stopRequested) return
        stopRequested = true
        entry.humanControl = true
        entry.driving = false
        operation.phase = 'stopped'
        operation.summary = 'Stopped by the person using the Browser'
        operation.finishedAt = Date.now()
        operation.warning = 'The Browser operation was stopped. Review the page before running another program.'
        entry.activity = { operation, control: 'human', warning: operation.warning }
        stopController.abort()
        void this.operationJournal?.setPhase(operation.id, 'stopped', { summary: operation.summary, warning: operation.warning })
        this.emit(entry)
      }
    }
    operation.phase = 'running'
    operation.summary = 'Agent is operating the Browser'
    void this.operationJournal?.setPhase(operation.id, 'running', { summary: operation.summary })
    // 翻转必须各带一次 emit，否则这一位只有主进程自己知道，标签上的标记永远不动。开始与结束
    // 两处都要——只推开始的话，标记会一直停在"正在驱动"上，那比不画更糟。
    this.emit(entry)
    try {
      const resultContext: BrowserResultContext = {
        workspaceId: entry.workspaceId, browserId: entry.id, operationId: operation.id,
        navigationId: resultNavigationId
      }
      const run = await runBrowserScript({ code, signal: stopController.signal,
        onPageCall: this.pageCallHandler(entry, session, notes, takeover, operation),
        ...(this.resultArtifacts ? { captureResultArtifact: async (sourcePath: string) =>
          await this.resultArtifacts!.import(resultContext, sourcePath) } : {})
      })
      // 会话中途没了，**压过程序自己的结局**。这一条是承重的：Agent 的程序里一个
      // `try { await click(ref) } catch {}` 完全是正常写法，而那个 catch 会把"会话没了"
      // 吞掉，程序照常 return——于是一次不知道点没点成的运行被报成 completed，
      // 而 `completed` 连个放警告的字段都没有。判在这一层，程序catch 不catch 都盖不住。
      const ended = session.endedReason
      if (stopRequested) {
        operation.phase = 'stopped'
        operation.summary = 'Stopped by the person using the Browser'
        operation.finishedAt = operation.finishedAt ?? Date.now()
        operation.warning = operation.warning ?? 'The Browser operation was stopped. Review the page before running another program.'
        entry.activity = { operation, control: 'human', warning: operation.warning }
        return {
          result: undefined,
          logs: run.logs,
          outcome: { kind: 'stopped', message: operation.warning },
          runOperation: operation
        }
      }
      if (ended !== null) {
        operation.phase = 'indeterminate'
        operation.summary = 'Browser session ended before the result was known'
        operation.finishedAt = Date.now()
        operation.warning = String(ended)
        entry.activity = { operation, control: 'agent', warning: operation.warning }
        return {
          result: undefined,
          logs: run.logs,
          outcome: {
            kind: 'indeterminate',
            message:
              `The debugging session ended mid-run (${ended}) — opening DevTools on the page does that. ` +
              'An action may have half-completed. Look at the page before running anything again.'
          },
          runOperation: operation
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
        operation.phase = 'stopped'
        operation.summary = 'Stopped after human takeover'
        operation.finishedAt = Date.now()
        operation.warning = takeoverMessage(takeover)
        entry.activity = { operation, control: 'human', warning: operation.warning }
        // 返回值照常带回去，与自愈那一支同理：程序如果吞掉拒绝、拿观察看清了页面再 return，
        // 那份东西正是这次运行**唯一**还有价值的产出。丢掉它就是在逼 Agent 再跑一遍——而"再跑
        // 一遍"恰恰是我们刚刚告诉它现在不要做的事。程序没跑完时 `run.value` 不存在，这里就是
        // undefined，与其它失败支一致。
        return {
          result: run.completed ? run.value : undefined,
          logs: run.logs,
          outcome: { kind: 'stopped', message: takeoverMessage(takeover) },
          runOperation: operation
        }
      }
      // 回放命中的目标是**按外观**认回来的，和 ref 自愈是同一件事，所以走同一个出口。
      //
      // 计划里存下来的身份只有 role+name+ordinal+count——快照本身就不含更稳的东西
      // （backendNodeId 随 CDP 会话消亡，见 browser-ref-ledger.ts）。
      //
      // **只有同名元素多于一个时才降级**，这条边界是承重的：`count === 1` 时那个总数判据恰恰
      // 证明了不存在第二个同名元素可以认错，此时它和按身份命中一样确定，报 `completed` 是诚实的。
      // 而 `count > 1` 时闸门挡不住一类很常见的页面变化：列表里多一行、少一行，总数仍是 3、
      // 序号仍是 2，闸门放行，点下去的却是**另一个** Delete。browser-ref-resolve.ts 刻意不做
      // role/name 回退，理由正是"它会静默改打一个同名元素，还照常报成功"——回放不能自己破那条规矩。
      //
      // 挡不住就不许装作挡住了：降级成 `indeterminate`（先看一眼页面，别盲目重试），返回值照带。
      // 反过来，把 `count === 1` 也一律降级，等于每一次回放都喊一声狼来了——那种警告会被学会忽略，
      // 于是真正该看的那一次也没人看（AGENTS.md:32-52 要的是可分辨，不是一律保守）。
      //
      // **判在 `run.completed` 分叉之前**，与上面接管那一支同理（见那段注释「两条路必须汇到同一个
      // 结局」）。写在 completed 臂里只能盖住「一路顺到底」的那次；而「按外观点下去了、后面某步
      // 才抛」的那次 `completed` 为 false，整份 notes 会被静默丢掉，收据报 `script-failed`——
      // 那句话对 Agent 的意思是"你代码写错了，改完重跑"，可此刻真实状态是**一个可能打在另一个
      // 同名元素上的破坏性动作已经执行了**。照着 script-failed 整段重跑，那个动作就再来一次，
      // 正是本文件反复点名的「下单点两次」。做没做成不确定，就得说不确定。
      if (replayOf && operation.steps.some((step) => step.target && step.target.count > 1)) {
        notes.push(
          'This run replayed recorded steps onto elements that share their role and name with ' +
            'others on the page. Replay re-finds those targets by name and position in a fresh ' +
            'snapshot — a match by appearance, not identity — so a page whose contents shifted can ' +
            'put the action on a different element of the same name. Look at the page before ' +
            'treating this as done.'
        )
      }
      if (run.completed) {
        // 自愈过就不是 `completed`。程序确实跑完了，但**它作用在什么上不确定**——role+name+nth
        // 能匹配到一个长得一样的邻居。这正是 `indeterminate` 的含义（先看一眼页面，别盲目重试），
        // 也是 `completed` 这一支承载不了的：它连一个放警告的字段都没有。返回值照常带回去——
        // 那是程序真算出来的东西，丢掉它只会逼 Agent 再跑一遍。
        if (notes.length > 0) {
          operation.phase = 'indeterminate'
          operation.summary = replayOf ? 'Replay completed by appearance match' : 'Completed with semantic ref healing'
          operation.finishedAt = Date.now()
          operation.warning = notes.join('\n')
          entry.activity = { operation, control: 'agent', warning: operation.warning }
          return {
            result: run.value,
            logs: run.logs,
            outcome: { kind: 'indeterminate', message: notes.join('\n') },
            runOperation: operation
          }
        }
        operation.phase = 'completed'
        operation.summary = 'Browser program completed'
        operation.finishedAt = Date.now()
        entry.activity = { operation, control: 'agent' }
        return { result: run.value, logs: run.logs, outcome: { kind: 'completed' }, runOperation: operation }
      }
      const outcome = browserRunOutcomeFromFailure(run.failure)
      // 结局四支 → phase 四支，**逐支对上**。原来写的是 `stopped ? stopped : failed`，于是
      // `indeterminate` 被折进 `failed`：同一次崩溃，Agent 收到的收据说"做到哪一步不知道，先看
      // 一眼页面别重试"，而人在历史里看到的是"失败了，改完重跑"——两个相反的结论。phase 枚举里
      // 本来就有 `indeterminate`，这不是缺词，是映射错了。崩溃恰恰意味着页面动作可能做了一半。
      //
      // 但**这一支自己算出来的结局还不够**：程序抛之前可能已经按外观点下去了（自愈、或回放打在
      // 同名元素上），那些告示就在 `notes` 里。一个"已经可能打错了对象"的运行报 `script-failed`
      // 等于叫 Agent 改代码整段重跑，而重跑会把那个动作再做一次。有告示就以 `indeterminate`
      // 收口，并且**把程序自己的失败原因一起带上**——那是排障的入口，不能被告示挤掉。
      if (notes.length > 0) {
        const failureReason = 'message' in outcome ? outcome.message : 'The Browser program failed.'
        operation.phase = 'indeterminate'
        operation.summary = replayOf ? 'Replay stopped after an appearance match' : 'Stopped after semantic ref healing'
        operation.finishedAt = Date.now()
        operation.warning = [...notes, failureReason].join('\n')
        entry.activity = { operation, control: 'agent', warning: operation.warning }
        return {
          result: undefined,
          logs: run.logs,
          outcome: { kind: 'indeterminate', message: operation.warning },
          runOperation: operation
        }
      }
      operation.phase = browserOperationPhaseFromOutcome(outcome.kind)
      operation.summary = 'message' in outcome ? outcome.message : 'Browser program failed'
      operation.finishedAt = Date.now()
      if ('message' in outcome) operation.warning = outcome.message
      entry.activity = { operation, control: 'agent', ...('message' in outcome ? { warning: outcome.message } : {}) }
      return { result: undefined, logs: run.logs, outcome, runOperation: operation }
    } finally {
      const cleanupWarning = session.detach()
      if (cleanupWarning) {
        operation.warning ??= cleanupWarning
        entry.activity = { ...entry.activity, warning: entry.activity.warning ?? cleanupWarning }
      }
      // 监听器跟着这一次运行走，不跟着 entry 走。挂在整个 entry 生命周期上的话，人平时正常
      // 用这个浏览器就一直在写 `takeover`，下一次 run 一启动就以为自己被接管了。
      contents.removeListener('input-event', onInput)
      entry.driving = false
      if (entry.activeRun?.operationId === operation.id) entry.activeRun = undefined
      entry.runInFlight = false
      if (this.operationJournal) {
        const finalPhase = operation.phase === 'completed' || operation.phase === 'failed' || operation.phase === 'indeterminate' || operation.phase === 'stopped'
          ? operation.phase
          : 'indeterminate'
        await this.operationJournal.finish(operation.id, finalPhase, {
          summary: operation.summary,
          ...(operation.warning ? { warning: operation.warning } : {})
        })
        const persistenceWarning = this.operationJournal.getPersistenceWarning()
        if (persistenceWarning) {
          operation.warning ??= persistenceWarning
          entry.activity = { ...entry.activity, warning: entry.activity.warning ?? persistenceWarning }
        }
      }
      this.emit(entry)
    }
  }

  async startDemonstration(id: string): Promise<BrowserDemonstrationState> {
    const entry = this.require(id)
    if (!this.demonstrations) throw new Error('Demonstration storage is unavailable. The Browser remains usable.')
    if (entry.runInFlight || entry.activeRun) throw new Error('Stop the active Browser operation before recording a human demonstration.')
    void this.releaseDemonstrationCapture()
    const view = entry.view
    const contents = view.webContents
    const current = {
      entry, view, contents,
      capture: new BrowserDemonstrationCapture({
        contents, browserId: id, recorder: this.demonstrations,
        getIdentity: () => ({ navigationId: entry.navigationId, url: contents.getURL() || entry.requestedUrl, title: contents.getTitle() }),
        onDraft: (draft, warning) => {
          if (this.demonstrationCapture !== current || !this.owns(entry, view) || contents.isDestroyed()) return
          this.publishDemonstration(entry, draft, warning)
          if (draft && draft.status !== 'recording') this.demonstrationCapture = null
        }
      })
    }
    this.demonstrationCapture = current
    try {
      const draft = await current.capture.start()
      if (this.demonstrationCapture !== current || !this.owns(entry, view) || contents.isDestroyed()) {
        throw new Error('Recording no longer owns this Browser. The current Browser operation remains available.')
      }
      if (entry.demonstration?.draft?.id !== draft.id) this.publishDemonstration(entry, draft)
      return structuredClone(entry.demonstration!)
    } catch (error) {
      if (this.demonstrationCapture === current) void this.releaseDemonstrationCapture(entry)
      throw error
    }
  }

  async stopDemonstration(id: string): Promise<BrowserDemonstrationState> {
    const entry = this.require(id)
    const view = entry.view
    if (!this.demonstrations) throw new Error('Demonstration storage is unavailable. The Browser remains usable.')
    const stopped = this.releaseDemonstrationCapture(entry)
    const draft = stopped ? await stopped : await this.demonstrations.stop(id)
    if (this.owns(entry, view) && this.demonstrationCapture?.entry !== entry) this.publishDemonstration(entry, draft)
    return structuredClone(entry.demonstration ?? { draft })
  }

  async getDemonstration(id: string): Promise<BrowserDemonstrationState> {
    const entry = this.require(id)
    const view = entry.view
    if (!this.demonstrations) return { draft: null, warning: 'Demonstration storage is unavailable. The Browser remains usable.' }
    const draft = await this.demonstrations.get(id)
    if (this.owns(entry, view) && this.demonstrationCapture?.entry !== entry) this.publishDemonstration(entry, draft)
    return structuredClone(entry.demonstration ?? { draft })
  }

  private publishDemonstration(entry: BrowserEntry, draft: BrowserDemonstrationDraft | null, warning?: string): void {
    if (draft && entry.demonstration?.draft?.id === draft.id && entry.demonstration.draft.revision > draft.revision) return
    const notice = warning ?? this.demonstrations?.getPersistenceWarning() ?? draft?.warning
    entry.demonstration = { draft, ...(notice ? { warning: notice } : {}) }
    this.emit(entry)
  }

  /** The native owner is released synchronously; saving the stopped draft completes in the background. */
  private releaseDemonstrationCapture(entry?: BrowserEntry): Promise<BrowserDemonstrationDraft | null> | null {
    const current = this.demonstrationCapture
    if (!current || (entry && current.entry !== entry)) return null
    this.demonstrationCapture = null
    if (!current.contents.isDestroyed() && current.entry.demonstration?.draft?.status === 'recording') {
      this.publishDemonstration(current.entry, { ...current.entry.demonstration.draft, status: 'stopped' })
    }
    return current.capture.stop().then(draft => {
      if (this.owns(current.entry, current.view) && !current.contents.isDestroyed() && this.demonstrationCapture?.entry !== current.entry) {
        this.publishDemonstration(current.entry, draft)
      }
      return draft
    }).catch(() => {
      if (this.owns(current.entry, current.view) && !current.contents.isDestroyed() && this.demonstrationCapture?.entry !== current.entry) {
        this.publishDemonstration(current.entry, current.entry.demonstration?.draft ?? null,
          'The demonstration stopped, but saving the draft could not be confirmed. The Browser remains usable; check local storage before recording again.')
      }
      return null
    })
  }

  async listOperationHistory(): Promise<BrowserOperation[]> {
    return this.operationJournal ? await this.operationJournal.list() : []
  }

  async runReplay(id: string, plan: BrowserReplayPlan, operator?: BrowserOperator): Promise<BrowserScriptRunReport> {
    if (plan.schema !== 'agentmux.browser-replay.v1' || !plan.operationId || !Array.isArray(plan.steps)) {
      throw new Error('Invalid Browser replay plan')
    }
    const blocked = plan.steps.find((step) => step.blockedReason)
    if (blocked?.blockedReason) {
      throw new Error(`Replay requires review before any action: ${blocked.blockedReason}`)
    }
    const script = buildReplayScript(plan)
    return await this.runScript(id, script, operator, plan.operationId)
  }

  /**
   * 按 operationId 停一个操作，**与它跑在哪个 Browser 上无关**。这是取消的唯一入口。
   *
   * 这里曾经还有一条 `stopOperation(id)`（按 browserId 停「这一页上正在跑的那个」），服务 UI 上的
   * 停止按钮。T-008 把那颗按钮收口到协议之后它没有调用方了，于是删掉——两条寻址落在同一个
   * `activeRun.stop` 上，留着第二条只是给「哪一条才是真的」留一个将来会漂移的问题。
   *
   * 三种答案都是成功，一个都不抛：
   *   - 还在飞 → 停下它，答出刚被改成 `stopped` 的那份事实。
   *   - 已经结束 → 幂等成功，答出它的既有终局。正常时序下取消总会撞上刚结束的操作（人按下停止的
   *     同一刻程序自己跑完了），把这个竞态报成失败等于让调用方分不出「我停晚了」和「出错了」。
   *   - 查不到 → `null`。RED-LINES 第 2 类：我们查不到 ≠ 这个 Browser 坏了。所以这条路**不碰任何
   *     entry 的状态**——尤其不清 activeRun，那会让一次查询失败变成一次真实的能力损失。
   */
  async stopOperationById(operationId: string): Promise<BrowserOperation | null> {
    for (const entry of this.entries.values()) {
      if (entry.activeRun?.operationId !== operationId) continue
      entry.activeRun.stop()
      // `stop()` 刚改的就是 `entry.activity.operation` 指的那个对象（runScript 里同一个引用），
      // 所以这里读到的是最新的一份，不必等 stop 里那条 fire-and-forget 的 journal 写落盘。
      const stopped = entry.activity.operation
      if (stopped?.id === operationId) return stopped
      break
    }
    // 不在飞：已结束或本就不认识。两者的答案都从 journal 来——不在这里维护第二份账。
    return await this.getOperation(operationId)
  }

  /**
   * 按 operationId 查一条操作。答案覆盖在跑、completed、stopped 与重启后被判为 indeterminate 四档，
   * 因为它读的就是 journal 本身（`ready()` 在重载时把活着的操作转成 indeterminate），不是第二份投影。
   *
   * journal 缺席或读坏了都属于流程状态，不是 Browser 坏了：答「查不到」，这个 Browser 照样能接新操作。
   * journal 本来就是 advisory 的。
   */
  async getOperation(operationId: string): Promise<BrowserOperation | null> {
    return this.operationJournal ? await this.operationJournal.get(operationId) : null
  }

  async getStepEvidence(operationId: string, sequence: number): Promise<BrowserStepEvidenceRead> {
    const operation = await this.getOperation(operationId)
    const step = operation?.steps.find(item => item.sequence === sequence)
    const result: BrowserStepEvidenceRead = { operationId, sequence, status: 'not-recorded', items: [] }
    if (!step) return { ...result, status: 'unavailable', warning: 'This operation step is no longer retained. Its page was not recaptured.' }
    if (step.evidenceWarning) result.warning = step.evidenceWarning
    if (!step.evidence?.length) return { ...result, ...(step.evidenceWarning ? { status: 'unavailable' as const } : {}) }
    for (const reference of step.evidence) {
      try {
        if (!this.stepEvidence || reference.operationId !== operationId || reference.sequence !== sequence ||
            reference.browserId !== operation?.browserId) throw new Error('Evidence identity is unavailable.')
        result.items.push(await this.stepEvidence.read(reference))
      } catch {
        result.warning = 'Some recorded evidence is unavailable or no longer retained. The step record remains; inspect the page before retrying an action.'
      }
    }
    result.status = result.items.length ? 'available' : 'unavailable'
    return result
  }

  returnControl(id: string): BrowserSnapshot {
    const entry = this.require(id)
    entry.humanControl = false
    if (entry.activity.operation) {
      const { warning: _warning, ...activity } = entry.activity
      entry.activity = { ...activity, control: 'agent' }
    }
    this.emit(entry)
    return this.snapshot(entry)
  }

  async replayPlan(operationId: string) {
    return this.operationJournal ? await this.operationJournal.replayPlan(operationId) : null
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
    takeover: BrowserTakeover,
    operation: BrowserOperation
  ): (name: string, args: unknown[]) => Promise<unknown> {
    let activeStep: BrowserOperationStep | null = null
    const waitingSteps = new Set<number>()
    let beforeWaiting: { phase: BrowserOperation['phase']; summary: string } | null = null
    const requireLive = (): WebContentsView => {
      const view = entry.view
      if (this.entries.get(entry.id) !== entry || view.webContents.isDestroyed()) {
        throw new Error(`Browser ${entry.id} went away while the script was running`)
      }
      return view
    }
    const dispatch = createBrowserPageDispatch({
      session,
      ...(this.resultArtifacts ? { resultArtifacts: {
        store: this.resultArtifacts, owner: { workspaceId: entry.workspaceId, browserId: entry.id }
      } } : {}),
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
      note: (text) => notes.push(text),
      recordTarget: (target) => {
        if (!activeStep) return
        activeStep.target = target
        if (activeStep.replay) {
          activeStep.replay.target = target
          if (activeStep.method === 'fillInput' || activeStep.method === 'typeText') {
            activeStep.replay.args = []
            activeStep.replay.inputKey = 'value'
            activeStep.replay.blockedReason = 'Sensitive input is requested again at replay time.'
          } else if (activeStep.method === 'js' || activeStep.method === 'cdp') {
            activeStep.replay.args = []
            activeStep.replay.blockedReason = 'Opaque page code or protocol input requires explicit review.'
          }
        }
      }
    })
    return async (name, args) => {
      requireLive()
      // 人接管之后，动作停、观察放行。拦在这里是因为这是主进程唯一的介入点——`runBrowserScript`
      // 不暴露 AbortSignal，程序跑在自己的子进程里；而每一次页面调用都要经过这道往返。
      if (takeover.at !== null && BROWSER_ACTION_PAGE_CALLS.has(name)) {
        throw new Error(takeoverMessage(takeover, name))
      }
      const step = startBrowserOperationStep(operation, name, args)
      activeStep = step
      this.emit(entry)
      if (this.operationJournal) {
        await this.operationJournal.startStep(operation.id, {
          method: step.method,
          label: step.label,
          ...(step.ref ? { ref: step.ref } : {}),
          ...(step.replay ? { replay: step.replay } : {})
        })
      }
      if (BROWSER_WAIT_PAGE_CALLS.has(name) && (operation.phase === 'running' || operation.phase === 'waiting')) {
        if (waitingSteps.size === 0) beforeWaiting = { phase: operation.phase, summary: operation.summary }
        waitingSteps.add(step.sequence)
        operation.phase = 'waiting'
        operation.summary = `Waiting: ${step.label}`
        void this.operationJournal?.setPhase(operation.id, 'waiting', { summary: operation.summary })
        this.emit(entry)
      }
      const saveEvidence = async (content: BrowserStepEvidenceContent, navigationId: string): Promise<void> => {
        if (!this.stepEvidence) return
        try {
          const reference = await recordBrowserStepEvidence(this.stepEvidence, {
            operationId: operation.id, sequence: step.sequence, browserId: entry.id, navigationId
          }, content)
          step.evidence = [...(step.evidence ?? []), reference]
        } catch {
          step.evidenceWarning = 'Step evidence could not be saved. The action result is retained; inspect the page and check local storage before recording again.'
          operation.warning ??= step.evidenceWarning
        }
      }
      try {
        const value = await dispatch(name, args)
        step.status = 'completed'
        step.finishedAt = Date.now()
        step.summary = summarizeBrowserValue(value)
        if (this.stepEvidence && name === 'snapshot') {
          const snapshot = value as BrowserPageSnapshot
          await saveEvidence(pageStepEvidence(snapshot), snapshot.navigationId)
        } else if (this.stepEvidence && name === 'captureScreenshot') {
          const capture = value as BrowserScreenshotCapture
          await saveEvidence(screenshotStepEvidence(capture), capture.navigationId)
        }
        if (this.operationJournal) await this.operationJournal.finishStep(operation.id, step.sequence, {
          status: 'completed',
          summary: step.summary,
          ...(step.evidence ? { evidence: step.evidence } : {}),
          ...(step.evidenceWarning ? { evidenceWarning: step.evidenceWarning } : {}),
          ...(step.target ? { target: step.target } : {}),
          ...(step.replay ? { replay: step.replay } : {})
        })
        this.emit(entry)
        return value
      } catch (error) {
        step.status = takeover.at !== null ? 'stopped' : 'failed'
        step.finishedAt = Date.now()
        step.summary = error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240)
        await saveEvidence({
          kind: 'diagnostic', code: 'page-call-failed',
          message: `Step ${step.sequence} (${name}) did not report completion. Side effects may already have occurred.`,
          nextAction: takeover.at !== null
            ? 'Human control is active. Wait for the user to return control before continuing.'
            : 'Inspect the page and take a fresh snapshot before deciding whether this action can be retried.'
        }, entry.navigationId)
        if (this.operationJournal) await this.operationJournal.finishStep(operation.id, step.sequence, {
          status: step.status,
          summary: step.summary,
          ...(step.evidence ? { evidence: step.evidence } : {}),
          ...(step.evidenceWarning ? { evidenceWarning: step.evidenceWarning } : {}),
          ...(step.target ? { target: step.target } : {}),
          ...(step.replay ? { replay: step.replay } : {})
        })
        this.emit(entry)
        throw error
      } finally {
        activeStep = null
        if (waitingSteps.delete(step.sequence) && waitingSteps.size === 0) {
          // Human takeover and Stop own the newer phase; finishing a wait must never overwrite them.
          if (operation.phase === 'waiting' && beforeWaiting) {
            operation.phase = beforeWaiting.phase
            operation.summary = beforeWaiting.summary
            void this.operationJournal?.setPhase(operation.id, operation.phase, { summary: operation.summary })
            this.emit(entry)
          }
          beforeWaiting = null
        }
      }
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
      void this.openExternalWithFeedback(entry, target)
    }))
  }

  private async openExternalWithFeedback(entry: BrowserEntry, target: string): Promise<void> {
    try {
      await this.appLinks.openExternal(target)
    } catch (error) {
      if (!this.owns(entry, entry.view)) return
      entry.error = `Could not open this link in another app: ${error instanceof Error ? error.message : String(error)}. Try again or choose another app.`
      this.emit(entry)
    }
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
      void this.openExternalWithFeedback(entry, target)
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

  /**
   * 页面首帧画出来之后，强制原生视图重绘一次它当前的、已可见的矩形。
   *
   * Electron 43 在 macOS 上有一个 `WebContentsView` 合成器 bug：视图在 renderer 挂载时就拿到
   * `setBounds`+`setVisible(true)`（那时页面还没画），首帧要等到 `did-finish-load` 才落地，而合成器
   * 一直显示挂载时那层空白，直到一次几何变化把它作废——于是"页面加载了却空白，resize 一下才出现"。
   * `webContents.invalidate()` 帮不上：它在 Electron 43 里只对 offscreen 渲染有效。
   *
   * 所以在首帧信号处把当前 bounds 原样重设一遍：`setBounds` 的调用本身就是让合成器作废旧层、
   * 重绘新内容的那次几何事件（值不必变，用户手动 resize 起作用也是同一个机制）。只有在视图确实
   * 已可见、且有一份真实矩形时才做——否则它还在被 `visible`/`released`/overlay 等分支正当地藏着，
   * 不能替那些分支把它显示出来。
   */
  private repaintAfterFirstFrame(entry: BrowserEntry, view: WebContentsView): void {
    if (!entry.visible || !entry.bounds) return
    view.setBounds(entry.bounds)
  }

  close(id: string): void {
    if (this.destroyOwner(id)) this.send({ type: 'closed', id })
  }

  /** Native teardown has no authority to retire the Renderer Region. */
  private destroyOwner(id: string): boolean {
    const entry = this.entries.get(id)
    if (!entry) return this.releasedEntries.delete(id)
    void this.releaseDemonstrationCapture(entry)
    this.cancelPendingSwitch(entry, new Error('Browser owner released during profile switch'))
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
    if (!this.window.isDestroyed()) {
      try { this.window.contentView.removeChildView(entry.view) } catch { /* already detached */ }
    }
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close()
    return true
  }

  dispose(): void {
    for (const id of [...this.entries.keys()]) this.destroyOwner(id)
    for (const id of [...this.releasedEntries.keys()]) this.destroyOwner(id)
  }

  private attach(entry: BrowserEntry, view: WebContentsView): void {
    const contents = view.webContents
    const guardNavigation = (event: { url: string; isMainFrame: boolean; preventDefault(): void }): void => {
      // 应用链接在闸门**之前**分流。闸门本身逐字不变：`customapp://` 装不进 WebContentsView，它要的不是
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
    // Chromium reports cross-origin child-frame src changes through this event;
    // An external app's device-authorize iframe uses exactly that path.
    contents.on('will-frame-navigate', guardNavigation)
    contents.on('will-redirect', guardNavigation)
    // 弹窗那条路。`649df3a2` 把整个 handler 删掉是为了保住原生 popup 语义，而缺席的代价是应用链接的
    // `window.open` 会真的开出一个装着 `customapp:` 的窗口，没人管。这里回装，但只截应用链接——回调体就是
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
      this.repaintAfterFirstFrame(entry, view)
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
      void this.releaseDemonstrationCapture(entry)
      this.cancelPendingSwitch(entry, new Error('Browser native owner was destroyed during profile switch'))
      if (this.entries.get(entry.id) !== entry || entry.view !== view) return
      this.entries.delete(entry.id)
      this.releasedEntries.set(entry.id, {
        id: entry.id, workspaceId: entry.workspaceId, profileId: entry.profileId, requestedUrl: entry.requestedUrl, viewport: entry.viewport
      })
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view)
      this.send({ type: 'unavailable', id: entry.id, error: 'Browser native page was destroyed. Retry to reopen this page.' })
    })
  }

  private require(id: string): BrowserEntry {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`Unknown browser: ${id}`)
    return entry
  }

  private assertWorkspaceBinding(bound: string | null, requested: string | null): void {
    // Unknown remains unknown; a recovery handshake never upgrades or replaces this owner's binding.
    if (bound !== null && requested !== null && bound !== requested) {
      throw new Error('This Browser belongs to another Workspace. Restore its original Workspace binding.')
    }
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
    const persistenceWarning = this.operationJournal?.getPersistenceWarning()
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
      ...(entry.demonstration ? { demonstration: entry.demonstration } : {}),
      appLinkPrompt: entry.appLinkPrompt,
      activity: persistenceWarning
        ? { ...entry.activity, warning: entry.activity.warning ?? persistenceWarning }
        : entry.activity
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
