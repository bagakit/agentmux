import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExternalBrowserBridge, ExternalBrowserRequestFailure } from '../src/main/browser-external-bridge.js'
import { attachExternalBrowserTarget, type ExternalBrowserTargetSession } from '../src/main/browser-external-target.js'
import { createBrowserPageDispatch } from '../src/main/browser-page-dispatch.js'
import { isShareUrl, isTabScopedCommand } from '../browser-extension/protocol.js'

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
  const bridge = new ExternalBrowserBridge(path)
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
        if (method === 'Runtime.callFunctionOn') { counter++; return { result: { value: null } } }
        return {}
      }) }
  }
  class ExtensionSocket extends WebSocket { constructor(url: string) { super(url, { origin }) } }
  vi.stubGlobal('chrome', api)
  vi.stubGlobal('WebSocket', ExtensionSocket)
  vi.resetModules()
  const { worker } = await import('../browser-extension/service-worker.js')
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
  return { api, bridge, worker, pairing, popup, share, attach, tabs, path, attached,
    select: (id: number) => { selected = id }, get counter() { return counter } }
}

describe('person-shared external Browser transport', () => {
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
    const action = session.sendCommand('Runtime.callFunctionOn', { objectId: 'fixture-object' })
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
    const action = session.sendCommand('Runtime.callFunctionOn', { objectId: 'fixture-object' })
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
