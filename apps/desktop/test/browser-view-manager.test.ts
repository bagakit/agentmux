const { fixtureFileUrl: _reshape_fixtureFileUrl } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
const { fixtureFileUrl: _hygiene_fixtureFileUrl, fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserRecoveryPreviewStore } from '../src/main/browser-recovery-preview.js'

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

function release(manager: BrowserViewManager, id: string) {
  return manager.release(id, manager.targets().find(target => target.id === id)?.navigationId ?? 'missing-source')
}

const fakeElectron = vi.hoisted(() => {
  type Listener = (...args: any[]) => void

  class FakeWebContents {
    url = ''
    title = ''
    loading = false
    destroyed = false
    mainFrame = { framesInSubtree: [{ osProcessId: 10, detached: false }] }
    zoomFactor = 1
    backgroundThrottling = true
    readonly getBackgroundThrottling = vi.fn(() => this.backgroundThrottling)
    readonly setBackgroundThrottling = vi.fn((value: boolean) => { this.backgroundThrottling = value })
    deviceEmulation: Record<string, unknown> | null = null
    readonly disableDeviceEmulation = vi.fn(() => { this.deviceEmulation = null })
    readonly enableDeviceEmulation = vi.fn((parameters: Record<string, unknown>) => {
      this.deviceEmulation = parameters
    })
    readonly executeJavaScript = vi.fn(async (_code: string) => true)
    readonly openDevTools = vi.fn()
    executeJavaScriptInIsolatedWorldImpl = async (_worldId: number, scripts: Array<{ code: string }>): Promise<unknown> =>
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
      fetch: vi.fn<typeof fetch>(),
      on: vi.fn(), removeListener: vi.fn(),
      checkHandler: null as null | ((...args: any[]) => boolean),
      requestHandler: null as null | ((...args: any[]) => void),
      setDevicePermissionHandler: vi.fn(),
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

    prependListener(event: string, listener: Listener) {
      this.listeners.set(event, [listener, ...(this.listeners.get(event) ?? [])])
      return this
    }

    getLastWebPreferences() { return {} }

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
      this.emit('did-finish-load')
      this.loading = false
      this.emit('did-stop-loading')
    }

    async loadURL(url: string) { await this.loadURLImpl(url) }

    getURL() { return this.url }
    getTitle() { return this.title }
    isLoading() { return this.loading }
    isDestroyed() { return this.destroyed }
    isBeingCaptured() { return false }
    isCurrentlyAudible() { return false }
    reload() {
      this.loading = true
      this.emitDetails('did-start-navigation', { url: this.url, isSameDocument: false, isMainFrame: true })
      this.emit('did-start-loading')
      this.zoomFactor = 1
      this.emit('did-finish-load')
      this.loading = false
      this.emit('did-stop-loading')
    }
    close() { this.destroyed = true; this.emit('destroyed') }
  }

  class FakeWebContentsView {
    static instances: FakeWebContentsView[] = []
    static nextLoadURLImpl: null | ((contents: FakeWebContents, url: string) => Promise<void>) = null
    readonly webContents: FakeWebContents
    readonly partition: string | undefined
    // 整份 webPreferences 都留着，不只挑 partition 出来。沙箱开关（contextIsolation/sandbox/
    // nodeIntegration）是这个内嵌浏览器唯一挡住"任意 URL 的页面拿到 Node 能力"的东西，而这个 fake
    // 此前只读 partition、把另外三个字段直接丢掉——于是把三个开关**各自**翻反，24 条测试照旧全绿。
    // 丢掉的字段等于没人守的字段，所以这里存整份，让下面那条断言够得着。
    readonly webPreferences: Record<string, unknown> | undefined
    visible = true
    bounds = { x: 0, y: 0, width: 0, height: 0 }
    // Keep every native geometry write so lifecycle synchronization cannot hide extra layout work.
    boundsHistory: Array<{ x: number; y: number; width: number; height: number }> = []

    constructor(options?: { webContents?: FakeWebContents; webPreferences?: Record<string, unknown> }) {
      this.webContents = options?.webContents ?? new FakeWebContents()
      FakeWebContentsView.instances.push(this)
      this.webPreferences = options?.webPreferences
      this.partition = options?.webPreferences?.partition as string | undefined
      if (this.partition?.startsWith('agentmux-browser-private:')) Object.assign(this.webContents, { session: fromPartition(this.partition) })
      const nextLoadURLImpl = FakeWebContentsView.nextLoadURLImpl
      FakeWebContentsView.nextLoadURLImpl = null
      if (nextLoadURLImpl) {
        this.webContents.loadURLImpl = async (url) => await nextLoadURLImpl(this.webContents, url)
      }
    }

    setVisible(value: boolean) { this.visible = value }
    getVisible() { return this.visible }
    setBounds(value: typeof this.bounds) { this.bounds = value; this.boundsHistory.push({ ...value }) }
    getBounds() { return this.bounds }
  }

  const privateSessions = new Map<string, FakeWebContents['session'] & { clearStorageData: ReturnType<typeof vi.fn>; clearCache: ReturnType<typeof vi.fn>; closeAllConnections: ReturnType<typeof vi.fn> }>()
  const fromPartition = vi.fn((partition: string) => {
    let value = privateSessions.get(partition)
    if (!value) {
      value = Object.assign(new FakeWebContents().session, { clearStorageData: vi.fn(async () => {}), clearCache: vi.fn(async () => {}), closeAllConnections: vi.fn(async () => {}) })
      privateSessions.set(partition, value)
    }
    return value
  })
  return { FakeWebContentsView, fromPartition }
})

// `app` 只为 BrowserRefLedgerStore 的默认路径参数而在：本文件每次都显式给路径，所以它不会被读到。
// 不给的话，那条 import 在 mock 的命名空间里取不到名字。
vi.mock('electron', () => ({
  WebContentsView: fakeElectron.FakeWebContentsView,
  session: { fromPartition: fakeElectron.fromPartition },
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
import { BROWSER_EVENT_CHANNEL, BROWSER_PRESENTATION_EVENT_CHANNEL, type BrowserEvent, type BrowserPresentationEvent } from '../src/shared/contracts.js'
import type { BrowserAgentAuthority } from '../src/main/browser-agent-authority.js'
import type { BrowserControlHandoff } from '../src/shared/contracts.js'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import ts from 'typescript'

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

const privateLedgerRoots: string[] = []
afterEach(() => { for (const path of privateLedgerRoots.splice(0)) rmSync(path, { recursive: true, force: true }) })

function browserManager(window: ReturnType<typeof fakeWindow>['window'], recoveryPreviews?: BrowserRecoveryPreviewStore, agents?: BrowserAgentAuthority): BrowserViewManager {
  // ref 账本指向一个临时路径：本文件判的是 view 生命周期，不判持久化。给真路径会让这些用例
  // 往用户的 userData 里写文件。
  const root = mkdtempSync(join(tmpdir(), 'agentmux-bvm-'))
  privateLedgerRoots.push(root)
  return new BrowserViewManager(window as never, profiles, new BrowserRefLedgerStore(
    join(root, 'ref-ledger.json')
  ), appLinkHost(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, recoveryPreviews, {}, agents)
}

describe('Browser exact Agent association and trusted handoff', () => {
  const recipient = { kind: 'agent' as const, hostId: 'original-host', agentSessionId: 'created-agent', run: { runId: 'created-run' } }
  const identity = { hostId: recipient.hostId, agentSessionId: recipient.agentSessionId }
  const inspect = () => vi.fn(async () => ({ ...recipient } as Awaited<ReturnType<BrowserAgentAuthority['inspect']>>))
  const input = (manager: BrowserViewManager, id: string): BrowserControlHandoff => ({ agent: recipient,
    navigationId: manager.target(id)!.navigationId!, expectedRevision: manager.target(id)!.control!.revision })

  it('publishes confirmed-none for a fresh page and refuses receiver-free Return without affecting the page', async () => {
    const f = fakeWindow(), manager = browserManager(f.window)
    await manager.create('unassociated', 'https://example.invalid/original', 'workspace-a')
    expect(manager.target('unassociated')?.control).toMatchObject({ owner: 'human', agent: null })
    expect(() => manager.returnControl('unassociated')).toThrow('no associated Agent')
    expect(manager.target('unassociated')).toMatchObject({ status: 'ready', url: 'https://example.invalid/original', control: { owner: 'human', agent: null, revision: 0 } })
    expect(f.children[0]!.webContents.isDestroyed()).toBe(false)
    manager.close('unassociated')
  })

  it('confirms the exact original Core Session/Run before associating and transferring, and retains the association after Take and navigation', async () => {
    const f = fakeWindow(), read = inspect(), manager = browserManager(f.window, undefined, { resolve: () => undefined, inspect: read })
    await manager.create('handoff', 'https://example.invalid/original', 'workspace-a')
    const received = await manager.returnControl('handoff', input(manager, 'handoff'))
    expect(read).toHaveBeenCalledExactlyOnceWith(recipient)
    expect(received.control).toMatchObject({ owner: 'agent', agent: identity, activeOperationId: null })
    expect(manager.target('handoff')?.control?.agent).toEqual(identity)
    expect(manager.takeControl('handoff').control).toMatchObject({ owner: 'human', agent: identity })
    const moved = await manager.navigate('handoff', 'https://example.invalid/current')
    expect(moved.control).toMatchObject({ owner: 'human', agent: identity })
    expect(manager.returnControl('handoff').control).toMatchObject({ owner: 'agent', agent: identity })
    expect(read).toHaveBeenCalledTimes(1)
    manager.close('handoff')
  })

  for (const wrong of ['hostId', 'agentSessionId', 'run', 'retired'] as const) it(`rejects a Core ${wrong} mismatch while keeping the created Agent and original page`, async () => {
    const f = fakeWindow(), read = inspect()
    read.mockResolvedValue({ ...recipient, ...(wrong === 'retired' ? { kind: 'retired-agent' } : wrong === 'run' ? { run: { runId: 'newer-run' } } : { [wrong]: 'another-identity' }) } as never)
    const manager = browserManager(f.window, undefined, { resolve: () => undefined, inspect: read })
    await manager.create('mismatch', 'https://example.invalid/original', 'workspace-a')
    await expect(manager.returnControl('mismatch', input(manager, 'mismatch'))).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION_BINDING' })
    expect(manager.target('mismatch')?.control).toMatchObject({ owner: 'human', agent: null, revision: 0 })
    expect(f.children[0]!.webContents.isDestroyed()).toBe(false)
    manager.close('mismatch')
  })

  for (const changed of ['take', 'navigation', 'closed', 'other-browser'] as const) it(`rechecks original Browser identity and revision after the Core await: ${changed}`, async () => {
    const f = fakeWindow()
    let release!: (value: Awaited<ReturnType<BrowserAgentAuthority['inspect']>>) => void
    const wait = new Promise<Awaited<ReturnType<BrowserAgentAuthority['inspect']>>>(resolve => { release = resolve })
    const read = vi.fn(() => wait), manager = browserManager(f.window, undefined, { resolve: () => undefined, inspect: read })
    await manager.create('race', 'https://example.invalid/original', 'workspace-a')
    const pending = manager.returnControl('race', input(manager, 'race'))
    const refused = expect(pending).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
    if (changed === 'take') manager.takeControl('race')
    if (changed === 'navigation') await manager.navigate('race', 'https://example.invalid/later')
    if (changed === 'closed' || changed === 'other-browser') manager.close('race')
    if (changed === 'other-browser') await manager.create('race', 'https://example.invalid/replacement', 'workspace-a')
    release({ ...recipient } as never)
    await refused
    if (changed !== 'closed') expect(manager.target('race')?.control).toMatchObject({ owner: 'human', agent: null })
    expect(read).toHaveBeenCalledTimes(1)
    if (changed !== 'closed') manager.close('race')
  })

  it('keeps an unavailable Core observation local to this handoff, and the same exact request works after reconnecting', async () => {
    const f = fakeWindow(), read = inspect(), manager = browserManager(f.window, undefined, { resolve: () => undefined, inspect: read })
    await manager.create('reconnect', 'https://example.invalid/original', 'workspace-a')
    const request = input(manager, 'reconnect')
    read.mockRejectedValueOnce(new Error('Original Core observation is unavailable'))
    await expect(manager.returnControl('reconnect', request)).rejects.toThrow('Core observation')
    expect(manager.target('reconnect')?.control).toMatchObject({ owner: 'human', agent: null })
    expect((await manager.returnControl('reconnect', request)).control).toMatchObject({ owner: 'agent', agent: identity })
    manager.close('reconnect')
  })

  it('does not infer an association from a legacy descriptor or an operation author, while a saved association survives same-ID native reacquisition', async () => {
    const f = fakeWindow(), manager = browserManager(f.window)
    const descriptor = { id: 'cold', workspaceId: 'workspace-a', url: 'https://example.invalid/original', title: '', mode: 'normal' as const }
    const cold = await manager.ensure('cold', async () => descriptor)
    expect(cold.control).not.toHaveProperty('agent')
    Reflect.get(manager, 'entries').get('cold').activity.operation = { id: 'historical', operator: { id: recipient.agentSessionId, name: 'Old author' }, phase: 'completed' }
    expect(() => manager.returnControl('cold')).toThrow('association is unconfirmed')
    manager.close('cold')
    const restored = await manager.ensure('saved', async () => ({ ...descriptor, id: 'saved', agent: identity }))
    expect(restored.control).toMatchObject({ owner: 'human', agent: identity, revision: 0, activeOperationId: null, inputIsolation: 'inactive' })
    f.children.find(child => child.webContents.getURL() === descriptor.url)!.webContents.close()
    const reopened = await manager.restore('saved', { workspaceId: 'workspace-a' })
    expect(reopened.control).toMatchObject({ owner: 'human', agent: identity, revision: 0, activeOperationId: null, inputIsolation: 'inactive' })
    expect(reopened.activity?.operation).toBeNull()
    manager.close('saved')
  })

  it('refuses stale, malformed, unknown-association and replacement recipients before reading Core', async () => {
    const f = fakeWindow(), read = inspect(), manager = browserManager(f.window, undefined, { resolve: () => undefined, inspect: read })
    await manager.create('checked', 'https://example.invalid/original', 'workspace-a')
    const valid = input(manager, 'checked')
    for (const bad of [{ ...valid, expectedRevision: 99 }, { ...valid, navigationId: 'wrong' }, { ...valid, approval: true },
      { ...valid, agent: { ...recipient, run: { runId: '' } } }]) await expect(manager.returnControl('checked', bad as never)).rejects.toThrow()
    const entry = Reflect.get(manager, 'entries').get('checked')
    entry.agent = undefined
    await expect(manager.returnControl('checked', valid)).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
    entry.agent = { ...identity, agentSessionId: 'original-other-agent' }
    await expect(manager.returnControl('checked', valid)).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
    expect(read).not.toHaveBeenCalled()
    expect(manager.target('checked')?.control?.owner).toBe('human')
    manager.close('checked')
  })

  it('consumes the actual trusted IPC handoff body before Core verification and Main transfer', async () => {
    const source = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
    const ast = ts.createSourceFile('ipc.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const handlers: ts.Expression[] = []
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'handleWithEvent' && node.arguments[0]?.getText(ast) === "'browser:returnControl'") handlers.push(node.arguments[1]!)
      ts.forEachChild(node, visit)
    }
    visit(ast); expect(handlers).toHaveLength(1)
    const emitted = ts.transpileModule(`const handle = ${handlers[0]!.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    const f = fakeWindow(), read = inspect(), manager = browserManager(f.window, undefined, { resolve: () => undefined, inspect: read })
    await manager.create('ipc-handoff', 'https://example.invalid/original', 'workspace-a')
    const trusted = {}, trust = vi.fn((_channel, event) => { if (event !== trusted) throw new Error('Untrusted Browser handoff sender') })
    const handler = new Function('requireTrustedSender', 'browsers', `${emitted}; return handle;`)(trust, manager)
    await expect(handler({}, 'ipc-handoff', input(manager, 'ipc-handoff'))).rejects.toThrow('Untrusted')
    expect(read).not.toHaveBeenCalled()
    const result = await handler(trusted, 'ipc-handoff', input(manager, 'ipc-handoff'))
    expect(result.control).toMatchObject({ owner: 'agent', agent: identity })
    expect(trust).toHaveBeenCalledWith('browser:returnControl', trusted)
    expect(read).toHaveBeenCalledExactlyOnceWith(recipient)
    manager.close('ipc-handoff')
  })

  it('carries exact Main association, confirmed-none and unknown through public RPC and the actual Browser targets CLI', async () => {
    const f = fakeWindow(), manager = browserManager(f.window)
    const directory = mkdtempSync(join(tmpdir(), 'amx-browser-agent-cli-')); privateLedgerRoots.push(directory)
    await manager.create('none', 'https://example.invalid/none', 'workspace-a')
    const descriptor = { workspaceId: 'workspace-a', url: 'https://example.invalid/saved', title: '', mode: 'normal' as const }
    await manager.ensure('unknown', async () => ({ id: 'unknown', ...descriptor }))
    await manager.ensure('associated', async () => ({ id: 'associated', ...descriptor, agent: identity }))
    const socketPath = join(directory, 'control.sock')
    const server = new AgentMuxControlServer({ socketPath, coreClients: () => [], async execute(request) {
      if (request.operation !== 'browser.targets') throw new Error('Unexpected private Browser request')
      return { operation: request.operation, targets: manager.targets(), coverage: 'partial', warning: 'An unrelated external owner is unavailable.' }
    } })
    await server.start()
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
    try {
      const decoded = await rpc.call('browser.targets', {})
      expect(decoded).toMatchObject({ coverage: 'partial', warning: 'An unrelated external owner is unavailable.' })
      expect(decoded.targets.map(target => [target.id, target.control?.agent])).toEqual([['none', null], ['unknown', undefined], ['associated', identity]])
      expect(decoded.targets[1]!.control).not.toHaveProperty('agent')
      const result = await runCompiledObjectCli(['--endpoint', `unix:${socketPath}`, 'browser', 'targets'], objectCliEnvironment(directory))
      expect(result.code, result.stderr).toBe(0)
      const actual = JSON.parse(result.stdout).result
      expect(actual).toEqual(decoded)
      expect(actual.targets[1].control).not.toHaveProperty('agent')
      expect(actual.targets[2].control.agent).toEqual(identity)
    } finally { await rpc.dispose(); await server.stop(); manager.dispose() }
  })
})

/**
 * 一个记账的应用链接宿主。`openExternal` **必须**是假的——真的 `shell.openExternal` 会在跑测试的
 * 人脸上弹出外部应用。记下来而不是只数次数：判据要能说出交出去的是**哪个** URL。
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
  const sent: BrowserEvent[] = []
  const presentationEvents: BrowserPresentationEvent[] = []
  const messages: Array<{ channel: string; value: unknown }> = []
  return {
    children,
    sent,
    presentationEvents,
    messages,
    window: {
      getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
      contentView: {
        addChildView(view: InstanceType<typeof fakeElectron.FakeWebContentsView>) {
          // Electron View.addChildView reorders an existing child; it never duplicates it.
          // https://www.electronjs.org/docs/latest/api/view#viewaddchildviewview-index
          const index = children.indexOf(view)
          if (index >= 0) children.splice(index, 1)
          children.push(view)
        },
        removeChildView(view: InstanceType<typeof fakeElectron.FakeWebContentsView>) {
          const index = children.indexOf(view)
          if (index >= 0) children.splice(index, 1)
        }
      },
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send(channel: string, value: unknown) {
          messages.push({ channel, value })
          if (channel === BROWSER_EVENT_CHANNEL) sent.push(value as BrowserEvent)
          if (channel === BROWSER_PRESENTATION_EVENT_CHANNEL) presentationEvents.push(value as BrowserPresentationEvent)
        }
      }
    }
  }
}

describe('BrowserViewManager', () => {
  it('private owner retains one session across release and ends only that incarnation on close', async () => {
    const f = fakeWindow(), manager = browserManager(f.window)
    const normal = await manager.create('normal-sibling', 'https://normal.example/', 'workspace-a', 'work')
    const normalView = f.children.at(-1)!
    const first = await manager.create('private-page', 'https://private.example/', 'workspace-a', undefined, 'private')
    const firstView = f.children.at(-1)!, partition = firstView.partition!
    const storage = fakeElectron.fromPartition(partition)
    expect(first).toMatchObject({ mode: 'private', profileId: null })
    expect(partition, 'private session must not use a persistent partition').not.toMatch(/^persist:/)
    expect(manager.targets().find(row => row.id === first.id)).toMatchObject({ mode: 'private' })
    expect(manager.inputHistoryScope(first.id, null)).toEqual({ workspaceId: 'workspace-a', profileId: null })
    expect(await manager.create(first.id, 'https://ignored.example/', 'workspace-a', undefined, 'private')).toMatchObject({ id: first.id, url: first.url, mode: 'private' })
    await expect(manager.create(first.id, 'about:blank', 'workspace-a', undefined, 'normal')).rejects.toThrow('cannot change mode')
    await expect(manager.switchProfile(first.id, 'work')).rejects.toThrow('private Browser')
    await release(manager, first.id)
    expect(storage.clearStorageData).not.toHaveBeenCalled()
    await manager.restore(first.id, { workspaceId: 'workspace-a', profileId: null, mode: 'private' })
    expect(f.children.at(-1)!.partition).toBe(partition)
    await manager.close(first.id)
    expect(storage.clearStorageData).toHaveBeenCalledTimes(1)
    expect(storage.clearCache).toHaveBeenCalledTimes(1)
    await manager.create(first.id, 'about:blank', 'workspace-a', undefined, 'private')
    expect(f.children.at(-1)!.partition, 'closed private incarnation must never be reused').not.toBe(partition)
    expect(normalView.webContents.isDestroyed()).toBe(false)
    expect(manager.targets().find(row => row.id === normal.id)).toMatchObject({ mode: 'normal' })
    await manager.close(first.id)
    manager.dispose()
  })

  it('separate private Browser identities never share a partition and never resolve a saved Profile', async () => {
    const f = fakeWindow(), manager = browserManager(f.window)
    await manager.create('private-one', 'about:blank', 'workspace-a', undefined, 'private')
    const first = f.children.at(-1)!.partition
    await manager.create('private-two', 'about:blank', 'workspace-a', undefined, 'private')
    expect(f.children.at(-1)!.partition).not.toBe(first)
    await expect(manager.create('wrong-private', 'about:blank', 'workspace-a', 'work', 'private')).rejects.toThrow('saved Profile')
    await manager.close('private-one'); await manager.close('private-two')
    manager.dispose()
  })

  it.each(['parent-close', 'closed-receipt', 'first-popup', 'storage'] as const)('private close attempts every cleanup after a %s failure and revokes late popups', async failure => {
    const f = fakeWindow(), manager = browserManager(f.window)
    await manager.create('normal-kept', 'about:blank', 'workspace-a', 'work')
    const normal = f.children.at(-1)!
    await manager.create('private-failure', 'about:blank', 'workspace-a', undefined, 'private')
    const original = f.children.at(-1)!, storage = fakeElectron.fromPartition(original.partition!)
    const popup = () => {
      const page = new fakeElectron.FakeWebContentsView().webContents
      Object.assign(page, { session: storage })
      vi.spyOn(page, 'close')
      return page
    }
    const first = popup(), second = popup()
    // Consume the real original request with Electron's supplied native guest;
    // child ownership is the ordinary entries map, with no popup-only helper.
    const opened = (page: ReturnType<typeof popup>) => {
      const outcome = original.webContents.windowOpenHandler!({ url: 'https://popup.example/' }) as any
      const actual = outcome.createWindow({ webContents: page, webPreferences: { session: storage } })
      expect(actual).toBe(page)
      return actual
    }
    opened(first); opened(second)
    expect(manager.targets().filter(target => target.openedFrom?.browserId === 'private-failure')).toHaveLength(2)
    if (failure === 'parent-close') vi.spyOn(original.webContents, 'close').mockImplementationOnce(() => { throw new Error('Parent close failed') })
    const closedReceiptFault = vi.fn()
    if (failure === 'closed-receipt') {
      const send = f.window.webContents.send
      vi.spyOn(f.window.webContents, 'send').mockImplementation((channel, value) => {
        const event = value as BrowserEvent
        if (channel === BROWSER_EVENT_CHANNEL && event.type === 'closed' && event.id === 'private-failure' && !closedReceiptFault.mock.calls.length) {
          closedReceiptFault(channel, value)
          throw new Error('Receipt failed')
        }
        send(channel, value)
      })
    }
    if (failure === 'first-popup') first.close.mockImplementationOnce(() => { throw new Error('Popup close failed') })
    if (failure === 'storage') storage.clearStorageData.mockRejectedValueOnce(new Error('Storage clear failed'))
    await expect(manager.close('private-failure')).rejects.toThrow('cleanup failures')
    if (failure === 'closed-receipt') expect(closedReceiptFault).toHaveBeenCalledExactlyOnceWith(BROWSER_EVENT_CHANNEL, { type: 'closed', id: 'private-failure' })
    expect(original.webContents.isDestroyed()).toBe(failure !== 'parent-close')
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(second.close).toHaveBeenCalledTimes(1)
    expect(storage.clearStorageData).toHaveBeenCalledTimes(1)
    expect(storage.clearCache).toHaveBeenCalledTimes(1)
    expect(storage.closeAllConnections).toHaveBeenCalledTimes(1)
    expect(storage.checkHandler?.()).toBe(false)
    const permission = vi.fn(); storage.requestHandler?.(original.webContents, 'notifications', permission)
    expect(permission).toHaveBeenCalledWith(false)
    expect(manager.targets().map(target => target.id)).toEqual(['normal-kept'])
    const late = popup()
    expect(() => opened(late)).toThrow('no longer current')
    expect(late.close).not.toHaveBeenCalled()
    expect(manager.targets().map(target => target.id)).toEqual(['normal-kept'])
    late.close()
    await manager.create('private-failure', 'about:blank', 'workspace-a', undefined, 'private')
    expect(f.children.at(-1)!.partition).not.toBe(original.partition)
    expect(normal.webContents.isDestroyed()).toBe(false)
    manager.dispose()
  })

  it('disposal continues exact private-session cleanup after a native close failure and reaches the next owner', async () => {
    const f = fakeWindow(), manager = browserManager(f.window)
    await manager.create('dispose-private-first', 'about:blank', 'workspace-a', undefined, 'private')
    const first = f.children.at(-1)!, firstSession = fakeElectron.fromPartition(first.partition!)
    await manager.create('dispose-private-next', 'about:blank', 'workspace-a', undefined, 'private')
    const second = f.children.at(-1)!, secondSession = fakeElectron.fromPartition(second.partition!)
    vi.spyOn(first.webContents, 'close').mockImplementationOnce(() => { throw new Error('Native close failed') })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => manager.dispose()).not.toThrow()
    await vi.waitFor(() => expect(warning).toHaveBeenCalledWith('Private website-data cleanup failed during disposal:', expect.any(AggregateError)))
    for (const storage of [firstSession, secondSession]) {
      expect(storage.clearStorageData).toHaveBeenCalledTimes(1)
      expect(storage.clearCache).toHaveBeenCalledTimes(1)
      expect(storage.closeAllConnections).toHaveBeenCalledTimes(1)
    }
    expect(second.webContents.isDestroyed()).toBe(true)
    warning.mockRestore()
  })

  it('disposal retires private consumers even when an earlier normal owner preserves its native teardown error', async () => {
    const f = fakeWindow(), manager = browserManager(f.window)
    await manager.create('dispose-normal-first', 'about:blank', 'workspace-a', 'work')
    const normal = f.children.at(-1)!
    await manager.create('dispose-private-after', 'about:blank', 'workspace-a', undefined, 'private')
    const privateView = f.children.at(-1)!, storage = fakeElectron.fromPartition(privateView.partition!)
    vi.spyOn(normal.webContents, 'close').mockImplementationOnce(() => { throw new Error('Normal native close failed') })
    expect(() => manager.dispose()).toThrow('Normal native close failed')
    await vi.waitFor(() => expect(storage.clearStorageData).toHaveBeenCalledTimes(1))
    expect(storage.clearCache).toHaveBeenCalledTimes(1)
    expect(storage.closeAllConnections).toHaveBeenCalledTimes(1)
    expect(privateView.webContents.isDestroyed()).toBe(true)
  })

  it('T049 retains destroyed metadata and announces owner loss when resource cleanup throws', async () => {
    const fixture = fakeWindow(), manager = browserManager(fixture.window)
    const current = await manager.create('cleanup-resource', 'https://original.example/path', 'workspace-a', 'work')
    const view = fixture.children[0]!
    manager.setViewport(current.id, 'mobile')
    vi.spyOn(view.webContents, 'getURL').mockImplementation(() => { throw new Error('Dead URL read') })
    vi.spyOn(view.webContents, 'getTitle').mockImplementation(() => { throw new Error('Dead title read') })
    const cleanup = vi.spyOn(manager as any, 'revokePresentationCapture').mockImplementation(() => { throw new Error('capture cleanup unavailable') })
    const detach = vi.spyOn(fixture.window.contentView, 'removeChildView')
    fixture.sent.length = 0
    expect(() => view.webContents.close()).not.toThrow()
    expect(detach).toHaveBeenCalledWith(view)
    expect(fixture.sent).toEqual([{ type: 'unavailable', id: current.id, error: expect.stringContaining('capture cleanup unavailable') }])
    expect(manager.resourceOwnerCounts()).toEqual({ browserViews: 0, releasedBrowserViews: 1 })
    cleanup.mockRestore()
    expect(await manager.restore(current.id, { workspaceId: 'workspace-a' })).toMatchObject({ id: current.id, url: current.url, profileId: 'work', viewport: 'mobile' })
    manager.close(current.id)
  })

  it('T049 retains a failed dead-view detach and reports it until explicit restore repairs cleanup', async () => {
    const fixture = fakeWindow(), manager = browserManager(fixture.window)
    const current = await manager.create('cleanup-detach', 'https://original.example/path', 'workspace-a', 'work')
    const view = fixture.children[0]!
    const originalDetach = fixture.window.contentView.removeChildView
    const detach = vi.spyOn(fixture.window.contentView, 'removeChildView').mockImplementation(() => { throw new Error('native detach blocked') })
    fixture.sent.length = 0
    expect(() => view.webContents.close()).not.toThrow()
    expect(fixture.sent).toEqual([{ type: 'unavailable', id: current.id, error: expect.stringContaining('native detach blocked') }])
    const views = fakeElectron.FakeWebContentsView.instances.length
    expect(await manager.restore(current.id, { workspaceId: 'workspace-a' }).then(() => null, error => error.message)).toEqual(expect.stringContaining('native detach blocked'))
    expect(fakeElectron.FakeWebContentsView.instances).toHaveLength(views)
    expect(manager.resourceOwnerCounts()).toEqual({ browserViews: 0, releasedBrowserViews: 1 })
    detach.mockImplementation(originalDetach)
    expect(await manager.restore(current.id, { workspaceId: 'workspace-a' })).toMatchObject({ id: current.id, url: current.url, profileId: 'work' })
    expect(fixture.children).toHaveLength(1)
    manager.close(current.id)
  })

  it('T049 release still closes a candidate after detach throws and keeps the healthy original', async () => {
    const fixture = fakeWindow(), manager = browserManager(fixture.window)
    const current = await manager.create('cleanup-release', 'https://original.example/')
    const original = fixture.children[0]!
    fakeElectron.FakeWebContentsView.nextLoadURLImpl = async () => await new Promise<void>(() => {})
    const switching = manager.switchProfile(current.id, 'work').catch(error => error as Error)
    const candidate = fixture.children[1]!
    const close = vi.spyOn(candidate.webContents, 'close')
    const nativeDetach = fixture.window.contentView.removeChildView
    const detach = vi.spyOn(fixture.window.contentView, 'removeChildView').mockImplementation(view => {
      if (view === candidate) throw new Error('candidate detach blocked')
      nativeDetach(view)
    })
    fixture.sent.length = 0
    await expect(release(manager, current.id)).resolves.toMatchObject({status:'retained',reasons:['profile-switch']})
    expect(close).not.toHaveBeenCalled()
    expect(() => manager.close(current.id)).toThrow('candidate detach blocked')
    expect((await switching).message).toContain('candidate detach blocked')
    expect(close).toHaveBeenCalledTimes(1)
    expect(candidate.webContents.isDestroyed()).toBe(true)
    expect(original.webContents.isDestroyed()).toBe(false)
    expect(manager.usesProfile('work')).toBe(true)
    expect(await manager.create(current.id, 'https://stale.example/')).toMatchObject({ id: current.id, profileId: 'default', url: current.url })
    expect(fixture.sent).toEqual([])
    detach.mockImplementation(nativeDetach)
    await manager.navigate(current.id, current.url)
    await release(manager, current.id)
    expect(fixture.children).toEqual([])
    expect(manager.resourceOwnerCounts()).toEqual({ browserViews: 0, releasedBrowserViews: 1 })
    expect(await manager.restore(current.id)).toMatchObject({ id: current.id, profileId: 'default', url: current.url })
    manager.close(current.id)
  })

  it('T049 close preserves a live candidate when both detach and close fail without retiring the original', async () => {
    const fixture = fakeWindow(), manager = browserManager(fixture.window)
    const current = await manager.create('cleanup-close', 'https://original.example/')
    const original = fixture.children[0]!
    fakeElectron.FakeWebContentsView.nextLoadURLImpl = async () => await new Promise<void>(() => {})
    const switching = manager.switchProfile(current.id, 'work').catch(error => error as Error)
    const candidate = fixture.children[1]!
    const nativeDetach = fixture.window.contentView.removeChildView
    const detach = vi.spyOn(fixture.window.contentView, 'removeChildView').mockImplementation(view => {
      if (view === candidate) throw new Error('candidate detach blocked')
      nativeDetach(view)
    })
    const close = vi.spyOn(candidate.webContents, 'close').mockImplementation(() => { throw new Error('candidate close blocked') })
    fixture.sent.length = 0
    expect(() => manager.close(current.id)).toThrow('candidate close blocked')
    const error = await switching
    expect(error.message).toContain('candidate detach blocked')
    expect(error.message).toContain('candidate close blocked')
    expect(close).toHaveBeenCalledTimes(1)
    expect(candidate.webContents.isDestroyed()).toBe(false)
    expect(original.webContents.isDestroyed()).toBe(false)
    expect(manager.usesProfile('work')).toBe(true)
    expect(fixture.sent).toEqual([])
    expect(() => manager.close(current.id)).toThrow('candidate close blocked')
    expect(close).toHaveBeenCalledTimes(2)
    detach.mockImplementation(nativeDetach); close.mockRestore()
    manager.close(current.id)
    expect(candidate.webContents.isDestroyed()).toBe(true)
    expect(original.webContents.isDestroyed()).toBe(true)
    expect(fixture.sent.at(-1)).toEqual({ type: 'closed', id: current.id })
    expect(manager.resourceOwnerCounts()).toEqual({ browserViews: 0, releasedBrowserViews: 0 })
  })

  it('T049 destroyed original retains live failed candidate cleanup across guarded restore and close', async () => {
    const fixture = fakeWindow(), manager = browserManager(fixture.window)
    const current = await manager.create('cleanup-retained', 'https://original.example/path', 'workspace-a', 'personal')
    const original = fixture.children[0]!
    fakeElectron.FakeWebContentsView.nextLoadURLImpl = async () => await new Promise<void>(() => {})
    const switching = manager.switchProfile(current.id, 'work').catch(error => error as Error)
    const candidate = fixture.children[1]!
    const nativeDetach = fixture.window.contentView.removeChildView
    const detach = vi.spyOn(fixture.window.contentView, 'removeChildView').mockImplementation(view => {
      if (view === candidate) throw new Error('retained detach blocked')
      nativeDetach(view)
    })
    const close = vi.spyOn(candidate.webContents, 'close').mockImplementation(() => { throw new Error('retained close blocked') })
    fixture.sent.length = 0
    expect(() => original.webContents.close()).not.toThrow()
    expect((await switching).message).toContain('retained close blocked')
    expect(close).toHaveBeenCalledTimes(1)
    expect(fixture.sent).toEqual([{ type: 'unavailable', id: current.id, error: expect.stringContaining('retained close blocked') }])
    expect(manager.usesProfile('work')).toBe(true)
    expect(manager.usesProfile('personal')).toBe(true)
    await expect(manager.restore(current.id, { workspaceId: 'workspace-foreign' })).rejects.toThrow('another Workspace')
    await expect(manager.restore(current.id, { workspaceId: 'workspace-a', profileId: 'unknown' })).rejects.toThrow('Unknown browser profile')
    expect(close).toHaveBeenCalledTimes(1)
    const views = fakeElectron.FakeWebContentsView.instances.length
    expect(await manager.restore(current.id, { workspaceId: 'workspace-a' }).then(() => null, error => error.message)).toEqual(expect.stringContaining('retained close blocked'))
    expect(fakeElectron.FakeWebContentsView.instances).toHaveLength(views)
    expect(() => manager.close(current.id)).toThrow('retained close blocked')
    expect(fixture.sent.some((event: any) => event.type === 'closed')).toBe(false)
    expect(manager.resourceOwnerCounts()).toEqual({ browserViews: 0, releasedBrowserViews: 1 })
    detach.mockImplementation(nativeDetach); close.mockRestore()
    expect(await manager.restore(current.id, { workspaceId: 'workspace-a' })).toMatchObject({ id: current.id, profileId: 'personal', url: current.url })
    expect(candidate.webContents.isDestroyed()).toBe(true)
    expect(manager.usesProfile('work')).toBe(false)
    expect(fixture.children).toHaveLength(1)
    manager.close(current.id)
  })

  it('retains a destroyed page native input cleanup owner and its process through same-id recovery', async () => {
    const f = fakeWindow(), manager = browserManager(f.window)
    await manager.create('native-cleanup', 'https://original.example/page', 'workspace-a')
    const source = f.children[0]!, shieldContents = new fakeElectron.FakeWebContentsView().webContents
    shieldContents.mainFrame.framesInSubtree = [{ osProcessId: 20, detached: false }]
    const dispose = vi.fn(() => { throw new Error('Native cleanup unavailable') })
    const shield = { contents: shieldContents, dispose, synchronize: vi.fn(), isCurrentFor: () => false }
    const entry = Reflect.get(manager, 'entries').get('native-cleanup')
    entry.agent = { hostId: 'original-host', agentSessionId: 'original-agent' }
    entry.inputShield = shield; entry.inputIsolation = 'isolated'
    source.webContents.close()
    const processes = new Map([[10, 1], [20, 2]])
    expect(manager.resourceTargets(processes)).toMatchObject([{ id: 'native-cleanup', resource: {
      state: 'unknown', processes: [{ pid: 20, creationTime: 2 }], retention: { status: 'unknown', reasons: ['close-unconfirmed'] }
    } }])
    expect(manager.resourceProcessIds()).toContain(20)
    await expect(manager.restore('native-cleanup', { workspaceId: 'workspace-a' })).resolves.toMatchObject({ id: 'native-cleanup' })
    expect(Reflect.get(manager, 'entries').get('native-cleanup').inputShield).toBe(shield)
    expect(manager.resourceTargets(processes)[0]?.resource?.retention).toMatchObject({ status: 'unknown', reasons: expect.arrayContaining(['close-unconfirmed']) })
    expect(manager.returnControl('native-cleanup').activity?.warning).toContain('could not be fully released')
    dispose.mockImplementation(() => { shieldContents.close() })
    expect(manager.takeControl('native-cleanup').control).toMatchObject({ owner: 'human', inputIsolation: 'inactive' })
    expect(manager.resourceProcessIds()).not.toContain(20)
    manager.close('native-cleanup')
  })

  it('keeps explicit Close cleanup-only without restoring the retired page or blocking a healthy sibling', async () => {
    const f = fakeWindow(), manager = browserManager(f.window)
    await manager.create('native-closed', 'https://original.example/closed', 'workspace-a')
    await manager.create('native-kept', 'https://original.example/kept', 'workspace-a')
    const kept = f.children[1]!, shieldContents = new fakeElectron.FakeWebContentsView().webContents
    const dispose = vi.fn(() => { throw new Error('Native cleanup unavailable') })
    const entry = Reflect.get(manager, 'entries').get('native-closed')
    entry.inputShield = { contents: shieldContents, dispose }; entry.inputIsolation = 'isolated'
    manager.close('native-closed')
    await expect(manager.restore('native-closed', { workspaceId: 'workspace-a' })).rejects.toThrow('closed explicitly')
    expect(manager.resourceTargets(new Map([[10, 1]])).find(target => target.id === 'native-closed')).toMatchObject({
      url: '', resource: { state: 'unknown' }, warning: expect.stringContaining('closed explicitly')
    })
    expect(kept.webContents.isDestroyed()).toBe(false)
    expect(manager.targets().map(target => target.id)).toEqual(['native-kept'])
    dispose.mockImplementation(() => { shieldContents.close() })
    manager.close('native-closed')
    expect(manager.resourceTargets(new Map([[10, 1]])).some(target => target.id === 'native-closed')).toBe(false)
    manager.close('native-kept')
  })

  it('T049 failed candidate loading keeps its failed-close reference for the next explicit operation', async () => {
    const fixture = fakeWindow(), manager = browserManager(fixture.window)
    const current = await manager.create('cleanup-load-failure', 'https://original.example/')
    const original = fixture.children[0]!
    fakeElectron.FakeWebContentsView.nextLoadURLImpl = async () => { throw new Error('candidate navigation failed') }
    const switching = manager.switchProfile(current.id, 'work')
    const candidate = fixture.children[1]!
    const close = vi.spyOn(candidate.webContents, 'close').mockImplementation(() => { throw new Error('load cleanup close blocked') })
    await expect(switching).rejects.toThrow('load cleanup close blocked')
    expect(close).toHaveBeenCalledTimes(1)
    expect(manager.usesProfile('work')).toBe(true)
    expect(original.webContents.isDestroyed()).toBe(false)
    await expect(manager.switchProfile(current.id, 'personal')).rejects.toThrow('load cleanup close blocked')
    expect(close).toHaveBeenCalledTimes(2)
    expect(fixture.children).toEqual([original])
    close.mockRestore()
    expect(await manager.switchProfile(current.id, 'personal')).toMatchObject({ id: current.id, profileId: 'personal' })
    expect(candidate.webContents.isDestroyed()).toBe(true)
    manager.close(current.id)
  })

  it('T049 keeps a candidate whose close returns without confirming destruction', async () => {
    const fixture = fakeWindow(), manager = browserManager(fixture.window)
    const current = await manager.create('cleanup-unconfirmed', 'https://original.example/')
    const original = fixture.children[0]!
    fakeElectron.FakeWebContentsView.nextLoadURLImpl = async () => await new Promise<void>(() => {})
    const switching = manager.switchProfile(current.id, 'work').catch(error => error as Error)
    const candidate = fixture.children[1]!
    const close = vi.spyOn(candidate.webContents, 'close').mockImplementation(() => {})
    await expect(release(manager, current.id)).resolves.toMatchObject({status:'retained',reasons:['profile-switch']})
    expect(close).not.toHaveBeenCalled()
    expect(() => manager.close(current.id)).toThrow('not confirmed')
    expect((await switching).message).toContain('not confirmed')
    expect(candidate.webContents.isDestroyed()).toBe(false)
    expect(manager.usesProfile('work')).toBe(true)
    expect(original.webContents.isDestroyed()).toBe(false)
    expect(close).toHaveBeenCalledTimes(1)
    close.mockRestore()
    await manager.navigate(current.id, current.url)
    await release(manager, current.id)
    expect(candidate.webContents.isDestroyed()).toBe(true)
    manager.close(current.id)
  })

  it('T049 cleanup failure unavailable reaches the actual Store without losing Region or sibling layout', async () => {
    const { useAppStore } = await import('../src/renderer/src/store.js')
    const { createWorkbenchTab, addWorkbenchRegion } = await import('../src/renderer/src/lib/workbench-tabs.js')
    const { createWorkspaceLayout } = await import('@agentmux/layout')
    const originalState = useAppStore.getState()
    const fixture = fakeWindow(), manager = browserManager(fixture.window)
    const send = fixture.window.webContents.send
    fixture.window.webContents.send = (channel, event) => {
      send(channel, event)
      if (channel === BROWSER_EVENT_CHANNEL) useAppStore.getState().applyBrowserEvent(event as BrowserEvent)
    }
    const current = await manager.create('cleanup-store', 'https://original.example/path', 'workspace-a', 'work')
    const view = fixture.children[0]!
    let tab = createWorkbenchTab('cleanup-store-tab', { ...current, kind: 'browser', browserId: current.id, regionId: 'cleanup-store-region', workspaceId: 'workspace-a' })
    tab = addWorkbenchRegion(tab, 'cleanup-store-region', 'right', { kind: 'file', regionId: 'cleanup-store-sibling', workspaceId: 'workspace-a', path: 'draft.md' })
    useAppStore.setState({ tabs: { [tab.id]: tab }, layouts: { 'workspace-a': createWorkspaceLayout('cleanup-store-group', [tab.id]) } })
    const before = useAppStore.getState(), nativeDetach = fixture.window.contentView.removeChildView
    const detach = vi.spyOn(fixture.window.contentView, 'removeChildView').mockImplementation(() => { throw new Error('Store native detach blocked') })
    try {
      expect(() => view.webContents.close()).not.toThrow()
      const after = useAppStore.getState()
      expect(after.tabs[tab.id]!.regions['cleanup-store-region']).toMatchObject({ browserId: current.id, url: current.url, profileId: 'work', error: expect.stringContaining('Store native detach blocked') })
      expect(after.tabs[tab.id]!.layout).toBe(before.tabs[tab.id]!.layout)
      expect(after.layouts).toBe(before.layouts)
      expect(after.tabs[tab.id]!.regions['cleanup-store-sibling']).toBe(before.tabs[tab.id]!.regions['cleanup-store-sibling'])
      detach.mockImplementation(nativeDetach)
      expect(await manager.restore(current.id, { workspaceId: 'workspace-a' })).toMatchObject({ id: current.id, url: current.url, profileId: 'work' })
      expect(useAppStore.getState().tabs[tab.id]!.regions['cleanup-store-region']).toMatchObject({ error: null })
    } finally { detach.mockRestore(); manager.dispose(); useAppStore.setState(originalState, true) }
  })

  it('T049 late destroyed callbacks cannot release a newer or unrelated healthy owner', async () => {
    const fixture = fakeWindow(), manager = browserManager(fixture.window)
    const current = await manager.create('cleanup-stale', 'https://original.example/')
    await manager.create('cleanup-neighbor', 'https://neighbor.example/')
    const old = fixture.children[0]!, neighbor = fixture.children[1]!
    const lateDestroyed = old.webContents.listeners.get('destroyed')![0]!
    old.webContents.close()
    expect(await manager.restore(current.id)).toMatchObject({ id: current.id, url: current.url })
    const newer = fixture.children.find(view => view !== neighbor)!
    fixture.sent.length = 0
    lateDestroyed()
    expect(fixture.sent).toEqual([])
    expect(newer.webContents.isDestroyed()).toBe(false)
    expect(neighbor.webContents.isDestroyed()).toBe(false)
    expect(manager.targets()).toHaveLength(2)
    manager.close(current.id); manager.close('cleanup-neighbor')
  })


  it('opens a restored Browser directly in its saved Profile without switching a healthy owner', async () => {
    const fixture = fakeWindow(), manager = browserManager(fixture.window)
    try {
      const restored = await manager.create('saved-profile', 'https://example.test/original', null, 'work')
      expect(restored.profileId).toBe('work')
      const original = fixture.children[0]!, load = vi.spyOn(original.webContents, 'loadURL')
      expect(await manager.create('saved-profile', 'https://stale.test/', null, 'personal')).toMatchObject({ profileId: 'work', url: restored.url })
      expect(fixture.children).toEqual([original]); expect(load).not.toHaveBeenCalled()
      await expect(manager.create('unknown-profile', 'https://example.test/', null, 'missing')).rejects.toThrow()
      expect(fixture.children).toEqual([original])
    } finally { manager.dispose() }
  })

  it('ensures an existing identity without navigating or replacing its Profile, including released owners', async () => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    try {
      await manager.create('browser-ensure', 'https://initial.example/', null, 'work')
      const current = await manager.navigate('browser-ensure', 'https://current.example/page')
      const view = fixture.children[0]!
      const load = vi.spyOn(view.webContents, 'loadURL')
      const ensured = await manager.create('browser-ensure', 'https://stale.example/').catch(() => null)
      expect(ensured).toMatchObject({
        id: 'browser-ensure', profileId: 'work', url: 'https://current.example/page', navigationId: current.navigationId
      })
      expect(fixture.children).toEqual([view])
      expect(load).not.toHaveBeenCalled()
      await release(manager, 'browser-ensure')
      const restored = await manager.create('browser-ensure', 'https://stale.example/')
      expect(restored).toMatchObject({ id: 'browser-ensure', profileId: 'work', url: 'https://current.example/page' })
      expect(fixture.children).toHaveLength(1)
      expect(fixture.children[0]).not.toBe(view)
      expect(view.webContents.isDestroyed()).toBe(true)
    } finally { manager.dispose() }
  })

  it('disposes active and released native owners without deleting the actual Store workbench; explicit close still removes only its Region', async () => {
    const { useAppStore } = await import('../src/renderer/src/store.js')
    const { createWorkbenchTab, addWorkbenchRegion } = await import('../src/renderer/src/lib/workbench-tabs.js')
    const { createWorkspaceLayout } = await import('@agentmux/layout')
    const original = useAppStore.getState()
    const fixture = fakeWindow()
    const sent = fixture.window.webContents.send
    fixture.window.webContents.send = (channel, value) => {
      sent(channel, value)
      if (channel === BROWSER_EVENT_CHANNEL) useAppStore.getState().applyBrowserEvent(value as BrowserEvent)
    }
    const manager = browserManager(fixture.window)
    try {
      const active = await manager.create('browser-active', 'https://active.example/')
      const released = await manager.create('browser-released', 'https://released.example/')
      let tab = createWorkbenchTab('browser-durable-tab', {
        ...active, kind: 'browser', regionId: 'browser-active-region', browserId: active.id, workspaceId: 'workspace-a'
      })
      tab = addWorkbenchRegion(tab, 'browser-active-region', 'right', {
        ...released, kind: 'browser', regionId: 'browser-released-region', browserId: released.id, workspaceId: 'workspace-a'
      })
      tab = addWorkbenchRegion(tab, 'browser-released-region', 'down', {
        kind: 'file', regionId: 'dirty-sibling', workspaceId: 'workspace-a', path: 'draft.md'
      })
      useAppStore.setState({ tabs: { [tab.id]: tab }, layouts: { 'workspace-a': createWorkspaceLayout('group-a', [tab.id]) } })
      const before = useAppStore.getState()
      const persistedBefore = useAppStore.persist.getOptions().partialize!(before)
      expect(Object.keys(before.tabs[tab.id]!.regions)).toEqual(['browser-active-region', 'browser-released-region', 'dirty-sibling'])
      await release(manager, 'browser-released')
      const afterRelease = useAppStore.getState()
      expect(manager.resourceOwnerCounts()).toEqual({ browserViews: 1, releasedBrowserViews: 1 })
      fixture.sent.length = 0
      manager.dispose()
      expect(manager.resourceOwnerCounts()).toEqual({ browserViews: 0, releasedBrowserViews: 0 })
      expect(fixture.children).toEqual([])
      expect(fixture.sent).toEqual([])
      expect(useAppStore.getState().tabs).toBe(afterRelease.tabs)
      expect(useAppStore.getState().layouts).toBe(before.layouts)
      expect(useAppStore.persist.getOptions().partialize!(useAppStore.getState())).toEqual(persistedBefore)
      await manager.create(active.id, active.url)
      manager.close(active.id)
      expect(fixture.sent.at(-1)).toEqual({ type: 'closed', id: active.id })
      expect(Object.keys(useAppStore.getState().tabs[tab.id]!.regions)).toEqual(['browser-released-region', 'dirty-sibling'])
    } finally {
      manager.dispose()
      useAppStore.setState(original, true)
    }
  })

  it('disposes an owned native page even after the parent Window has already been destroyed', async () => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    await manager.create('browser-window-gone', 'https://private.example/')
    const view = fixture.children[0]!
    vi.spyOn(fixture.window, 'isDestroyed').mockReturnValue(true)
    const remove = vi.spyOn(fixture.window.contentView, 'removeChildView').mockImplementation(() => { throw new Error('Destroyed Window') })
    fixture.sent.length = 0
    expect(() => manager.dispose()).not.toThrow()
    expect(view.webContents.isDestroyed()).toBe(true)
    expect(remove).not.toHaveBeenCalled()
    expect(manager.resourceOwnerCounts()).toEqual({ browserViews: 0, releasedBrowserViews: 0 })
    expect(fixture.sent).toEqual([])
  })

  it('reports native Browser owners and actual frame OS PIDs without counting shared or detached processes twice', async () => {
    const { window } = fakeWindow()
    const manager = browserManager(window)
    await manager.create('owner-a', 'about:blank')
    await manager.create('owner-b', 'about:blank')
    const views = fakeElectron.FakeWebContentsView.instances.slice(-2)
    expect(views).toHaveLength(2)
    views[0]!.webContents.mainFrame.framesInSubtree = [
      { osProcessId: 100, detached: false }, { osProcessId: 101, detached: false },
      { osProcessId: 102, detached: true }
    ]
    views[1]!.webContents.mainFrame.framesInSubtree = [{ osProcessId: 100, detached: false }]
    expect(manager.resourceOwnerCounts()).toEqual({ browserViews: 2, releasedBrowserViews: 0 })
    expect(manager.resourceProcessIds()).toEqual([100, 101])
    await release(manager, 'owner-a')
    expect(manager.resourceOwnerCounts()).toEqual({ browserViews: 1, releasedBrowserViews: 1 })
    expect(manager.resourceProcessIds()).toEqual([100])
    manager.close('owner-a')
    manager.close('owner-b')
    expect(manager.resourceOwnerCounts()).toEqual({ browserViews: 0, releasedBrowserViews: 0 })
    expect(manager.resourceProcessIds()).toEqual([])
  })

  it('opens ordinary address text as search through actual create and navigate', async () => {
    const fixture = fakeWindow(), manager = browserManager(fixture.window)
    try {
      const opened = await manager.create('address-search', '天气', null, 'work')
      const view = fixture.children[0]!
      expect(opened.url).toBe('https://www.google.com/search?q=%E5%A4%A9%E6%B0%94')
      expect(view.webContents.url).toBe(opened.url)
      const searched = await manager.navigate(opened.id, 'skyvern')
      expect(searched.url).toBe('https://www.google.com/search?q=skyvern')
      expect(view.webContents.url).toBe(searched.url)
      expect(searched.profileId).toBe('work')
      expect(searched.id).toBe(opened.id)
      expect(fixture.children).toEqual([view])
      expect((await manager.navigate(opened.id, 'example.com:8443/a')).url).toBe('https://example.com:8443/a')
      expect((await manager.navigate(opened.id, 'localhost:3000')).url).toBe('http://localhost:3000/')
      const currentUrl = view.webContents.url
      await expect(manager.navigate(opened.id, 'javascript:123')).rejects.toThrow('Unsupported browser URL protocol')
      expect(view.webContents.url).toBe(currentUrl)
      expect(fixture.children).toEqual([view])
      for (const malformed of ['192.168.1.999', '[2001:db8::1]:99999', 'example.com:99999']) {
        await expect(manager.navigate(opened.id, malformed)).rejects.toThrow('Invalid URL')
        expect(view.webContents.url).toBe(currentUrl)
        expect(await manager.create(opened.id, 'about:blank')).toMatchObject({ id: opened.id, profileId: 'work', url: currentUrl })
        expect(fixture.children).toEqual([view])
      }
    } finally { manager.dispose() }
  })

  it('normalizes only embeddable web URLs', () => {
    expect(normalizeBrowserUrl('example.com')).toBe('https://example.com/')
    expect(normalizeBrowserUrl('localhost:4173')).toBe('http://localhost:4173/')
    expect(normalizeBrowserUrl('agent runtime docs')).toBe('https://www.google.com/search?q=agent%20runtime%20docs')
    expect(normalizeBrowserUrl('about:blank')).toBe('about:blank')
    expect(normalizeBrowserUrl(_reshape_fixtureFileUrl("browser-local-file"))).toBe(_reshape_fixtureFileUrl("browser-local-file"))
    expect(normalizeBrowserUrl((_hygiene_fixturePath("tmp/browser") + " page.html"))).toBe(_hygiene_fixtureFileUrl("tmp/browser%20page.html"))
    expect(new URL(normalizeBrowserUrl('./browser page.html')).protocol).toBe('file:')
    expect(new URL(normalizeBrowserUrl('../browser page.html')).protocol).toBe('file:')
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
      scale: 501 / 844
    })
    expect(manager.setViewport('browser-1', 'desktop')).toMatchObject({ viewport: 'desktop' })
    expect(view.webContents.enableDeviceEmulation).toHaveBeenLastCalledWith(expect.objectContaining({
      screenPosition: 'desktop',
      viewSize: { width: 1152, height: 720 }
    }))
    expect(manager.setViewport('browser-1', 'responsive')).toMatchObject({ viewport: 'responsive' })
    expect(view.webContents.deviceEmulation).toBeNull()
    expect(() => manager.setViewport('browser-1', 'watch' as never)).toThrow('Unknown browser viewport')

    manager.openDevTools('browser-1')
    expect(view.webContents.openDevTools).toHaveBeenCalledWith({ mode: 'detach', activate: true })

    await expect(manager.captureScreenshot('browser-1')).resolves.toEqual({
      browserId: 'browser-1',
      navigationId: expect.any(String),
      source: { url: view.webContents.getURL(), title: view.webContents.getTitle(), viewport: null, viewportWarning: expect.stringContaining('could not be confirmed') },
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

  it('keeps the confirmed viewport when native application fails and permits retry', async () => {
    const fixture = fakeWindow(), manager = browserManager(fixture.window)
    const initial = await manager.create('browser-viewport-failure', 'https://example.com/')
    const view = fixture.children[0]!
    manager.setBounds(initial.id, { x: 10, y: 20, width: 720, height: 600 })
    const lastEvent = () => (fixture.sent.at(-1) as { browser: { viewport: string } }).browser.viewport

    view.webContents.enableDeviceEmulation.mockImplementationOnce(() => { throw new Error('Native preset rejected') })
    expect(() => manager.setViewport(initial.id, 'mobile')).toThrow('Native preset rejected')
    expect(await manager.create(initial.id, initial.url)).toMatchObject({
      viewport: 'responsive', navigationId: initial.navigationId, profileId: initial.profileId
    })
    expect(lastEvent()).toBe('responsive')
    expect(fixture.children).toContain(view)
    expect(view.visible).toBe(true)
    expect(view.webContents.isDestroyed()).toBe(false)
    expect(manager.setViewport(initial.id, 'mobile').viewport).toBe('mobile')

    view.webContents.disableDeviceEmulation.mockImplementationOnce(() => { throw new Error('Native reset rejected') })
    expect(() => manager.setViewport(initial.id, 'responsive')).toThrow('Native reset rejected')
    expect((await manager.create(initial.id, initial.url)).viewport).toBe('mobile')
    expect(lastEvent()).toBe('mobile')
    expect(view.webContents.deviceEmulation).not.toBeNull()
    expect(manager.setViewport(initial.id, 'responsive').viewport).toBe('responsive')
    expect(view.webContents.deviceEmulation).toBeNull()
    manager.close(initial.id)
  })

  it('applies custom dimensions on the same page, fits resize and zoom, and retains the original released owner', async () => {
    const fixture = fakeWindow(), manager = browserManager(fixture.window)
    const original = await manager.create('custom-viewport', 'https://example.com/original', 'workspace-a', 'work')
    const sibling = await manager.create('custom-sibling', 'https://example.com/sibling', 'workspace-a', 'personal')
    const view = fixture.children[0]!, contents = view.webContents
    manager.setBounds(original.id, { x: 10, y: 20, width: 600, height: 500 })
    const requested = { width: 412, height: 915, screenPosition: 'mobile' as const }
    const applied = manager.setViewport(original.id, requested)
    expect(applied).toMatchObject({ id: original.id, navigationId: original.navigationId, profileId: 'work', url: original.url, viewport: requested })
    expect(contents.deviceEmulation).toEqual({
      screenPosition: 'mobile', screenSize: { width: 412, height: 915 },
      viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 0,
      viewSize: { width: 412, height: 915 }, scale: 500 / 915
    })
    requested.width = 1000
    expect(Reflect.set(applied.viewport as object, 'width', 2000)).toBe(false)
    expect((await manager.create(original.id, original.url)).viewport).toEqual({ width: 412, height: 915, screenPosition: 'mobile' })
    manager.setViewport(original.id, { width: 915, height: 412, screenPosition: 'mobile' })
    expect(contents.deviceEmulation).toMatchObject({ viewSize: { width: 915, height: 412 }, scale: 600 / 915 })
    manager.setBounds(original.id, { x: 10, y: 20, width: 300, height: 250 })
    expect(contents.deviceEmulation).toMatchObject({ scale: 300 / 915 })
    expect(contents.getZoomFactor()).toBe(DEFAULT_BROWSER_ZOOM_FACTOR)
    manager.setViewport(original.id, { width: 1440, height: 900, screenPosition: 'desktop' })
    expect(contents.deviceEmulation).toMatchObject({ screenPosition: 'desktop', viewSize: { width: 1296, height: 810 }, scale: 300 / 1296 })
    expect(await manager.create(sibling.id, sibling.url)).toEqual(sibling)
    manager.setBounds(original.id, null)
    expect(await release(manager, original.id)).toMatchObject({ status: 'released' })
    const restored = await manager.restore(original.id, { workspaceId: 'workspace-a' })
    expect(restored).toMatchObject({ id: original.id, url: original.url, profileId: 'work', viewport: { width: 1440, height: 900, screenPosition: 'desktop' } })
    expect(fixture.children.at(-1)!.webContents.deviceEmulation).toMatchObject({ screenPosition: 'desktop', viewSize: { width: 1296, height: 810 } })
    manager.close(original.id)
    manager.close(sibling.id)
  })

  it('does not publish rejected custom dimensions or native failures and permits correction on the original owner', async () => {
    const fixture = fakeWindow(), manager = browserManager(fixture.window)
    const initial = await manager.create('custom-rejected', 'https://example.com/original', 'workspace-a', 'work')
    const view = fixture.children[0]!
    const custom = { width: 1366, height: 768, screenPosition: 'desktop' as const }
    manager.setViewport(initial.id, custom)
    const sentBefore = fixture.sent.length, callsBefore = view.webContents.enableDeviceEmulation.mock.calls.length
    for (const viewport of [{ ...custom, width: 0 }, { ...custom, height: 1.5 }, { ...custom, width: 2_147_483_648 }, { ...custom, screenPosition: 'watch' }]) {
      expect(() => manager.setViewport(initial.id, viewport as never)).toThrow('Unknown browser viewport')
    }
    expect(view.webContents.enableDeviceEmulation).toHaveBeenCalledTimes(callsBefore)
    expect(fixture.sent).toHaveLength(sentBefore)
    view.webContents.enableDeviceEmulation.mockImplementationOnce(() => { throw new Error('Native custom size rejected') })
    expect(() => manager.setViewport(initial.id, { width: 430, height: 932, screenPosition: 'mobile' })).toThrow('Native custom size rejected')
    expect(fixture.sent).toHaveLength(sentBefore)
    expect(await manager.create(initial.id, initial.url)).toMatchObject({ viewport: custom, navigationId: initial.navigationId, url: initial.url, profileId: initial.profileId })
    view.webContents.zoomFactor = 2
    expect(() => manager.setViewport(initial.id, { width: 2_147_483_647, height: 768, screenPosition: 'desktop' })).toThrow('current page zoom')
    expect(fixture.sent).toHaveLength(sentBefore)
    view.webContents.zoomFactor = DEFAULT_BROWSER_ZOOM_FACTOR
    expect(manager.setViewport(initial.id, 'responsive').viewport).toBe('responsive')
    expect(await release(manager, initial.id)).toMatchObject({ status: 'released' })
    await expect(manager.restore(initial.id, { viewport: { width: 0, height: 400, screenPosition: 'mobile' } })).rejects.toThrow('Unknown browser viewport')
    expect(await manager.restore(initial.id)).toMatchObject({ id: initial.id, viewport: 'responsive', url: initial.url, profileId: initial.profileId })
    manager.close(initial.id)
  })

  it('creates a cold native owner with confirmed custom dimensions and validates before allocating it', async () => {
    const fixture = fakeWindow(), manager = browserManager(fixture.window)
    await expect(manager.create('custom-cold-invalid', 'https://example.com/', 'workspace-a', 'work', 'normal', { width: -1, height: 844, screenPosition: 'mobile' })).rejects.toThrow('Unknown browser viewport')
    expect(fixture.children).toHaveLength(0)
    const size = { width: 820, height: 1180, screenPosition: 'mobile' as const }
    const created = await manager.create('custom-cold', 'https://example.com/original', 'workspace-a', 'work', 'normal', size)
    expect(created).toMatchObject({ viewport: size, profileId: 'work', url: 'https://example.com/original' })
    expect(fixture.sent.every(event => event.type !== 'updated' || event.browser.viewport !== 'responsive')).toBe(true)
    expect(fixture.children[0]!.webContents.deviceEmulation).toMatchObject({ screenPosition: 'mobile', viewSize: { width: 820, height: 1180 } })
    size.width = 500
    expect((await manager.create(created.id, created.url)).viewport).toEqual({ width: 820, height: 1180, screenPosition: 'mobile' })
    manager.close(created.id)
  })

  it('fits fixed viewports again only when the original Pane size changes', async () => {
    const fixture = fakeWindow(), manager = browserManager(fixture.window)
    const initial = await manager.create('browser-fit', 'https://example.com/')
    const view = fixture.children[0]!, contents = view.webContents
    manager.setBounds(initial.id, { x: 20, y: 40, width: 720, height: 600 })
    manager.setViewport(initial.id, 'mobile')
    expect(contents.deviceEmulation).toMatchObject({ viewSize: { width: 390, height: 844 }, scale: 600 / 844 })
    contents.enableDeviceEmulation.mockClear()
    manager.setBounds(initial.id, { x: 30, y: 50, width: 720, height: 600 })
    expect(contents.enableDeviceEmulation).not.toHaveBeenCalled()
    manager.setBounds(initial.id, { x: 30, y: 50, width: 480, height: 420 })
    expect(contents.deviceEmulation).toMatchObject({ scale: 420 / 844 })
    expect(contents.getZoomFactor()).toBe(DEFAULT_BROWSER_ZOOM_FACTOR)
    expect(await manager.create(initial.id, initial.url)).toMatchObject({ navigationId: initial.navigationId, profileId: initial.profileId })

    manager.setViewport(initial.id, 'desktop')
    expect(contents.deviceEmulation).toMatchObject({ viewSize: { width: 1152, height: 720 }, scale: 480 / 1152 })
    manager.setBounds(initial.id, null)
    manager.setBounds(initial.id, { x: 30, y: 50, width: 1600, height: 1000 })
    expect(contents.deviceEmulation).toMatchObject({ scale: 1 })
    await manager.reload(initial.id)
    expect(contents.deviceEmulation).toMatchObject({ viewSize: { width: 1152, height: 720 }, scale: 1 })
    manager.setViewport(initial.id, 'responsive')
    manager.setBounds(initial.id, { x: 30, y: 50, width: 480, height: 420 })
    expect(contents.deviceEmulation).toBeNull()
    manager.close(initial.id)
  })

  it.each(['get', 'set'] as const)('publishes applied dimensions when native paint policy %s synchronization fails', async method => {
    const fixture = fakeWindow(), manager = browserManager(fixture.window)
    const original = await manager.create('browser-viewport-paint-failure', 'https://example.com/')
    const view = fixture.children[0]!
    manager.setBounds(original.id, { x: 5, y: 6, width: 800, height: 612 })
    const failure = new Error('Native drawing synchronization unavailable')
    const operation = method === 'get' ? view.webContents.getBackgroundThrottling : view.webContents.setBackgroundThrottling
    operation.mockImplementationOnce(() => { throw failure })
    const requested = { width: 820, height: 1180, screenPosition: 'mobile' as const }

    let observedError: unknown
    try { manager.setViewport(original.id, requested) } catch (error) { observedError = error }
    expect(observedError).toBe(failure)
    expect(view.webContents.deviceEmulation).toMatchObject({ viewSize: { width: 820, height: 1180 } })
    expect(fixture.sent.at(-1)).toMatchObject({ type: 'updated', browser: {
      viewport: requested, navigationId: original.navigationId, profileId: original.profileId
    } })
    expect(view.visible).toBe(true)
    expect(view.webContents.backgroundThrottling).toBe(true)
    expect(fixture.children[0]).toBe(view)
    expect(manager.setViewport(original.id, 'responsive').viewport).toBe('responsive')
    manager.close(original.id)
  })

  it('retains both viewport paint and publication failures without closing the original page', async () => {
    const fixture = fakeWindow(), manager = browserManager(fixture.window)
    const original = await manager.create('browser-viewport-paint-publication', 'https://example.com/')
    const view = fixture.children[0]!
    manager.setBounds(original.id, { x: 5, y: 6, width: 800, height: 612 })
    const drawingError = new Error('Native drawing synchronization unavailable')
    const publicationError = new Error('Renderer observation unavailable')
    view.webContents.setBackgroundThrottling.mockImplementationOnce(() => { throw drawingError })
    vi.spyOn(fixture.window.webContents, 'send').mockImplementationOnce(() => { throw publicationError })
    let observedError: unknown
    try { manager.setViewport(original.id, 'mobile') } catch (error) { observedError = error }
    expect(observedError).toBeInstanceOf(AggregateError)
    expect((observedError as AggregateError).errors).toEqual([drawingError, publicationError])
    expect(view.webContents.deviceEmulation).toMatchObject({ viewSize: { width: 390, height: 844 } })
    expect(view.webContents.isDestroyed()).toBe(false)
    expect(fixture.children[0]).toBe(view)
    expect(manager.setViewport(original.id, 'responsive').viewport).toBe('responsive')
    manager.close(original.id)
  })

  it.each([true, false])('synchronizes viewport changes on the original visible page while preserving policy %s', async policy => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    const original = await manager.create('browser-viewport-paint', 'https://example.com/')
    const view = fixture.children[0]!
    view.webContents.backgroundThrottling = policy
    const bounds = { x: 5, y: 6, width: 800, height: 612 }
    manager.setBounds(original.id, bounds)
    view.webContents.setBackgroundThrottling.mockClear()
    const geometry = [...view.boundsHistory]
    const frames: unknown[] = []
    view.webContents.setBackgroundThrottling.mockImplementation(value => {
      expect(value).toBe(policy)
      frames.push(view.webContents.deviceEmulation)
    })

    manager.setViewport(original.id, { width: 820, height: 1180, screenPosition: 'mobile' })
    expect(frames).toEqual([expect.objectContaining({ viewSize: { width: 820, height: 1180 } })])
    const reset = manager.setViewport(original.id, 'responsive')
    expect(frames).toEqual([expect.any(Object), null])
    expect(view.webContents.backgroundThrottling).toBe(policy)
    expect(view.boundsHistory).toEqual(geometry)
    expect(reset).toMatchObject({ navigationId: original.navigationId, profileId: original.profileId, viewport: 'responsive' })

    manager.setBounds(original.id, null)
    manager.setViewport(original.id, 'mobile')
    expect(frames).toHaveLength(2)
    manager.setBounds(original.id, bounds)
    expect(frames).toHaveLength(3)
    expect(fixture.children[0]).toBe(view)
    manager.close(original.id)
  })

  it.each([true, false])('synchronizes a loaded visible page at load and show edges, preserving policy %s', async policy => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    await manager.create('browser-paint', 'https://example.com/')
    const view = fixture.children[0]!
    view.webContents.backgroundThrottling = policy
    expect(view.webContents.setBackgroundThrottling.mock.calls).toEqual([])

    const bounds = { x: 5, y: 6, width: 640, height: 480 }
    manager.setBounds('browser-paint', bounds)
    expect(view.webContents.setBackgroundThrottling.mock.calls).toEqual([[policy]])
    expect(view.boundsHistory).toEqual([fixture.window.getContentBounds(), bounds])
    // Position and size updates are layout work, not another visibility edge.
    manager.setBounds('browser-paint', { ...bounds, x: 9 })
    manager.setBounds('browser-paint', { ...bounds, x: 9 })
    expect(view.webContents.setBackgroundThrottling.mock.calls).toEqual([[policy]])
    const layoutBeforeLoad = [...view.boundsHistory]
    await manager.reload('browser-paint')
    expect(view.webContents.setBackgroundThrottling.mock.calls).toEqual([[policy], [policy]])
    expect(view.boundsHistory).toEqual(layoutBeforeLoad)
    expect(view.webContents.backgroundThrottling).toBe(policy)

    manager.setBounds('browser-paint', null)
    await manager.reload('browser-paint')
    expect(view.visible).toBe(false)
    expect(view.webContents.setBackgroundThrottling.mock.calls).toEqual([[policy], [policy]])
    manager.setBounds('browser-paint', bounds)
    expect(view.webContents.setBackgroundThrottling.mock.calls).toEqual([[policy], [policy], [policy]])
    expect(view.visible).toBe(true)
    manager.close('browser-paint')
  })

  it('waits for loading to finish when the original page becomes visible first', async () => {
    const fixture = fakeWindow()
    let finish!: () => void
    fakeElectron.FakeWebContentsView.nextLoadURLImpl = async (contents, url) => {
      contents.loading = true
      await new Promise<void>(resolve => { finish = () => { contents.finishLoad(url); resolve() } })
    }
    const manager = browserManager(fixture.window)
    await manager.create('browser-loading', 'https://example.com/')
    const view = fixture.children[0]!
    manager.setBounds('browser-loading', { x: 1, y: 2, width: 300, height: 200 })
    expect(view.visible).toBe(true)
    expect(view.webContents.setBackgroundThrottling.mock.calls).toEqual([])
    finish()
    await Promise.resolve()
    expect(view.webContents.setBackgroundThrottling.mock.calls).toEqual([[true]])
    expect(view.boundsHistory).toEqual([fixture.window.getContentBounds(), { x: 1, y: 2, width: 300, height: 200 }])
    manager.close('browser-loading')
  })

  it('waits for did-stop-loading when did-finish-load still reports an in-flight page', async () => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    await manager.create('browser-load-stop', 'https://example.com/')
    const view = fixture.children[0]!
    const bounds = { x: 5, y: 6, width: 300, height: 200 }
    manager.setBounds('browser-load-stop', bounds)
    view.webContents.setBackgroundThrottling.mockClear()

    const loadingAtEvents: boolean[] = []
    view.webContents.on('did-finish-load', () => loadingAtEvents.push(view.webContents.isLoading()))
    view.webContents.on('did-stop-loading', () => loadingAtEvents.push(view.webContents.isLoading()))
    await manager.reload('browser-load-stop')
    expect(loadingAtEvents).toEqual([true, false])
    expect(view.webContents.setBackgroundThrottling.mock.calls).toEqual([[true]])
    expect(view.boundsHistory).toEqual([fixture.window.getContentBounds(), bounds])
    manager.close('browser-load-stop')
  })

  it('synchronizes a loaded profile candidate only after it is the visible authoritative owner', async () => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    await manager.create('browser-profile-paint', 'https://example.com/')
    const original = fixture.children[0]!
    manager.setBounds('browser-profile-paint', { x: 1, y: 2, width: 300, height: 200 })
    let finish!: () => void
    fakeElectron.FakeWebContentsView.nextLoadURLImpl = async (contents, url) => {
      await new Promise<void>(resolve => { finish = () => { contents.finishLoad(url); resolve() } })
    }
    const pending = manager.switchProfile('browser-profile-paint', 'work')
    const candidate = fixture.children[1]!
    expect(candidate.visible).toBe(false)
    expect(candidate.webContents.setBackgroundThrottling.mock.calls).toEqual([])
    finish()
    expect(candidate.webContents.setBackgroundThrottling.mock.calls).toEqual([])
    await pending
    expect(fixture.children).toEqual([candidate])
    expect(candidate.visible).toBe(true)
    expect(candidate.webContents.setBackgroundThrottling.mock.calls).toEqual([[true]])
    expect(original.webContents.setBackgroundThrottling.mock.calls).toEqual([[true]])
    expect(original.webContents.isDestroyed()).toBe(true)
    manager.close('browser-profile-paint')
  })


  it('waits for an in-flight document with a nonempty previous URL before synchronizing its first show', async () => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    await manager.create('browser-known-url-loading', 'https://example.com/old')
    const view = fixture.children[0]!
    expect(view.webContents.getURL()).toBe('https://example.com/old')
    view.webContents.loading = true
    view.webContents.emitDetails('did-start-navigation', {
      url: 'https://example.com/new', isSameDocument: false, isMainFrame: true
    })
    view.webContents.emit('did-start-loading')
    manager.setBounds('browser-known-url-loading', { x: 5, y: 6, width: 300, height: 200 })
    expect(view.visible).toBe(true)
    expect(view.webContents.getURL()).toBe('https://example.com/old')
    expect(view.webContents.setBackgroundThrottling.mock.calls).toEqual([])
    view.webContents.finishLoad('https://example.com/new')
    expect(view.webContents.setBackgroundThrottling.mock.calls).toEqual([[true]])
    expect(view.boundsHistory).toEqual([fixture.window.getContentBounds(), { x: 5, y: 6, width: 300, height: 200 }])
    manager.close('browser-known-url-loading')
  })

  it('waits for a nonempty document URL before synchronizing its first show', async () => {
    const fixture = fakeWindow()
    let finish!: () => void
    fakeElectron.FakeWebContentsView.nextLoadURLImpl = async (contents, url) => {
      await new Promise<void>(resolve => { finish = () => { contents.finishLoad(url); resolve() } })
    }
    const manager = browserManager(fixture.window)
    await manager.create('browser-empty-url', 'https://example.com/new')
    const view = fixture.children[0]!
    expect(view.webContents.getURL()).toBe('')
    expect(view.webContents.isLoading()).toBe(false)
    manager.setBounds('browser-empty-url', { x: 1, y: 2, width: 300, height: 200 })
    expect(view.webContents.setBackgroundThrottling.mock.calls).toEqual([])
    finish()
    await Promise.resolve()
    expect(view.webContents.setBackgroundThrottling.mock.calls).toEqual([[true]])
    manager.close('browser-empty-url')
  })

  it('releases a hidden native owner without deleting the Browser Region and restores its projection', async () => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    const created = await manager.create('browser-release', 'https://example.com/page')
    const view = fixture.children[0]!
    manager.setViewport('browser-release', 'mobile')
    manager.setBounds('browser-release', { x: 2, y: 3, width: 400, height: 500 })
    manager.setBounds('browser-release', null)
    fixture.sent.length = 0
    const messagesBeforeRelease = fixture.messages.length

    await release(manager, 'browser-release')

    expect(fixture.children).toEqual([])
    expect(view.webContents.isDestroyed()).toBe(true)
    expect(manager.usesProfile('default')).toBe(true)
    // A budget release is not a user close: no closed event may remove the Region projection.
    expect(fixture.sent).toContainEqual({type:'released',id:created.id,navigationId:created.navigationId})
    expect(fixture.sent.some(event=>event.type==='closed')).toBe(false)
    const coverage = { type: 'native-coverage-changed', browserId: created.id, coverage: null }
    expect(fixture.messages.slice(messagesBeforeRelease)).toContainEqual({ channel: BROWSER_PRESENTATION_EVENT_CHANNEL, value: coverage })
    expect(fixture.presentationEvents.at(-1)).toEqual(coverage)
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
    await release(manager, 'browser-release-loading')
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
    await release(manager, 'browser-release-failure')
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
          return original!.apply(manager, args)
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
    const closeRejection = expect(closeSwitch).rejects.toThrow('owner released during profile switch')
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

  /**
   * 这条断言原本叫 'leaves popup and opener behavior to Chromium'，钉的是 `windowOpenHandler === null`
   * ——`649df3a2` 删掉整个 handler 时立的。**现在正面推翻它**：handler 装回来了，但 649df3a2 修的那件事
   * 仍然成立，而判据从「有没有 handler」换成了「handler 对 http(s) 怎么答」。
   *
   * 为什么必须改而不能删：那条断言是一次决定的唯一记录。删掉它，下一个人只会看到「这里本来就该有个
   * handler」，而 649df3a2 修的 bug（每一个 window-open 都被压进同一个 view、弹窗语义全没了）会悄悄
   * 回来，没有任何东西拦得住。
   */
  it('hands app-link popups off and leaves every other window.open to Chromium', async () => {
    const fixture = fakeWindow()
    const host = appLinkHost()
    const manager = new BrowserViewManager(fixture.window as never, profiles, new BrowserRefLedgerStore(
      join(mkdtempSync(join(tmpdir(), 'agentmux-bvm-')), 'ref-ledger.json')
    ), host)

    await manager.create('browser-native-window-open', 'https://example.com')
    const contents = fixture.children[0]!.webContents
    const handler = contents.windowOpenHandler
    expect(handler, 'handler 没装上——应用链接的弹窗会开出一个没人管的窗口').not.toBeNull()

    // 承重的反向一半。`649df3a2` 删掉的那段正是把**每一个** window-open 都 `this.navigate(...)` 再
    // deny；回到那个形状就是把它修的 bug 重新引入。'allow' 就是「没有 handler」时的默认动作。
    for (const url of ['https://example.com/popup', 'http://localhost:4173/x', 'about:blank']) {
      expect(handler!({ url }), `${url} 的弹窗被截走了`).toMatchObject({ action: 'allow' })
    }
    // 改道的另一个形状是偷偷把当前 view 导过去。它不会体现在返回值上，所以单独判一次。
    expect(contents.getURL(), '普通弹窗把当前页改道了').toBe('https://example.com/')
    expect(host.opened, '普通弹窗被甩给了系统浏览器').toEqual([])

    // 正向：应用链接才归我们，且走的是和导航路同一条问答路（这里没记过，所以挂出提问、不开）。
    expect(handler!({ url: 'customapp://open?token=9' })).toEqual({ action: 'deny' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(manager.setViewport('browser-native-window-open', 'responsive').appLinkPrompt)
      .toEqual({ url: 'customapp://open?token=9', scheme: 'customapp' })
    expect(host.opened, '还没问就交出去了').toEqual([])
  })

  it('allows controlled local files but blocks unsupported page navigation and redirects', async () => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    await manager.create('browser-guarded', 'https://example.com')
    const view = fixture.children[0]!
    const navigate = view.webContents.listeners.get('will-navigate')![0]!
    const redirect = view.webContents.listeners.get('will-redirect')![0]!
    const blockedNavigation = {
      url: _reshape_fixtureFileUrl("browser-local-file"),
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

  it('keeps an unexpectedly destroyed native owner recoverable through the actual Store and the same Browser identity', async () => {
    const { useAppStore } = await import('../src/renderer/src/store.js')
    const { createWorkbenchTab, addWorkbenchRegion } = await import('../src/renderer/src/lib/workbench-tabs.js')
    const { createWorkspaceLayout } = await import('@agentmux/layout')
    const original = useAppStore.getState()
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    const send = fixture.window.webContents.send
    fixture.window.webContents.send = (channel, event) => {
      send(channel, event)
      if (channel === BROWSER_EVENT_CHANNEL) useAppStore.getState().applyBrowserEvent(event as BrowserEvent)
    }
    try {
      await manager.create('browser-destroyed', 'https://initial.example/')
      const current = await manager.switchProfile('browser-destroyed', 'work')
      const view = fixture.children[0]!
      let tab = createWorkbenchTab('owner-loss-tab', {
        ...current, kind: 'browser', browserId: current.id, regionId: 'owner-loss-region', workspaceId: 'workspace-a'
      })
      tab = addWorkbenchRegion(tab, 'owner-loss-region', 'right', { kind: 'file', regionId: 'owner-loss-sibling', workspaceId: 'workspace-a', path: 'draft.md' })
      useAppStore.setState({ tabs: { [tab.id]: tab }, layouts: { 'workspace-a': createWorkspaceLayout('owner-loss-group', [tab.id]) } })
      const before = useAppStore.getState()
      // A destroyed WebContents has no readable live navigation/title/history; the handler must use
      // only its existing retained owner descriptor, never a fabricated complete snapshot.
      vi.spyOn(view.webContents, 'getURL').mockImplementation(() => { throw new Error('Destroyed getURL') })
      vi.spyOn(view.webContents, 'getTitle').mockImplementation(() => { throw new Error('Destroyed getTitle') })
      fixture.sent.length = 0
      view.webContents.close()
      expect(fixture.children).toEqual([])
      expect(fixture.sent).toEqual([{ type: 'unavailable', id: current.id, error: 'Browser native page was destroyed. Retry to reopen this page.' }])
      const after = useAppStore.getState()
      expect(Object.keys(after.tabs[tab.id]!.regions)).toEqual(['owner-loss-region', 'owner-loss-sibling'])
      expect(after.tabs[tab.id]!.layout).toBe(before.tabs[tab.id]!.layout)
      expect(after.layouts).toBe(before.layouts)
      expect(after.tabs[tab.id]!.regions['owner-loss-sibling']).toBe(before.tabs[tab.id]!.regions['owner-loss-sibling'])
      expect(after.tabs[tab.id]!.regions['owner-loss-region']).toMatchObject({ error: expect.stringContaining('Retry'), url: current.url, profileId: 'work' })
      expect(manager.resourceOwnerCounts()).toEqual({ browserViews: 0, releasedBrowserViews: 1 })
      expect(await manager.create(current.id, 'https://stale.example/')).toMatchObject({ id: current.id, url: current.url, profileId: 'work', error: null })
      expect(fixture.children).toHaveLength(1)
      expect(useAppStore.getState().tabs[tab.id]!.regions['owner-loss-region']).toMatchObject({ error: null })
    } finally { manager.dispose(); useAppStore.setState(original, true) }
  })

  it('observes an input frame inside the original capture owner without extra captures or layout writes', async () => {
    const fixture = fakeWindow(), manager = browserManager(fixture.window)
    await manager.create('browser-frame', 'https://page.invalid/original')
    const view = fixture.children[0]!, events: string[] = []
    const inputContext = manager.inputContext.bind(manager)
    vi.spyOn(manager, 'inputContext').mockImplementation((id, hostId) => { events.push('observation'); return inputContext(id, hostId) })
    const originalCapture = view.webContents.capturePageImpl
    view.webContents.capturePageImpl = async () => { events.push('pixels'); return await originalCapture() }
    const bounds = [...view.boundsHistory], result = await manager.captureInputFrame('browser-frame', 'local')
    expect(events).toEqual(['observation', 'pixels', 'observation'])
    expect(result.before.browser).toEqual({ hostId: 'local', browserId: 'browser-frame', navigationId: result.capture.navigationId })
    expect(result.after.browser).toEqual(result.before.browser)
    expect(result.capture.image.width).toBe(2)
    expect(view.webContents.capturePage).toHaveBeenCalledOnce()
    expect(view.boundsHistory).toEqual(bounds)
    vi.restoreAllMocks(); manager.dispose()
  })

  it('refuses a late input frame after original navigation changes without disabling its new page', async () => {
    const fixture = fakeWindow(), manager = browserManager(fixture.window)
    await manager.create('browser-frame', 'https://page.invalid/original')
    const view = fixture.children[0]!, originalCapture = view.webContents.capturePageImpl
    view.webContents.capturePageImpl = async () => {
      const image = await originalCapture()
      view.webContents.finishLoad('https://page.invalid/new')
      return image
    }
    await expect(manager.captureInputFrame('browser-frame', 'local')).rejects.toThrow('Browser page changed while the screenshot was being captured')
    expect(manager.inputContext('browser-frame', 'local')?.page.url).toBe('https://page.invalid/new')
    manager.dispose()
  })

  it('rejects a screenshot that completes after the page navigation changes', async () => {
    const fixture = fakeWindow()
    const manager = browserManager(fixture.window)
    const created = await manager.create('browser-capture', 'https://example.com')
    const view = fixture.children[0]!
    let resolveCapture!: (image: Awaited<ReturnType<typeof view.webContents.capturePage>>) => void
    view.webContents.capturePageImpl = async () => await new Promise((resolve) => { resolveCapture = resolve })

    const pending = manager.captureScreenshot('browser-capture')
    await vi.waitFor(() => expect(resolveCapture).toBeTypeOf('function'))
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
    await vi.waitFor(() => expect(resolveCapture).toBeTypeOf('function'))
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
    let preflightStarted!: () => void
    const preflight = new Promise<void>((resolve) => { preflightStarted = resolve })
    let delayFirstCancel = true
    view.webContents.executeJavaScriptInIsolatedWorldImpl = async (_worldId, scripts) => {
      const script = scripts[0]?.code ?? ''
      if (delayFirstCancel && script.includes('const barrier =')) {
        delayFirstCancel = false
        return await new Promise<boolean>((resolve) => { resolvePreflight = resolve; preflightStarted() })
      }
      return script.includes('Select an element') ? null : true
    }
    view.webContents.executeJavaScriptInIsolatedWorld.mockClear()

    const pending = manager.selectElement('browser-selection-race')
    await preflight
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


describe('BrowserViewManager direct candidate destruction', () => {
  it('T049 direct destroyed candidate reports detach failure without losing the original or blindly retrying', async () => {
    const fixture = fakeWindow(), manager = browserManager(fixture.window)
    const current = await manager.create('cleanup-direct-candidate', 'https://original.example/path', 'workspace-a', 'personal')
    await manager.create('cleanup-direct-neighbor', 'https://neighbor.example/')
    const original = fixture.children[0]!, neighbor = fixture.children[1]!
    let finish!: () => void
    fakeElectron.FakeWebContentsView.nextLoadURLImpl = async (contents, url) => {
      await new Promise<void>(resolve => { finish = () => { contents.finishLoad(url); resolve() } })
    }
    const switching = manager.switchProfile(current.id, 'work').catch(error => error as Error)
    const candidate = fixture.children[2]!
    // Read the original Main record to verify this exact pending reference survives. No test owner
    // supplies facts to the manager, and the actual native destroyed listener below drives cleanup.
    const record = (manager as any).entries.get(current.id)
    const pending = record.pendingSwitch
    expect(pending.view).toBe(candidate)
    const nativeDetach = fixture.window.contentView.removeChildView
    const detach = vi.spyOn(fixture.window.contentView, 'removeChildView').mockImplementation(view => {
      if (view === candidate) throw new Error('direct candidate detach blocked')
      nativeDetach(view)
    })
    const close = vi.spyOn(candidate.webContents, 'close')
    fixture.sent.length = 0
    expect(() => candidate.webContents.close()).not.toThrow()
    const failed = await switching
    expect(failed.message).toContain('direct candidate detach blocked')
    expect(fixture.sent).toEqual([{ type: 'updated', browser: expect.objectContaining({
      id: current.id, url: current.url, profileId: 'personal', activity: expect.objectContaining({ warning: expect.stringContaining('direct candidate detach blocked') })
    }) }])
    expect(detach).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(record.pendingSwitch).toBe(pending)
    expect(pending).toMatchObject({ attached: true, released: false })
    expect((manager as any).releasedEntries.has(current.id)).toBe(false)
    expect(manager.usesProfile('work')).toBe(true)
    expect(original.webContents.isDestroyed()).toBe(false)
    expect(neighbor.webContents.isDestroyed()).toBe(false)
    expect(await manager.create(current.id, 'https://stale.example/', 'workspace-a')).toMatchObject({ id: current.id, url: current.url, profileId: 'personal' })
    finish()
    await Promise.resolve(); await Promise.resolve()
    expect(detach).toHaveBeenCalledTimes(1)
    expect(record.pendingSwitch).toBe(pending)
    expect(fixture.children).toEqual([original, neighbor, candidate])
    detach.mockImplementation(nativeDetach)
    const repaired = await manager.navigate(current.id, 'https://repaired.example/')
    expect(repaired).toMatchObject({ id: current.id, profileId: 'personal', url: 'https://repaired.example/' })
    expect(repaired.activity).not.toHaveProperty('warning')
    expect(detach).toHaveBeenCalledTimes(2)
    expect(detach.mock.calls[1]![0]).toBe(candidate)
    expect(close).toHaveBeenCalledTimes(1)
    expect(record.pendingSwitch).toBeNull()
    expect(pending).toMatchObject({ attached: false, released: true })
    expect(manager.usesProfile('work')).toBe(false)
    expect(fixture.children).toEqual([original, neighbor])
    expect(neighbor.webContents.getURL()).toBe('https://neighbor.example/')
    expect(manager.resourceOwnerCounts()).toEqual({ browserViews: 2, releasedBrowserViews: 0 })
    manager.close(current.id); manager.close('cleanup-direct-neighbor')
  })
})


describe('BrowserViewManager healthy page during failed candidate cleanup', () => {
  it('T049 failed candidate cleanup keeps original navigation and reload usable with a persistent cause', async () => {
    const fixture = fakeWindow(), manager = browserManager(fixture.window)
    const current = await manager.create('cleanup-healthy-page', 'https://original.example/', 'workspace-a', 'personal')
    const original = fixture.children[0]!
    let finish!: () => void
    fakeElectron.FakeWebContentsView.nextLoadURLImpl = async (contents, url) => {
      await new Promise<void>(resolve => { finish = () => { contents.finishLoad(url); resolve() } })
    }
    const switching = manager.switchProfile(current.id, 'work').catch(error => error as Error)
    const candidate = fixture.children[1]!, record = (manager as any).entries.get(current.id), pending = record.pendingSwitch
    const nativeDetach = fixture.window.contentView.removeChildView
    const detach = vi.spyOn(fixture.window.contentView, 'removeChildView').mockImplementation(view => {
      if (view === candidate) throw new Error('healthy page candidate detach blocked')
      nativeDetach(view)
    })
    const close = vi.spyOn(candidate.webContents, 'close').mockImplementation(() => { throw new Error('healthy page candidate close blocked') })
    const load = vi.spyOn(original.webContents, 'loadURL'), reload = vi.spyOn(original.webContents, 'reload')
    const navigated = await manager.navigate(current.id, 'https://navigated.example/').then(value => value, error => ({ failure: error.message }))
    expect(navigated).toMatchObject({ id: current.id, url: 'https://navigated.example/', profileId: 'personal', activity: expect.objectContaining({ warning: expect.stringContaining('healthy page candidate close blocked') }) })
    expect(load).toHaveBeenCalledWith('https://navigated.example/')
    expect(detach).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect((await switching).message).toContain('healthy page candidate close blocked')
    expect(record.pendingSwitch).toBe(pending)
    expect(candidate.webContents.isDestroyed()).toBe(false)
    expect(original.webContents.isDestroyed()).toBe(false)
    const reloaded = await manager.reload(current.id).then(value => value, error => ({ failure: error.message }))
    expect(reloaded).toMatchObject({ id: current.id, url: 'https://navigated.example/', activity: expect.objectContaining({ warning: expect.stringContaining('healthy page candidate detach blocked') }) })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(detach).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledTimes(2)
    finish(); await Promise.resolve(); await Promise.resolve()
    expect(detach).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledTimes(2)
    expect(record.pendingSwitch).toBe(pending)
    await expect(release(manager, current.id)).resolves.toMatchObject({status:'retained',reasons:['profile-switch']})
    expect(() => manager.close(current.id)).toThrow('healthy page candidate close blocked')
    const views = fakeElectron.FakeWebContentsView.instances.length
    await expect(manager.switchProfile(current.id, 'default')).rejects.toThrow('healthy page candidate close blocked')
    expect(fakeElectron.FakeWebContentsView.instances).toHaveLength(views)
    expect(record.pendingSwitch).toBe(pending)
    expect(original.webContents.isDestroyed()).toBe(false)
    detach.mockImplementation(nativeDetach); close.mockRestore()
    const repaired = await manager.navigate(current.id, 'https://repaired.example/')
    expect(repaired).toMatchObject({ id: current.id, url: 'https://repaired.example/', profileId: 'personal' })
    expect(repaired.activity).not.toHaveProperty('warning')
    expect(candidate.webContents.isDestroyed()).toBe(true)
    expect(record.pendingSwitch).toBeNull()
    expect(manager.usesProfile('work')).toBe(false)
    // The same pending record owns only its published cleanup cause. A different existing
    // resource warning remains visible when cleanup of another candidate succeeds.
    fakeElectron.FakeWebContentsView.nextLoadURLImpl = async () => await new Promise<void>(() => {})
    const nextSwitch = manager.switchProfile(current.id, 'work').catch(error => error as Error)
    const nextCandidate = fixture.children[1]!
    detach.mockImplementation(view => { if (view === nextCandidate) throw new Error('next candidate detach blocked'); nativeDetach(view) })
    const nextClose = vi.spyOn(nextCandidate.webContents, 'close').mockImplementation(() => { throw new Error('next candidate close blocked') })
    expect(await manager.reload(current.id)).toMatchObject({ activity: expect.objectContaining({ warning: expect.stringContaining('next candidate close blocked') }) })
    expect((await nextSwitch).message).toContain('next candidate close blocked')
    record.activity = { ...record.activity, warning: 'Independent upload staging warning' }
    detach.mockImplementation(nativeDetach); nextClose.mockRestore()
    expect(await manager.reload(current.id)).toMatchObject({ activity: expect.objectContaining({ warning: 'Independent upload staging warning' }) })
    expect(nextCandidate.webContents.isDestroyed()).toBe(true)
    expect(record.pendingSwitch).toBeNull()
    manager.close(current.id)
  })
})

it('native attachment lookup preserves the exact current view and window without reading page titles', async () => {
  const fixture = fakeWindow(), manager = browserManager(fixture.window)
  for (let index = 0; index < 24; index++) await manager.create(`unrelated-native-owner-${index}`, 'https://example.org')
  const originalAttachments = new Set(fixture.children)
  const original = await manager.create('exact-native-owner', 'https://example.org')
  const view = fixture.children.find(view => !originalAttachments.has(view))!
  expect(manager.nativeOwnerForView(view as never)).toBeUndefined()
  // Native bounds publish retention; measure only the physical attachment lookup below.
  manager.setBounds('exact-native-owner', { x: 10, y: 20, width: 120, height: 80 })
  const records = (manager as unknown as { entries: Map<string, { view: unknown }> }).entries
  const unrelatedReads = vi.fn()
  const restore = [...records.entries()].filter(([id]) => id !== 'exact-native-owner').map(([, entry]) => {
    const descriptor = Object.getOwnPropertyDescriptor(entry, 'view')!
    Object.defineProperty(entry, 'view', { configurable: true, get: () => { unrelatedReads(); return descriptor.value } })
    return () => Object.defineProperty(entry, 'view', descriptor)
  })
  const title = vi.spyOn(view.webContents, 'getTitle').mockImplementation(() => { throw new Error('A native attachment does not need its title') })
  try {
    expect(manager.nativeOwnerForView(view as never, fixture.window)).toMatchObject({ browserId: 'exact-native-owner', view })
    expect(manager.nativeOwnerForView(view as never, fakeWindow().window)).toBeUndefined()
    expect(manager.nativeOwnerForView({} as never, fixture.window)).toBeUndefined()
    manager.setBounds('exact-native-owner', { x: 10, y: 20, width: 120, height: 80 })
    manager.setBounds('exact-native-owner', { x: 10, y: 20, width: 120, height: 80 })
    expect(unrelatedReads, 'An exact physical attachment lookup must not read unrelated Browser entries').not.toHaveBeenCalled()
    expect(title).not.toHaveBeenCalled()
    title.mockRestore()
    manager.setBounds('exact-native-owner', null)
    expect(await manager.release('exact-native-owner', original.navigationId)).toMatchObject({ status: 'released' })
    expect(manager.nativeOwnerForView(view as never, fixture.window)).toBeUndefined()
    await manager.restore('exact-native-owner')
    manager.setBounds('exact-native-owner', { x: 10, y: 20, width: 120, height: 80 })
    expect(manager.nativeOwner('exact-native-owner', fixture.window)).toBeDefined()
    expect(manager.nativeOwnerForView(view as never, fixture.window), 'An old physical attachment must not gain the restored Browser owner').toBeUndefined()
  } finally {
    restore.forEach(restore => restore())
    title.mockRestore()
    manager.dispose()
  }
})

it('native chrome demand follows successful physical Browser owner bounds and releases without a second registry', async () => {
  const fixture = fakeWindow(), manager = browserManager(fixture.window)
  const changes = vi.fn(); manager.onNativeVisibilityChange = changes
  expect(manager.nativeBrowserVisibility()).toEqual({ revision: 0, bounds: [] })
  await manager.create('chrome-demand-page', 'https://example.org')
  expect(manager.nativeBrowserVisibility().bounds).toEqual([])
  const bounds = { x: 10, y: 20, width: 120, height: 80 }
  manager.setBounds('chrome-demand-page', bounds)
  expect(changes.mock.calls.at(-1)?.[0]).toEqual({ revision: 1, bounds: [bounds] })
  const detached = manager.nativeBrowserVisibility(); detached.bounds[0]!.x = 999
  expect(manager.nativeBrowserVisibility().bounds).toEqual([bounds])
  manager.setBounds('chrome-demand-page', { ...bounds })
  expect(changes).toHaveBeenCalledTimes(1)
  manager.setBounds('chrome-demand-page', { ...bounds, y: 30 })
  expect(changes.mock.calls.at(-1)?.[0]).toEqual({ revision: 2, bounds: [{ ...bounds, y: 30 }] })
  manager.setBounds('chrome-demand-page', null)
  expect(changes.mock.calls.at(-1)?.[0]).toEqual({ revision: 3, bounds: [] })
  manager.setBounds('chrome-demand-page', bounds)
  expect(await release(manager, 'chrome-demand-page')).toMatchObject({status:'retained',reasons:['visible']})
  expect(manager.nativeBrowserVisibility().bounds).toEqual([bounds])
  manager.setBounds('chrome-demand-page', null)
  await release(manager, 'chrome-demand-page')
  expect(changes.mock.calls.at(-1)?.[0].bounds).toEqual([])
  expect(manager.nativeBrowserVisibility().bounds).toEqual([])
  manager.dispose()
})


describe('reported Browser favicon ownership', () => {
  it('fetches relative SVG and absolute PNG through the original Profile session and publishes only data artwork', async () => {
    const fixture = fakeWindow(), manager = browserManager(fixture.window)
    await manager.create('icon', 'https://page.example/sub/page', null, 'work')
    const contents = fixture.children[0]!.webContents
    contents.session.fetch.mockResolvedValueOnce(new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { headers: { 'content-type': 'image/svg+xml' } }))
    contents.emit('page-favicon-updated', ['../real.svg'])
    await vi.waitFor(() => expect(fixture.sent.at(-1)).toMatchObject({ type: 'updated', browser: { faviconDataUrl: expect.stringMatching(/^data:image\/svg\+xml;base64,/) } }))
    expect(contents.session.fetch).toHaveBeenCalledWith('https://page.example/real.svg', expect.objectContaining({ credentials: 'include', signal: expect.any(AbortSignal) }))
    contents.emit('page-favicon-updated', ['../real.svg'])
    expect(contents.session.fetch).toHaveBeenCalledOnce()
    const current = await manager.create('icon', 'about:blank')
    expect(current.profileId).toBe('work'); expect(current.faviconDataUrl).toMatch(/^data:image\/svg\+xml;base64,/)
    contents.session.fetch.mockResolvedValueOnce(new Response(png(), { headers: { 'content-type': 'image/png' } }))
    contents.emit('page-favicon-updated', ['https://cdn.example/icon.png'])
    await vi.waitFor(() => expect(fixture.sent.at(-1)).toMatchObject({ browser: { faviconDataUrl: expect.stringMatching(/^data:image\/png;base64,/) } }))
    expect(contents.session.fetch.mock.calls.at(-1)![0]).toBe('https://cdn.example/icon.png')
    await release(manager, 'icon')
  })

  it('rejects a late icon after navigation while keeping the current Browser usable', async () => {
    const fixture = fakeWindow(), manager = browserManager(fixture.window)
    await manager.create('late-icon', 'https://page.example/old')
    const contents = fixture.children[0]!.webContents
    let finish!: (response: Response) => void
    contents.session.fetch.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    contents.emit('page-favicon-updated', ['https://page.example/slow.svg'])
    const previousSignal = contents.session.fetch.mock.calls[0]![1]!.signal!
    await manager.navigate('late-icon', 'https://page.example/current')
    expect(previousSignal.aborted).toBe(true)
    finish(new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }))
    await new Promise(resolve => setTimeout(resolve, 0))
    const current = await manager.create('late-icon', 'about:blank')
    expect(current.url).toBe('https://page.example/current'); expect(current.error).toBeNull(); expect(current.faviconDataUrl).toBeUndefined()
    await release(manager, 'late-icon')
  })

  it('retains candidate Profile favicon events and ignores replaced or released native owners', async () => {
    const fixture = fakeWindow(), manager = browserManager(fixture.window)
    await manager.create('profile-icon', 'https://page.example/first')
    const original = fixture.children[0]!.webContents
    fakeElectron.FakeWebContentsView.nextLoadURLImpl = async (contents, url) => {
      contents.finishLoad(url)
      contents.session.fetch.mockResolvedValue(new Response(png(), { headers: { 'content-type': 'image/png' } }))
      contents.emit('page-favicon-updated', ['https://page.example/profile.png'])
    }
    await manager.switchProfile('profile-icon', 'work')
    const candidate = fixture.children[0]!.webContents
    expect(candidate).not.toBe(original)
    await vi.waitFor(() => expect(fixture.sent.at(-1)).toMatchObject({ browser: { profileId: 'work', faviconDataUrl: expect.stringMatching(/^data:image\/png;base64,/) } }))
    original.emit('page-favicon-updated', ['https://page.example/obsolete.png'])
    expect(original.session.fetch).not.toHaveBeenCalled()
    let finish!: (response: Response) => void
    candidate.session.fetch.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    candidate.emit('page-favicon-updated', ['https://page.example/release.svg'])
    const signal = candidate.session.fetch.mock.calls.at(-1)![1]!.signal!
    expect(await release(manager, 'profile-icon')).toMatchObject({status:'unknown',reasons:['document-unconfirmed']})
    expect(signal.aborted).toBe(false)
    manager.close('profile-icon')
    const sent = fixture.sent.length
    expect(signal.aborted).toBe(true)
    finish(new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fixture.sent).toHaveLength(sent)
  })
})

it('aborts pending favicon observation on explicit Browser close', async () => {
  const fixture = fakeWindow(), manager = browserManager(fixture.window)
  await manager.create('closed-icon', 'https://page.example/first')
  const contents = fixture.children[0]!.webContents
  contents.session.fetch.mockReturnValue(new Promise(() => {}))
  contents.emit('page-favicon-updated', ['https://page.example/slow'])
  const signal = contents.session.fetch.mock.calls[0]![1]!.signal!
  manager.close('closed-icon')
  expect(signal.aborted).toBe(true)
})

it('clears a cached reported favicon when the original Browser changes document', async () => {
  const fixture = fakeWindow(), manager = browserManager(fixture.window)
  try {
    await manager.create('new-document-icon', 'https://page.example/first')
    const contents = fixture.children[0]!.webContents
    contents.session.fetch.mockResolvedValue(new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }))
    contents.emit('page-favicon-updated', ['https://page.example/icon.svg'])
    await vi.waitFor(() => expect(fixture.sent.at(-1)).toMatchObject({ browser: { faviconDataUrl: expect.any(String) } }))
    const next = await manager.navigate('new-document-icon', 'https://other.example/second')
    expect(next.faviconDataUrl).toBeUndefined(); expect(next.error).toBeNull()
    expect(next.url).toBe('https://other.example/second')
  } finally { manager.close('new-document-icon') }
})


it('reobserves a still-declared native favicon after same-URL navigate and ordinary reload without another icon event', async () => {
  const fixture = fakeWindow(), manager = browserManager(fixture.window), url = 'https://page.example/unchanged'
  try {
    await manager.create('reloaded-icon', url)
    const contents = fixture.children[0]!.webContents
    contents.session.fetch.mockImplementation(async () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }))
    contents.emit('page-favicon-updated', ['https://page.example/real.svg'])
    await vi.waitFor(() => expect(fixture.sent.at(-1)).toMatchObject({ browser: { faviconDataUrl: expect.any(String) } }))
    await manager.navigate('reloaded-icon', url)
    await vi.waitFor(() => expect(contents.session.fetch).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(fixture.sent.at(-1)).toMatchObject({ browser: { faviconDataUrl: expect.any(String) } }))
    await manager.reload('reloaded-icon')
    await vi.waitFor(() => expect(contents.session.fetch).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => expect(fixture.sent.at(-1)).toMatchObject({ browser: { faviconDataUrl: expect.any(String) } }))
    expect(contents.executeJavaScript).toHaveBeenCalledTimes(2)
    expect(contents.executeJavaScript.mock.calls[0]![0]).toContain('link[rel~="icon" i]')
    expect(contents.executeJavaScript.mock.calls[0]![0]).toContain('https://page.example/real.svg')
    expect((await manager.create('reloaded-icon', 'about:blank')).url).toBe(url)
  } finally { manager.close('reloaded-icon') }
})

it('keeps generic artwork when the same URL reload removes its earlier declared favicon', async () => {
  const fixture = fakeWindow(), manager = browserManager(fixture.window), url = 'https://page.example/dynamic'
  try {
    await manager.create('removed-icon', url)
    const contents = fixture.children[0]!.webContents
    contents.session.fetch.mockImplementation(async () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }))
    contents.emit('page-favicon-updated', ['https://page.example/old.svg'])
    await vi.waitFor(() => expect(fixture.sent.at(-1)).toMatchObject({ browser: { faviconDataUrl: expect.any(String) } }))
    contents.executeJavaScript.mockResolvedValue(false)
    await manager.navigate('removed-icon', url)
    await vi.waitFor(() => expect(contents.executeJavaScript).toHaveBeenCalledOnce())
    await new Promise(resolve => setTimeout(resolve, 0))
    const current = await manager.create('removed-icon', 'about:blank')
    expect(contents.session.fetch).toHaveBeenCalledOnce()
    expect(current.faviconDataUrl).toBeUndefined(); expect(current.url).toBe(url); expect(current.error).toBeNull()
  } finally { manager.close('removed-icon') }
})

it('keeps a later native favicon when an earlier reload declaration check returns late', async () => {
  const fixture = fakeWindow(), manager = browserManager(fixture.window), url = 'https://page.example/late-declaration'
  try {
    await manager.create('late-declaration-icon', url)
    const contents = fixture.children[0]!.webContents
    contents.session.fetch.mockImplementation(async () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }))
    contents.emit('page-favicon-updated', ['https://page.example/original.svg'])
    await vi.waitFor(() => expect(fixture.sent.at(-1)).toMatchObject({ browser: { faviconDataUrl: expect.any(String) } }))
    let finish!: (confirmed: boolean) => void
    contents.executeJavaScript.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    await manager.reload('late-declaration-icon')
    contents.session.fetch.mockImplementation(async () => new Response('<svg id="later"/>', { headers: { 'content-type': 'image/svg+xml' } }))
    contents.emit('page-favicon-updated', ['https://page.example/later.svg'])
    const later = 'data:image/svg+xml;base64,' + Buffer.from('<svg id="later"/>').toString('base64')
    await vi.waitFor(() => expect(fixture.sent.at(-1)).toMatchObject({ browser: { faviconDataUrl: later } }))
    finish(false)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect((await manager.create('late-declaration-icon', 'about:blank')).faviconDataUrl).toBe(later)
  } finally { manager.close('late-declaration-icon') }
})

describe('Browser recovery preview producer', () => {
  const image = () => ({ isEmpty: () => false, getSize: () => ({ width: 1600, height: 1000 }),
    resize: vi.fn(() => ({ toJPEG: vi.fn(() => Buffer.from([0xff, 0xd8, 0xff, 0xd9])) })) })
  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'amx-preview-source-')); privateLedgerRoots.push(root)
    const store = new BrowserRecoveryPreviewStore(join(root, 'previews'))
    const record = vi.spyOn(store, 'record'), fixture = fakeWindow(), manager = browserManager(fixture.window, store)
    return { store, record, fixture, manager }
  }
  const bounds = { x: 1, y: 2, width: 800, height: 500 }

  it('samples only the related visible loaded document once, with a bounded native image and original scope', async () => {
    const { store, record, fixture, manager } = setup()
    try {
      const browser = await manager.create('appearance', 'https://preview.invalid/original', 'workspace', 'personal')
      const contents = fixture.children[0]!.webContents, pixels = image()
      contents.capturePageImpl = async () => pixels as never
      expect(contents.capturePage).not.toHaveBeenCalled()
      manager.setBounds(browser.id, bounds)
      await vi.waitFor(() => expect(record).toHaveBeenCalledOnce())
      await store.flush()
      expect(pixels.resize).toHaveBeenCalledExactlyOnceWith({ width: 480, height: 300, quality: 'good' })
      const scope = manager.recoveryPreviewScope(browser.id)!
      expect(scope).toEqual({ browserId: browser.id, workspaceId: 'workspace', mode: 'normal', profileId: 'personal' })
      expect(await store.read(scope)).toMatchObject({ status: 'available', preview: {
        url: 'https://preview.invalid/original', title: 'preview.invalid', navigationId: browser.navigationId,
        image: { width: 480, height: 300 }
      } })
      contents.emit('did-stop-loading'); manager.setBounds(browser.id, { ...bounds, x: 10 })
      expect(contents.capturePage).toHaveBeenCalledOnce()
      manager.setBounds(browser.id, null)
      expect(manager.recoveryPreviewScope(browser.id)).toEqual(scope)
      await manager.release(browser.id, browser.navigationId)
      expect(manager.recoveryPreviewScope(browser.id)).toEqual(scope)
      expect(await store.read(scope)).toMatchObject({ status: 'available' })
    } finally { manager.dispose(); await store.dispose() }
  })

  it.each(['navigation', 'frame', 'hidden', 'close'] as const)('does not publish stale pixels after %s changes during native capture', async change => {
    const { store, record, fixture, manager } = setup()
    const browser = await manager.create('stale-appearance', 'https://preview.invalid/old', 'workspace', 'personal')
    const contents = fixture.children[0]!.webContents
    let finish!: (value: never) => void
    contents.capturePageImpl = () => new Promise(resolve => { finish = resolve })
    manager.setBounds(browser.id, bounds)
    expect(contents.capturePage).toHaveBeenCalledOnce()
    const scope = manager.recoveryPreviewScope(browser.id)!
    if (change === 'navigation') {
      contents.loading = true
      contents.emitDetails('did-start-navigation', { url: 'https://preview.invalid/later', isMainFrame: true, isSameDocument: false })
    } else if (change === 'frame') (contents.mainFrame as any).frameToken = 'replacement-document'
    else if (change === 'hidden') manager.setBounds(browser.id, null)
    else await manager.close(browser.id)
    finish(image() as never)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(record).not.toHaveBeenCalled()
    expect(await store.read(scope)).toEqual({ status: 'missing' })
    manager.dispose(); await store.dispose()
  })

  it('keeps native capture failure local while the original Browser and retry remain usable', async () => {
    const { store, fixture, manager } = setup(), log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const browser = await manager.create('capture-unavailable', 'https://preview.invalid/page')
      fixture.children[0]!.webContents.capturePageImpl = async () => { throw new Error('Fixture compositor unavailable') }
      manager.setBounds(browser.id, bounds)
      await vi.waitFor(() => expect(log).toHaveBeenCalled())
      expect(manager.targets().find(target => target.id === browser.id)).toMatchObject({ status: 'ready' })
      const contents = fixture.children[0]!.webContents
      contents.capturePageImpl = async () => image() as never
      manager.setBounds(browser.id, null); manager.setBounds(browser.id, bounds)
      await vi.waitFor(() => expect(contents.capturePage).toHaveBeenCalledTimes(2))
      await store.flush()
      expect(await store.read(manager.recoveryPreviewScope(browser.id)!)).toMatchObject({ status: 'available' })
      expect((await manager.reload(browser.id)).error).toBeNull()
    } finally { manager.dispose(); await store.dispose(); log.mockRestore() }
  })
})
