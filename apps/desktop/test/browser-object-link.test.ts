import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import mainSource from '../src/main/ipc.ts?raw'
import { SpatialLinkIngress } from '../src/main/spatial-link-ingress'
import { focusFacts } from '../../../packages/core/test/fixtures/desktop-focus-facts'
import type { AgentMuxControlRequest, AgentMuxControlResult } from '@agentmux/core'

const native = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  class Contents extends EventEmitter {
    url = ''
    destroyed = false
    mainFrame = { url: '', parent: null, detached: false, isDestroyed: () => false }
    readonly navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    readonly ipc = { handlers: new Map<string, (...args: any[]) => any>(), handle: (channel: string, handler: (...args: any[]) => any) => { this.ipc.handlers.set(channel, handler) } }
    readonly session = { on() {}, removeListener() {}, setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, setDevicePermissionHandler() {} }
    readonly send = vi.fn()
    readonly executeJavaScriptInIsolatedWorld = vi.fn(async () => true)
    windowOpenHandler: ((details: { url: string }) => any) | null = null
    setWindowOpenHandler(handler: (details: { url: string }) => any) { this.windowOpenHandler = handler }
    isDestroyed() { return this.destroyed }
    getURL() { return this.url }
    getTitle() { return 'Original page' }
    isLoading() { return false }
    setZoomFactor() {}
    enableDeviceEmulation() {}
    disableDeviceEmulation() {}
    async loadURL(url: string) { this.url = url; this.mainFrame.url = url }
    close() { if (!this.destroyed) { this.destroyed = true; this.emit('destroyed') } }
  }
  class View {
    readonly webContents: Contents
    constructor(options: { webContents?: Contents } = {}) { this.webContents = options.webContents ?? new Contents() }
    setVisible() {}
    setBounds() {}
    setBorderRadius() {}
  }
  class Window extends EventEmitter {
    static readonly instances: Window[] = []
    readonly webContents = new Contents()
    readonly children: View[] = []
    readonly contentView = { addChildView: (view: View) => this.children.push(view), removeChildView: (view: View) => { const i = this.children.indexOf(view); if (i >= 0) this.children.splice(i, 1) } }
    destroyed = false
    constructor(..._args: unknown[]) { super(); Window.instances.push(this) }
    getContentBounds() { return { x: 0, y: 0, width: 1024, height: 768 } }
    isDestroyed() { return this.destroyed }
    setTitle() {}
    async loadURL(url: string) { await this.webContents.loadURL(url) }
    close() { if (!this.destroyed) { this.destroyed = true; this.emit('closed') } }
    destroy() { this.close() }
  }
  return { Contents, View, Window }
})
vi.mock('electron', () => ({ WebContentsView: native.View, BrowserWindow: native.Window }))
const { BrowserViewManager } = await import('../src/main/browser-view-manager')
const { BrowserRefLedgerStore } = await import('../src/main/browser-ref-ledger-store')

/** Execute the actual BrowserViewManager host callback registered by Main. */
function mainDestination(args: { spatialLinks?: SpatialLinkIngress }, shell: { openExternal: (target: string) => unknown }) {
  const ast = ts.createSourceFile('ipc.ts', mainSource, ts.ScriptTarget.Latest, true)
  const found: ts.Expression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'BrowserViewManager') {
      const host = node.arguments?.[3]
      if (host && ts.isObjectLiteralExpression(host)) {
        for (const property of host.properties) if (ts.isPropertyAssignment(property) && property.name.getText(ast) === 'openExternal') found.push(property.initializer)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  expect(found, 'one actual Main destination must be consumed').toHaveLength(1)
  const compiled = ts.transpileModule(`const destination = ${found[0]!.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function('args', 'shell', `${compiled}; return destination`)(args, shell) as (target: string) => void | Promise<void>
}
const settled = () => new Promise(resolve => setImmediate(resolve))
const cleanup: Array<() => void> = []
afterEach(() => {
  const errors: unknown[] = []
  for (const release of cleanup.splice(0).reverse()) { try { release() } catch (error) { errors.push(error) } }
  if (errors.length) throw new AggregateError(errors, 'Browser object-link fixture cleanup failed')
})

async function fixture(choices: Record<string, 'allow' | 'deny'> = {}, available = true) {
  const directory = mkdtempSync(join(tmpdir(), 'agentmux-browser-links-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const owner = new SpatialLinkIngress(), report = vi.fn(), shell = { openExternal: vi.fn(async (_target: string) => {}) }
  const receive = vi.spyOn(owner, 'receive')
  const requests: AgentMuxControlRequest[] = []
  const execute = vi.fn(async (request: AgentMuxControlRequest): Promise<AgentMuxControlResult> => {
    requests.push(request)
    if (request.operation === 'space.ls') return { operation: 'space.ls', catalog: {
      spaces: [], zones: [], tabs: [], bindings: [],
      regions: [{ regionId: 'original-region', tabId: 'original-tab', kind: 'agent', agentSessionId: 'original SID/中文', runId: 'original-run', execution: { hostId: 'local', cwd: directory } }],
      locations: [{ regionId: 'original-region', tabId: 'original-tab', groupId: 'original-group', workspaceId: 'execution-workspace', displayWorkspaceId: 'display-workspace', spaceId: null, zoneId: null }]
    } }
    if (request.operation !== 'focus') throw new Error('Unexpected object navigation')
    const result = focusFacts(request)
    return { ...result, navigation: { ...result.navigation, ...(request.expectedAgentSessionId === undefined ? {} : { expectedAgentSessionId: request.expectedAgentSessionId }) },
      presentation: { provenance: 'observed', state: 'main-visible', tabId: null, regionId: null, blockers: [] } }
  })
  owner.ready(execute, report)
  const appLinks = {
    rememberedSchemes: async () => choices,
    rememberScheme: async (scheme: string, answer: 'allow' | 'deny') => { choices[scheme] = answer },
    openExternal: mainDestination(available ? { spatialLinks: owner } : {}, shell)
  }
  const window = new native.Window()
  const manager = new BrowserViewManager(window as never, { defaultProfileId: () => 'default', resolvePartition: (id: string) => `persist:${id}` },
    new BrowserRefLedgerStore(join(directory, 'refs.json')), appLinks)
  cleanup.push(() => owner.unavailable(), () => manager.dispose())
  await manager.create('source-browser', 'https://source.invalid/original')
  const page = window.children[0]!.webContents
  const snapshot = () => manager.setViewport('source-browser', 'responsive')
  const popup = async () => {
    const guest = new native.Contents()
    await guest.loadURL('https://popup.invalid/original')
    const decision = page.windowOpenHandler!({ url: guest.getURL() })
    expect(decision.action).toBe('allow')
    expect(decision.createWindow({ webContents: guest })).toBe(guest)
    await settled()
    const targets = manager.targets().filter(target => target.id !== 'source-browser')
    expect(targets).toHaveLength(1)
    const id = targets[0]!.id
    expect(targets[0]!.openedFrom).toMatchObject({ browserId: 'source-browser' })
    return { id, page: guest,
      snapshot: () => manager.setViewport(id, 'responsive'),
      answer: (allow: boolean, remember = false) => manager.answerAppLink(id, allow, remember) }

  }
  return { id: 'source-browser', manager, page, snapshot, popup, owner, receive, report, requests, shell, choices, execute }
}
function navigate(page: InstanceType<typeof native.Contents>, url: string, channel = 'will-navigate') {
  const preventDefault = vi.fn()
  page.emit(channel, { url, isMainFrame: channel !== 'will-frame-navigate', preventDefault })
  expect(preventDefault).toHaveBeenCalledOnce()
}

describe('Browser object links share Main navigation after the original authorization', () => {
  it.each(['Browser', 'Popup'])('%s address submission preserves one-use authorization and the original object', async kind => {
    const f = await fixture(), source = kind === 'Popup' ? await f.popup() : f
    const url = 'amux://agent/original%20SID%2F%E4%B8%AD%E6%96%87', pageUrl = source.page.getURL()
    expect((await f.manager.navigate(source.id, url)).appLinkPrompt).toEqual({ url, scheme: 'amux' })
    expect(f.receive).not.toHaveBeenCalled(); expect(f.shell.openExternal).not.toHaveBeenCalled()
    await f.manager.answerAppLink(source.id, false, false)
    expect(source.snapshot().error).toContain('You chose not')
    expect(f.choices).toEqual({})
    expect((await f.manager.navigate(source.id, url)).appLinkPrompt).toEqual({ url, scheme: 'amux' })
    await f.manager.answerAppLink(source.id, true, false); await settled()
    expect(f.receive).toHaveBeenCalledExactlyOnceWith(url)
    expect(f.requests).toHaveLength(2)
    expect(f.requests[1]).toMatchObject({ operation: 'focus', inputPolicy: 'preserve', expectedAgentSessionId: 'original SID/中文' })
    expect(source.page.getURL()).toBe(pageUrl); expect(f.shell.openExternal).not.toHaveBeenCalled()
  })

  it.each(['Browser', 'Popup'])('%s address submission keeps remembered choices, raw validation and source feedback', async kind => {
    const f = await fixture({ amux: 'deny', 'other-app': 'allow' }), source = kind === 'Popup' ? await f.popup() : f
    const pageUrl = source.page.getURL(), url = 'amux://region/raw%2Fvalue'
    expect((await f.manager.navigate(source.id, url)).error).toContain('You chose not')
    expect(f.receive).not.toHaveBeenCalled(); expect(f.requests).toEqual([])
    f.choices.amux = 'allow'
    const malformed = 'amux://region/raw%2fvalue'
    await f.manager.navigate(source.id, malformed); await settled()
    expect(f.receive).toHaveBeenLastCalledWith(malformed)
    expect(source.snapshot().error).toContain('not an exact original identity')
    expect(f.requests).toEqual([])
    await f.manager.navigate(source.id, url); await settled()
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]).toMatchObject({ operation: 'focus', inputPolicy: 'preserve', target: { kind: 'space', regionId: 'raw/value' } })
    expect(source.snapshot().error).toBeNull(); expect(f.shell.openExternal).not.toHaveBeenCalled()
    await f.manager.navigate(source.id, 'other-app://open/original'); await settled()
    expect(f.shell.openExternal).toHaveBeenCalledExactlyOnceWith('other-app://open/original')
    expect(f.receive).toHaveBeenCalledTimes(2); expect(source.page.getURL()).toBe(pageUrl)
  })

  it.each(['Browser', 'Popup'])('%s address submission preserves ordinary addresses and refused pseudo-protocols', async kind => {
    const f = await fixture(), source = kind === 'Popup' ? await f.popup() : f
    for (const [input, expected] of [['example.com:8443/a', 'https://example.com:8443/a'], ['localhost:3000', 'http://localhost:3000/'], ['weather', 'https://www.google.com/search?q=weather']]) {
      expect((await f.manager.navigate(source.id, input!)).url).toBe(expected)
      expect(source.page.getURL()).toBe(expected)
    }
    const pageUrl = source.page.getURL()
    await expect(f.manager.navigate(source.id, 'javascript:123')).rejects.toThrow('Unsupported browser URL protocol')
    expect(source.page.getURL()).toBe(pageUrl)
    expect(f.receive).not.toHaveBeenCalled(); expect(f.shell.openExternal).not.toHaveBeenCalled()
  })

  it('asks before opening, then keeps the exact Agent identity and original page', async () => {
    const f = await fixture(), url = 'amux://agent/original%20SID%2F%E4%B8%AD%E6%96%87'
    navigate(f.page, url); await settled()
    expect(f.snapshot().appLinkPrompt).toEqual({ url, scheme: 'amux' })
    expect(f.receive).not.toHaveBeenCalled(); expect(f.requests).toEqual([]); expect(f.shell.openExternal).not.toHaveBeenCalled()
    await f.manager.answerAppLink('source-browser', true, false); await settled()
    expect(f.receive).toHaveBeenCalledExactlyOnceWith(url)
    expect(f.requests).toHaveLength(2)
    expect(f.requests[1]).toMatchObject({ operation: 'focus', inputPolicy: 'preserve', expectedAgentSessionId: 'original SID/中文',
      target: { kind: 'space', regionId: 'original-region', tabId: 'original-tab', groupId: 'original-group', displayWorkspaceId: 'display-workspace' } })
    expect(f.page.getURL()).toBe('https://source.invalid/original')
    expect(f.choices).toEqual({}); expect(f.report).not.toHaveBeenCalled(); expect(f.shell.openExternal).not.toHaveBeenCalled()
  })

  it.each(['will-frame-navigate', 'will-redirect'])('remembered allow routes %s internally and keeps other app schemes external', async channel => {
    const f = await fixture({ amux: 'allow', 'other-app': 'allow' }), url = 'amux://tab/tab%2Fexact'
    navigate(f.page, url, channel); await settled()
    expect(f.receive).toHaveBeenCalledExactlyOnceWith(url)
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]).toMatchObject({ operation: 'focus', inputPolicy: 'preserve', target: { kind: 'space', tabId: 'tab/exact' } })
    expect(f.shell.openExternal).not.toHaveBeenCalled()
    navigate(f.page, 'other-app://open/original', channel); await settled()
    expect(f.shell.openExternal).toHaveBeenCalledExactlyOnceWith('other-app://open/original')
    expect(f.receive).toHaveBeenCalledTimes(1); expect(f.page.getURL()).toBe('https://source.invalid/original')
  })

  it('remembered deny and an explicit one-use denial never dispatch object navigation', async () => {
    const f = await fixture({ amux: 'deny' })
    navigate(f.page, 'amux://region/original-region'); await settled()
    expect(f.snapshot().error).toContain('You chose not')
    delete f.choices.amux
    navigate(f.page, 'amux://region/original-region'); await settled()
    expect(f.snapshot().appLinkPrompt?.scheme).toBe('amux')
    await f.manager.answerAppLink('source-browser', false, false); await settled()
    expect(f.receive).not.toHaveBeenCalled(); expect(f.requests).toEqual([]); expect(f.shell.openExternal).not.toHaveBeenCalled()
    expect(f.page.getURL()).toBe('https://source.invalid/original')
  })

  it.each([undefined, 'deny', 'allow'] as const)('the actual Popup consumer preserves %s authorization and shares the Main destination', async answer => {
    const f = await fixture(answer ? { amux: answer } : {}), popup = await f.popup(), url = 'amux://zone/original%2Fzone'
    if (answer === 'allow') expect(popup.page.windowOpenHandler!({ url })).toEqual({ action: 'deny' })
    else navigate(popup.page, url)
    await settled()
    if (answer !== 'allow') {
      expect(f.receive).not.toHaveBeenCalled(); expect(f.requests).toEqual([])
      if (answer === undefined) {
        expect(popup.snapshot().appLinkPrompt).toMatchObject({ url, scheme: 'amux' })
        await popup.answer(true); await settled()
      } else expect(popup.snapshot().error).toContain('You chose not')
    }
    if (answer !== 'deny') {
      expect(f.receive).toHaveBeenCalledExactlyOnceWith(url)
      expect(f.requests).toHaveLength(1)
      expect(f.requests[0]).toMatchObject({ operation: 'focus', inputPolicy: 'preserve', target: { kind: 'space', zoneId: 'original/zone' } })
    }
    expect(f.shell.openExternal).not.toHaveBeenCalled()
    expect(popup.page.getURL()).toBe('https://popup.invalid/original'); expect(f.page.getURL()).toBe('https://source.invalid/original')
  })

  it('a Popup one-use refusal leaves authorization unanswered for its next request', async () => {
    const f = await fixture(), popup = await f.popup(), url = 'amux://region/original-region'
    navigate(popup.page, url); await settled()
    expect(popup.snapshot().appLinkPrompt).toMatchObject({ url, scheme: 'amux' })
    await popup.answer(false); await settled()
    expect(popup.snapshot().error).toContain('You chose not')
    expect(f.choices).toEqual({}); expect(f.receive).not.toHaveBeenCalled(); expect(f.requests).toEqual([])
    navigate(popup.page, url, 'will-frame-navigate'); await settled()
    expect(popup.snapshot().appLinkPrompt).toMatchObject({ url, scheme: 'amux' })
    await popup.answer(true, true); await settled()
    expect(f.choices).toEqual({ amux: 'allow' }); expect(f.receive).toHaveBeenCalledExactlyOnceWith(url)
    expect(f.shell.openExternal).not.toHaveBeenCalled(); expect(popup.page.getURL()).toBe('https://popup.invalid/original')
  })

  it.each(['Browser', 'Popup'])('%s malformed objects report through the original ingress and a later exact link still works', async kind => {
    const f = await fixture({ amux: 'allow' }), malformed = 'amux://agent/original?unexpected=1'
    const source = kind === 'Popup' ? await f.popup() : { page: f.page, snapshot: f.snapshot }
    const { page } = source, originalUrl = page.getURL()
    navigate(page, malformed); await settled()
    expect(f.receive).toHaveBeenCalledExactlyOnceWith(malformed)
    expect(f.report).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Your current workface is kept'))
    expect(source.snapshot().error).toContain(f.report.mock.calls[0]![0])
    expect(f.requests).toEqual([]); expect(page.getURL()).toBe(originalUrl)
    navigate(page, 'amux://region/original-region'); await settled()
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]).toMatchObject({ operation: 'focus', inputPolicy: 'preserve', target: { kind: 'space', regionId: 'original-region' } })
    expect(source.snapshot().error).toBeNull()
    expect(f.shell.openExternal).not.toHaveBeenCalled()
  })

  it.each(['Browser', 'Popup'])('%s reports its own asynchronous resolver failure without replacing the page', async kind => {
    const f = await fixture({ amux: 'allow' }), source = kind === 'Popup' ? await f.popup() : { page: f.page, snapshot: f.snapshot }
    const originalUrl = source.page.getURL()
    f.execute.mockResolvedValueOnce({ operation: 'space.ls', catalog: { spaces: [], zones: [], tabs: [], bindings: [], regions: [], locations: [] } })
    navigate(source.page, 'amux://agent/original%20SID'); await settled()
    expect(f.report).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('0 confirmed display candidates'))
    expect(source.snapshot().error).toContain(f.report.mock.calls[0]![0])
    expect(source.page.getURL()).toBe(originalUrl); expect(source.page.isDestroyed()).toBe(false)
    expect(f.shell.openExternal).not.toHaveBeenCalled()
  })

  it.each(['Browser', 'Popup'])('%s keeps newer opening feedback when an earlier object request is superseded', async kind => {
    const f = await fixture({ amux: 'allow' }), source = kind === 'Popup' ? await f.popup() : { page: f.page, snapshot: f.snapshot }
    let fail!: (reason: Error) => void
    f.execute.mockImplementationOnce(async () => await new Promise<AgentMuxControlResult>((_resolve, reject) => { fail = reject }))
    navigate(source.page, 'amux://region/earlier'); await settled()
    navigate(source.page, 'amux://region/newer'); await settled()
    expect(source.snapshot().error).toBeNull()
    fail(new Error('Earlier unconfirmed response')); await settled()
    expect(source.snapshot().error).toBeNull(); expect(f.report).not.toHaveBeenCalled()
    expect(f.receive).toHaveBeenCalledTimes(2)
    expect(f.shell.openExternal).not.toHaveBeenCalled()
  })

  it.each(['Browser', 'Popup'])('%s shows an interrupted opening in its original workface and can retry explicitly', async kind => {
    const f = await fixture({ amux: 'allow' }), source = kind === 'Popup' ? await f.popup() : { page: f.page, snapshot: f.snapshot }
    let fail!: (reason: Error) => void
    f.execute.mockImplementationOnce(async () => await new Promise<AgentMuxControlResult>((_resolve, reject) => { fail = reject }))
    navigate(source.page, 'amux://region/original'); await settled()
    f.owner.unavailable(); await settled()
    expect(source.snapshot().error).toContain('interrupted before confirmation')
    f.owner.ready(f.execute, f.report); await settled()
    expect(f.report).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('interrupted before confirmation'))
    navigate(source.page, 'amux://region/original'); await settled()
    expect(source.snapshot().error).toBeNull()
    fail(new Error('Old operation result')); await settled()
    expect(source.snapshot().error).toBeNull(); expect(f.execute).toHaveBeenCalledTimes(2)
  })

  it.each(['Browser', 'Popup'])('%s does not apply a late opening failure to a newer prompt or document', async kind => {
    const f = await fixture({ amux: 'allow' }), source = kind === 'Popup' ? await f.popup() : { page: f.page, snapshot: f.snapshot }
    let fail!: (reason: Error) => void
    f.execute.mockImplementationOnce(async () => await new Promise<AgentMuxControlResult>((_resolve, reject) => { fail = reject }))
    navigate(source.page, 'amux://region/earlier'); await settled()
    navigate(source.page, 'other-app://new-prompt'); await settled()
    fail(new Error('Earlier opening failed')); await settled()
    expect(source.snapshot().appLinkPrompt).toMatchObject({ url: 'other-app://new-prompt', scheme: 'other-app' })
    expect(source.snapshot().error).toBeNull()
    f.execute.mockImplementationOnce(async () => await new Promise<AgentMuxControlResult>((_resolve, reject) => { fail = reject }))
    navigate(source.page, 'amux://region/another-earlier'); await settled()
    await source.page.loadURL('https://source.invalid/new-document')
    source.page.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: source.page.getURL() })
    fail(new Error('Previous document opening failed')); await settled()
    expect(source.snapshot().appLinkPrompt).toBeNull(); expect(source.snapshot().error).toBeNull()
    expect(source.page.getURL()).toBe('https://source.invalid/new-document')
    expect(f.shell.openExternal).not.toHaveBeenCalled()
  })

  it('an unavailable window owner rejects only that object handoff with visible Browser feedback', async () => {
    const f = await fixture({ amux: 'allow', 'other-app': 'allow' }, false)
    navigate(f.page, 'amux://region/original-region'); await settled()
    expect(f.snapshot().error).toContain('Object link navigation is unavailable in this window')
    expect(f.receive).not.toHaveBeenCalled(); expect(f.requests).toEqual([]); expect(f.shell.openExternal).not.toHaveBeenCalled()
    navigate(f.page, 'other-app://open/original'); await settled()
    expect(f.shell.openExternal).toHaveBeenCalledExactlyOnceWith('other-app://open/original')
    expect(f.page.isDestroyed()).toBe(false); expect(f.page.getURL()).toBe('https://source.invalid/original')
  })
})
