import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserNetworkRouting } from '../../../packages/browser/src/browser-network-routing.js'
import { startBrowserOperationStep } from '../../../packages/browser/src/browser-operation-step.js'

const resources: ReturnType<typeof createBrowserNetworkRouting>[] = []
afterEach(async () => { for (const resource of resources.splice(0)) await resource.dispose(); vi.restoreAllMocks() })
function fixture() {
  const close = vi.fn(async () => { events.clear() })
  const events = new Set<(method: string, params: unknown, sessionId?: string) => void>(), signal = new AbortController(), cleanups: (() => Promise<void>)[] = [], notes: string[] = []
  let navigationId = 'original', ended: string | null = null, hook = async (_method: string, _params: any): Promise<any> => undefined
  const sendCommand = vi.fn(async (method: string, params?: any) => {
    const result = await hook(method, params)
    return result ?? (method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main' } } } : method === 'Network.emulateNetworkConditionsByRule' ? { ruleIds: params.matchedNetworkConditions.map((_: unknown, index: number) => String(index)) } : {})
  })
  const context = { session: { sendCommand, frames: new Map(), get endedReason() { return ended }, frameDiscoveryFailure: null,
    observe(fn: (method: string, params: unknown, sessionId?: string) => void) { events.add(fn); return () => { events.delete(fn) } },
    async openNetworkSession() { return {sendCommand, observe(fn: (method: string, params: unknown, sessionId?: string) => void) {events.add(fn);return () => {events.delete(fn)}}, get endedReason() {return ended}, close} } },
    signal: signal.signal, beforeAction: () => { if (signal.signal.aborted) throw Error('Original control stopped') }, pageInfo: () => ({ navigationId }),
    note: (value: string) => { notes.push(value) }, registerCleanup: (cleanup: () => Promise<void>) => { cleanups.push(cleanup) } }
  const owner = createBrowserNetworkRouting(context); resources.push(owner)
  const emit = (method: string, params: unknown, sessionId?: string) => { for (const fn of [...events]) fn(method, params, sessionId) }
  const paused = (url = 'https://example.test/items', frameId = 'main', method = 'GET') => emit('Fetch.requestPaused', { requestId: 'native-request', frameId, request: { url, method, headers: { Authorization: 'private-header' }, postData: 'private-request-body' } })
  return { owner, context, signal, close, sendCommand, events, notes, paused, emit, cleanups, hook(next: typeof hook) { hook = next }, navigate() { navigationId = 'replacement'; emit('Page.frameNavigated', { frame: { id: 'main' } }) }, ended() { ended = 'original disconnected' } }
}
const mocked = [{ match: { url: { contains: '/items' } }, action: 'mock', status: 201, headers: { 'Content-Type': 'application/json' }, body: '{"fixture":true}' }]
const nativeCalls = (f: ReturnType<typeof fixture>) => f.sendCommand.mock.calls.filter(([method]) => method.startsWith('Fetch.'))
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve() }

describe('original page network rules', () => {
  it('arms the original listener before native activation acknowledgement and fulfills the exact paused request', async () => {
    const f = fixture(); f.hook(async method => { if (method === 'Fetch.enable') f.paused() })
    expect(await f.owner.route(mocked)).toMatchObject({ status: 'active', ruleCount: 1 })
    const fulfilled = nativeCalls(f).find(([method]) => method === 'Fetch.fulfillRequest')![1]
    expect(fulfilled).toMatchObject({ requestId: 'native-request', responseCode: 201 })
    expect(Buffer.from(fulfilled.body, 'base64').toString()).toBe('{"fixture":true}')
    expect(JSON.stringify(fulfilled)).not.toMatch(/private-header|private-request-body/)
  })
  it('matches explicit method/URL rules in order and continues unmatched or other-frame original requests', async () => {
    const f = fixture(); await f.owner.route([{ match: { url: 'https://example.test/items', method: 'POST' }, action: 'abort' }, ...mocked])
    f.paused('https://example.test/items', 'main', 'POST'); f.paused('https://example.test/other'); f.paused('https://example.test/items', 'child')
    expect(nativeCalls(f).slice(1).map(([method]) => method)).toEqual(['Fetch.failRequest', 'Fetch.continueRequest', 'Fetch.continueRequest'])
  })
  it('does not expose inline body URLs, accept Profile cookie headers or begin malformed native configuration', async () => {
    const f = fixture()
    for (const value of [[], [{ match: { url: 'data:text/plain,private-body' }, action: 'mock' }], [{ match: { url: { contains: 'items' } }, action: 'mock', headers: { 'Set-Cookie': 'session=private' } }], [{ match: { url: 'https://example.test/items' }, action: 'continue', body: 'wrong' }]]) {
      await expect(f.owner.route(value)).rejects.toThrow()
    }
    expect(f.sendCommand).not.toHaveBeenCalled()
  })
  it('requires the actual program cleanup owner before installing any native rule', async () => {
    const f = fixture(), { registerCleanup: _register, ...context } = f.context, owner = createBrowserNetworkRouting(context); resources.push(owner)
    await expect(owner.route(mocked)).rejects.toThrow(/cleanup/)
    expect(f.sendCommand).not.toHaveBeenCalled()
  })
  it.each(['stop', 'navigation'] as const)('withdraws only the original configuration on %s and cannot mock a late request', async cause => {
    const f = fixture(); await f.owner.route(mocked)
    const late = [...f.events]
    cause === 'stop' ? f.signal.abort() : f.navigate()
    for (const fn of late) fn('Fetch.requestPaused', { requestId: 'late', frameId: 'main', request: { url: 'https://example.test/items', method: 'GET' } })
    await settle()
    expect(f.close).toHaveBeenCalledTimes(1)
    expect(nativeCalls(f).some(([method]) => method === 'Fetch.fulfillRequest')).toBe(false)
    expect(f.events.size).toBe(0)
  })
  it('retains an unknown application result and only explicitly withdraws, without re-enabling or replaying it', async () => {
    const f = fixture(); f.hook(async method => { if (method === 'Fetch.enable') throw Error('Native ACK unavailable') })
    await expect(f.owner.route(mocked)).rejects.toMatchObject({ fact: { kind: 'network-configuration', effects: 'unknown' } })
    expect(await f.owner.unroute()).toMatchObject({ status: 'withdrawn' })
    expect(nativeCalls(f).map(([method]) => method)).toEqual(['Fetch.enable', 'Fetch.disable'])
  })
  it('reports withdrawal failure without clearing the original fact or cancelling other healthy page capabilities', async () => {
    const f = fixture(); await f.owner.route(mocked)
    f.hook(async method => { if (method === 'Fetch.disable') throw Error('Native ACK unavailable') })
    expect(await f.owner.unroute()).toMatchObject({ status: 'unknown' }); expect(f.notes).toHaveLength(1)
    f.hook(async () => undefined); expect(await f.owner.unroute()).toMatchObject({ status: 'withdrawn' })
    expect(nativeCalls(f).filter(([method]) => method === 'Fetch.enable')).toHaveLength(1)
  })
  it('does not replace an activation still awaiting its original native acknowledgement', async () => {
    const f = fixture(); let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve })
    f.hook(async method => { if (method === 'Fetch.enable') await blocked })
    const first = f.owner.route(mocked); await settle()
    await expect(f.owner.route(mocked)).rejects.toThrow(/still changing/)
    release(); await first; expect(nativeCalls(f).filter(([method]) => method === 'Fetch.enable')).toHaveLength(1)
  })
  it('applies request-network limits with native identities and clears this session rules without overriding navigator state', async () => {
    const f = fixture(); expect(await f.owner.setConditions({ offline: true, latencyMs: 40, downloadBytesPerSecond: 1024 })).toMatchObject({ status: 'active', ruleCount: 2 })
    const applied = f.sendCommand.mock.calls.find(([method]) => method === 'Network.emulateNetworkConditionsByRule')![1]
    expect(applied).not.toHaveProperty('offline'); expect(applied.matchedNetworkConditions).toHaveLength(2)
    expect(applied.matchedNetworkConditions[0]).toMatchObject({ urlPattern: 'http://*:*/*', latency: 40, downloadThroughput: 1024, uploadThroughput: -1 })
    expect(await f.owner.clearConditions()).toMatchObject({ status: 'withdrawn' })
    expect(f.sendCommand.mock.calls).toContainEqual(['Network.emulateNetworkConditionsByRule', { matchedNetworkConditions: [] }]); expect(nativeCalls(f).at(-1)?.[0]).toBe('Fetch.disable')
    expect(f.sendCommand.mock.calls.some(([method]) => method === 'Network.overrideNetworkState')).toBe(false)
  })
  it('applies offline only to main-document HTTP requests and withdrawing request rules preserves that independent condition', async () => {
    const f = fixture(); await f.owner.setConditions({offline: true}); await f.owner.route(mocked)
    f.paused(); f.paused('https://example.test/items', 'child'); await settle()
    expect(nativeCalls(f).slice(1).map(([method]) => method)).toEqual(['Fetch.failRequest','Fetch.continueRequest'])
    expect(await f.owner.unroute()).toMatchObject({status: 'withdrawn'})
    f.paused(); expect(nativeCalls(f).at(-1)?.[0]).toBe('Fetch.failRequest')
    expect(await f.owner.clearConditions()).toMatchObject({status: 'withdrawn'})
    expect(nativeCalls(f).at(-1)?.[0]).toBe('Fetch.disable')
  })
  it('does not sign application when native rule identities are unavailable, and still clears the uncertain set', async () => {
    const f = fixture(); f.hook(async method => method === 'Network.emulateNetworkConditionsByRule' ? {} : undefined)
    await expect(f.owner.setConditions({ offline: true })).rejects.toMatchObject({ fact: { effects: 'unknown' } })
    expect(await f.owner.clearConditions()).toMatchObject({ status: 'withdrawn' })
  })
  it('distinguishes configured rules, observed matches, acknowledged results and lost acknowledgements', async () => {
    const f = fixture()
    expect(await f.owner.route(mocked)).toMatchObject({status: 'active', hits: {matchedRequests: 0, fulfilledRequests: 0}})
    f.paused(); await settle()
    f.hook(async method => {if (method === 'Fetch.fulfillRequest') throw Error('Native effect acknowledgement lost')})
    f.paused(); await settle()
    expect(await f.owner.unroute()).toMatchObject({status: 'withdrawn', hits: {matchedRequests: 2, fulfilledRequests: 1, unconfirmedRequests: 1}})
    expect(nativeCalls(f).filter(([method]) => method === 'Fetch.fulfillRequest')).toHaveLength(2)
  })
  it('refuses an explicit withdrawal while configuration is pending and cleans after its original acknowledgement', async () => {
    const f = fixture(); let acknowledge!: () => void
    f.hook(async method => {if (method === 'Fetch.enable') await new Promise<void>(resolve => {acknowledge = resolve})})
    const applying = f.owner.route(mocked); await settle()
    await expect(f.owner.unroute()).rejects.toThrow(/still changing/)
    f.signal.abort(); acknowledge()
    await expect(applying).rejects.toMatchObject({fact: {effects: 'unknown'}})
    for (const cleanup of f.cleanups) await cleanup()
    expect(nativeCalls(f).map(([method]) => method)).toEqual(['Fetch.enable']); expect(f.close).toHaveBeenCalledTimes(1)
  })
  it('releases stopped-operation cleanup after a lost native detach acknowledgement and retains the exact unknown scope', async () => {
    const f = fixture(); await f.owner.route(mocked)
    let acknowledge!: () => void
    f.close.mockImplementationOnce(() => new Promise<void>(resolve => {acknowledge = resolve}))
    vi.useFakeTimers()
    try {
      f.signal.abort(); const cleanup = Promise.all(f.cleanups.map(fn => fn()))
      await vi.advanceTimersByTimeAsync(1001); await cleanup
      expect(f.notes.join(' ')).toMatch(/cleanup is unconfirmed/)
      expect(f.close).toHaveBeenCalledTimes(1)
      expect(await f.context.session.sendCommand('Page.getFrameTree')).toHaveProperty('frameTree')
      f.paused(); await settle()
      expect(nativeCalls(f).some(([method]) => method === 'Fetch.fulfillRequest')).toBe(false)
      acknowledge(); await settle()
    } finally {vi.useRealTimers()}
  })
  it('ends only the independent network session when the activation acknowledgement remains pending', async () => {
    const f = fixture(); let acknowledge!: () => void
    f.hook(async method => {if (method === 'Fetch.enable') await new Promise<void>(resolve => {acknowledge = resolve})})
    const applying = f.owner.route(mocked); await settle(); f.signal.abort()
    await Promise.all(f.cleanups.map(fn => fn()))
    expect(f.close).toHaveBeenCalledTimes(1)
    expect(await f.context.session.sendCommand('Page.getFrameTree')).toHaveProperty('frameTree')
    acknowledge(); await expect(applying).rejects.toMatchObject({fact: {effects: 'unknown'}})
  })
  it('awaits both protocol withdrawals through the original program cleanup without replaying page actions', async () => {
    const f = fixture(); await f.owner.route(mocked); await f.owner.setConditions({ latencyMs: 10 })
    f.signal.abort(); for (const cleanup of f.cleanups) await cleanup()
    expect(f.close).toHaveBeenCalledTimes(1)
    expect(f.events.size).toBe(0)
  })
})
it('keeps static mock definitions and condition/rule arguments out of retained replay facts', () => {
  const operation: any = { url: 'https://example.test/page', steps: [] }
  for (const method of ['routeRequests', 'unrouteRequests', 'setNetworkConditions', 'clearNetworkConditions']) {
    const step = startBrowserOperationStep(operation, method, [mocked])
    expect(step.replay?.args).toEqual([]); expect(step.replay?.blockedReason).toMatch(/original program/)
  }
  expect(JSON.stringify(operation)).not.toContain('fixture')
})
