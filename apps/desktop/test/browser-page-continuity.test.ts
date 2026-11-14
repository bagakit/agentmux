import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Main lifecycle only: the native back/forward list behaves like Chromium's; no pixels or input are claimed.
const native = vi.hoisted(() => {
  type Listener = (...args: any[]) => void
  type Entry = { url: string; title: string; pageState?: string }
  class Contents {
    url = ''; title = ''; loading = false; destroyed = false
    history: Entry[] = []; index = -1
    readonly loads: string[] = []
    readonly restores: { entries: Entry[]; index?: number }[] = []
    readonly mainFrame = { framesInSubtree: [{ osProcessId: 10, detached: false }] }
    readonly session = { fetch: vi.fn(), on: vi.fn(), removeListener: vi.fn(), setDevicePermissionHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(), clearStorageData: vi.fn(async () => {}),
      clearCache: vi.fn(async () => {}), closeAllConnections: vi.fn(async () => {}) }
    readonly listeners = new Map<string, Listener[]>()
    readonly navigationHistory = {
      canGoBack: () => this.index > 0,
      canGoForward: () => this.index < this.history.length - 1,
      goBack: () => { this.index -= 1; this.commit(this.history[this.index]!.url) },
      goForward: () => { this.index += 1; this.commit(this.history[this.index]!.url) },
      getAllEntries: () => this.history.map(entry => ({ ...entry })),
      getActiveIndex: () => this.index,
      restore: async (options: { entries: Entry[]; index?: number }) => {
        this.restores.push(structuredClone(options))
        this.history = options.entries.map(({ url, title }) => ({ url, title }))
        this.index = options.index ?? options.entries.length - 1
        this.commit(this.history[this.index]!.url)
      }
    }
    readonly executeJavaScript = vi.fn(async () => true)
    readonly executeJavaScriptInIsolatedWorld = vi.fn(async () => true)
    readonly setBackgroundThrottling = vi.fn()
    readonly enableDeviceEmulation = vi.fn()
    readonly disableDeviceEmulation = vi.fn()
    zoomFactor = 1
    getBackgroundThrottling() { return true }
    setZoomFactor(value: number) { this.zoomFactor = value }
    getZoomFactor() { return this.zoomFactor }
    setWindowOpenHandler() {}
    getLastWebPreferences() { return {} }
    on(event: string, listener: Listener) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); return this }
    prependListener(event: string, listener: Listener) { this.listeners.set(event, [listener, ...(this.listeners.get(event) ?? [])]); return this }
    once(event: string, listener: Listener) {
      const wrapped: Listener = (...args) => { this.removeListener(event, wrapped); listener(...args) }
      return this.on(event, wrapped)
    }
    removeListener(event: string, listener: Listener) { this.listeners.set(event, (this.listeners.get(event) ?? []).filter(item => item !== listener)); return this }
    emit(event: string, ...args: any[]) {
      // Electron's title event always carries the observed title; retain that native port in this double.
      if (event === 'page-title-updated' && !args.length) args.push(this.title)
      for (const listener of this.listeners.get(event) ?? []) listener({}, ...args)
    }
    commit(url: string) {
      this.loading = true
      for (const listener of this.listeners.get('did-start-navigation') ?? []) listener({ url, isSameDocument: false, isMainFrame: true })
      this.emit('did-start-loading')
      this.url = url
      this.title = `Title of ${new URL(url).pathname}`
      this.history[this.index] = { ...this.history[this.index]!, title: this.title }
      this.emit('did-navigate', url)
      this.emit('did-finish-load')
      this.loading = false
      this.emit('did-stop-loading')
    }
    async loadURL(url: string) {
      this.loads.push(url)
      this.history = [...this.history.slice(0, this.index + 1), { url, title: '' }]
      this.index = this.history.length - 1
      this.commit(url)
    }
    getURL() { return this.url }
    getTitle() { return this.title }
    isLoading() { return this.loading }
    isDestroyed() { return this.destroyed }
    isBeingCaptured() { return false }
    isCurrentlyAudible() { return false }
    reload() { this.commit(this.url) }
    close() { this.destroyed = true; this.emit('destroyed') }
  }
  class View {
    static instances: View[] = []
    readonly webContents = new Contents()
    visible = true
    bounds = { x: 0, y: 0, width: 0, height: 0 }
    constructor() { View.instances.push(this) }
    setVisible(value: boolean) { this.visible = value }
    getVisible() { return this.visible }
    setBounds(value: typeof this.bounds) { this.bounds = value }
    getBounds() { return this.bounds }
  }
  const fromPartition = vi.fn(() => new Contents().session)
  return { View, fromPartition }
})
vi.mock('electron', () => ({ WebContentsView: native.View, session: { fromPartition: native.fromPartition }, app: { getPath: () => tmpdir() } }))

import { BROWSER_PAGE_MEMORY_SETTLE_MS, BrowserViewManager, type BrowserProfileResolver } from '../src/main/browser-view-manager.js'
import { BrowserRecoveryPreviewStore } from '../src/main/browser-recovery-preview.js'
import { BrowserInputHistoryStore } from '../src/main/browser-input-history.js'
import { BrowserRefLedgerStore } from '@agentmux/browser/browser-ref-ledger-store'
import type { BrowserColdDescriptor } from '../src/main/browser-cold-descriptor.js'

const profiles: BrowserProfileResolver = { defaultProfileId: () => 'personal', resolvePartition: id => `persist:browser-${id}` }
const roots: string[] = [], managers: BrowserViewManager[] = [], stores: BrowserRecoveryPreviewStore[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const manager of managers.splice(0)) manager.dispose()
  for (const store of stores.splice(0)) await store.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  native.View.instances.length = 0
})

function owner(directory = mkdtempSync(join(tmpdir(), 'amx-page-continuity-')), withRecovery = true) {
  if (!roots.includes(directory)) roots.push(directory)
  const store = new BrowserRecoveryPreviewStore(join(directory, 'previews')); stores.push(store)
  const window = { getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }), isDestroyed: () => false,
    contentView: { addChildView() {}, removeChildView() {} }, webContents: { isDestroyed: () => false, send() {} } }
  const manager = new BrowserViewManager(window as never, profiles, new BrowserRefLedgerStore(join(directory, 'ref-ledger.json')),
    { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: () => {} },
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, withRecovery ? store : undefined)
  managers.push(manager)
  return { directory, store, manager, contents: () => native.View.instances.at(-1)!.webContents }
}
const scope = { browserId: 'page', workspaceId: 'workspace', mode: 'normal' as const, profileId: 'personal' }
const cold = (url: string): BrowserColdDescriptor => ({ id: 'page', workspaceId: 'workspace', url, title: 'Saved', mode: 'normal', profileId: 'personal', viewport: 'responsive' })

async function visitTwoPagesAndGoBack(manager: BrowserViewManager) {
  await manager.create('page', 'https://pages.invalid/one', 'workspace', 'personal')
  await manager.navigate('page', 'https://pages.invalid/two')
  await manager.back('page')
}

describe('Browser page continuity across release and cold start', () => {
  it('[page-appearance] a real later save clears only its own warning and an older failure cannot reinstate it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const f = owner(undefined, false), history = new BrowserInputHistoryStore(join(f.directory, 'inputs'))
    const scope = { workspaceId: 'workspace', profileId: 'AbCdEfGh1234' }, url = 'https://pages.invalid/one'
    await history.record(scope, url)
    const decorate = vi.spyOn(history, 'decorate').mockRejectedValueOnce(new Error('Original appearance storage unavailable'))
    f.manager.onPageAppearance = (actual, requested, appearance) => history.decorate(actual, requested, appearance)
    await f.manager.create('page', url, scope.workspaceId, scope.profileId)
    const entry = Reflect.get(f.manager, 'entries').get('page')
    entry.activity.warning = 'An unrelated original warning'
    vi.advanceTimersByTime(BROWSER_PAGE_MEMORY_SETTLE_MS)
    await vi.waitFor(async () => expect((await f.manager.create('page', 'about:blank')).activity?.warning).toContain('Recent-page details could not be saved'))
    f.manager.refreshInputHistoryAppearance('page', scope.profileId); await history.flush()
    await vi.waitFor(async () => expect((await f.manager.create('page', 'about:blank')).activity?.warning).toBe('An unrelated original warning'))
    let rejectOlder!: (error: Error) => void
    const older = new Promise<import('../src/shared/browser-input-history.js').BrowserInputHistorySnapshot>((_resolve, reject) => { rejectOlder = reject })
    decorate.mockReturnValueOnce(older)
    f.manager.refreshInputHistoryAppearance('page', scope.profileId)
    f.manager.refreshInputHistoryAppearance('page', scope.profileId); await history.flush()
    rejectOlder(new Error('Earlier attempt failed after the latest save'))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect((await f.manager.create('page', 'about:blank')).activity?.warning).toBe('An unrelated original warning')
    expect((await history.list(scope)).entries[0]!.appearance?.title).toBe('Title of /one')
  })

  it('[page-appearance] the actual native resource Profile stays separate from the default and identical observations coalesce', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const f = owner(undefined, false), history = new BrowserInputHistoryStore(join(f.directory, 'inputs'))
    const scope = { workspaceId: 'workspace', profileId: 'AbCdEfGh1234' }, other = { ...scope, profileId: 'ZyXwVuTs9876' }, url = 'https://pages.invalid/one'
    await history.record(scope, url); await history.record(other, url)
    const defaultProfile = vi.spyOn(profiles, 'defaultProfileId').mockReturnValue(other.profileId), decorate = vi.spyOn(history, 'decorate')
    try {
      f.manager.onPageAppearance = (actual, requested, appearance) => history.decorate(actual, requested, appearance)
      await f.manager.create('page', url, scope.workspaceId, scope.profileId)
      vi.advanceTimersByTime(BROWSER_PAGE_MEMORY_SETTLE_MS); await history.flush()
      expect((await history.list(scope)).entries[0]!.appearance).toEqual({ url, title: 'Title of /one' })
      expect((await history.list(other)).entries[0]!.appearance).toBeUndefined()
      f.contents().emit('page-title-updated', 'Title of /one'); f.contents().emit('page-title-updated', 'Title of /one')
      vi.advanceTimersByTime(BROWSER_PAGE_MEMORY_SETTLE_MS); await history.flush()
      expect(decorate).toHaveBeenCalledOnce()
    } finally { defaultProfile.mockRestore() }
  })

  it('[page-appearance] a committed slow document uses explicit native title/favicon before full load and Close', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const f = owner(undefined, false), history = new BrowserInputHistoryStore(join(f.directory, 'inputs'))
    const scope = { workspaceId: 'workspace', profileId: 'AbCdEfGh1234' }, url = 'https://slow.invalid/document'
    await history.record(scope, url)
    f.manager.onPageAppearance = (actual, requested, appearance) => history.decorate(actual, requested, appearance)
    await f.manager.create('page', 'about:blank', scope.workspaceId, scope.profileId)
    const contents = f.contents()
    for (const listener of contents.listeners.get('did-start-navigation') ?? []) listener({ url, isSameDocument: false, isMainFrame: true })
    contents.url = url; contents.title = 'Old getter title'; contents.loading = true
    contents.emit('did-navigate', url)
    contents.emit('page-title-updated', 'Confirmed slow document')
    contents.session.fetch.mockResolvedValue(new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }))
    contents.emit('page-favicon-updated', ['https://slow.invalid/icon.svg'])
    await vi.waitFor(async () => expect((await f.manager.create('page', 'about:blank')).faviconDataUrl).toMatch(/^data:image\/svg\+xml;base64,/))
    expect(contents.loading).toBe(true)
    await f.manager.close('page'); await history.flush()
    expect((await history.list(scope)).entries[0]!.appearance).toEqual({ url, title: 'Confirmed slow document', faviconDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' })
  })

  it('[page-appearance] original native observations persist real title/icon before one-second Close without a recovery store', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const f = owner(undefined, false), history = new BrowserInputHistoryStore(join(f.directory, 'inputs'))
    const scope = { workspaceId: 'workspace', profileId: 'AbCdEfGh1234' }, url = 'https://pages.invalid/one'
    await history.record(scope, url)
    f.manager.onPageAppearance = (actual, requested, appearance) => history.decorate(actual, requested, appearance)
    await f.manager.create('page', url, scope.workspaceId, scope.profileId)
    f.contents().session.fetch.mockResolvedValue(new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }))
    f.contents().emit('page-favicon-updated', ['https://pages.invalid/icon.svg'])
    await vi.waitFor(async () => expect((await f.manager.create('page', 'about:blank')).faviconDataUrl).toMatch(/^data:image\/svg\+xml;base64,/))
    expect((await history.list(scope)).entries[0]!.appearance).toBeUndefined()
    await f.manager.close('page'); await history.flush()
    expect((await new BrowserInputHistoryStore(join(f.directory, 'inputs')).list(scope)).entries[0]!.appearance).toEqual({
      url, title: 'Title of /one', faviconDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' })
  })

  it('[page-appearance] original committed redirect facts match the input, while failed/pending navigation cannot borrow the old title', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const f = owner(undefined, false), history = new BrowserInputHistoryStore(join(f.directory, 'inputs'))
    const scope = { workspaceId: 'workspace', profileId: 'AbCdEfGh1234' }, input = 'https://input.invalid/start', final = 'https://document.invalid/final'
    await history.record(scope, input); await history.record(scope, 'https://failed.invalid/target')
    f.manager.onPageAppearance = (actual, requested, appearance) => history.decorate(actual, requested, appearance)
    await f.manager.create('page', 'about:blank', scope.workspaceId, scope.profileId)
    const contents = f.contents()
    for (const listener of contents.listeners.get('did-start-navigation') ?? []) listener({ url: input, isSameDocument: false, isMainFrame: true })
    contents.url = final; contents.title = 'Actual redirected document'; contents.emit('did-navigate', final); contents.emit('did-stop-loading')
    vi.advanceTimersByTime(BROWSER_PAGE_MEMORY_SETTLE_MS); await history.flush()
    expect((await history.list(scope)).entries.find(row => row.text === input)!.appearance).toEqual({ url: final, title: 'Actual redirected document' })
    for (const listener of contents.listeners.get('did-start-navigation') ?? []) listener({ url: 'https://failed.invalid/target', isSameDocument: false, isMainFrame: true })
    contents.emit('page-title-updated'); vi.advanceTimersByTime(BROWSER_PAGE_MEMORY_SETTLE_MS)
    contents.emit('did-fail-load', -105, 'Resolution failed', 'https://failed.invalid/target', true)
    contents.emit('did-stop-loading'); vi.advanceTimersByTime(BROWSER_PAGE_MEMORY_SETTLE_MS); await history.flush()
    expect((await history.list(scope)).entries.find(row => row.text === 'https://failed.invalid/target')!.appearance).toBeUndefined()
  })

  it('[page-appearance] a confirmed observation survives departure and dispose, while private/native visits add no records', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const f = owner(undefined, false), history = new BrowserInputHistoryStore(join(f.directory, 'inputs'))
    const scope = { workspaceId: 'workspace', profileId: 'AbCdEfGh1234' }, first = 'https://pages.invalid/one', second = 'https://pages.invalid/two'
    await history.record(scope, first); await history.record(scope, second)
    const decorate = vi.spyOn(history, 'decorate')
    f.manager.onPageAppearance = (actual, requested, appearance) => history.decorate(actual, requested, appearance)
    await f.manager.create('page', first, scope.workspaceId, scope.profileId)
    await f.manager.navigate('page', second)
    f.manager.dispose(); managers.splice(managers.indexOf(f.manager), 1); await history.flush()
    expect((await new BrowserInputHistoryStore(join(f.directory, 'inputs')).list(scope)).entries.map(row => row.appearance?.title)).toEqual(['Title of /two', 'Title of /one'])
    expect(decorate).toHaveBeenCalledTimes(2)
    const p = owner(undefined, false)
    p.manager.onPageAppearance = (actual, requested, appearance) => history.decorate(actual, requested, appearance)
    await p.manager.create('private', first, scope.workspaceId, undefined, 'private')
    vi.advanceTimersByTime(BROWSER_PAGE_MEMORY_SETTLE_MS); await history.flush()
    expect(decorate).toHaveBeenCalledTimes(2)
  })

  it('rebuilds back/forward entries and in-process page state after an idle release', async () => {
    const { manager, contents } = owner()
    await visitTwoPagesAndGoBack(manager)
    const original = contents()
    original.history[0]!.pageState = 'scroll-and-form-state'
    const navigationId = manager.target('page')!.navigationId!
    expect(await manager.release('page', navigationId)).toMatchObject({ status: 'released' })
    const restored = await manager.restore('page')
    const reopened = contents()
    expect(reopened).not.toBe(original)
    expect(reopened.loads).toEqual([])
    expect(reopened.restores).toEqual([{ index: 0, entries: [
      { url: 'https://pages.invalid/one', title: 'Title of /one', pageState: 'scroll-and-form-state' },
      { url: 'https://pages.invalid/two', title: 'Title of /two' }
    ] }])
    expect(restored.url).toBe('https://pages.invalid/one')
    expect(manager.target('page')).toMatchObject({ url: 'https://pages.invalid/one' })
    expect(reopened.navigationHistory.canGoForward()).toBe(true)
  })

  it('records commits and titles as one coalesced page memory without Chromium page state', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { store, manager, contents } = owner()
    const record = vi.spyOn(store, 'recordPage')
    await visitTwoPagesAndGoBack(manager)
    contents().history[0]!.pageState = 'scroll-and-form-state'
    expect(record).not.toHaveBeenCalled()
    vi.advanceTimersByTime(BROWSER_PAGE_MEMORY_SETTLE_MS)
    expect(record).toHaveBeenCalledOnce()
    vi.useRealTimers(); await store.flush()
    expect(await store.readPage(scope)).toEqual({ status: 'available', memory: { scope, url: 'https://pages.invalid/one', history: { index: 0, entries: [
      { url: 'https://pages.invalid/one', title: 'Title of /one' }, { url: 'https://pages.invalid/two', title: 'Title of /two' }
    ] } } })
  })

  it('remembers the icon with another address of the page that keeps it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { store, manager, contents } = owner()
    await manager.create('page', 'https://pages.invalid/one', 'workspace', 'personal')
    contents().session.fetch.mockImplementation(async () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }))
    contents().emit('page-favicon-updated', ['https://pages.invalid/icon.svg'])
    await manager.navigate('page', 'https://pages.invalid/two')
    await vi.waitFor(() => expect(contents().session.fetch).toHaveBeenCalledTimes(2))
    await vi.waitFor(async () => expect((await manager.create('page', 'about:blank')).faviconDataUrl).toMatch(/^data:image\/svg\+xml;base64,/))
    vi.advanceTimersByTime(BROWSER_PAGE_MEMORY_SETTLE_MS)
    vi.useRealTimers(); await store.flush()
    expect(await store.readPage(scope)).toMatchObject({ status: 'available', memory: { url: 'https://pages.invalid/two',
      favicon: { dataUrl: expect.stringMatching(/^data:image\/svg\+xml;base64,/) } } })
  })

  it('reopens remembered entries on cold start only while they still describe the saved address', async () => {
    const first = owner()
    await visitTwoPagesAndGoBack(first.manager)
    expect(await first.manager.release('page', first.manager.target('page')!.navigationId!)).toMatchObject({ status: 'released' })
    await first.store.flush()
    first.manager.dispose(); managers.splice(managers.indexOf(first.manager), 1)

    const restarted = owner(first.directory)
    await restarted.manager.ensure('page', async () => cold('https://pages.invalid/one'))
    expect(restarted.contents().loads).toEqual([])
    expect(restarted.contents().restores).toEqual([{ index: 0, entries: [
      { url: 'https://pages.invalid/one', title: 'Title of /one' }, { url: 'https://pages.invalid/two', title: 'Title of /two' }
    ] }])

    const moved = owner(first.directory)
    await moved.manager.ensure('page', async () => cold('https://pages.invalid/elsewhere'))
    expect(moved.contents().restores).toEqual([])
    expect(moved.contents().loads).toEqual(['https://pages.invalid/elsewhere'])
  })

  it('loads the saved address instead of restoring a remembered list with a non-Browser entry', async () => {
    const { directory, store } = owner()
    await store.recordPage(scope, { scope, url: 'https://pages.invalid/one', history: { index: 1, entries: [
      { url: 'javascript:alert(1)', title: 'Injected' }, { url: 'https://pages.invalid/one', title: 'One' }
    ] } }, () => true)
    const restarted = owner(directory)
    await restarted.manager.ensure('page', async () => cold('https://pages.invalid/one'))
    expect(restarted.contents().restores).toEqual([])
    expect(restarted.contents().loads).toEqual(['https://pages.invalid/one'])
  })

  it('drops the page memory with the Browser close', async () => {
    const { directory, store, manager } = owner()
    await visitTwoPagesAndGoBack(manager)
    await manager.release('page', manager.target('page')!.navigationId!)
    await store.flush()
    expect(await store.readPage(scope)).toMatchObject({ status: 'available' })
    await manager.close('page')
    await store.flush()
    expect(await store.readPage(scope)).toEqual({ status: 'missing' })
    expect(readdirSync(join(directory, 'previews'), { recursive: true }).filter(name => String(name).endsWith('.page.json'))).toEqual([])
  })
})
