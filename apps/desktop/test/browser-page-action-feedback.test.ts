const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserPageDispatch } from '../src/main/browser-page-dispatch.js'
import { DEFAULT_BROWSER_AGENT_CONTROL, type BrowserAgentControlPreferences } from '../src/shared/browser-agent-control.js'

const native = vi.hoisted(() => ({ views: [] as any[], mode: 'click', key: undefined as string | undefined, onFeedback: undefined as undefined | (() => void), onWaiting: undefined as undefined | (() => Promise<void>), displayFails: false, displayThrows: false, displayAllThrows: false, observe: undefined as undefined | (() => Promise<unknown>), takeover: undefined as undefined | (() => void), deferredCloseId: undefined as number | undefined }))
vi.mock('../src/main/browser-page-dispatch.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/main/browser-page-dispatch.js')>()
  return { ...actual, createBrowserPageDispatch: (...args: Parameters<typeof actual.createBrowserPageDispatch>) => {
    const dispatch = actual.createBrowserPageDispatch(...args)
    return (name: string, args: unknown[], scope?: Parameters<typeof dispatch>[2]) => dispatch(name, args,
      native.mode === 'concurrent-observe' && scope?.feedback ? { ...scope, feedback: async (node, send) => {
        await scope.feedback!(node, send) // Actual Main callback completes its own post-display guard.
        await native.observe!() // The real operation now receives a concurrent readonly page call.
        queueMicrotask(() => native.takeover!()) // Real input lands before the actual dispatcher's last send guard.
      } } : scope)
  } }
})
vi.mock('../src/main/browser-script-runner.js', () => ({ runBrowserScript: async ({ onPageCall }: any) => {
  try {
    const page = await onPageCall('snapshot', [])
    if (native.mode === 'held-wait') {
      const waiting = onPageCall('wait', [0])
      await native.onWaiting!()
      await waiting
      return { completed: true, value: true, logs: [] }
    }
    if (native.mode === 'concurrent-observe') native.observe = () => onPageCall('snapshot', [])
    if (native.mode === 'concurrent') await Promise.all([onPageCall('click', [page.nodes[0].ref]), onPageCall('hover', [page.nodes[0].ref])])
    else await onPageCall(['navigation', 'concurrent-observe', 'wait'].includes(native.mode) ? 'click' : native.mode, [page.nodes[0].ref, native.key ?? 'private-invocation-value'])
    if (native.mode === 'wait') await onPageCall('wait', [0])
    if (native.mode === 'navigation') {
      await onPageCall('gotoUrl', ['https://generic.invalid/next'])
      const next = await onPageCall('snapshot', [])
      await onPageCall('click', [next.nodes[0].ref])
    }
    return { completed: true, value: true, logs: [] }
  } catch (error) { return { completed: false, failure: { kind: 'script-error', message: String(error) }, logs: [] } }
} }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  let nextId = 90
  class Contents extends EventEmitter {
    id = ++nextId; url = ''; attached = false; destroyed = false; focused = false; focusCalls = 0; actions = 0; displayAttempts = 0; feedbackCalls = 0; feedbackPayloads: any[] = []; scripts: string[] = []; commands: string[] = []; documentPayloads: any[] = []
    displays: Array<{ family: 'action' | 'control' | 'revision' | 'selection' | 'annotation' | 'unknown'; payload?: any; code: string }> = []
    readonly session = Object.assign(new EventEmitter(), { setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, setDevicePermissionHandler() {} })
    readonly navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    readonly mainFrame = { framesInSubtree: [] }
    readonly debugger = Object.assign(new EventEmitter(), {
      attach: () => { this.attached = true }, detach: () => { this.attached = false }, isAttached: () => this.attached,
      sendCommand: async (method: string, params: any = {}) => {
        this.commands.push(method)
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'loaded' } } }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 8 }
        if (method === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: '1', backendDOMNodeId: 11, role: { value: 'button' }, name: { value: 'Continue' }, childIds: [] }] }
        if (method === 'DOM.resolveNode') return { object: { objectId: params.executionContextId ? 'feedback-object' : 'action-object' } }
        if (method === 'Runtime.evaluate') {
          const code = params.expression ?? '', start = code.lastIndexOf(')(')
          if (start >= 0 && code.slice(start + 2, -1).startsWith('{')) this.documentPayloads.push(JSON.parse(code.slice(start + 2, -1)))
          return { result: { value: true } }
        }
        if (method === 'Runtime.callFunctionOn') {
          if (params.objectId === 'feedback-object') { this.feedbackCalls++; this.feedbackPayloads.push(params.arguments[0].value); native.onFeedback?.(); return { result: { value: true } } }
          if (params.functionDeclaration.includes('this.click()') || params.functionDeclaration.includes('this.value') || params.functionDeclaration.includes('pointerover')) this.actions++
          return { result: { value: null } }
        }
        return {}
      }
    })
    isDestroyed() { return this.destroyed }; isLoading() { return false }; getURL() { return this.url }; getTitle() { return 'Page' }
    isLoadingMainFrame() { return false }
    isFocused() { return this.focused }
    focus() { for (const view of native.views) view.webContents.focused = false; this.focused = true; this.focusCalls++; this.emit('focus') }
    getZoomFactor() { return 1 }; setZoomFactor() {}; setBackgroundThrottling() {}; getBackgroundThrottling() { return true }
    disableDeviceEmulation() {}; enableDeviceEmulation() {}; setWindowOpenHandler() {}
    executeJavaScriptInIsolatedWorld(_world: number, scripts: Array<{ code: string }>) {
      this.displayAttempts++
      const calls = scripts.map(({ code }) => {
        this.scripts.push(code)
        const start = code.lastIndexOf(')(')
        const payload = start >= 0 && code.slice(start + 2, -1).startsWith('{') ? JSON.parse(code.slice(start + 2, -1)) : undefined
        const family = payload && typeof payload.active === 'boolean' && code.includes('__agentMuxBrowserControlFeedback') ? 'control'
          : payload && typeof payload.phase === 'string' && code.includes('__agentMuxBrowserOperationFeedback') ? 'action'
          : !payload && code.includes('Math.max(...[globalThis.__agentMuxBrowserOperationFeedback?.revision') ? 'revision'
          : _world === 1208 && code.includes('__agentMuxBrowserSelection') ? 'selection'
          : _world === 1208 && code.includes('__agentMuxBrowserAnnotations') ? 'annotation' : 'unknown'
        const call = { family, payload, code } as typeof this.displays[number]
        this.displays.push(call)
        return call
      })
      if (calls.some(call => call.family === 'unknown')) throw new Error('Unclassified isolated-world script')
      if (native.displayAllThrows && calls.some(call => call.family === 'action' || call.family === 'control')) throw new Error('Persistent native feedback display failure')
      const running = calls.some(call => call.family === 'action' && call.payload.phase === 'running')
      if (native.displayThrows && running) throw new Error('Synchronous native display failure')
      return Promise.resolve(!(native.displayFails && running))
    }
    executeJavaScript = vi.fn(async (_code: string) => true)
    async loadURL(url: string) { this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url }); this.url = url; this.emit('did-navigate', {}, url); this.emit('dom-ready'); this.emit('did-finish-load'); this.emit('did-stop-loading') }
    close() { if (this.id !== native.deferredCloseId) this.finishClose() }
    finishClose() { if (this.destroyed) return; this.destroyed = true; this.focused = false; this.emit('destroyed') }
  }
  class View extends EventEmitter {
    readonly webContents = new Contents()
    private visible = true
    private bounds = { x: 0, y: 0, width: 0, height: 0 }
    backgroundColor = ''
    constructor() { super(); native.views.push(this) }
    setVisible(value: boolean) { this.visible = value }
    getVisible() { return this.visible }
    setBorderRadius(_radius: number) {}
    setBackgroundColor(value: string) { this.backgroundColor = value }
    setBounds(value: typeof this.bounds) { const changed = Object.keys(value).some(key => value[key as keyof typeof value] !== this.bounds[key as keyof typeof value]); this.bounds = { ...value }; if (changed) this.emit('bounds-changed') }
    getBounds() { return { ...this.bounds } }
  }
  return { WebContentsView: View }
})
import { BrowserViewManager } from '../src/main/browser-view-manager.js'
import { BrowserRefLedgerStore } from '../src/main/browser-ref-ledger-store.js'
import { NativeOverlaySurfaces } from '../src/main/native-overlay-surfaces.js'
const roots: string[] = [], managers: BrowserViewManager[] = []
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.dispose()
  // Every attempted script remains visible, including failures and newly introduced families.
  for (const view of native.views) {
    expect(view.webContents.displays).toHaveLength(view.webContents.scripts.length)
    expect(view.webContents.displays.filter((call: any) => call.family === 'unknown')).toEqual([])
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  native.views.length = 0; native.mode = 'click'; native.key = undefined; native.onFeedback = undefined; native.onWaiting = undefined; native.displayFails = false; native.displayThrows = false; native.displayAllThrows = false; native.observe = undefined; native.takeover = undefined; native.deferredCloseId = undefined
})
const actionPayloads = (contents: any, start = 0): any[] => contents.displays.slice(start).filter((call: any) => call.family === 'action').map((call: any) => call.payload)
const controlPayloads = (contents: any): any[] => contents.displays.filter((call: any) => call.family === 'control').map((call: any) => call.payload)
async function managerFixture(preferences?: () => BrowserAgentControlPreferences) {
  const root = await mkdtemp(_hygiene_fixturePath("tmp/amx-action-feedback-source-")); roots.push(root)
  const children: any[] = [], events: any[] = []
  const window = Object.assign(new EventEmitter(), { isVisible: () => true, isMinimized: () => false, getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }), isFocused: () => true,
    contentView: { get children() { return [...children] }, addChildView: (view: any, index?: number) => {
      const previous = children.indexOf(view)
      if (previous >= 0) children.splice(previous, 1)
      children.splice(index ?? children.length, 0, view)
    }, removeChildView: (view: any) => { const index = children.indexOf(view); if (index >= 0) children.splice(index, 1) } },
    isDestroyed: () => false, webContents: Object.assign(new EventEmitter(), { isDestroyed: () => false, getZoomFactor: () => 1, beginFrameSubscription: vi.fn(), endFrameSubscription: vi.fn(),
      capturePage: vi.fn(async () => ({ isEmpty: () => false, toPNG: () => Buffer.from('original Renderer chrome') })),
      send: (_name: string, e: any) => events.push(structuredClone(e)) }) })
  const manager = new BrowserViewManager(window as never, { defaultProfileId: () => 'default', resolvePartition: () => 'persist:feedback' },
    new BrowserRefLedgerStore(join(root, 'refs.json')), { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal() {} },
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, preferences)
  managers.push(manager)
  await manager.create('browser-one', 'https://generic.invalid/one', 'workspace')
  const source = children.find(view => view.webContents.getURL() === 'https://generic.invalid/one')
  await manager.create('sibling', 'https://generic.invalid/two', 'workspace')
  const sibling = children.find(view => view.webContents.getURL() === 'https://generic.invalid/two')
  manager.setBounds('browser-one', { x: 0, y: 0, width: 500, height: 400 })
  const siblingBefore = { scripts: [...sibling.webContents.scripts], commands: [...sibling.webContents.commands] }
  return { window, manager, contents: source.webContents, sibling: sibling.webContents, siblingBefore, children, events }
}
describe('actual dispatcher action feedback consumer', () => {
  it('passes the resolved node/sender after the original scroll and rechecks control after asynchronous display', async () => {
    const order: string[] = [], recorded: unknown[] = [], notes: string[] = []; let human = false
    const main = async (name: string) => {
      if (name === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'loaded' }, childFrames: [{ frame: { id: 'child', parentId: 'main', loaderId: 'child-loaded' } }] } }
      if (name === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: '1', backendDOMNodeId: 10, frameId: 'main', role: { value: 'button' }, name: { value: 'Main' }, childIds: [] }] }
      return {}
    }
    const child = async (name: string, params?: any) => {
      if (name === 'Page.getFrameTree') return { frameTree: { frame: { id: 'child', parentId: 'main', loaderId: 'child-loaded' } } }
      if (name === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: '2', backendDOMNodeId: 22, frameId: 'child', role: { value: 'button' }, name: { value: 'Child' }, childIds: [] }] }
      if (name === 'DOM.resolveNode') { expect(params.backendNodeId).toBe(22); order.push('resolve-child'); return { object: { objectId: 'actual-child' } } }
      if (name === 'Runtime.callFunctionOn') { order.push(params.functionDeclaration.includes('scrollIntoView') ? 'scroll' : 'action'); return { result: { value: null } } }
      return {}
    }
    const dispatch = createBrowserPageDispatch({ session: { sendCommand: main, frames: new Map([['child-session', child]]), frameDiscoveryFailure: null } as never,
      pageInfo: () => ({ url: 'https://generic.invalid', title: 'Page', navigationId: 'nav' }), gotoUrl: async () => {}, captureScreenshot: async () => null,
      readLedger: async () => ({ url: 'https://generic.invalid', entries: [{ ref: '@e7', role: 'button', name: 'Child', nth: 1 }] }), writeLedger: async () => {}, note: text => notes.push(text), recordTarget: value => recorded.push(value), beforeAction: () => { order.push('guard'); if (human) throw new Error('Human control') },
      actionFeedback: async (node, send) => { order.push('feedback'); expect(node).toMatchObject({ backendNodeId: 22, frameId: 'child', sessionId: 'child-session' }); expect(send).toBe(child); expect(node.ref).not.toBe('@e7'); human = true } })
    const snapshot = await dispatch('snapshot', []) as any
    expect(snapshot.nodes.length).toBeGreaterThan(0)
    const node = snapshot.nodes.find((n: any) => n.backendNodeId === 22); expect(node).toBeDefined()
    await expect(dispatch('click', ['@e7'])).rejects.toThrow('Human control')
    expect(notes).toHaveLength(1); expect(recorded).toEqual([{ role: 'button', name: 'Child', ordinal: 1, count: 1 }])
    expect(order).toEqual(['resolve-child', 'guard', 'scroll', 'guard', 'feedback', 'guard'])
  })
})
describe('actual resolved document and sender after display', () => {
  it.each(['navigation', 'sender'])('%s change during feedback rejects only the undispatched current action', async (changed) => {
    let navigationId = 'document-one', actions = 0, feedbackCalls = 0
    const child = async (method: string, params?: any) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'child', parentId: 'main', loaderId: 'child-document' } } }
      if (method === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: 'child-button', backendDOMNodeId: 22, frameId: 'child', role: { value: 'button' }, name: { value: 'Child' }, childIds: [] }] }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'actual-child' } }
      if (method === 'Runtime.callFunctionOn' && params.functionDeclaration.includes('this.click()')) actions++
      return { result: { value: null } }
    }
    const main = async (method: string) => method === 'Page.getFrameTree'
      ? { frameTree: { frame: { id: 'main', loaderId: 'document-one' }, childFrames: [{ frame: { id: 'child', parentId: 'main', loaderId: 'child-document' } }] } }
      : method === 'Accessibility.getFullAXTree' ? { nodes: [{ nodeId: 'main', backendDOMNodeId: 10, frameId: 'main', role: { value: 'button' }, name: { value: 'Continue' }, childIds: [] }] } : {}
    const frames = new Map([['child-session', child]])
    const dispatch = createBrowserPageDispatch({ session: { sendCommand: main, frames, frameDiscoveryFailure: null } as never,
      pageInfo: () => ({ url: 'https://generic.invalid', title: 'Page', navigationId }), gotoUrl: async () => {}, captureScreenshot: async () => null,
      readLedger: async () => null, writeLedger: async () => {}, note() {}, beforeAction() {}, actionFeedback: async (node, send) => {
        feedbackCalls++; expect(node.backendNodeId).toBe(22); expect(send).toBe(child)
        await Promise.resolve()
        if (changed === 'navigation') navigationId = 'document-two'
        else frames.delete('child-session')
      } })
    const snapshot = await dispatch('snapshot', []) as any
    expect(snapshot.nodes.length).toBeGreaterThan(0)
    const node = snapshot.nodes.find((node: any) => node.backendNodeId === 22); expect(node).toBeDefined()
    await expect(dispatch('click', [node.ref])).rejects.toMatchObject({ name: 'BrowserLocalRecoveryFailure', fact: { kind: 'locator-changed', effects: 'not-dispatched' } })
    expect(feedbackCalls).toBe(1); expect(actions).toBe(0)
    // The existing observation entry remains usable; no Browser or Agent lifecycle is closed.
    const next = await dispatch('snapshot', []) as any
    expect(next.nodes.length).toBeGreaterThan(0); expect(next.navigationId).toBe(navigationId)
  })
})
describe('actual BrowserViewManager consumer', () => {
  it.each(['completed', 'takeover'])('clears only its confirmed cleanup notice after delayed native destruction following %s', async ending => {
    const f = await managerFixture(); native.mode = 'held-wait'
    const operationId = 'delayed-close-' + ending
    let shield: any
    native.onWaiting = async () => {
      shield = f.manager.nativeOwner('browser-one')!.inputShield
      native.deferredCloseId = shield.webContents.id
      if (ending === 'takeover') f.manager.takeControl('browser-one')
    }
    const report = await f.manager.runScript('browser-one', 'actual worker with delayed native close', undefined, undefined, operationId)
    expect(report.outcome.kind).toBe(ending === 'completed' ? 'completed' : 'stopped')
    if (ending === 'completed') f.manager.takeControl('browser-one')
    expect(f.manager.target('browser-one')?.control?.inputIsolation).toBe('unconfirmed')
    expect(f.manager.target('browser-one')?.status).toBe('ready'); expect(f.contents.isDestroyed()).toBe(false)
    expect(report.runOperation?.warning?.match(/could not be fully released/gu)).toHaveLength(1)
    expect(f.manager.nativeOwner('browser-one')?.inputShield).toBeUndefined()
    expect(Reflect.get(f.manager, 'entries').get('browser-one').inputShield.view).toBe(shield)
    expect(f.children).not.toContain(shield)
    shield.webContents.finishClose()
    await Promise.resolve(); await Promise.resolve()
    expect(f.manager.nativeOwner('browser-one')?.inputShield).toBeUndefined()
    expect(f.manager.target('browser-one')?.control?.inputIsolation).toBe('inactive')
    expect(f.events.at(-1).browser.activity.warning ?? '').not.toContain('could not be fully released')
    expect(report.runOperation?.warning ?? '').not.toContain('could not be fully released')
    if (ending === 'takeover') expect(report.runOperation?.warning).toContain('stopped explicitly')
    else expect(report.runOperation?.warning).toBeUndefined()
    expect(f.sibling.commands).toEqual(f.siblingBefore.commands)
  })
  it('keeps a newer operation notice when an older exact native surface finishes cleanup', async () => {
    const f = await managerFixture(); native.mode = 'held-wait'
    let shield: any
    native.onWaiting = async () => { shield = f.manager.nativeOwner('browser-one')!.inputShield; native.deferredCloseId = shield.webContents.id }
    const original = await f.manager.runScript('browser-one', 'original delayed native close', undefined, undefined, 'original-close')
    f.manager.takeControl('browser-one'); f.manager.returnControl('browser-one')
    expect(original.runOperation?.warning).toContain('could not be fully released')
    native.onWaiting = async () => {
      const before = f.events.at(-1).browser.activity.operation
      expect(before.id).toBe('new-operation')
      expect(before.warning).toContain('Native Browser input isolation is unconfirmed')
      shield.webContents.finishClose(); await Promise.resolve(); await Promise.resolve()
      const after = f.events.at(-1).browser.activity.operation
      expect(after.id).toBe('new-operation'); expect(after.warning).toContain('Native Browser input isolation is unconfirmed')
    }
    const next = await f.manager.runScript('browser-one', 'new healthy program with retained input observation', undefined, undefined, 'new-operation')
    expect(next.outcome.kind).toBe('completed'); expect(next.runOperation?.warning).toContain('Native Browser input isolation is unconfirmed')
    expect(original.runOperation?.warning).toContain('Native Browser input isolation is unconfirmed')
  })
  it('consumes the saved pointer preferences and dispatch acknowledgement through the original target callback', async () => {
    const preferences = { ...DEFAULT_BROWSER_AGENT_CONTROL, pointerDurationMs: 530, clickRadius: 33, glowColor: '#3366cc' }
    const f = await managerFixture(() => preferences)
    const report = await f.manager.runScript('browser-one', 'actual worker double', { id: 'agent', name: 'Actual Agent' })
    expect(report.outcome.kind).toBe('completed'); expect(f.contents.actions).toBe(1)
    const target = f.contents.feedbackPayloads[0]
    expect(target.moveMs).toBe(530); expect(target.preferences).toEqual(preferences)
    expect(target.css).toContain('--amux-agent-color:#3366cc')
    const click = f.contents.documentPayloads.find((payload: any) => payload.phase === 'click')
    expect(click).toMatchObject({ operationId: report.runOperation?.id, token: target.token, navigationId: target.navigationId, method: 'click', preferences })
    native.mode = 'hover'
    await f.manager.runScript('browser-one', 'actual worker double')
    expect(f.contents.documentPayloads.filter((payload: any) => payload.phase === 'click')).toHaveLength(1)
    expect(f.sibling.commands).toEqual(f.siblingBefore.commands)
  })
  it('connects visible run to feedback, clears busy at normal end and leaves the unrelated Browser untouched', async () => {
    const f = await managerFixture()
    const report = await f.manager.runScript('browser-one', 'actual worker double', { id: 'agent', name: 'Actual Agent' })
    expect(report.outcome.kind).toBe('completed'); expect(f.contents.actions).toBe(1); expect(f.contents.feedbackCalls).toBe(1)
    expect(f.contents.attached).toBe(false); expect(f.contents.destroyed).toBe(false)
    expect(f.contents.scripts.length).toBeGreaterThan(0)
    expect(actionPayloads(f.contents).at(-1).phase).toBe('completed')
    expect(controlPayloads(f.contents).at(-1).active).toBe(true)
    expect(f.sibling.commands).toEqual(f.siblingBefore.commands); expect(f.sibling.scripts).toEqual(f.siblingBefore.scripts); expect(f.sibling.destroyed).toBe(false)
    const count = f.contents.displays.length; f.manager.setBounds('browser-one', null)
    expect(actionPayloads(f.contents, count)).toMatchObject([{ phase: 'clear' }])
    expect(f.manager.target('browser-one')?.control?.owner).toBe('agent')
  })
  it('the same operation binds each action to its actual new navigation and a fresh decoration token', async () => {
    const f = await managerFixture(); native.mode = 'navigation'
    const report = await f.manager.runScript('browser-one', 'actual worker double')
    expect(report.outcome.kind).toBe('completed'); expect(f.contents.actions).toBe(2)
    expect(f.contents.feedbackPayloads).toHaveLength(2)
    const [first, second] = f.contents.feedbackPayloads
    expect(first.operationId).toBe(report.runOperation?.id); expect(second.operationId).toBe(first.operationId)
    expect(second.navigationId).not.toBe(first.navigationId); expect(second.token).not.toBe(first.token)
    expect(f.contents.getURL()).toBe('https://generic.invalid/next'); expect(f.contents.attached).toBe(false)
    const count = f.contents.displays.length
    f.contents.emit('input-event', {}, { type: 'mouseDown' })
    expect(actionPayloads(f.contents, count)).toEqual([])
    expect(f.manager.target('browser-one')?.control?.owner).toBe('agent')
    expect(f.contents.attached).toBe(false); expect(report.runOperation?.phase).toBe('completed')
    expect(f.sibling.commands).toEqual(f.siblingBefore.commands); expect(f.sibling.scripts).toEqual(f.siblingBefore.scripts)
  })
  it('actual concurrent page calls keep both healthy actions while stale feedback cannot borrow the newer action label', async () => {
    const f = await managerFixture(); native.mode = 'concurrent'
    const report = await f.manager.runScript('browser-one', 'actual concurrent worker double')
    expect(report.outcome.kind).toBe('completed'); expect(f.contents.actions).toBe(2)
    expect(f.contents.feedbackPayloads).toHaveLength(1)
    expect(f.contents.feedbackPayloads[0].label).toBe('Agent · Hover')
    expect(actionPayloads(f.contents).at(-1).label).toBe('Agent · Hover complete')
    expect(f.contents.attached).toBe(false); expect(f.sibling.commands).toEqual(f.siblingBefore.commands); expect(f.sibling.scripts).toEqual(f.siblingBefore.scripts)
  })
  it('a concurrent readonly call cannot replace the action guard before explicit takeover', async () => {
    const f = await managerFixture(); native.mode = 'concurrent-observe'
    native.takeover = () => { f.manager.takeControl('browser-one') }
    const report = await f.manager.runScript('browser-one', 'actual concurrent worker double', undefined, undefined, 'concurrent-observe')
    expect(report.outcome.kind).toBe('stopped'); expect(f.contents.feedbackCalls).toBe(1)
    expect(f.contents.commands.filter((name: string) => name === 'Accessibility.getFullAXTree')).toHaveLength(2)
    expect(f.contents.actions).toBe(0); expect(f.contents.attached).toBe(false)
    expect(f.events.at(-1).browser.activity.control).toBe('human')
    expect(f.sibling.commands).toEqual(f.siblingBefore.commands); expect(f.sibling.scripts).toEqual(f.siblingBefore.scripts)
  })
  it('explicit takeover during feedback stops the original late action while preserving both healthy pages', async () => {
    const f = await managerFixture()
    native.onFeedback = () => { f.manager.takeControl('browser-one') }
    const report = await f.manager.runScript('browser-one', 'actual worker double', undefined, undefined, 'feedback-takeover')
    expect(f.contents.feedbackCalls).toBe(1); expect(f.contents.actions).toBe(0)
    expect(report.outcome.kind).toBe('stopped'); expect(report.runOperation?.phase).toBe('stopped')
    expect(f.events.at(-1).browser.activity.control).toBe('human')
    expect(actionPayloads(f.contents).at(-1).phase).toBe('clear')
    expect(controlPayloads(f.contents).at(-1).active).toBe(false)
    expect(f.contents.destroyed).toBe(false); expect(f.sibling.destroyed).toBe(false)
    expect(f.sibling.scripts).toEqual(f.siblingBefore.scripts); expect(f.sibling.commands).toEqual(f.siblingBefore.commands)
  })
  it.each(['false', 'synchronous throw', 'persistent clear/display throw'])('%s display result leaves the actual action completed with a persistent local service warning', async (kind) => {
    const f = await managerFixture(); native.displayFails = kind === 'false'; native.displayThrows = kind === 'synchronous throw'; native.displayAllThrows = kind === 'persistent clear/display throw'
    const report = await f.manager.runScript('browser-one', 'actual worker double')
    expect(report.outcome.kind).toBe('completed'); expect(f.contents.actions).toBe(1)
    expect(f.contents.feedbackCalls).toBe(0); expect(actionPayloads(f.contents).length).toBeLessThanOrEqual(4); expect(f.contents.destroyed).toBe(false); expect(f.contents.attached).toBe(false)
    expect(report.runOperation?.warning).toContain('feedback could not be displayed')
    expect(f.events.at(-1).browser.activity.warning).toContain('remain usable')
    native.displayFails = false; native.displayThrows = false; native.displayAllThrows = false; native.observe = undefined; native.takeover = undefined
    const next = await f.manager.runScript('browser-one', 'second healthy run')
    expect(next.outcome.kind).toBe('completed'); expect(f.contents.actions).toBe(2)
    expect(f.sibling.commands).toEqual(f.siblingBefore.commands); expect(f.sibling.scripts).toEqual(f.siblingBefore.scripts)
  })
  it('fill feedback is connected without disclosing its value and opaque calls create no target pointer', async () => {
    const f = await managerFixture(); native.mode = 'fillInput'
    const report = await f.manager.runScript('browser-one', 'actual worker double')
    expect(report.outcome.kind).toBe('completed'); expect(f.contents.actions).toBe(1); expect(f.contents.feedbackCalls).toBe(1)
    expect(f.contents.scripts.join('')).not.toContain('private-invocation-value')
    native.mode = 'js'; const before = f.contents.feedbackCalls
    await f.manager.runScript('browser-one', 'actual worker double')
    expect(f.contents.feedbackCalls).toBe(before)
  })
  it.each(['completed', 'takeover'])('keeps the waiting owner active until %s and never wakes the sibling', async end => {
    const f = await managerFixture(); native.mode = 'held-wait'
    f.contents.focus()
    const operationId = 'waiting-control-' + end
    let shield: any, observed = false
    native.onWaiting = async () => {
      await Promise.resolve()
      expect(f.events.at(-1).browser.activity.operation.phase).toBe('waiting')
      expect(f.manager.target('browser-one')?.control).toMatchObject({ owner: 'agent', activeOperationId: operationId, inputIsolation: 'isolated' })
      expect(controlPayloads(f.contents).length).toBeGreaterThan(0)
      expect(controlPayloads(f.contents).every(payload => payload.active)).toBe(true)
      const owner = f.manager.nativeOwner('browser-one')!
      shield = owner.inputShield
      expect(shield).toBeDefined()
      expect(f.children.indexOf(shield)).toBe(f.children.indexOf(owner.view) + 1)
      expect(shield.getBounds()).toEqual(owner.view.getBounds())
      expect(shield.getVisible()).toBe(true)
      expect(shield.backgroundColor).toBe('#00000000')
      expect(shield.webContents.isFocused()).toBe(true); expect(f.contents.isFocused()).toBe(false)
      // A queued page input may invalidate the transient cue; it cannot grant takeover.
      f.contents.emit('input-event', {}, { type: 'mouseDown' })
      f.manager.refreshAgentFeedback()
      await Promise.resolve()
      expect(actionPayloads(f.contents).at(-1).phase).toBe('clear')
      expect(controlPayloads(f.contents).at(-1).active).toBe(true)
      expect(f.manager.target('browser-one')?.control?.owner).toBe('agent')
      expect(f.sibling.commands).toEqual(f.siblingBefore.commands); expect(f.sibling.scripts).toEqual(f.siblingBefore.scripts); expect(f.sibling.focusCalls).toBe(0)
      observed = true
      if (end === 'takeover') f.manager.takeControl('browser-one')
    }
    const report = await f.manager.runScript('browser-one', 'actual waiting worker', { id: 'original-agent', name: 'Original Agent' }, undefined, operationId)
    expect(observed, JSON.stringify(report)).toBe(true)
    expect(report.outcome.kind).toBe(end === 'takeover' ? 'stopped' : 'completed')
    expect(controlPayloads(f.contents).at(-1)).toMatchObject({ operationId, active: end !== 'takeover' })
    expect(f.manager.target('browser-one')?.control).toMatchObject({ owner: end === 'takeover' ? 'human' : 'agent', activeOperationId: null, inputIsolation: end === 'takeover' ? 'inactive' : 'isolated' })
    expect(shield.webContents.isDestroyed()).toBe(end === 'takeover')
    expect(f.children.includes(shield)).toBe(end !== 'takeover')
    expect(f.contents.isFocused()).toBe(end === 'takeover')
    expect(f.contents.attached).toBe(false); expect(f.contents.destroyed).toBe(false)
    expect(f.sibling.commands).toEqual(f.siblingBefore.commands); expect(f.sibling.scripts).toEqual(f.siblingBefore.scripts); expect(f.sibling.focusCalls).toBe(0)
  })
})

describe('T024 actual Main display semantics', () => {
  it('new operations replace cues while readonly snapshots preserve them and wait/human input invalidates history', async () => {
    const f = await managerFixture()
    const first = await f.manager.runScript('browser-one', 'actual first tool call')
    expect(first.outcome.kind).toBe('completed')
    const before = f.contents.displays.length
    const second = await f.manager.runScript('browser-one', 'actual next tool call')
    expect(second.outcome.kind).toBe('completed'); expect(f.contents.actions).toBe(2)
    const payloads = actionPayloads(f.contents, before)
    expect(payloads.length).toBeGreaterThan(0)
    const clears = payloads.filter((p: any) => p.phase === 'clear')
    expect(clears).toHaveLength(2) // Previous operation and next actual action begin; initial readonly needs no cue work.
    expect(clears.map((p: any) => p.clearReason)).toEqual(['replace', 'replace'])
    native.mode = 'wait'
    const start = f.contents.displays.length
    const waited = await f.manager.runScript('browser-one', 'actual wait call')
    expect(waited.outcome.kind).toBe('completed')
    const waiting = actionPayloads(f.contents, start)
    expect(waiting.length).toBeGreaterThan(0)
    expect(waiting.filter((p: any) => p.phase === 'clear').at(-1).clearReason).toBe('invalidate')
    f.contents.emit('input-event', {}, { type: 'mouseDown' })
    expect(actionPayloads(f.contents).at(-1).clearReason).toBe('invalidate')
    expect(f.sibling.commands).toEqual(f.siblingBefore.commands); expect(f.sibling.scripts).toEqual(f.siblingBefore.scripts)
  })
  it.each(['Enter', 'Meta+Enter', 'private-invocation-value'])('pressKey %s consumes actual single-key semantics without fabricating chords or text', async key => {
    const f = await managerFixture(); native.mode = 'pressKey'; native.key = key
    const report = await f.manager.runScript('browser-one', 'actual named-key worker')
    expect(report.outcome.kind).toBe('completed'); expect(f.contents.feedbackPayloads).toHaveLength(1)
    const payload = f.contents.feedbackPayloads[0]
    expect(payload.method).toBe('pressKey'); expect(payload.keyLabel).toBe(key === 'Enter' ? 'Enter' : '⌨')
    expect(payload.label).toBe(key === 'Enter' ? 'Agent · Key Enter' : 'Agent · Key ⌨')
    expect(f.contents.scripts.join('')).not.toContain('Meta+Enter'); expect(f.contents.scripts.join('')).not.toContain('private-invocation-value')
    expect(f.sibling.commands).toEqual(f.siblingBefore.commands); expect(f.sibling.scripts).toEqual(f.siblingBefore.scripts)
  })
  it.each(['js', 'cdp'])('only actual %s opaque work enables the executor method, with no code or params in display payload', async method => {
    const f = await managerFixture(); native.mode = method
    const report = await f.manager.runScript('browser-one', 'actual opaque worker')
    expect(report.outcome.kind).toBe('completed'); expect(f.contents.feedbackPayloads).toHaveLength(0)
    const payloads = actionPayloads(f.contents)
    const running = payloads.filter((p: any) => p.phase === 'running')
    expect(running).toHaveLength(1); expect(running[0].method).toBe(method); expect(running[0].kind).toBe('page')
    expect(f.contents.scripts.join('')).not.toContain('private-invocation-value')
    expect(f.contents.attached).toBe(false); expect(f.sibling.commands).toEqual(f.siblingBefore.commands); expect(f.sibling.scripts).toEqual(f.siblingBefore.scripts)
  })
})


describe('native shield presentation ownership through the real manager', () => {
  const floatingStage = {
    id: 'chrome-1', bounds: { x: 0, y: 0, width: 600, height: 450 }, radius: 8,
    browserStages: [{ browserId: 'browser-one', bounds: { x: 0, y: 0, width: 500, height: 400 } }]
  }

  it('never reattaches a disposed cleanup shield above the restored same-id page', async () => {
    const f = await managerFixture(); native.mode = 'held-wait'
    let retired: any
    native.onWaiting = async () => {
      retired = f.manager.nativeOwner('browser-one')!.inputShield
      retired.webContents.mainFrame.framesInSubtree = [{ osProcessId: 902, detached: false }]
      native.deferredCloseId = retired.webContents.id
    }
    const operation = await f.manager.runScript('browser-one', 'original delayed-close operation', undefined, undefined, 'cleanup-before-restore')
    expect(operation.outcome.kind).toBe('completed')
    f.manager.takeControl('browser-one')
    expect(retired.webContents.isDestroyed()).toBe(false)
    expect(retired.getVisible()).toBe(false) // Cleanup uncertainty must not leave a false control edge on screen.
    expect(f.children).not.toContain(retired)
    const original = f.manager.nativeOwner('browser-one')!.view
    original.webContents.close()
    expect(original.webContents.isDestroyed()).toBe(true)
    const restored = await f.manager.restore('browser-one', { workspaceId: 'workspace' })
    f.manager.setBounds('browser-one', { x: 0, y: 0, width: 500, height: 400 })
    const current = f.manager.nativeOwner('browser-one')!
    expect(restored).toMatchObject({ id: 'browser-one', url: 'https://generic.invalid/one', profileId: 'default' })
    expect(current.view).not.toBe(original)
    const cleanup = Reflect.get(f.manager, 'entries').get('browser-one').inputShield
    expect(cleanup.view).toBe(retired)
    expect(f.manager.resourceProcessIds()).toContain(902)
    const warning = vi.fn(), chrome = new NativeOverlaySurfaces(f.window as never, f.manager, warning, vi.fn())
    try {
      expect(await chrome.update([floatingStage])).toMatchObject({ projected: 1 })
      // The actual consumer must not reinstall a live-but-retired native surface.
      expect(f.children).not.toContain(retired)
      expect(f.manager.nativeOwner('browser-one')?.inputShield).toBeUndefined()
      expect(f.manager.nativeOwner('browser-one')?.view).toBe(current.view)
      expect(current.view.webContents.isDestroyed()).toBe(false)
      expect(cleanup.contents.isDestroyed()).toBe(false)
      expect(Reflect.get(f.manager, 'entries').get('browser-one').inputShield).toBe(cleanup)
      expect(f.manager.target('browser-one')?.control?.inputIsolation).toBe('unconfirmed')
      expect(f.manager.resourceProcessIds()).toContain(902)
      expect(f.manager.resourceTargets(new Map([[902, 1]])).find(target => target.id === 'browser-one')?.resource?.retention).toMatchObject({ status: 'unknown', reasons: expect.arrayContaining(['close-unconfirmed']) })
      expect(warning).not.toHaveBeenCalled()
      retired.webContents.finishClose()
      await Promise.resolve(); await Promise.resolve()
      expect(f.manager.resourceProcessIds()).not.toContain(902)
      expect(Reflect.get(f.manager, 'entries').get('browser-one').inputShield).toBeUndefined()
      expect(f.manager.nativeOwner('browser-one')?.view).toBe(current.view)
    } finally { chrome.dispose(); retired.webContents.finishClose() }
  })

  it('keeps a live exact shield in the floating pair while its adjacency needs arranging', async () => {
    const f = await managerFixture(); native.mode = 'held-wait'
    const warning = vi.fn(), chrome = new NativeOverlaySurfaces(f.window as never, f.manager, warning, vi.fn())
    let checked = false, checkError: unknown
    native.onWaiting = async () => {
      try {
        const owner = f.manager.nativeOwner('browser-one')!, shield = owner.inputShield!
        const originalCleanup = Reflect.get(f.manager, 'entries').get('browser-one').inputShield
        expect(originalCleanup.isolated).toBe(true)
        expect(originalCleanup.isCurrentFor(owner.view)).toBe(true)
        expect(originalCleanup.isCurrentFor(f.children.find(view => view.webContents === f.sibling))).toBe(false)
        // Native ordering can temporarily separate the pair. Current ownership is
        // the input fact used to repair that order, not a consequence of adjacency.
        const sibling = f.children.find(view => view.webContents === f.sibling)
        f.window.contentView.removeChildView(sibling)
        f.window.contentView.addChildView(sibling, f.children.indexOf(owner.view) + 1)
        expect(originalCleanup.isolated).toBe(false)
        expect(f.manager.nativeOwner('browser-one')?.inputShield).toBe(shield)
        expect(await chrome.update([floatingStage])).toMatchObject({ projected: 1 })
        expect(f.children.indexOf(shield)).toBe(f.children.indexOf(owner.view) + 1)
        expect(originalCleanup.isolated).toBe(true)
        expect(f.manager.nativeOwner('browser-one')?.inputShield).toBe(shield)
        expect(owner.view.webContents.isDestroyed()).toBe(false)
        expect(shield.webContents.isDestroyed()).toBe(false)
        expect(warning).not.toHaveBeenCalled()
        checked = true
      } catch (error) {
        checkError = error
        throw error
      }
    }
    try {
      const report = await f.manager.runScript('browser-one', 'original live operation', undefined, undefined, 'live-shield-pair')
      if (checkError) throw checkError
      expect(report).toMatchObject({ outcome: { kind: 'completed' } })
      expect(checked).toBe(true)
    } finally { chrome.dispose() }
  })
})
