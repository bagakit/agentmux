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
import { runBrowserScript } from './browser-script-runner.js'
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
    private readonly profiles: BrowserProfileResolver
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
      error: null
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
    try {
      const run = await runBrowserScript({ code, onPageCall: this.pageCallHandler(entry, session) })
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
      if (run.completed) {
        return { result: run.value, logs: run.logs, outcome: { kind: 'completed' } }
      }
      return { result: undefined, logs: run.logs, outcome: browserRunOutcomeFromFailure(run.failure) }
    } finally {
      session.detach()
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
    session: BrowserCdpSession
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
      captureScreenshot: async () => await this.captureScreenshot(entry.id)
    })
    return async (name, args) => {
      requireLive()
      return await dispatch(name, args)
    }
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
    contents.on('did-finish-load', () => {
      if (!this.owns(entry, view)) return
      contents.setZoomFactor(DEFAULT_BROWSER_ZOOM_FACTOR)
      this.applyViewport(entry, view)
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
      error: entry.error
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
