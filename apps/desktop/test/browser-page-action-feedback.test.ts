import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserPageDispatch } from '../src/main/browser-page-dispatch.js'

const native = vi.hoisted(() => ({ views: [] as any[], mode: 'click', onFeedback: undefined as undefined | (() => void), displayFails: false, displayThrows: false, observe: undefined as undefined | (() => Promise<unknown>), takeover: undefined as undefined | (() => void) }))
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
    if (native.mode === 'concurrent-observe') native.observe = () => onPageCall('snapshot', [])
    if (native.mode === 'concurrent') await Promise.all([onPageCall('click', [page.nodes[0].ref]), onPageCall('hover', [page.nodes[0].ref])])
    else await onPageCall(['navigation', 'concurrent-observe'].includes(native.mode) ? 'click' : native.mode, [page.nodes[0].ref, 'private-invocation-value'])
    if (native.mode === 'navigation') {
      await onPageCall('gotoUrl', ['https://generic.invalid/next'])
      const next = await onPageCall('snapshot', [])
      await onPageCall('click', [next.nodes[0].ref])
    }
    return { completed: true, value: true, logs: [] }
  } catch (error) { return { completed: false, failure: { kind: 'program-error', message: String(error) }, logs: [] } }
} }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Contents extends EventEmitter {
    id = 91; url = ''; attached = false; destroyed = false; actions = 0; feedbackCalls = 0; feedbackPayloads: any[] = []; scripts: string[] = []; commands: string[] = []
    readonly session = Object.assign(new EventEmitter(), { setPermissionCheckHandler() {}, setPermissionRequestHandler() {} })
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
        if (method === 'Runtime.evaluate') return { result: { value: true } }
        if (method === 'Runtime.callFunctionOn') {
          if (params.objectId === 'feedback-object') { this.feedbackCalls++; this.feedbackPayloads.push(params.arguments[0].value); native.onFeedback?.(); return { result: { value: true } } }
          if (params.functionDeclaration.includes('this.click()') || params.functionDeclaration.includes('this.value') || params.functionDeclaration.includes('pointerover')) this.actions++
          return { result: { value: null } }
        }
        return {}
      }
    })
    isDestroyed() { return this.destroyed }; isLoading() { return false }; getURL() { return this.url }; getTitle() { return 'Page' }
    getZoomFactor() { return 1 }; setZoomFactor() {}; setBackgroundThrottling() {}; getBackgroundThrottling() { return true }
    disableDeviceEmulation() {}; enableDeviceEmulation() {}; setWindowOpenHandler() {}
    executeJavaScriptInIsolatedWorld(_world: number, scripts: any[]) { if (native.displayThrows && scripts.some(s => s.code.includes('\"phase\":\"running\"'))) throw new Error('Synchronous native display failure'); this.scripts.push(...scripts.map(s => s.code)); return Promise.resolve(!(native.displayFails && scripts.some(s => s.code.includes('\"phase\":\"running\"')))) }
    async loadURL(url: string) { const previous = this.url; this.url = url; if (previous) this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url }) }; close() { this.destroyed = true; this.emit('destroyed') }
  }
  class View { readonly webContents = new Contents(); constructor() { native.views.push(this) }; setVisible() {}; setBounds() {} }
  return { WebContentsView: View }
})
import { BrowserViewManager } from '../src/main/browser-view-manager.js'
import { BrowserRefLedgerStore } from '../src/main/browser-ref-ledger-store.js'
const roots: string[] = [], managers: BrowserViewManager[] = []
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  native.views.length = 0; native.mode = 'click'; native.onFeedback = undefined; native.displayFails = false; native.displayThrows = false; native.observe = undefined; native.takeover = undefined
})
async function managerFixture() {
  const root = await mkdtemp('/tmp/amx-action-feedback-source-'); roots.push(root)
  const children: any[] = [], events: any[] = []
  const window = { contentView: { addChildView: (v: any) => children.push(v), removeChildView() {} },
    isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (_name: string, e: any) => events.push(e) } }
  const manager = new BrowserViewManager(window as never, { defaultProfileId: () => 'default', resolvePartition: () => 'persist:feedback' },
    new BrowserRefLedgerStore(join(root, 'refs.json')), { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal() {} })
  managers.push(manager)
  await manager.create('browser-one', 'https://generic.invalid/one', 'workspace')
  await manager.create('sibling', 'https://generic.invalid/two', 'workspace')
  manager.setBounds('browser-one', { x: 0, y: 0, width: 500, height: 400 })
  return { manager, contents: children[0].webContents, sibling: children[1].webContents, events }
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
  it('connects visible run to feedback, clears busy at normal end and leaves the unrelated Browser untouched', async () => {
    const f = await managerFixture()
    const report = await f.manager.runScript('browser-one', 'actual worker double', { id: 'agent', name: 'Actual Agent' })
    expect(report.outcome.kind).toBe('completed'); expect(f.contents.actions).toBe(1); expect(f.contents.feedbackCalls).toBe(1)
    expect(f.contents.attached).toBe(false); expect(f.contents.destroyed).toBe(false)
    expect(f.contents.scripts.length).toBeGreaterThan(0)
    expect(f.contents.scripts.at(-1)).toContain('"phase":"completed"')
    expect(f.sibling.commands).toEqual([]); expect(f.sibling.scripts).toEqual([]); expect(f.sibling.destroyed).toBe(false)
    const count = f.contents.scripts.length; f.manager.setBounds('browser-one', null)
    expect(f.contents.scripts.slice(count)).toHaveLength(1); expect(f.contents.scripts.at(-1)).toContain('"phase":"clear"')
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
    const count = f.contents.scripts.length
    f.contents.emit('input-event', {}, { type: 'mouseDown' })
    expect(f.contents.scripts.slice(count)).toHaveLength(1); expect(f.contents.scripts.at(-1)).toContain('\"phase\":\"clear\"')
    expect(f.contents.attached).toBe(false); expect(report.runOperation?.phase).toBe('completed')
    expect(f.sibling.commands).toEqual([]); expect(f.sibling.scripts).toEqual([])
  })
  it('actual concurrent page calls keep both healthy actions while stale feedback cannot borrow the newer action label', async () => {
    const f = await managerFixture(); native.mode = 'concurrent'
    const report = await f.manager.runScript('browser-one', 'actual concurrent worker double')
    expect(report.outcome.kind).toBe('completed'); expect(f.contents.actions).toBe(2)
    expect(f.contents.feedbackPayloads).toHaveLength(1)
    expect(f.contents.feedbackPayloads[0].label).toBe('Agent · Hover')
    expect(f.contents.scripts.at(-1)).toContain('Hover complete')
    expect(f.contents.attached).toBe(false); expect(f.sibling.commands).toEqual([]); expect(f.sibling.scripts).toEqual([])
  })
  it('a concurrent readonly call cannot replace the original action guard after display and permit a late human action', async () => {
    const f = await managerFixture(); native.mode = 'concurrent-observe'
    native.takeover = () => f.contents.emit('input-event', {}, { type: 'mouseDown' })
    const report = await f.manager.runScript('browser-one', 'actual concurrent worker double')
    expect(report.outcome.kind).toBe('stopped'); expect(f.contents.feedbackCalls).toBe(1)
    expect(f.contents.commands.filter((name: string) => name === 'Accessibility.getFullAXTree')).toHaveLength(2)
    expect(f.contents.actions).toBe(0); expect(f.contents.attached).toBe(false)
    expect(f.events.at(-1).browser.activity.control).toBe('human')
    expect(f.sibling.commands).toEqual([]); expect(f.sibling.scripts).toEqual([])
  })
  it('a real input during feedback stops the original late action while preserving both healthy pages', async () => {
    const f = await managerFixture()
    native.onFeedback = () => f.contents.emit('input-event', {}, { type: 'mouseDown' })
    const report = await f.manager.runScript('browser-one', 'actual worker double')
    expect(f.contents.feedbackCalls).toBe(1); expect(f.contents.actions).toBe(0)
    expect(report.outcome.kind).toBe('stopped'); expect(report.runOperation?.phase).toBe('stopped')
    expect(f.events.at(-1).browser.activity.control).toBe('human')
    expect(f.contents.scripts.at(-1)).toContain('"phase":"clear"')
    expect(f.contents.destroyed).toBe(false); expect(f.sibling.destroyed).toBe(false)
    expect(f.sibling.scripts).toEqual([]); expect(f.sibling.commands).toEqual([])
  })
  it.each(['false', 'synchronous throw'])('%s display result leaves the actual action completed with a persistent local service warning', async (kind) => {
    const f = await managerFixture(); native.displayFails = kind === 'false'; native.displayThrows = kind === 'synchronous throw'
    const report = await f.manager.runScript('browser-one', 'actual worker double')
    expect(report.outcome.kind).toBe('completed'); expect(f.contents.actions).toBe(1)
    expect(f.contents.feedbackCalls).toBe(0); expect(f.contents.destroyed).toBe(false); expect(f.contents.attached).toBe(false)
    expect(report.runOperation?.warning).toContain('feedback could not be displayed')
    expect(f.events.at(-1).browser.activity.warning).toContain('remain usable')
    native.displayFails = false; native.displayThrows = false; native.observe = undefined; native.takeover = undefined
    const next = await f.manager.runScript('browser-one', 'second healthy run')
    expect(next.outcome.kind).toBe('completed'); expect(f.contents.actions).toBe(2)
    expect(f.sibling.commands).toEqual([]); expect(f.sibling.scripts).toEqual([])
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
})
