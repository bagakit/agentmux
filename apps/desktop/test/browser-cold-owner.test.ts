const { fixtureFileUrl: _hygiene_fixtureFileUrl, fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { browserColdDescriptor, coldBrowserTargets } from '../src/main/browser-cold-descriptor.js'
import { parseBrowserTargetsResult } from '../../../packages/core/src/control-browser-targets.js'
import type { AgentMuxBrowserTarget } from '@agentmux/core'
import type { AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserPresentationEvent, BrowserPresentationOccurrence } from '../src/shared/contracts.js'

// Main resource tests isolate Electron transport; they do not claim Native pixels or physical input.
const native = vi.hoisted(() => {
  class Session {
    display: ((request: any, callback: (streams: any) => void) => void) | null = null
    setDisplayMediaRequestHandler = vi.fn((handler: ((request: any, callback: (streams: any) => void) => void) | null) => { this.display = handler })
    setPermissionCheckHandler = vi.fn()
    setPermissionRequestHandler = vi.fn()
    setDevicePermissionHandler = vi.fn()
    on = vi.fn()
    removeListener = vi.fn()
  }
  class Contents {
    readonly session = new Session()
    url = _hygiene_fixtureFileUrl("app/renderer/index.html")
    dead = false
    readonly mainFrame = { url: this.url, detached: false, parent: null }
    readonly listeners = new Map<string, Set<(...args: any[]) => void>>()
    readonly navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    send = vi.fn()
    focus = vi.fn()
    setWindowOpenHandler = vi.fn()
    zoom = 0.9
    getZoomFactor = () => this.zoom
    sendInputEvent = vi.fn((input: any) => { this.emit('input-event', {}, input) })
    setZoomFactor = vi.fn()
    disableDeviceEmulation = vi.fn()
    enableDeviceEmulation = vi.fn()
    getBackgroundThrottling = () => true
    setBackgroundThrottling = vi.fn()
    executeJavaScriptInIsolatedWorld = vi.fn(async () => true)
    getURL = () => this.url
    getTitle = () => 'Original Browser'
    isLoading = () => false
    isLoadingMainFrame = () => false
    isDestroyed = () => this.dead
    on(event: string, listener: (...args: any[]) => void) {
      const set = this.listeners.get(event) ?? new Set()
      set.add(listener); this.listeners.set(event, set); return this
    }
    once(event: string, listener: (...args: any[]) => void) {
      const wrapped = (...args: any[]) => { this.removeListener(event, wrapped); listener(...args) }
      return this.on(event, wrapped)
    }
    removeListener(event: string, listener: (...args: any[]) => void) { this.listeners.get(event)?.delete(listener) }
    emit(event: string, ...args: any[]) { for (const listener of this.listeners.get(event) ?? []) listener(...args) }
    readonly loads: string[] = []
    async loadURL(url: string) {
      this.loads.push(url)
      this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url })
      this.url = url; this.mainFrame.url = url
      this.emit('did-finish-load'); this.emit('did-stop-loading')
    }
    reload() { void this.loadURL(this.url) }
    close() { this.dead = true; this.emit('destroyed') }
  }
  class View {
    readonly webContents = new Contents()
    visible = false
    bounds = { x: 0, y: 0, width: 0, height: 0 }
    setVisible(value: boolean) { this.visible = value }
    getVisible() { return this.visible }
    setBounds(value: typeof this.bounds) { this.bounds = { ...value } }
    getBounds() { return this.bounds }
  }
  const shells: BaseWindow[] = []
  class BaseWindow {
    readonly views: View[] = []
    readonly contentView = {
      children: this.views,
      addChildView: (view: View) => { this.views.push(view) },
      removeChildView: (view: View) => { const index = this.views.indexOf(view); if (index !== -1) this.views.splice(index, 1) }
    }
    dead = false
    constructor(readonly options: Record<string, unknown>) { shells.push(this) }
    isDestroyed = () => this.dead
    destroy = vi.fn(() => { this.dead = true })
  }
  return { Session, Contents, View, BaseWindow, shells }
})
vi.mock('electron', () => ({ BaseWindow: native.BaseWindow, WebContentsView: native.View, app: { getPath: () => _hygiene_fixturePath("unused-private-ledger") } }))
import { BrowserViewManager } from '../src/main/browser-view-manager.js'
import { BrowserRefLedgerStore } from '../src/main/browser-ref-ledger-store.js'
import { browserOperationAlreadyExistsError } from '../src/main/browser-operation-journal.js'
import { browserRunResult, unwrapBrowserRunResult } from '../src/shared/browser-run-result.js'

const managers: BrowserViewManager[] = [], roots: string[] = []
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function savedGraph(count = 2): AgentMuxSpatialGraph {
  return { spaces: [], zones: [], bindings: [], locations: [], layouts: {}, tabLayouts: {},
    tabs: Array.from({ length: count }, (_, i) => ({ tabId: 'tab-' + i, regionIds: ['region-' + i] })),
    regions: Array.from({ length: count }, (_, i) => ({ tabId: 'tab-' + i, regionId: 'region-' + i, kind: 'browser', browserId: 'page-' + i })),
    resources: Object.fromEntries(Array.from({ length: count }, (_, i) => ['region:region-' + i, {
      browserId: 'page-' + i, workspaceId: 'workspace', url: 'https://fixture.invalid/page-' + i,
      title: 'Original page ' + i, profileId: 'saved-profile', viewport: 'mobile'
    }])) } as unknown as AgentMuxSpatialGraph
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'browser-cold-owner-')); roots.push(directory)
  const app = new native.Contents(), views: InstanceType<typeof native.View>[] = []
  const window = { webContents: app, isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), contentView: {
    children: views, addChildView(view: InstanceType<typeof native.View>, index = views.length) {
      const previous = views.indexOf(view); if (previous !== -1) views.splice(previous, 1)
      views.splice(index, 0, view)
    }, removeChildView(view: InstanceType<typeof native.View>) { const index = views.indexOf(view); if (index !== -1) views.splice(index, 1) }
  } }
  const partition = vi.fn((profile: string) => 'persist:' + profile)
  const manager = new BrowserViewManager(window as never, { defaultProfileId: () => 'default', resolvePartition: partition },
    new BrowserRefLedgerStore(directory), { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal() {} })
  managers.push(manager)
  return { manager, views, partition }
}

// Execute the production IPC function bytes with explicit Electron/API ports, not a copy of its logic.
const ipcSource = readFileSync(process.env.AGENTMUX_COLD_IPC_SOURCE ?? new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
function ipcFunction(name: string, ports: Record<string, unknown>) {
  const file = ts.createSourceFile('ipc.ts', ipcSource, ts.ScriptTarget.Latest, true)
  const found: ts.Node[] = []
  function walk(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name && node.initializer) found.push(node.initializer)
    if (ts.isCallExpression(node) && ['handleWithEvent', 'handle'].includes(node.expression.getText(file)) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === name) found.push(node.arguments[1]!)
    ts.forEachChild(node, walk)
  }
  walk(file); expect(found).toHaveLength(1)
  const code = ts.transpile(`const execute = ${found[0]!.getText(file)}`, { target: ts.ScriptTarget.ES2022 })
  return new Function(...Object.keys(ports), code + ';return execute')(...Object.values(ports))
}
function mainPorts(manager: BrowserViewManager, graph = savedGraph()) {
  const spatialState = { read: vi.fn(async () => ({ graph })) }
  const browserProfiles = { initialize: vi.fn(async () => {}) }
  const config = { workspaces: [{ id: 'workspace' }], browser: { agentAutomation: true } }
  const ensureBrowser = ipcFunction('ensureBrowser', { browsers: manager, browserColdDescriptor, spatialState, browserProfiles, config,
    workspace: (_config: unknown, id: string) => { if (id !== 'workspace') throw new Error('Wrong workspace') } })
  return { spatialState, browserProfiles, config, ensureBrowser }
}

describe('cold Browser ownership through the original Main owner', () => {
  it('discovers thirty original cold identities through the public target handler without a native page or fictitious navigation', async () => {
    const { manager, views } = fixture(), ports = mainPorts(manager, savedGraph(30))
    const list = ipcFunction('browser:listTargets', { ...ports, requireTrustedSender: vi.fn(), workspace: vi.fn(),
      browsers: manager, externalBridge: { list: () => [] }, coldBrowserTargets })
    const { targets }: { targets: AgentMuxBrowserTarget[] } = await list({})
    expect(views).toHaveLength(0); expect(targets).toHaveLength(30)
    expect(targets.every(target => target.status === 'unavailable' && target.navigationId === undefined && target.capabilities.length === 0)).toBe(true)
    expect(parseBrowserTargetsResult({ targets }).targets).toEqual(targets)
    expect(() => parseBrowserTargetsResult({ targets: [{ ...targets[0], status: 'ready' }] })).toThrow('navigation')
    expect(() => parseBrowserTargetsResult({ targets: [{ ...targets[0], navigationId: '' }] })).toThrow()
  })
  it('keeps healthy live discovery usable when saved cold metadata cannot be observed', async () => {
    const { manager, views } = fixture(), ports = mainPorts(manager, savedGraph(30))
    await manager.create('live-page', 'https://fixture.invalid/live', 'workspace', 'original')
    ports.spatialState.read.mockRejectedValueOnce(new Error('Saved source temporarily unavailable'))
    const list = ipcFunction('browser:listTargets', { ...ports, requireTrustedSender: vi.fn(), workspace: vi.fn(),
      browsers: manager, externalBridge: { list: () => [] }, coldBrowserTargets })
    const before = manager.targets()
    const result = await list({})
    expect(result.targets).toEqual(before); expect(result.warning).toContain('unconfirmed')
    expect(views).toHaveLength(1); expect(views[0]!.webContents.loads).toEqual(['https://fixture.invalid/live'])
    expect(views[0]!.webContents.dead).toBe(false)
  })
  it('reads retained operation and history through their original IPC consumers without acquiring a cold page', async () => {
    const { manager, views } = fixture(), ports = mainPorts(manager)
    const get = ipcFunction('browser:getOperation', { ...ports, requireTrustedSender: vi.fn(), browsers: manager })
    const history = ipcFunction('browser:listOperationHistory', { ...ports, requireTrustedSender: vi.fn(), browsers: manager })
    expect(await get({}, 'unobserved-original-operation')).toBeNull()
    expect(await history({})).toEqual([])
    expect(ports.spatialState.read).not.toHaveBeenCalled(); expect(ports.browserProfiles.initialize).not.toHaveBeenCalled()
    expect(views).toHaveLength(0)
  })
  it('uses the exact Region resource, profile and saved viewport; missing historical viewport stays absent', () => {
    const graph = savedGraph(), resource = graph.resources['region:region-0'] as Record<string, any>
    expect(browserColdDescriptor(graph, 'page-0')).toMatchObject({ id: 'page-0', profileId: 'saved-profile', viewport: 'mobile' })
    delete resource.viewport; expect(browserColdDescriptor(graph, 'page-0')).not.toHaveProperty('viewport')
    resource.mode = 'private'; expect(browserColdDescriptor(graph, 'page-0')).toMatchObject({ mode: 'private', url: 'about:blank', title: 'Private page' })
    expect(browserColdDescriptor(graph, 'page-0')).not.toHaveProperty('profileId')
    expect(() => browserColdDescriptor(graph, 'region-0')).toThrow('exact saved Browser')
    graph.regions.push({ ...graph.regions[0]! }); expect(() => browserColdDescriptor(graph, 'page-0')).toThrow('ambiguous')
  })
  it('owns custom cold viewport dimensions and keeps absent or invalid saved values unconfirmed', () => {
    const graph = savedGraph(), resource = graph.resources['region:region-0'] as Record<string, unknown>
    const viewport = { width: 640, height: 480, screenPosition: 'desktop' }
    resource.viewport = viewport
    expect(() => browserColdDescriptor(graph, 'page-0')).not.toThrow()
    const saved = browserColdDescriptor(graph, 'page-0')
    expect(saved.viewport).toEqual(viewport)
    expect(saved.viewport).not.toBe(viewport)
    expect(Object.isFrozen(saved.viewport)).toBe(true)
    viewport.width = 320
    expect(saved.viewport).toMatchObject({ width: 640, height: 480, screenPosition: 'desktop' })
    delete resource.viewport
    expect(browserColdDescriptor(graph, 'page-0')).not.toHaveProperty('viewport')
    resource.viewport = { width: 0, height: 480, screenPosition: 'desktop' }
    expect(() => browserColdDescriptor(graph, 'page-0')).toThrow('descriptor is incomplete')
  })
  it('fresh creation accepts the shared custom viewport contract without a second preset gate', async () => {
    const { manager, views } = fixture()
    const viewport = { width: 640, height: 480, screenPosition: 'desktop' as const }
    await expect(manager.create('custom', 'https://fixture.invalid/custom', 'workspace', 'original', 'normal', viewport))
      .resolves.toMatchObject({ id: 'custom', viewport })
    viewport.width = 320
    const confirmed = await manager.create('custom', 'https://fixture.invalid/custom', 'workspace', 'original', 'normal', viewport)
    expect(confirmed.viewport).toEqual({ width: 640, height: 480, screenPosition: 'desktop' })
    expect(views).toHaveLength(1)
  })
  it('shares one real native owner for concurrent visible and public acquisition without a pending registry', async () => {
    const { manager, views, partition } = fixture(), ports = mainPorts(manager)
    const snapshots = await Promise.all([ports.ensureBrowser('page-0'), ports.ensureBrowser('page-0'), ports.ensureBrowser('page-0')])
    expect(views).toHaveLength(1); expect(views[0]!.webContents.loads).toEqual(['https://fixture.invalid/page-0'])
    expect(partition).toHaveBeenCalledWith('saved-profile')
    expect(snapshots.every(value => value.navigationId === snapshots[0].navigationId && value.viewport === 'mobile')).toBe(true)
    manager.setBounds('page-0', { x: 0, y: 0, width: 600, height: 400 })
    expect(views[0]!.webContents.enableDeviceEmulation).toHaveBeenCalled()
  })
  it('returns a healthy original page before Core/profile observation and never reloads or closes its state', async () => {
    const { manager, views } = fixture(), original = await manager.create('page-0', 'https://fixture.invalid/live', 'workspace', 'original')
    const contents = views[0]!.webContents
    Object.assign(contents, { formDraft: 'Unsent original form', selection: [2, 9], scrollY: 178 })
    const unavailable = vi.fn(async () => { throw new Error('Core unavailable') })
    const current = await manager.ensure('page-0', unavailable)
    expect(unavailable).not.toHaveBeenCalled(); expect(current.navigationId).toBe(original.navigationId)
    expect(contents.loads).toEqual(['https://fixture.invalid/live']); expect(contents.dead).toBe(false)
    expect(contents).toMatchObject({ formDraft: 'Unsent original form', selection: [2, 9], scrollY: 178 })
    expect(contents.focus).not.toHaveBeenCalled()
    expect(coldBrowserTargets(savedGraph(), manager.targets()).map(row => row.id)).toEqual(['page-1'])
  })
  it('restores a released owner from its Main URL/profile/viewport rather than a stale cold description', async () => {
    const { manager, views } = fixture()
    await manager.create('page-0', 'https://fixture.invalid/original', 'workspace', 'original', 'normal', 'desktop')
    await manager.navigate('page-0', 'https://fixture.invalid/later'); await manager.release('page-0')
    const cold = vi.fn(async () => browserColdDescriptor(savedGraph(), 'page-0'))
    const restored = await manager.ensure('page-0', cold)
    expect(cold).not.toHaveBeenCalled(); expect(views).toHaveLength(1)
    expect(restored).toMatchObject({ id: 'page-0', url: 'https://fixture.invalid/later', profileId: 'original', viewport: 'desktop' })
  })
  it('keeps a concurrently acquired healthy owner when an older cold observation fails or returns stale data', async () => {
    const { manager, views } = fixture()
    let reject!: (error: Error) => void
    const waiting = manager.ensure('page-0', () => new Promise((_resolve, no) => { reject = no }))
    const original = await manager.create('page-0', 'https://fixture.invalid/actual', 'workspace', 'original')
    reject(new Error('Former Core observation failed'))
    expect((await waiting).navigationId).toBe(original.navigationId)
    let resolve!: (value: ReturnType<typeof browserColdDescriptor>) => void
    const stale = manager.ensure('page-1', () => new Promise(yes => { resolve = yes }))
    const other = await manager.create('page-1', 'https://fixture.invalid/other', 'workspace', 'original')
    resolve({ ...browserColdDescriptor(savedGraph(), 'page-1'), id: 'foreign' })
    expect((await stale).navigationId).toBe(other.navigationId); expect(views).toHaveLength(2)
    expect(views[0]!.webContents.loads).toEqual(['https://fixture.invalid/actual'])
  })
  it('keeps a failed cold recovery retryable and rejects a removed exact target before creation', async () => {
    const { manager, views } = fixture(), graph = savedGraph(), ports = mainPorts(manager, graph)
    ports.browserProfiles.initialize.mockRejectedValueOnce(new Error('Profile unavailable'))
    await expect(ports.ensureBrowser('page-0')).rejects.toThrow('Profile unavailable'); expect(views).toHaveLength(0)
    await ports.ensureBrowser('page-0'); expect(views).toHaveLength(1)
    ports.browserProfiles.initialize.mockImplementationOnce(async () => { graph.regions = graph.regions.filter(row => row.browserId !== 'page-1') })
    await expect(ports.ensureBrowser('page-1')).rejects.toThrow('exact saved Browser'); expect(views).toHaveLength(1)
  })
  it('admits the real public run handler before acquisition, then runs the same cold Browser without focus', async () => {
    const { manager, views } = fixture(), ports = mainPorts(manager)
    const run = vi.spyOn(manager, 'runScript').mockResolvedValue({ result: 'actual-page-result', outcome: { kind: 'completed' } } as never)
    const external = { has: vi.fn(() => false), runScript: vi.fn() }, trust = vi.fn()
    const mainHandler = ipcFunction('browser:runScript', { ...ports, requireTrustedSender: trust, externalBrowsers: external,
      externalBridge: { require: vi.fn(() => ({ workspaceId: 'workspace' })) }, workspace: vi.fn(), browsers: manager,
      browserRunResult, browserOperationAlreadyExistsError })
    // The Main carrier is plain data. Consume the production Renderer decoder before asserting
    // the Desktop result contract. Native qualification must exercise api.ts itself.
    const handle = async (...args: unknown[]) => unwrapBrowserRunResult(await mainHandler(...args))
    ports.config.browser.agentAutomation = false
    await expect(handle({}, 'page-1', 'return 1', undefined, 'original-operation')).rejects.toMatchObject({ code: 'BROWSER_AUTOMATION_DISABLED' })
    expect(views).toHaveLength(0); expect(ports.spatialState.read).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled()
    ports.config.browser.agentAutomation = true
    expect(await handle({}, 'page-1', 'return 1', undefined, 'original-operation')).toMatchObject({ result: 'actual-page-result' })
    expect(views).toHaveLength(1); expect(run).toHaveBeenCalledExactlyOnceWith('page-1', 'return 1', undefined, undefined, 'original-operation')
    expect(views[0]!.webContents.focus).not.toHaveBeenCalled()
    external.has.mockReturnValue(true); external.runScript.mockResolvedValueOnce({ result: 'external-result' })
    await handle({}, 'external-page', 'return 2'); expect(views).toHaveLength(1); expect(external.runScript).toHaveBeenCalledOnce()
  })
})
