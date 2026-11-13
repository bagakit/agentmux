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
      setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn() }
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
    emit(event: string, ...args: any[]) { for (const listener of this.listeners.get(event) ?? []) listener({}, ...args) }
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
import { BrowserRefLedgerStore } from '../src/main/browser-ref-ledger-store.js'
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

function owner(directory = mkdtempSync(join(tmpdir(), 'amx-page-continuity-'))) {
  if (!roots.includes(directory)) roots.push(directory)
  const store = new BrowserRecoveryPreviewStore(join(directory, 'previews')); stores.push(store)
  const window = { getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }), isDestroyed: () => false,
    contentView: { addChildView() {}, removeChildView() {} }, webContents: { isDestroyed: () => false, send() {} } }
  const manager = new BrowserViewManager(window as never, profiles, new BrowserRefLedgerStore(join(directory, 'ref-ledger.json')),
    { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: () => {} },
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, store)
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
