import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Chromium's site zoom as Electron 43 behaves: one level per site in each Profile session, 100% where none is stored,
// and a page's zoomFactor preference stored for a site without one by Chromium's own commit observer, after did-navigate.
const native = vi.hoisted(() => {
  type Listener = (...args: any[]) => void
  const sessions = new Map<string, { zoom: Map<string, number> } & Record<string, unknown>>()
  const sessionFor = (partition: string) => {
    let session = sessions.get(partition)
    if (!session) sessions.set(partition, session = { zoom: new Map(), fetch: vi.fn(), on: vi.fn(), removeListener: vi.fn(),
      setDevicePermissionHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn() })
    return session
  }
  const site = (url: string) => { try { const parsed = new URL(url); return parsed.hostname || parsed.href.split('#')[0]! } catch { return url } }
  class Contents {
    url = ''; title = ''; loading = false; destroyed = false
    history: string[] = []; index = -1
    readonly mainFrame = { framesInSubtree: [{ osProcessId: 10, detached: false }] }
    readonly listeners = new Map<string, Listener[]>()
    readonly navigationHistory = {
      canGoBack: () => this.index > 0, canGoForward: () => this.index < this.history.length - 1,
      getAllEntries: () => this.history.map(url => ({ url, title: '' })), getActiveIndex: () => this.index
    }
    readonly executeJavaScript = vi.fn(async () => true)
    readonly executeJavaScriptInIsolatedWorld = vi.fn(async () => true)
    readonly setBackgroundThrottling = vi.fn()
    readonly enableDeviceEmulation = vi.fn()
    readonly disableDeviceEmulation = vi.fn()
    constructor(readonly session: ReturnType<typeof sessionFor>, readonly preferredZoom: number) {}
    getZoomFactor() { return this.session.zoom.get(site(this.url)) ?? 1 }
    setZoomFactor(value: number) { this.session.zoom.set(site(this.url), value) }
    getBackgroundThrottling() { return true }
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
      this.emit('did-navigate', url)
      if (this.preferredZoom !== 1 && !this.session.zoom.has(site(url))) this.session.zoom.set(site(url), this.preferredZoom)
      this.emit('dom-ready')
      this.emit('did-finish-load')
      this.loading = false
      this.emit('did-stop-loading')
    }
    async loadURL(url: string) {
      this.history = [...this.history.slice(0, this.index + 1), url]
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
    readonly webContents: Contents
    visible = true
    bounds = { x: 0, y: 0, width: 0, height: 0 }
    constructor(readonly options: { webPreferences?: { partition?: string; zoomFactor?: number } } = {}) {
      this.webContents = new Contents(sessionFor(options.webPreferences?.partition ?? ''), options.webPreferences?.zoomFactor ?? 1)
      View.instances.push(this)
    }
    setVisible(value: boolean) { this.visible = value }
    getVisible() { return this.visible }
    setBounds(value: typeof this.bounds) { this.bounds = value }
    getBounds() { return this.bounds }
  }
  return { View, sessions, fromPartition: vi.fn(sessionFor) }
})
vi.mock('electron', () => ({ WebContentsView: native.View, session: { fromPartition: native.fromPartition }, app: { getPath: () => tmpdir() } }))

import { BrowserViewManager, type BrowserProfileResolver } from '../src/main/browser-view-manager.js'
import { steppedBrowserZoom } from '../src/shared/browser-zoom.js'
import { BrowserRefLedgerStore } from '@agentmux/browser/browser-ref-ledger-store'
import type { BrowserEvent, BrowserSnapshot } from '../src/shared/contracts.js'

const profiles: BrowserProfileResolver = { defaultProfileId: () => 'personal', resolvePartition: id => `persist:browser-${id}` }
const roots: string[] = [], managers: BrowserViewManager[] = []
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  native.View.instances.length = 0
  native.sessions.clear()
})

function owner() {
  const directory = mkdtempSync(join(tmpdir(), 'amx-page-zoom-')); roots.push(directory)
  const send = vi.fn()
  const window = { getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }), isDestroyed: () => false,
    contentView: { addChildView() {}, removeChildView() {} }, webContents: { isDestroyed: () => false, send } }
  const manager = new BrowserViewManager(window as never, profiles, new BrowserRefLedgerStore(join(directory, 'ref-ledger.json')),
    { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: () => {} })
  managers.push(manager)
  const published = (id: string): BrowserSnapshot[] => send.mock.calls.map(([, event]) => event as BrowserEvent)
    .flatMap(event => event.type === 'updated' && event.browser.id === id ? [event.browser] : [])
  const contents = (url: string) => native.View.instances.filter(view => !view.webContents.destroyed && view.webContents.url === url).at(-1)!.webContents
  return { manager, send, published, latest: (id: string) => published(id).at(-1), contents }
}

/** Chromium's commit observer has run once the commit's own task has finished. */
const settled = () => new Promise(resolve => setImmediate(resolve))

describe('Browser page zoom per site and Profile', () => {
  it.each([0, 200])('[zoom-cost] reads only related native pages with %i unrelated pages', async unrelated => {
    const { manager, contents, published } = owner()
    await manager.create('source', 'https://shared.test/source', 'workspace', 'personal')
    await manager.create('peer', 'https://shared.test/peer', 'workspace', 'personal')
    for (let i = 0; i < unrelated; i++) await manager.create(`unrelated-${i}`, `https://unrelated-${i}.test/`, 'workspace', 'personal')
    await settled()
    const source = vi.spyOn(contents('https://shared.test/source'), 'getZoomFactor'), peer = vi.spyOn(contents('https://shared.test/peer'), 'getZoomFactor')
    const strangers = Array.from({ length: unrelated }, (_, i) => vi.spyOn(contents(`https://unrelated-${i}.test/`), 'getZoomFactor'))
    manager.zoom('source', 'in')
    if (process.env.AGENTMUX_ZOOM_COST_RECEIPT) appendFileSync(process.env.AGENTMUX_ZOOM_COST_RECEIPT, JSON.stringify({ unrelated, sourceReads: source.mock.calls.length, peerReads: peer.mock.calls.length, unrelatedReads: strangers.reduce((n, read) => n + read.mock.calls.length, 0) }) + '\n')
    expect(source).toHaveBeenCalledTimes(2); expect(peer).toHaveBeenCalledTimes(1)
    expect(strangers.reduce((n, read) => n + read.mock.calls.length, 0)).toBe(0)
    expect(published('peer').at(-1)?.zoomFactor).toBe(1)
  })

  it('[zoom-cost] follows native host scope across ports and protocols, and full hostless URLs without fragments', async () => {
    const { manager, latest, contents } = owner()
    const pages = { a: 'http://shared.test:8000/a', b: 'https://shared.test:9000/b', blank: 'about:blank', fragment: 'about:blank' }
    for (const [id, url] of Object.entries(pages)) await manager.create(id, url, 'workspace', 'personal')
    // A same-document native commit is observed on the already admitted blank page.
    contents('about:blank').commit('about:blank#part')
    await settled()
    manager.zoom('a', 'in'); expect(latest('b')?.zoomFactor).toBe(1)
    manager.zoom('blank', 'in'); expect(latest('fragment')?.zoomFactor).toBe(1)
  })

  it('[zoom-cost] moves a navigated page to its real scope and removes old native views on Profile replacement and close', async () => {
    const { manager, contents, latest } = owner()
    await manager.create('a', 'https://shared.test/a', 'workspace', 'personal')
    await manager.create('b', 'https://shared.test/b', 'workspace', 'personal')
    await manager.create('work', 'https://shared.test/work', 'workspace', 'work')
    await settled()
    const old = contents('https://shared.test/b')
    await manager.navigate('b', 'https://other.test/b'); await settled()
    const otherRead = vi.spyOn(old, 'getZoomFactor')
    manager.zoom('a', 'in'); expect(otherRead).not.toHaveBeenCalled()
    await manager.navigate('b', 'https://shared.test/b'); await settled()
    await manager.switchProfile('b', 'work'); await settled()
    const switched = contents('https://shared.test/b'), switchedRead = vi.spyOn(switched, 'getZoomFactor')
    otherRead.mockClear(); manager.zoom('a', 'in')
    expect(otherRead).not.toHaveBeenCalled(); expect(switchedRead).not.toHaveBeenCalled()
    manager.zoom('work', 'out'); expect(latest('b')?.zoomFactor).toBe(0.8)
    await manager.close('b'); switchedRead.mockClear()
    manager.zoom('work', 'reset'); expect(switchedRead).not.toHaveBeenCalled()
    await manager.close('a'); await manager.close('work')
    expect(Reflect.get(manager, 'zoomScopes').size).toBe(0)
  })

  it('steps through the common preset levels and returns to the product default', () => {
    expect([steppedBrowserZoom(0.9, 'in'), steppedBrowserZoom(1, 'in'), steppedBrowserZoom(0.9, 'out')]).toEqual([1, 1.1, 0.8])
    expect([steppedBrowserZoom(1.1, 'reset'), steppedBrowserZoom(3, 'reset')]).toEqual([0.9, 0.9])
    // Chromium reports a preset through its zoom level, a few ulps either side of the preset factor.
    expect([steppedBrowserZoom(0.8999999999999999, 'in'), steppedBrowserZoom(0.9000000000000001, 'out')]).toEqual([1, 0.8])
    expect([steppedBrowserZoom(0.95, 'in'), steppedBrowserZoom(0.95, 'out')]).toEqual([1, 0.9])
    expect([steppedBrowserZoom(5, 'in'), steppedBrowserZoom(0.25, 'out')]).toEqual([5, 0.25])
  })

  it('opens pages at the default and keeps a person\'s site zoom through navigation, load, reload and a new page', async () => {
    const { manager, latest, contents } = owner()
    await manager.create('page', 'https://site.test/one', 'workspace', 'personal')
    expect(native.View.instances[0]!.options.webPreferences).toMatchObject({ zoomFactor: 0.9 })
    await settled()
    expect(latest('page')?.zoomFactor).toBe(0.9)
    expect(manager.zoom('page', 'in').zoomFactor).toBe(1)
    expect(manager.zoom('page', 'in').zoomFactor).toBe(1.1)
    expect(latest('page')?.zoomFactor).toBe(1.1)

    await manager.navigate('page', 'https://site.test/two'); await settled()
    contents('https://site.test/two').reload(); await settled()
    expect(contents('https://site.test/two').getZoomFactor()).toBe(1.1)
    await manager.create('other', 'https://site.test/three', 'workspace', 'personal'); await settled()
    expect([latest('page')?.zoomFactor, latest('other')?.zoomFactor]).toEqual([1.1, 1.1])

    expect(manager.zoom('other', 'reset').zoomFactor).toBe(0.9)
    expect(latest('page')?.zoomFactor).toBe(0.9)
    expect(manager.zoom('page', 'out').zoomFactor).toBe(0.8)
    expect(() => manager.zoom('page', 'sideways' as never)).toThrow('Unknown Browser zoom step')
  })

  it('refits and republishes the same site in the same Profile and leaves another site and Profile alone', async () => {
    const { manager, send, published, contents } = owner()
    const pages = { a: 'https://site.test/a', b: 'https://site.test/b', c: 'https://other.test/c', d: 'https://site.test/d' }
    for (const [id, url] of Object.entries(pages)) await manager.create(id, url, 'workspace', id === 'd' ? 'work' : 'personal', 'normal', 'desktop')
    await settled()
    for (const url of Object.values(pages)) contents(url).enableDeviceEmulation.mockClear()
    send.mockClear()

    manager.zoom('a', 'in')
    for (const id of ['a', 'b'] as const) {
      expect(contents(pages[id]).enableDeviceEmulation).toHaveBeenLastCalledWith(expect.objectContaining({ viewSize: { width: 1280, height: 800 } }))
      expect(published(id).map(page => page.zoomFactor)).toEqual([1])
    }
    for (const id of ['c', 'd'] as const) {
      expect(contents(pages[id]).enableDeviceEmulation).not.toHaveBeenCalled()
      expect(published(id)).toEqual([])
      expect(contents(pages[id]).getZoomFactor()).toBe(0.9)
    }
  })

  it('publishes the zoom Chromium applies after a commit, never the 100% it reads before', async () => {
    const { manager, send, published } = owner()
    await manager.create('page', 'https://site.test/a', 'workspace', 'personal'); await settled()
    manager.zoom('page', 'in'); manager.zoom('page', 'in')
    send.mockClear()

    await manager.navigate('page', 'https://fresh.test/'); await settled()
    const zooms = published('page').map(page => page.zoomFactor)
    expect(zooms).not.toContain(1)
    expect(zooms.at(-1)).toBe(0.9)
  })

  it('switches Profile to the target Profile\'s own zoom for the site and keeps each Profile\'s', async () => {
    const { manager } = owner()
    await manager.create('page', 'https://site.test/a', 'workspace', 'personal'); await settled()
    for (let step = 0; step < 3; step++) manager.zoom('page', 'in')
    expect((await manager.switchProfile('page', 'work')).zoomFactor).toBe(0.9)
    expect(manager.zoom('page', 'out').zoomFactor).toBe(0.8)
    expect((await manager.switchProfile('page', 'personal')).zoomFactor).toBe(1.25)
    expect((await manager.switchProfile('page', 'work')).zoomFactor).toBe(0.8)
  })
})
