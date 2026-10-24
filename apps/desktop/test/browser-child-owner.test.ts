import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const native = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  class Session extends EventEmitter {
    clearStorageData = vi.fn(async () => {})
    clearCache = vi.fn(async () => {})
    closeAllConnections = vi.fn(async () => {})
    setPermissionCheckHandler() {}
    setPermissionRequestHandler() {}
    setDevicePermissionHandler() {}
  }
  const sessions = new Map<string, Session>()
  const fromPartition = (partition: string) => {
    if (!sessions.has(partition)) sessions.set(partition, new Session())
    return sessions.get(partition)!
  }
  class Contents extends EventEmitter {
    url = ''; destroyed = false; vetoClose = false; vetoNavigation = false
    mainFrame = { url: '', processId: 1, frameToken: 'original-frame', parent: null, detached: false, isDestroyed: () => false, framesInSubtree: [] }
    navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    send = vi.fn()
    executeJavaScriptInIsolatedWorld = vi.fn(async () => true)
    debugger = { attach: vi.fn(() => { throw new Error('original-child-transport-observed') }) }
    windowOpenHandler: ((details: {url: string}) => any) | null = null
    constructor(readonly session = new Session()) { super() }
    setWindowOpenHandler(handler: (details: {url: string}) => any) { this.windowOpenHandler = handler }
    isDestroyed() { return this.destroyed }
    getURL() { return this.url }
    getTitle() { return 'Original native child' }
    isLoading() { return false }
    setZoomFactor() {}
    enableDeviceEmulation() {}
    disableDeviceEmulation() {}
    getLastWebPreferences() { return { session: this.session, sandbox: true, contextIsolation: true, nodeIntegration: false } }
    loadURL = vi.fn(async (url: string) => {
      if (this.vetoNavigation) { this.emit('will-prevent-unload', {}); throw new Error('Original navigation was vetoed') }
      this.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false })
      this.url = url; this.mainFrame.url = url
      this.emit('did-navigate', {}, url); this.emit('did-finish-load'); this.emit('did-stop-loading')
    })
    close = vi.fn((options?: { waitForBeforeUnload?: boolean }) => {
      if (this.destroyed) return
      if (options?.waitForBeforeUnload && this.vetoClose) { this.emit('will-prevent-unload', {}); return }
      this.destroyed = true; this.emit('destroyed')
    })
  }
  class View {
    readonly webContents: Contents
    visible = true; bounds = { x: 0, y: 0, width: 0, height: 0 }
    constructor(options: { webContents?: Contents; webPreferences?: { partition?: string; session?: Session } } = {}) {
      this.webContents = options.webContents ?? new Contents(options.webPreferences?.session ?? fromPartition(options.webPreferences?.partition ?? 'default'))
    }
    setVisible(visible: boolean) { this.visible = visible }
    getVisible() { return this.visible }
    setBounds(bounds: typeof this.bounds) { this.bounds = bounds }
    getBounds() { return this.bounds }
    setBorderRadius() {}
  }
  class Window extends EventEmitter {
    readonly webContents = new Contents()
    readonly children: View[] = []
    readonly contentView = { children: this.children,
      addChildView: (view: View, index = this.children.length) => { this.contentView.removeChildView(view); this.children.splice(index, 0, view) },
      removeChildView: (view: View) => { const at = this.children.indexOf(view); if (at >= 0) this.children.splice(at, 1) } }
    isDestroyed() { return false }
    getContentBounds() { return { x: 0, y: 0, width: 1024, height: 768 } }
  }
  return { Contents, View, Window, fromPartition }
})
vi.mock('electron', () => ({ WebContentsView: native.View, BrowserWindow: native.Window, session: { fromPartition: native.fromPartition } }))
const { BrowserViewManager } = await import('../src/main/browser-view-manager')
const { BrowserRefLedgerStore } = await import('../src/main/browser-ref-ledger-store')
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const settled = () => new Promise(resolve => setImmediate(resolve))

async function fixture(mode: 'normal' | 'private' = 'normal') {
  const directory = mkdtempSync(join(tmpdir(), 'agentmux-child-owner-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const window = new native.Window(), prompts: Array<{ window: unknown; resolve(value: boolean): void }> = []
  const manager = new BrowserViewManager(window as never, { defaultProfileId: () => 'normal', resolvePartition: () => 'persist:normal' },
    new BrowserRefLedgerStore(join(directory, 'refs.json')), { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: async () => {} },
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { confirmLeave: window => new Promise(resolve => prompts.push({ window, resolve })) })
  cleanups.push(() => manager.dispose())
  await manager.create('original-parent', 'https://parent.invalid/original', 'workspace', undefined, mode)
  const parent = window.children[0]!.webContents
  async function child(url = 'https://child.invalid/original') {
    const page = new native.Contents(parent.session); await page.loadURL(url)
    const before = new Set(manager.targets().map(target => target.id))
    const request = parent.windowOpenHandler!({ url })
    expect(request.action).toBe('allow')
    expect(request.createWindow({ webContents: page, webPreferences: { session: parent.session } })).toBe(page)
    const targets = manager.targets().filter(target => !before.has(target.id))
    expect(targets).toHaveLength(1)
    return { id: targets[0]!.id, page }
  }
  return { manager, window, parent, prompts, child }
}

describe('Native child pages use the ordinary Browser owner', () => {
  it('publishes the original child/source and routes standard run admission to its exact transport', async () => {
    const f = await fixture(), child = await f.child()
    const source = { browserId: 'original-parent', navigationId: f.manager.target('original-parent')!.navigationId }
    expect(f.manager.target(child.id)).toMatchObject({ id: child.id, url: child.page.url, openedFrom: source, status: 'ready' })
    expect(f.manager.setViewport(child.id, 'responsive').source).toEqual(source)
    await expect(f.manager.runScript(child.id, 'return 17')).rejects.toThrow('original-child-transport-observed')
    expect(child.page.debugger.attach).toHaveBeenCalledOnce()
    expect(f.parent.debugger.attach).not.toHaveBeenCalled()
    expect(f.manager.target(child.id)?.status).toBe('ready')
    expect(child.page.isDestroyed()).toBe(false)
  })

  it('one exact Close token shares its pending confirmation, Stay retains it, and a fresh Leave closes it', async () => {
    const f = await fixture(), child = await f.child(); child.page.vetoClose = true
    const first = Promise.resolve(f.manager.close(child.id)).then(() => 'closed', () => 'retained')
    const concurrent = Promise.resolve(f.manager.close(child.id)).then(() => 'closed', () => 'retained')
    await settled()
    expect(child.page.close).toHaveBeenCalledTimes(1)
    expect(f.prompts).toHaveLength(1); expect(f.prompts[0]!.window).toBe(f.window)
    f.prompts[0]!.resolve(false)
    expect(await first).toBe('retained'); expect(await concurrent).toBe('retained')
    expect(f.manager.target(child.id)?.status).toBe('ready'); expect(child.page.isDestroyed()).toBe(false)
    const next = Promise.resolve(f.manager.close(child.id))
    await settled(); expect(f.prompts).toHaveLength(2)
    f.prompts[1]!.resolve(true); await next
    expect(child.page.isDestroyed()).toBe(true); expect(f.manager.target(child.id)).toBeNull()
    expect(f.parent.isDestroyed()).toBe(false)
  })

  it('a navigation veto never becomes Close or requests a leave confirmation', async () => {
    const f = await fixture(), child = await f.child(); child.page.vetoNavigation = true
    await f.manager.navigate(child.id, 'https://child.invalid/next'); await settled()
    expect(child.page.loadURL).toHaveBeenLastCalledWith('https://child.invalid/next')
    expect(child.page.close).not.toHaveBeenCalled(); expect(f.prompts).toEqual([])
    expect(f.manager.target(child.id)).toMatchObject({ status: 'ready', url: 'https://child.invalid/original' })
    expect(child.page.isDestroyed()).toBe(false)
  })

  it('a late Leave answer for a changed document cannot close the later native document', async () => {
    const f = await fixture(), child = await f.child(); child.page.vetoClose = true
    const closing = Promise.resolve(f.manager.close(child.id)).then(() => 'closed', () => 'retained')
    await settled(); expect(f.prompts).toHaveLength(1)
    child.page.mainFrame = { ...child.page.mainFrame, frameToken: 'later-frame' }
    f.prompts[0]!.resolve(true)
    expect(await closing).toBe('retained')
    expect(child.page.close).toHaveBeenCalledTimes(1)
    expect(child.page.isDestroyed()).toBe(false); expect(f.manager.target(child.id)?.status).toBe('ready')
  })

  it('a missing native Close callback stays unknown and a later observation does not replay the request', async () => {
    const f = await fixture(), child = await f.child()
    child.page.close.mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      const first = Promise.resolve(f.manager.close(child.id)).then(() => '', error => String(error))
      await vi.advanceTimersByTimeAsync(1_000)
      const firstFailure = await first
      expect(firstFailure).toContain('is unconfirmed')
      expect(child.page.close).toHaveBeenCalledTimes(1)
      expect(f.manager.target(child.id)?.status).toBe('ready')
      expect(f.manager.setViewport(child.id, 'responsive').activity.warning).toContain('is unconfirmed')
      const again = Promise.resolve(f.manager.close(child.id)).then(() => '', error => String(error))
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await again).toBe(firstFailure)
      expect(child.page.close).toHaveBeenCalledTimes(1)
      const originalCompletion = Promise.resolve(f.manager.close(child.id))
      child.page.destroyed = true; child.page.emit('destroyed')
      await originalCompletion
      expect(f.manager.target(child.id)).toBeNull()
      expect(f.parent.isDestroyed()).toBe(false)
    } finally { vi.useRealTimers() }
  })

  it('a new document retires an unknown Close so a fresh explicit Close reaches the same page', async () => {
    const f = await fixture(), child = await f.child()
    const originalClose = child.page.close.getMockImplementation()!
    child.page.close.mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      const first = Promise.resolve(f.manager.close(child.id)).then(() => 'closed', () => 'unknown')
      await vi.advanceTimersByTimeAsync(1_000); expect(await first).toBe('unknown')
      await f.manager.navigate(child.id, 'https://child.invalid/new-document')
      expect(f.manager.target(child.id)?.url).toBe('https://child.invalid/new-document')
      child.page.close.mockImplementation(originalClose)
      const fresh = Promise.resolve(f.manager.close(child.id)).then(() => 'closed', () => 'unknown')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await fresh).toBe('closed')
      expect(child.page.close).toHaveBeenCalledTimes(2)
      expect(f.parent.isDestroyed()).toBe(false)
    } finally { vi.useRealTimers() }
  })

  it('a new navigation veto cannot consume an earlier unknown Close intent', async () => {
    const f = await fixture(), child = await f.child()
    child.page.close.mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      const first = Promise.resolve(f.manager.close(child.id)).catch(() => {})
      await vi.advanceTimersByTimeAsync(1_000); await first
      child.page.vetoNavigation = true
      await f.manager.navigate(child.id, 'https://child.invalid/vetoed')
      expect(f.prompts).toHaveLength(0)
      expect(child.page.close).toHaveBeenCalledTimes(1)
      expect(child.page.isDestroyed()).toBe(false)
    } finally { vi.useRealTimers() }
  })

  it('navigation supersedes an unanswered Close prompt and fences its late Leave', async () => {
    const f = await fixture(), child = await f.child(); child.page.vetoClose = true
    let result = 'pending'
    const closing = Promise.resolve(f.manager.close(child.id)).then(() => { result = 'closed' }, () => { result = 'retained' })
    await settled(); expect(f.prompts).toHaveLength(1)
    await f.manager.navigate(child.id, 'https://child.invalid/later-document'); await settled()
    expect(result).toBe('retained')
    f.prompts[0]!.resolve(true); await closing; await settled()
    expect(child.page.close).toHaveBeenCalledTimes(1)
    expect(child.page.isDestroyed()).toBe(false)
    expect(f.manager.target(child.id)?.url).toBe('https://child.invalid/later-document')
  })

  it('closing one private child preserves its shared parent Session; closing the root ends it', async () => {
    const f = await fixture('private'), first = await f.child(), sibling = await f.child('https://child.invalid/sibling')
    const websiteSession = f.parent.session
    expect(first.page.session).toBe(websiteSession); expect(sibling.page.session).toBe(websiteSession)
    await f.manager.close(first.id)
    expect(first.page.isDestroyed()).toBe(true)
    expect(f.parent.isDestroyed()).toBe(false); expect(sibling.page.isDestroyed()).toBe(false)
    expect(websiteSession.clearStorageData).not.toHaveBeenCalled()
    expect(websiteSession.clearCache).not.toHaveBeenCalled(); expect(websiteSession.closeAllConnections).not.toHaveBeenCalled()
    await f.manager.close('original-parent')
    expect(f.parent.isDestroyed()).toBe(true); expect(sibling.page.isDestroyed()).toBe(true)
    expect(websiteSession.clearStorageData).toHaveBeenCalledOnce()
    expect(websiteSession.clearCache).toHaveBeenCalledOnce(); expect(websiteSession.closeAllConnections).toHaveBeenCalledOnce()
  })
})
