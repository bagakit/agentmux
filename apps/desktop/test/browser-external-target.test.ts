import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExternalBrowserBridge, ExternalBrowserRequestFailure } from '../src/main/browser-external-bridge.js'
import { attachExternalBrowserTarget, type ExternalBrowserTargetSession } from '../src/main/browser-external-target.js'
import { createBrowserPageDispatch } from '../src/main/browser-page-dispatch.js'
import { isShareUrl, isTabScopedCommand, BROWSER_OPERATION_FEEDBACK_WORLD_NAME, buildOwnedFeedbackClearScript } from '../browser-extension/protocol.js'

// A real production extension worker talks to the real loopback bridge. Chrome APIs are
// deliberately Source doubles here; this suite does not certify a Native browser.
class Signal {
  listeners: ((...args: any[]) => unknown)[] = []
  addListener(listener: (...args: any[]) => unknown): void { this.listeners.push(listener) }
  emit(...args: any[]): void { for (const listener of this.listeners) listener(...args) }
}
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
const extensionId = 'a'.repeat(32)
const origin = `chrome-extension://${extensionId}`
const owner = { operationId: 'fixture-operation', callerId: 'fixture-caller' }
let Worker: typeof import('../browser-extension/service-worker.js')['SharedTabWorker'] | undefined
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  // Disconnect before transport cleanup, so a deliberately malformed reply cannot
  // turn a Source assertion into a long cleanup timeout.
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.unstubAllGlobals()
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'agentmux-shared-tab-source-'))
  const path = join(directory, 'bindings.json')
  const documentEnded = vi.fn()
  const bridge = new ExternalBrowserBridge(path, () => {}, documentEnded)
  const tabs = new Map([
    [1, { id: 1, url: 'https://fixture.invalid/form', title: 'Fixture HTTPS' }],
    [2, { id: 2, url: 'http://127.0.0.1:8123/form', title: 'Fixture loopback' }],
    [3, { id: 3, url: 'https://unshared.invalid/', title: 'Unshared fixture' }]
  ])
  let selected = 1
  let state: Record<string, any> = {}
  let counter = 0
  const attached = new Set<number>()
  const api = {
    storage: { session: { get: vi.fn(async () => structuredClone(state)), set: vi.fn(async (value) => { state = structuredClone(value) }) } },
    runtime: { onMessage: new Signal(), getURL: (name: string) => `${origin}/${name}` },
    tabs: { onRemoved: new Signal(), onUpdated: new Signal(),
      query: vi.fn(async () => [tabs.get(selected)]),
      get: vi.fn(async (id: number) => { const tab = tabs.get(id); if (!tab) throw new Error('Tab closed'); return { ...tab } }),
      create: vi.fn(), update: vi.fn() },
    windows: { update: vi.fn() },
    debugger: { onDetach: new Signal(), onEvent: new Signal(),
      attach: vi.fn(async (target: { tabId: number }) => { attached.add(target.tabId) }),
      detach: vi.fn(async (target: { tabId: number }) => { attached.delete(target.tabId) }),
      sendCommand: vi.fn(async (target: { tabId: number; sessionId?: string }, method: string, params?: any): Promise<any> => {
        if (!attached.has(target.tabId)) throw new Error('Not attached')
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-document', loaderId: `loader-${target.tabId}`, url: tabs.get(target.tabId)!.url } } }
        if (method === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: '1', backendDOMNodeId: 11, role: { value: 'button' }, name: { value: 'Fixture button' }, childIds: [] }] }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 }
        if (method === 'Runtime.evaluate') return { result: { value: params.expression === 'counter' ? counter : '[]' } }
        if (method === 'DOM.resolveNode') return { object: { objectId: 'fixture-object' } }
        if (method === 'Runtime.callFunctionOn') { if (params?.functionDeclaration?.includes('this.click()')) counter++; return { result: { value: null } } }
        return {}
      }) }
  }
  class ExtensionSocket extends WebSocket { constructor(url: string) { super(url, { origin }) } }
  vi.stubGlobal('chrome', api)
  vi.stubGlobal('WebSocket', ExtensionSocket)
  let worker: import('../browser-extension/service-worker.js').SharedTabWorker
  if (!Worker) {
    const module = await import('../browser-extension/service-worker.js')
    Worker = module.SharedTabWorker; worker = module.worker
  } else { worker = new Worker(api, ExtensionSocket); worker.start() }
  await worker.ready
  cleanups.push(async () => { worker.disconnect('Fixture complete'); await bridge.dispose(); await rm(directory, { recursive: true }) })
  function popup(message: Record<string, unknown>, sender = { url: `${origin}/popup.html` }): Promise<any> {
    return new Promise(resolve => {
      const accepted = api.runtime.onMessage.listeners[0]!(message, sender, (reply: any) => resolve(reply))
      if (!accepted) resolve({ ok: false, error: 'Untrusted caller' })
    })
  }
  const pairing = await bridge.createPairing('fixture-workspace')
  expect(await popup({ type: 'connect', link: pairing.link })).toEqual({ ok: true, value: {} })
  async function share(tabId = 1) {
    selected = tabId
    const reply = await popup({ type: 'share', tabId })
    expect(reply.ok).toBe(true)
    const binding = bridge.require(reply.value.bindingId)
    expect(binding.tabId).toBe(tabId)
    return binding
  }
  async function attach(tabId = 1) {
    const binding = await share(tabId)
    const session = await attachExternalBrowserTarget(bridge, binding, owner)
    cleanups.push(() => session.detach())
    return { binding, session }
  }
  return { api, bridge, worker, documentEnded, pairing, popup, share, attach, tabs, path, attached,
    select: (id: number) => { selected = id }, get counter() { return counter } }
}

describe('person-shared external Browser transport', () => {
  it.each(['withdrawal', 'disconnect'])('clears only original recorded root/child feedback contexts before detach on %s', async reason => {
    const f = await fixture(); const { session } = await f.attach()
    const original = f.api.debugger.sendCommand.getMockImplementation()!
    f.api.debugger.sendCommand.mockImplementation(async (target, method, params) => method === 'Page.createIsolatedWorld'
      ? { executionContextId: params?.worldName === BROWSER_OPERATION_FEEDBACK_WORLD_NAME ? target.sessionId ? 17 : 11 : 29 }
      : await original(target, method, params))
    await session.sendCommand('Page.createIsolatedWorld', { frameId: 'main-document', worldName: BROWSER_OPERATION_FEEDBACK_WORLD_NAME })
    await session.sendCommand('Page.createIsolatedWorld', { frameId: 'main-document', worldName: 'ordinary-page-world' })
    f.api.debugger.onEvent.emit({ tabId: 1 }, 'Target.attachedToTarget', { sessionId: 'original-child', targetInfo: { type: 'iframe' } })
    await vi.waitFor(() => expect(session.frames.has('original-child')).toBe(true))
    await session.frames.get('original-child')!('Page.createIsolatedWorld', { frameId: 'original-child-frame', worldName: BROWSER_OPERATION_FEEDBACK_WORLD_NAME })
    f.api.debugger.sendCommand.mockClear(); f.api.debugger.attach.mockClear()
    if (reason === 'withdrawal') expect((await f.popup({ type: 'unshare', tabId: 1 })).ok).toBe(true)
    else f.worker.disconnect('Actual fixture disconnect')
    await vi.waitFor(() => expect(f.api.debugger.detach).toHaveBeenCalledTimes(1))
    expect(f.api.debugger.sendCommand.mock.calls).toEqual([
      [{ tabId: 1 }, 'Runtime.evaluate', { contextId: 11, expression: buildOwnedFeedbackClearScript(owner.operationId), returnByValue: true }],
      [{ tabId: 1, sessionId: 'original-child' }, 'Runtime.evaluate', { contextId: 17, expression: buildOwnedFeedbackClearScript(owner.operationId), returnByValue: true }]
    ])
    expect(f.api.debugger.attach).not.toHaveBeenCalled(); expect(f.api.tabs.update).not.toHaveBeenCalled(); expect(f.api.windows.update).not.toHaveBeenCalled()
    expect(f.api.debugger.sendCommand.mock.invocationCallOrder.at(-1)).toBeLessThan(f.api.debugger.detach.mock.invocationCallOrder[0]!)
  })
  it('keeps ordinary completed feedback on normal detach and creates no cleanup reads for an unrecorded world', async () => {
    const f = await fixture(); const { session } = await f.attach()
    await session.sendCommand('Page.createIsolatedWorld', { frameId: 'main-document', worldName: BROWSER_OPERATION_FEEDBACK_WORLD_NAME })
    f.api.debugger.sendCommand.mockClear()
    await session.detach()
    expect(f.api.debugger.sendCommand.mock.calls).toEqual([])
    expect(f.api.debugger.detach).toHaveBeenCalledTimes(1)
    const second = await f.attach(2)
    f.api.debugger.sendCommand.mockClear()
    await f.popup({ type: 'unshare', tabId: 2 })
    expect(f.api.debugger.sendCommand.mock.calls).toEqual([])
    await vi.waitFor(() => expect(second.binding.status).toBe('revoked'))
  })
  it('ends only the original replaced or closed document, keeping same-document navigation, withdrawal and disconnection unknown', async () => {
    const f = await fixture(); const { binding } = await f.attach()
    const document = binding.navigationId
    f.documentEnded.mockClear()
    f.api.debugger.onEvent.emit({ tabId: 1 }, 'Page.navigatedWithinDocument', { frameId: 'main-document', url: 'https://fixture.invalid/form#section' })
    await vi.waitFor(() => expect(binding.url).toContain('#section'))
    expect(binding.navigationId).toBe(document)
    expect(f.documentEnded).not.toHaveBeenCalled()
    f.api.debugger.onEvent.emit({ tabId: 1 }, 'Page.frameNavigated', { frame: { id: 'main-document', loaderId: 'confirmed-next-document', url: 'https://fixture.invalid/next' } })
    await vi.waitFor(() => expect(f.documentEnded).toHaveBeenCalledWith(binding.id, document))
    expect(f.documentEnded.mock.calls).toEqual([[binding.id, document]])
    f.api.tabs.onRemoved.emit(1)
    await vi.waitFor(() => expect(binding.status).toBe('closed'))
    expect(f.documentEnded.mock.calls).toEqual([[binding.id, document], [binding.id, 'confirmed-next-document']])
    const second = await f.share(2)
    f.documentEnded.mockClear()
    expect((await f.popup({ type: 'unshare', tabId: 2 })).ok).toBe(true)
    await vi.waitFor(() => expect(second.status).toBe('revoked'))
    const third = await f.share(3)
    f.worker.disconnect('Uncertain transport loss')
    await vi.waitFor(() => expect(third.status).toBe('disconnected'))
    expect(f.documentEnded).not.toHaveBeenCalled()
  })
  it('pairs transport without granting a tab and refuses a page sender or a stale selection', async () => {
    const f = await fixture()
    expect(f.bridge.list()).toEqual([])
    expect(await f.popup({ type: 'share', tabId: 1 }, { url: `${origin}/popup.html`, tab: { id: 1 } } as any)).toEqual({ ok: false, error: 'Untrusted caller' })
    f.select(2)
    expect((await f.popup({ type: 'share', tabId: 1 })).ok).toBe(false)
    expect(f.bridge.list()).toEqual([])
    expect(f.api.debugger.attach).not.toHaveBeenCalled()
  })
  it('does not turn an unknown restored grant into person consent', async () => {
    const f = await fixture()
    f.worker.grants.set(1, { tabId: 1, grantId: crypto.randomUUID(), navigationId: 'unapproved-document',
      url: f.tabs.get(1)!.url, title: 'Unapproved restored record', attached: false, frames: new Map() })
    expect((await f.popup({ type: 'connect', link: f.pairing.link })).ok).toBe(true)
    await vi.waitFor(() => expect(f.worker.grants.size).toBe(0))
    expect(f.bridge.list()).toEqual([])
    expect(f.api.debugger.attach).not.toHaveBeenCalled()
  })
  it.each([1, 2])('shares the selected generic protocol page %i and dispatches snapshot/ref/action through the original SDK', async tabId => {
    const f = await fixture()
    const { binding, session } = await f.attach(tabId)
    const dispatch = createBrowserPageDispatch({ session, pageInfo: () => binding,
      gotoUrl: async () => {}, captureScreenshot: async () => ({}), readLedger: async () => null,
      writeLedger: async () => {}, note: () => {} })
    const snapshot = await dispatch('snapshot', []) as { nodes: { ref: string }[] }
    expect(snapshot.nodes).toHaveLength(1)
    expect(snapshot.nodes[0]!.ref).toBeTruthy()
    await dispatch('click', [snapshot.nodes[0]!.ref])
    expect(f.counter).toBe(1)
    expect(f.api.debugger.sendCommand.mock.calls.length).toBeGreaterThan(0)
    expect(f.api.debugger.sendCommand.mock.calls.map(call => call[0].tabId)).toEqual(expect.arrayContaining([tabId]))
    expect(f.api.tabs.get.mock.calls.some(([id]) => id === 3)).toBe(false)
    expect(f.api.tabs.create).not.toHaveBeenCalled()
    expect(f.api.tabs.update).not.toHaveBeenCalled()
    expect(f.api.windows.update).not.toHaveBeenCalled()
  })
  it('rejects broader targets, global profile commands, browser focus and foreign child sessions', async () => {
    const f = await fixture()
    const { binding, session } = await f.attach()
    const count = f.api.debugger.sendCommand.mock.calls.length
    for (const [method, params] of [['Target.attachToTarget', { targetId: 'foreign' }], ['Storage.getCookies', {}],
      ['Page.bringToFront', {}], ['Runtime.evaluate', { expression: '1', targetId: 'foreign' }], ['Network.getCookies', {}],
      ['Security.setIgnoreCertificateErrors', { ignore: true }], ['IO.read', { handle: 'foreign-stream' }]] as const) {
      await expect(session.sendCommand(method, params)).rejects.toMatchObject({ sent: false })
    }
    await expect(binding.connection!.request(binding, owner, 'command', 'Runtime.evaluate', { expression: '1' }, 'foreign')).rejects.toThrow(/child session/)
    expect(f.api.debugger.sendCommand).toHaveBeenCalledTimes(count)
    expect(session.endedReason).toBeNull()
  })
  it('accepts only actual iframe descendants, retains them on same-process child navigation, and removes an entire detached subtree', async () => {
    const f = await fixture()
    const { session } = await f.attach()
    f.api.debugger.onEvent.emit({ tabId: 3 }, 'Target.attachedToTarget', { sessionId: 'foreign', targetInfo: { type: 'iframe' } })
    f.api.debugger.onEvent.emit({ tabId: 1 }, 'Target.attachedToTarget', { sessionId: 'child', targetInfo: { type: 'iframe' } })
    await vi.waitFor(() => expect(session.frames.has('child')).toBe(true))
    f.api.debugger.onEvent.emit({ tabId: 1, sessionId: 'child' }, 'Target.attachedToTarget', { sessionId: 'grandchild', targetInfo: { type: 'iframe' } })
    await vi.waitFor(() => expect([...session.frames.keys()]).toEqual(['child', 'grandchild']))
    const grandchild = session.frames.get('grandchild')!
    f.api.debugger.onEvent.emit({ tabId: 1 }, 'Page.frameNavigated', { frame: { id: 'same-process-child', parentId: 'main-document', loaderId: 'child-loader' } })
    f.api.debugger.onEvent.emit({ tabId: 1 }, 'Page.navigatedWithinDocument', { frameId: 'same-process-child', url: 'https://fixture.invalid/child#part' })
    await expect(grandchild('Runtime.evaluate', { expression: 'counter' })).resolves.toEqual({ result: { value: 0 } })
    expect([...session.frames.keys()]).toEqual(['child', 'grandchild'])
    f.api.debugger.onEvent.emit({ tabId: 1 }, 'Target.detachedFromTarget', { sessionId: 'child' })
    await vi.waitFor(() => expect([...session.frames.keys()]).toEqual([]))
    expect(f.worker.grants.get(1).frames.size).toBe(0)
  })
  it('reports a known frame discovery error without declaring the original document dead', async () => {
    const f = await fixture()
    const original = f.api.debugger.sendCommand.getMockImplementation()!
    f.api.debugger.sendCommand.mockImplementation(async (target, method, params) => {
      if (method === 'Target.setAutoAttach') throw new Error('Fixture unsupported frame discovery')
      return original(target, method, params)
    })
    const { session } = await f.attach()
    expect(session.frameDiscoveryFailure).toMatch(/unsupported frame discovery/)
    expect(session.endedReason).toBeNull()
    await expect(session.sendCommand('Runtime.evaluate', { expression: 'counter' })).resolves.toEqual({ result: { value: 0 } })
  })
  it('does not send an action after person revocation while the original tab read is awaiting', async () => {
    const f = await fixture()
    const { session } = await f.attach()
    const held = deferred<any>(); const entered = deferred()
    const cleanupHeld = deferred(); const cleanupEntered = deferred()
    f.api.debugger.detach.mockImplementationOnce(async target => { cleanupEntered.resolve(); await cleanupHeld.promise; f.attached.delete(target.tabId) })
    f.api.tabs.get.mockImplementationOnce(async () => { entered.resolve(); return held.promise })
    const action = session.sendCommand('Runtime.callFunctionOn', { objectId: 'fixture-object', functionDeclaration: 'function(){this.click()}' })
    const rejected = expect(action).rejects.toMatchObject({ uncertain: true })
    await entered.promise
    const unshare = f.popup({ type: 'unshare', tabId: 1 })
    await cleanupEntered.promise
    held.resolve(f.tabs.get(1))
    await rejected
    await vi.waitFor(() => expect(f.worker.requestTails.size).toBe(0))
    try {
      expect(f.counter).toBe(0)
      expect(f.bridge.list().map(row => row.status)).toEqual(['revoked'])
    } finally { cleanupHeld.resolve(); expect((await unshare).ok).toBe(true) }
  })
  it('keeps sent-but-unconfirmed actions unknown across disconnect and ignores their late acknowledgements without replay', async () => {
    const f = await fixture()
    const { binding, session } = await f.attach()
    const held = deferred<any>(); const entered = deferred()
    const original = f.api.debugger.sendCommand.getMockImplementation()!
    f.api.debugger.sendCommand.mockImplementation(async (target, method, params) => {
      const result = await original(target, method, params)
      if (method === 'Runtime.callFunctionOn') { entered.resolve(); return held.promise }
      return result
    })
    const action = session.sendCommand('Runtime.callFunctionOn', { objectId: 'fixture-object', functionDeclaration: 'function(){ this.click() }' })
    const rejected = expect(action).rejects.toBeInstanceOf(ExternalBrowserRequestFailure)
    await entered.promise
    f.worker.disconnect('Fixture link lost')
    await rejected
    expect(session.endedReason).toMatch(/Connection|connection/)
    expect(f.counter).toBe(1)
    expect((await f.popup({ type: 'connect', link: f.pairing.link })).ok).toBe(true)
    held.resolve({ result: { value: null } })
    await vi.waitFor(() => expect(binding.status).toBe('ready'))
    expect(f.bridge.list()).toHaveLength(1)
    expect(f.counter).toBe(1)
    await expect(session.sendCommand('Runtime.evaluate', { expression: 'counter' })).rejects.toThrow()
  })
  it('rejects an old document command that is queued behind a navigation', async () => {
    const f = await fixture()
    const { binding, session } = await f.attach()
    const held = deferred<any>(); const entered = deferred()
    const original = f.api.debugger.sendCommand.getMockImplementation()!
    f.api.debugger.sendCommand.mockImplementation(async (target, method, params) => {
      if (method === 'Runtime.evaluate' && params?.expression === 'hold') { entered.resolve(); return held.promise }
      return original(target, method, params)
    })
    const prior = session.sendCommand('Runtime.evaluate', { expression: 'hold' })
    const priorRejected = expect(prior).rejects.toThrow(/document changed/)
    await entered.promise
    const action = session.sendCommand('Runtime.callFunctionOn', { objectId: 'fixture-object', functionDeclaration: 'function(){ this.click() }' })
    const actionRejected = expect(action).rejects.toMatchObject({ sent: false })
    f.api.debugger.onEvent.emit({ tabId: 1 }, 'Page.frameNavigated', { frame: { id: 'main-document', loaderId: 'new-loader', url: f.tabs.get(1)!.url } })
    await vi.waitFor(() => expect(binding.navigationId).toBe('new-loader'))
    held.resolve({ result: { value: null } })
    await priorRejected; await actionRejected
    expect(f.counter).toBe(0)
  })
  it('classifies a stale error acknowledgement as unknown even when the extension claims certainty', async () => {
    const f = await fixture()
    const { binding, session } = await f.attach()
    const held = deferred(); const entered = deferred()
    f.api.debugger.sendCommand.mockImplementationOnce(async () => { entered.resolve(); await held.promise; throw new Error('Fixture protocol error') })
    const originalReply = f.worker.reply.bind(f.worker)
    f.worker.reply = (message: any, payload: any, socket: any, generation: number) => originalReply(message,
      { ...payload, uncertain: false, navigationId: message.navigationId }, socket, generation)
    const action = session.sendCommand('Runtime.evaluate', { expression: 'counter' })
    const rejected = expect(action).rejects.toMatchObject({ uncertain: true, sent: true })
    await entered.promise
    f.api.debugger.onEvent.emit({ tabId: 1 }, 'Page.frameNavigated', { frame: { id: 'main-document', loaderId: 'different-document', url: f.tabs.get(1)!.url } })
    await vi.waitFor(() => expect(binding.navigationId).toBe('different-document'))
    held.resolve()
    await rejected
    expect(session.endedReason).toMatch(/document changed/)
  })
  it('ignores a response for a different caller, operation or child session before accepting the actual tuple', async () => {
    const f = await fixture()
    const { session } = await f.attach()
    const realReply = f.worker.reply.bind(f.worker)
    let acknowledge!: () => void
    const wrongSent = deferred()
    f.worker.reply = (message: any, payload: any, socket: any, generation: number) => {
      realReply({ ...message, callerId: 'different-caller', operationId: 'different-operation', sessionId: 'different-frame' }, payload, socket, generation)
      acknowledge = () => realReply(message, payload, socket, generation)
      wrongSent.resolve()
    }
    let settled = false
    const action = session.sendCommand('Runtime.evaluate', { expression: 'counter' }).finally(() => { settled = true })
    await wrongSent.promise
    const eventReceived = deferred()
    const release = session.observe(method => { if (method === 'Network.loadingFinished') eventReceived.resolve() })
    f.api.debugger.onEvent.emit({ tabId: 1 }, 'Network.loadingFinished', { requestId: 'fixture-request' })
    await eventReceived.promise
    // The two frames may be emitted in one socket callback. Drain promise continuations
    // before checking whether an incorrectly accepted reply settled the SDK call.
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
    acknowledge()
    await expect(action).resolves.toEqual({ result: { value: 0 } })
    f.worker.reply = realReply
    release()
  })
  it('allows original-operation cleanup during a pending attach and never revives a cancelled lease', async () => {
    const f = await fixture()
    const binding = await f.share()
    const held = deferred(); const entered = deferred()
    f.api.debugger.attach.mockImplementationOnce(async target => { entered.resolve(); await held.promise; f.attached.add(target.tabId) })
    const pending = attachExternalBrowserTarget(f.bridge, binding, owner)
    const rejected = expect(pending).rejects.toThrow(/stopped during debugger attachment/)
    await entered.promise
    await expect(binding.connection!.request(binding, owner, 'detach')).resolves.toEqual({})
    held.resolve()
    await rejected
    expect(f.attached.size).toBe(0)
    expect(f.worker.attachOwners.size).toBe(0)
  })
  it.each(['detach', 'revoke'] as const)('does not discover a tab after %s during debugger preparation', async action => {
    const f = await fixture()
    const binding = await f.share()
    const held = deferred(); const entered = deferred()
    const send = f.api.debugger.sendCommand.getMockImplementation()!
    f.api.debugger.sendCommand.mockImplementation(async (target, method, params) => {
      if (method === 'Page.enable') { entered.resolve(); await held.promise; return {} }
      return await send(target, method, params)
    })
    const pending = attachExternalBrowserTarget(f.bridge, binding, owner)
    const rejected = expect(pending).rejects.toThrow()
    await entered.promise
    if (action === 'detach') await binding.connection!.request(binding, owner, 'detach')
    else expect((await f.popup({ type: 'unshare', tabId: 1 })).ok).toBe(true)
    held.resolve()
    await rejected
    expect(f.api.debugger.sendCommand.mock.calls.filter(call => call[1] === 'Page.getFrameTree')).toEqual([])
    expect(f.attached.size).toBe(0)
  })
  it('cannot detach a different operation attachment', async () => {
    const f = await fixture()
    const { binding, session } = await f.attach()
    const before = f.api.debugger.detach.mock.calls.length
    await expect(binding.connection!.request(binding, { operationId: 'other', callerId: owner.callerId }, 'detach')).rejects.toThrow(/no longer owns/)
    expect(f.api.debugger.detach).toHaveBeenCalledTimes(before)
    await expect(session.sendCommand('Runtime.evaluate', { expression: 'counter' })).resolves.toEqual({ result: { value: 0 } })
  })
  it.each([false, true])('does not accept a replaced child frame acknowledgement (error=%s)', async error => {
    const f = await fixture()
    const { session } = await f.attach()
    f.api.debugger.onEvent.emit({ tabId: 1 }, 'Target.attachedToTarget', { sessionId: 'child', targetInfo: { type: 'iframe' } })
    await vi.waitFor(() => expect(session.frames.has('child')).toBe(true))
    const held = deferred(); const entered = deferred()
    const original = f.api.debugger.sendCommand.getMockImplementation()!
    f.api.debugger.sendCommand.mockImplementation(async (target, method, params) => {
      if (method === 'Runtime.evaluate') { entered.resolve(); await held.promise; if (error) throw new Error('Known protocol error from replaced child') }
      return original(target, method, params)
    })
    const originalReply = f.worker.reply.bind(f.worker)
    f.worker.reply = (message: any, payload: any, socket: any, generation: number) => originalReply(message, { ...payload, uncertain: false }, socket, generation)
    const originalChild = session.frames.get('child')!
    const action = originalChild('Runtime.evaluate', { expression: 'counter' })
    const rejected = expect(action).rejects.toMatchObject({ uncertain: true, sent: true })
    await entered.promise
    f.api.debugger.onEvent.emit({ tabId: 1 }, 'Target.detachedFromTarget', { sessionId: 'child' })
    f.api.debugger.onEvent.emit({ tabId: 1 }, 'Target.attachedToTarget', { sessionId: 'child', targetInfo: { type: 'iframe' } })
    await vi.waitFor(() => expect(session.frames.get('child')).not.toBe(originalChild))
    held.resolve()
    await rejected
    expect(session.endedReason).toMatch(/child frame changed/)
  })
  it('does not bind a new browser instance to an existing pairing or choose a substitute tab', async () => {
    const f = await fixture()
    const original = await f.share()
    f.worker.instanceId = crypto.randomUUID()
    expect((await f.popup({ type: 'connect', link: f.pairing.link })).ok).toBe(false)
    await vi.waitFor(() => expect(f.bridge.require(original.id).status).toBe('disconnected'))
    expect(f.bridge.list()).toHaveLength(1)
    expect(f.api.debugger.attach).not.toHaveBeenCalled()
  })
  it('restores only disconnected metadata on client restart, without storing pairing secrets or creating a new browser', async () => {
    const f = await fixture()
    const binding = await f.share()
    await vi.waitFor(async () => expect(JSON.parse(await readFile(f.path, 'utf8')).targets.map((row: any) => row.status)).toEqual(['ready']))
    const stored = await readFile(f.path, 'utf8')
    expect(stored).not.toContain(f.pairing.link.split('#')[1]!)
    const restarted = new ExternalBrowserBridge(f.path)
    cleanups.push(() => restarted.dispose())
    await restarted.ready()
    expect(restarted.list()).toHaveLength(1)
    expect(restarted.require(binding.id).status).toBe('disconnected')
    await expect(attachExternalBrowserTarget(restarted, restarted.require(binding.id), owner)).rejects.toThrow(/reconnect/i)
    expect(f.api.debugger.attach).not.toHaveBeenCalled()
  })
  it('does not resurrect revoked original grants on reconnect or silently switch a target to a reused tab id', async () => {
    const f = await fixture()
    const binding = await f.share()
    const staleGrant = { ...f.worker.grants.get(1), frames: new Map(), attached: false }
    expect((await f.popup({ type: 'unshare', tabId: 1 })).ok).toBe(true)
    f.tabs.set(1, { id: 1, url: 'https://replacement.invalid/', title: 'Replacement' })
    f.worker.grants.set(1, staleGrant)
    expect((await f.popup({ type: 'connect', link: f.pairing.link })).ok).toBe(true)
    expect(f.bridge.require(binding.id).status).toBe('revoked')
    expect(f.bridge.list()).toHaveLength(1)
    expect(f.api.debugger.attach).not.toHaveBeenCalled()
    const replacement = await f.share()
    expect(replacement.id).not.toBe(binding.id)
    expect(f.bridge.require(binding.id).url).toBe('https://fixture.invalid/form')
  })
  it('does not grant file or arbitrary remote HTTP based only on a localhost-looking name', () => {
    expect(['https://fixture.invalid/', 'http://localhost:8080/', 'http://[::1]:8080/'].map(isShareUrl)).toEqual([true, true, true])
    expect([("file://localhost" + _hygiene_fixturePath("tmp")), 'ftp://localhost/', 'http://localhost.example.invalid/', 'http://remote.invalid/', 'https://user:password@fixture.invalid/'].map(isShareUrl)).toEqual([false, false, false, false, false])
    expect(isTabScopedCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'page', exclude: false }] })).toBe(false)
  })
})

// The actual page program child process, dispatch, operation journal and retained evidence
// consume this transport. Native Chrome is certified by the separate private-profile probe.
async function programOwner(f: Awaited<ReturnType<typeof fixture>>, uploads: import('../src/main/browser-uploads.js').BrowserUploads = { upload: vi.fn() } as any) {
  const { dirname } = await import('node:path')
  const { ExternalBrowserOwner } = await import('../src/main/browser-external-owner.js')
  const { BrowserOperationJournal, BrowserOperationFileStore } = await import('../src/main/browser-operation-journal.js')
  const { BrowserStepEvidenceStore } = await import('../src/main/browser-step-evidence.js')
  const { BrowserResultArtifactStore } = await import('../src/main/browser-result-artifact.js')
  const directory = dirname(f.path)
  const journalFile = new BrowserOperationFileStore(join(directory, 'operations.json'))
  const journalSaves = vi.spyOn(journalFile, 'save')
  const journal = new BrowserOperationJournal(journalFile)
  const evidence = new BrowserStepEvidenceStore(join(directory, 'evidence'))
  const ledger = new Map<string, any>()
  const refs = { read: vi.fn(async id => ledger.get(id) ?? null), write: vi.fn(async (id, value) => { ledger.set(id, value) }) }
  const page = new ExternalBrowserOwner(f.bridge, { journal, refs, evidence, uploads,
    results: new BrowserResultArtifactStore(join(directory, 'results')),
    decodeScreenshot: () => { throw new Error('This Source fixture does not certify PNG decoding.') } })
  return { page, journal, evidence, refs, journalFile, journalSaves }
}


// Execute the original Desktop branches, preload invokes and registered Main callbacks.
// Only the UI/IPC frame and empty embedded-page context are Source fixture inputs.
async function sourceBrowserExecutor(f: Awaited<ReturnType<typeof fixture>>, o: Awaited<ReturnType<typeof programOwner>>) {
  const { readFileSync } = await import('node:fs')
  const ts = (await import('typescript')).default
  function ast(path: string) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  }
  function select(source: import('typescript').SourceFile, predicate: (node: import('typescript').Node) => boolean) {
    const nodes: import('typescript').Node[] = []
    const walk = (node: import('typescript').Node): void => { if (predicate(node)) nodes.push(node); ts.forEachChild(node, walk) }
    walk(source); return nodes
  }
  function compiled(source: string, dependencies: Record<string, unknown>) {
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
    return new Function(...Object.keys(dependencies), output)(...Object.values(dependencies))
  }
  const frame = {}; const config = { browser: { agentAutomation: true } }
  const requireTrustedSender = vi.fn((_channel: string, event: unknown) => { if (event !== frame) throw new Error('Untrusted Source frame') })
  const workspace = (_config: unknown, id: string) => { if (id !== 'fixture-workspace') throw new Error('Unknown original Source Workspace'); return { id } }
  const getterSource = ast('../src/main/browser-view-manager.ts')
  const methods = select(getterSource, node => ts.isMethodDeclaration(node) && ['getOperation', 'stopOperationById'].includes(node.name.getText(getterSource)))
  expect(methods, 'Original BVM journal getter and stop method must be present').toHaveLength(2)
  const journalOwner = compiled(`return ({ entries: new Map(), operationJournal, ${methods.map(node => node.getText(getterSource)).join(',\n')} });`, { operationJournal: o.journal })
  const browsers = { targets: () => [], getOperation: (id: string) => journalOwner.getOperation(id),
    runScript: vi.fn(async () => { throw new Error('Unexpected embedded-page run') }),
    stopOperationById: vi.fn(async (id: string) => journalOwner.stopOperationById(id)) }
  const main = ast('../src/main/ipc.ts')
  const callbacks = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  for (const channel of ['browser:listTargets', 'browser:runScript', 'browser:stopOperationById', 'browser:getOperation']) {
    const nodes = select(main, node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'handleWithEvent' &&
      !!node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === channel)
    expect(nodes, `Original Main registration must be unique: ${channel}`).toHaveLength(1)
    const call = nodes[0] as import('typescript').CallExpression
    callbacks.set(channel, compiled(`return ${call.arguments[1]!.getText(main)};`, { requireTrustedSender, config, workspace,
      browsers, externalBrowsers: o.page, externalBridge: f.bridge }))
  }
  const preload = ast('../src/preload/index.ts')
  const names = ['listTargets', 'runScript', 'stopOperationById', 'getOperation']
  const properties = select(preload, node => ts.isPropertyAssignment(node) && names.includes(node.name.getText(preload)))
  expect(properties, 'Original preload Browser invokes must all be present').toHaveLength(4)
  const api = { browser: compiled(`return ({ ${properties.map(node => node.getText(preload)).join(',\n')} });`, {
    ipcRenderer: { invoke: (channel: string, ...args: unknown[]) => {
      const callback = callbacks.get(channel)
      if (!callback) throw new Error(`No original Main callback ${channel}`)
      return callback(frame, ...args)
    } }
  }) }
  const store = ast('../src/renderer/src/store.ts')
  const controlMethods = ['browser.targets', 'browser.run', 'browser.stop', 'browser.operation']
  const branches = select(store, node => ts.isIfStatement(node) && ts.isBinaryExpression(node.expression) &&
    node.expression.left.getText(store) === 'request.operation' && ts.isStringLiteralLike(node.expression.right) && controlMethods.includes(node.expression.right.text))
  expect(branches, 'Original Renderer Browser branches must be unique and nonempty').toHaveLength(4)
  const execute = compiled(`return async request => { ${branches.map(node => node.getText(store)).join('\n')}\nthrow new Error('No original Browser branch'); };`, {
    api, requireActive: () => {}, get: () => ({ sessions: [] })
  }) as (request: import('../../../packages/core/src/control.js').AgentMuxControlRequest) => Promise<import('../../../packages/core/src/control.js').AgentMuxControlResult>
  return { execute, requireTrustedSender, browsers }
}

// The actual executable CLI and public service delegate to this fixture's production
// owner. Chrome APIs remain Source doubles; no installed App or OS focus is certified.
async function sourcePublicCli(f: Awaited<ReturnType<typeof fixture>>, o: Awaited<ReturnType<typeof programOwner>>) {
  const { spawn } = await import('node:child_process')
  const { symlink } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  const { createRequire } = await import('node:module')
  const { fileURLToPath } = await import('node:url')
  const { AgentMuxControlServer } = await import('../../../packages/core/src/control-host.js')
  const { objectCliReceipt } = await import('../../../packages/core/test/helpers/object-cli-receipt.js')
  const require = createRequire(new URL('../../../packages/core/package.json', import.meta.url))
  const directory = dirname(f.path)
  const cli = join(directory, 'agentmux.mjs')
  await symlink(fileURLToPath(new URL('../../../packages/core/node_modules', import.meta.url)), join(directory, 'node_modules'), 'dir')
  await require('esbuild').build({ entryPoints: [fileURLToPath(new URL('../../../packages/core/src/agentmux.ts', import.meta.url))],
    outfile: cli, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
    plugins: [{ name: 'keep-existing-dependencies-external', setup(build: import('esbuild').PluginBuild) {
      build.onResolve({ filter: /[/\\]node_modules[/\\]/ }, args => ({ path: args.path, external: true }))
    } }] })
  const seen: string[] = []
  const desktop = await sourceBrowserExecutor(f, o)
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), coreClients: () => [], async execute(request) {
    seen.push(request.operation)
    return await desktop.execute(request)
  } })
  await server.start()
  async function run(args: string[], input = '') {
    return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], { cwd: directory,
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_'))),
          AGENTMUX_RUNTIME_DIRECTORY: directory, AGENTMUX_STATE_DIRECTORY: join(directory, 'state') }, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''; let stderr = ''
      child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Source public stop CLI exceeded its bounded request.')) }, 10_000)
      child.on('error', error => { clearTimeout(timeout); reject(error) })
      child.on('close', code => { clearTimeout(timeout); resolve({ code: code ?? -1, stdout, stderr }) })
      child.stdin.end(input)
    })
  }
  function receipt(output: Awaited<ReturnType<typeof run>>) {
    expect(output.code, output.stderr).toBe(0)
    const value = objectCliReceipt(JSON.parse(output.stdout))
    expect(value.ok).toBe(true)
    if (!value.ok) throw new Error(value.error.message)
    return value
  }
  return { run, receipt, seen, desktop, stop: () => server.stop() }
}

describe('external page owner uses the existing program and journal', () => {
  it('passes the independent-document fact through the real SDK dispatcher into the original Workspace upload store', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    const { LocalExecutionHost } = await import('../../../packages/core/src/execution-host.js')
    const { WorkspaceFiles } = await import('../src/main/workspace-files.js')
    const { BrowserUploads } = await import('../src/main/browser-uploads.js')
    const f = await fixture(); const binding = await f.share()
    const directory = dirname(f.path); const root = join(directory, 'workspace'); await mkdir(root)
    await writeFile(join(root, 'selected.txt'), 'original Workspace snapshot')
    const uploads = new BrowserUploads(join(directory, 'uploads'), new WorkspaceFiles(() => new LocalExecutionHost()),
      id => ({ id, name: 'Owned Source workspace', path: root, kind: 'folder', hostId: 'local' }))
    const original = f.api.debugger.sendCommand.getMockImplementation()!
    let selected: string[] = []
    f.api.debugger.sendCommand.mockImplementation(async (target, method, params) => {
      if (method === 'DOM.setFileInputFiles') { selected = params!.files; return {} }
      if (method === 'Runtime.callFunctionOn' && params?.functionDeclaration?.includes('Current target is not an enabled file input')) return { result: { value: { multiple: false } } }
      if (method === 'Runtime.callFunctionOn' && params?.functionDeclaration?.includes('Array.from(this.files')) return { result: { value: [{ name: 'selected.txt', byteLength: 27 }] } }
      return await original(target, method, params)
    })
    const o = await programOwner(f, uploads)
    const report = await o.page.runScript(binding.id, 'const page=await snapshot();return await uploadFiles(page.nodes[0].ref,["selected.txt"])')
    expect(report.outcome.kind).toBe('completed')
    expect(report.result).toMatchObject({ kind: 'browser-upload-files', browserId: binding.id, workspaceId: 'fixture-workspace', navigationId: binding.navigationId })
    expect(selected).toHaveLength(1)
    await uploads.dispose()
    await expect(readFile(selected[0]!, 'utf8')).resolves.toBe('original Workspace snapshot')
    expect(await uploads.retained()).toMatchObject({ selections: [expect.objectContaining({ browserId: binding.id, navigationId: binding.navigationId, byteLength: 27 })] })
  })
  it('runs the original SDK and joins the selected target, caller, steps, refs and evidence to its actual journal', async () => {
    const f = await fixture(); const binding = await f.share(); const o = await programOwner(f)
    const report = await o.page.runScript(binding.id, 'const page = await snapshot(); await click(page.nodes[0].ref); return await js("counter")', { id: owner.callerId, name: 'Fixture Agent' }, 'public-operation')
    expect(report.outcome).toEqual({ kind: 'completed' })
    expect(report.result).toBe(1)
    expect(f.counter).toBe(1)
    const record = await o.journal.get('public-operation')
    expect(record?.browserId).toBe(binding.id)
    expect(record?.operator.id).toBe(owner.callerId)
    expect(record?.steps.map(step => [step.sequence, step.method, step.status])).toEqual([[1, 'snapshot', 'completed'], [2, 'click', 'completed'], [3, 'js', 'completed']])
    expect(o.refs.write).toHaveBeenCalledWith(binding.id, expect.anything())
    expect(binding.ledgerNavigationId).toBe(binding.navigationId)
    expect(record?.steps[1]?.target).toEqual(expect.objectContaining({ role: 'button', name: 'Fixture button' }))
    expect(record?.steps[0]?.evidence).toHaveLength(1)
    const retained = await o.evidence.read(record!.steps[0]!.evidence![0]!)
    expect(retained.content).toEqual(expect.objectContaining({ kind: 'page', text: expect.stringContaining('Fixture button') }))
    expect(f.attached.size).toBe(0)
    expect(f.api.tabs.update).not.toHaveBeenCalled(); expect(f.api.windows.update).not.toHaveBeenCalled()
  })
  it('continues the original isolated-world revision for a later operation without adding preparation to a read-only snapshot', async () => {
    const { buildBrowserOperationFeedbackRevisionScript } = await import('../src/main/browser-operation-feedback.js')
    const f = await fixture(); const binding = await f.share(); const o = await programOwner(f)
    const probe = buildBrowserOperationFeedbackRevisionScript()
    const original = f.api.debugger.sendCommand.getMockImplementation()!
    f.api.debugger.sendCommand.mockImplementation(async (target, method, params) => {
      if (method === 'Runtime.evaluate' && params?.expression?.includes(probe)) return { result: { value: { value: true, revision: 37 } } }
      return await original(target, method, params)
    })
    expect((await o.page.runScript(binding.id, 'return await snapshot()')).outcome.kind).toBe('completed')
    expect(f.api.debugger.sendCommand.mock.calls.filter(call => call[1] === 'Runtime.evaluate' && call[2]?.expression?.includes(probe))).toHaveLength(1)
    const report = await o.page.runScript(binding.id, 'const page=await snapshot();await click(page.nodes[0].ref);return 1')
    expect(report.outcome.kind).toBe('completed')
    expect(f.counter).toBe(1)
    expect(f.api.debugger.sendCommand.mock.calls.filter(call => call[1] === 'Runtime.evaluate' && call[2]?.expression?.includes(probe))).toHaveLength(5)
    const scripts = f.api.debugger.sendCommand.mock.calls.filter(call => call[1] === 'Runtime.evaluate' && call[2]?.expression?.includes('data-agentmux-browser-operation-feedback') && call[2]?.expression?.includes('"phase":"running"')).map(call => call[2]!.expression)
    expect(scripts.length).toBeGreaterThan(0)
    expect(scripts[0]).toContain('"revision":39')
  })
  it('reports a failed feedback acknowledgement beside the result without blocking the original action', async () => {
    const { buildBrowserOperationFeedbackRevisionScript } = await import('../src/main/browser-operation-feedback.js')
    const f = await fixture(); const binding = await f.share(); const o = await programOwner(f)
    const probe = buildBrowserOperationFeedbackRevisionScript(); const original = f.api.debugger.sendCommand.getMockImplementation()!
    f.api.debugger.sendCommand.mockImplementation(async (target, method, params) => {
      if (method === 'Runtime.evaluate' && params?.expression?.includes(probe)) throw new Error('Owned feedback world unavailable')
      return await original(target, method, params)
    })
    const report = await o.page.runScript(binding.id, 'const page=await snapshot();await click(page.nodes[0].ref);return 1')
    expect(report.outcome.kind).toBe('completed')
    expect(f.counter).toBe(1)
    expect(report.runOperation?.warning).toContain('Action feedback is unavailable')
  })
  it('keeps a lost side effect indeterminate even if the program catches its error', async () => {
    const f = await fixture(); const binding = await f.share(); const o = await programOwner(f)
    const entered = deferred(); const held = deferred(); const original = f.api.debugger.sendCommand.getMockImplementation()!
    f.api.debugger.sendCommand.mockImplementation(async (target, method, params) => {
      if (method === 'Runtime.evaluate' && params?.expression === 'mutate') { entered.resolve(); await held.promise; return { result: { value: 1 } } }
      return await original(target, method, params)
    })
    const run = o.page.runScript(binding.id, 'try { await js("mutate") } catch {} return "caught"', { id: owner.callerId, name: 'Fixture Agent' })
    await entered.promise
    f.worker.disconnect('Fixture lost action acknowledgement')
    held.resolve()
    const report = await run
    expect(report.outcome.kind).toBe('indeterminate')
    expect(report.runOperation?.phase).toBe('indeterminate')
    expect((await o.journal.get(report.runOperation!.id))?.phase).toBe('indeterminate')
  })
  it('keeps a sent action across a document change indeterminate when the program catches its result error', async () => {
    const f = await fixture(); const binding = await f.share(); const o = await programOwner(f)
    const entered = deferred(); const held = deferred(); const original = f.api.debugger.sendCommand.getMockImplementation()!
    f.api.debugger.sendCommand.mockImplementation(async (target, method, params) => {
      if (method === 'Runtime.evaluate' && params?.expression === 'mutate') { entered.resolve(); await held.promise; return { result: { value: 1 } } }
      return await original(target, method, params)
    })
    const run = o.page.runScript(binding.id, 'try { await js("mutate") } catch {} return "caught"', { id: owner.callerId, name: 'Fixture Agent' })
    await entered.promise
    f.api.debugger.onEvent.emit({ tabId: 1 }, 'Page.frameNavigated', { frame: { id: 'main-document', loaderId: 'replacement-document', url: 'https://fixture.invalid/replacement' } })
    held.resolve()
    const report = await run
    expect(binding.status).toBe('ready')
    expect(binding.navigationId).toBe('replacement-document')
    expect(report.result).toBe('caught')
    expect(report.outcome.kind).toBe('indeterminate')
    expect((await o.journal.get(report.runOperation!.id))?.phase).toBe('indeterminate')
  })
  it('stops the original operation and removes its sharing authority without enabling a replacement', async () => {
    const f = await fixture(); const binding = await f.share(); const o = await programOwner(f)
    const started = deferred(); const stopped = deferred()
    const release = await o.journal.subscribe('stop-original', 0, event => {
      if (event.event.type === 'step-started') started.resolve()
      if (event.event.type === 'step-finished' && event.event.step.status === 'stopped') stopped.resolve()
    })
    const run = o.page.runScript(binding.id, 'await waitForLoad(5000); return 1', { id: owner.callerId, name: 'Fixture Agent' }, 'stop-original')
    await started.promise
    await o.page.stopOperationById('stop-original')
    expect(binding.status).toBe('revoked')
    const report = await run
    expect(report.outcome.kind).toBe('stopped')
    expect(report.outcome).toEqual({ kind: 'stopped', message: 'The shared-tab operation was stopped. Sharing must be granted explicitly before another action.' })
    expect(binding.warning).toBe('Sharing of this original tab ended. Grant control explicitly before another action.')
    // The runner aborts promptly; the original page callback can persist its final
    // step later. Wait for that actual terminal step and its real file saves before
    // removing this fixture, rather than racing durableWriteFile or retrying rm.
    await stopped.promise
    await Promise.all(o.journalSaves.mock.results.map(result => result.value))
    const durable = await o.journalFile.load()
    expect(durable?.operations.find(item => item.id === 'stop-original')?.steps.map(step => [step.method, step.status])).toEqual([['waitForLoad', 'stopped']])
    await vi.waitFor(() => expect(f.worker.grants.has(1)).toBe(false))
    expect(f.bridge.list()).toHaveLength(1)
    expect(f.api.tabs.create).not.toHaveBeenCalled(); release.dispose()
  })

  it('keeps explicit stop actor-neutral through the actual public CLI and retains another shared target', async () => {
    const f = await fixture(); const binding = await f.share(); const other = await f.share(2)
    const o = await programOwner(f); const cli = await sourcePublicCli(f, o)
    const started = deferred(); const stopped = deferred()
    const release = await o.journal.subscribe('public-stop-original', 0, event => {
      if (event.event.type === 'step-started') started.resolve()
      if (event.event.type === 'step-finished' && event.event.step.status === 'stopped') stopped.resolve()
    })
    try {
      for (const args of [['--help'], ['--help', 'browser'], ['--help', 'browser', 'stop'], ['--skill']]) {
        const output = await cli.run(args)
        expect(output.code, output.stderr).toBe(0)
        expect(output.stdout).toContain('Stop an active Browser operation; return retained state if finished.')
        if (args.length === 3) {
          expect(output.stdout).toContain('other targets retain their grants')
          expect(output.stdout).toContain('Reader cancellation only detaches the reader')
          expect(output.stdout).toContain('For an active operation on an external shared tab, explicit stop ends only that original tab')
          expect(output.stdout).toContain('A finished operation returns its retained terminal state without ending its sharing grant')
        }
      }
      const listed = cli.receipt(await cli.run(['browser', 'targets', '--workspace', 'fixture-workspace']))
      expect(listed.result).toEqual({ targets: f.bridge.list() })
      const run = cli.run(['browser', 'run', '--browser', binding.id, '--operation-id', 'public-stop-original'], 'await waitForLoad(5000); return 1')
      await started.promise
      const stoppedReceipt = cli.receipt(await cli.run(['browser', 'stop', '--operation-id', 'public-stop-original']))
      expect(stoppedReceipt.result).toMatchObject({ runOperation: { id: 'public-stop-original', browserId: binding.id, operator: { id: 'agent:unknown', name: 'Agent' } } })
      expect(binding.status).toBe('revoked')
      expect(binding.warning).toBe('Sharing of this original tab ended. Grant control explicitly before another action.')
      expect(other.status).toBe('ready')
      const report = cli.receipt(await run)
      expect(report.result).toMatchObject({ outcome: { kind: 'stopped', message: 'The shared-tab operation was stopped. Sharing must be granted explicitly before another action.' } })
      await stopped.promise
      const inspected = cli.receipt(await cli.run(['browser', 'inspect', '--operation-id', 'public-stop-original']))
      expect(inspected.result).toMatchObject({ runOperation: { phase: 'stopped', operator: { id: 'agent:unknown', name: 'Agent' },
        summary: 'The shared-tab operation was stopped. Sharing must be granted explicitly before another action.' } })
      const after = cli.receipt(await cli.run(['browser', 'targets']))
      expect(after.result).toMatchObject({ targets: [expect.objectContaining({ id: binding.id, status: 'revoked', warning: binding.warning }),
        expect.objectContaining({ id: other.id, status: 'ready' })] })
      const continued = cli.receipt(await cli.run(['browser', 'run', '--browser', other.id, '--operation-id', 'public-other-continues'], 'return await snapshot()'))
      expect(continued.result).toMatchObject({ outcome: { kind: 'completed' }, runOperation: { browserId: other.id, phase: 'completed' } })
      expect(f.api.debugger.sendCommand.mock.calls.some(([target, method]) => target.tabId === 2 && method === 'Accessibility.getFullAXTree')).toBe(true)
      expect(await o.page.stopOperationById('public-other-continues')).toBeNull()
      const finished = cli.receipt(await cli.run(['browser', 'stop', '--operation-id', 'public-other-continues']))
      expect(finished.result).toMatchObject({ runOperation: { id: 'public-other-continues', phase: 'completed', browserId: other.id } })
      expect(other.status).toBe('ready')
      await vi.waitFor(() => expect(f.worker.grants.has(1)).toBe(false))
      expect(f.worker.grants.has(2)).toBe(true)
      expect(f.bridge.list()).toHaveLength(2)
      expect(f.api.tabs.create).not.toHaveBeenCalled(); expect(f.api.tabs.update).not.toHaveBeenCalled(); expect(f.api.windows.update).not.toHaveBeenCalled()
      expect(cli.seen).toEqual(['browser.targets', 'browser.run', 'browser.stop', 'browser.operation', 'browser.targets', 'browser.run', 'browser.stop'])
      expect(cli.desktop.requireTrustedSender.mock.calls.map(([channel]) => channel)).toEqual(['browser:listTargets', 'browser:runScript', 'browser:stopOperationById', 'browser:getOperation', 'browser:listTargets', 'browser:runScript', 'browser:stopOperationById'])
      expect(cli.desktop.browsers.runScript).not.toHaveBeenCalled(); expect(cli.desktop.browsers.stopOperationById).toHaveBeenCalledExactlyOnceWith('public-other-continues')
    } finally { release.dispose(); await cli.stop() }
    await Promise.all(o.journalSaves.mock.results.map(result => result.value))
  }, 20_000)

  it('observes the original navigation load before allowing the next SDK read', async () => {
    const f = await fixture(); const binding = await f.share(); const o = await programOwner(f)
    const navigated = deferred(); const original = f.api.debugger.sendCommand.getMockImplementation()!
    f.api.debugger.sendCommand.mockImplementation(async (target, method, params) => {
      if (method === 'Page.navigate') {
        f.api.debugger.onEvent.emit({ tabId: 1 }, 'Page.frameNavigated', { frame: { id: 'main-document', loaderId: 'next-document', url: params!.url } })
        navigated.resolve(); return { loaderId: 'next-document' }
      }
      return await original(target, method, params)
    })
    const run = o.page.runScript(binding.id, 'await gotoUrl("https://fixture.invalid/next"); return await js("counter")', { id: owner.callerId, name: 'Fixture Agent' })
    await navigated.promise
    // Give the real child program and WebSocket response chain a bounded opportunity
    // to make an illegal next read; one microtask would sample before either path can continue.
    await new Promise<void>(resolve => setTimeout(resolve, 100))
    expect(f.api.debugger.sendCommand.mock.calls.filter(call => call[1] === 'Runtime.evaluate' && call[2]?.expression === 'counter')).toEqual([])
    f.api.debugger.onEvent.emit({ tabId: 1 }, 'Page.loadEventFired', { timestamp: 1 })
    expect((await run).outcome.kind).toBe('completed')
    expect(binding.navigationId).toBe('next-document')
    expect(f.api.debugger.sendCommand.mock.calls.filter(call => call[1] === 'Runtime.evaluate' && call[2]?.expression === 'counter')).toHaveLength(1)
  })
})
