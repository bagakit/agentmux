import { afterEach, describe, expect, it, vi } from 'vitest'
import { startBrowserOperationStep, isSensitiveBrowserPageCall } from '@agentmux/browser/operations'
import { createBrowserNetworkObservations } from '../../../packages/browser/src/browser-network-observation.js'

const owners: ReturnType<typeof createBrowserNetworkObservations>[] = []
afterEach(() => { for (const owner of owners.splice(0)) owner.dispose(); vi.useRealTimers() })
function fixture() {
  const listeners = new Set<(method: string, params: unknown, sessionId?: string) => void>(), signal = new AbortController()
  let navigationId = 'original-navigation', endedReason: string | null = null, hook = (_method: string) => {}
  const emit = (method: string, params: unknown, sessionId?: string) => { for (const fn of [...listeners]) fn(method, params, sessionId) }
  const sendCommand = vi.fn(async (method: string) => { hook(method); return method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'frame', loaderId: 'original-loader' } } } : {} })
  const session = { frames: new Map(), frameDiscoveryFailure: null, get endedReason() { return endedReason }, sendCommand,
    observe(fn: (method: string, params: unknown, sessionId?: string) => void) { listeners.add(fn); return () => { listeners.delete(fn) } } }
  const make = () => { const owner = createBrowserNetworkObservations({ session, signal: signal.signal, pageInfo: () => ({ navigationId }) }); owners.push(owner); return owner }
  const owner = make()
  const request = (id = 'request', extra = {}, sessionId?: string) => emit('Network.requestWillBeSent', { requestId: id, frameId: 'frame', loaderId: 'original-loader', request: { method: 'POST', url: 'https://example.test/api', headers: { Authorization: 'private-header' }, postData: 'private-body' }, ...extra }, sessionId)
  const response = (id = 'request', extra = {}, sessionId?: string) => emit('Network.responseReceived', { requestId: id, frameId: 'frame', loaderId: 'original-loader', response: { status: 201, mimeType: 'application/json', headers: { 'Set-Cookie': 'private-cookie' } }, ...extra }, sessionId)
  return { owner, make, signal, listeners, sendCommand, emit, request, response, hook(fn: typeof hook) { hook = fn }, ended() { endedReason = 'native connection detached' }, navigate() { navigationId = 'next-navigation'; emit('Page.frameNavigated', { frame: { id: 'frame', loaderId: 'next-loader' } }) } }
}

describe('scoped network readers on the original document', () => {
  it('buffers an immediate native response before Network.enable acknowledgement, with no headers or body', async () => {
    const f = fixture(); f.hook(method => { if (method === 'Network.enable') { f.request(); f.response() } })
    const reader = await f.owner.watch()
    expect(await f.owner.waitForResponse(reader, { url: { contains: '/api' }, method: 'POST', status: 201 })).toMatchObject({ event: 'response', status: 201 })
    const read = f.owner.read(reader)
    expect(read.observations.map(row => row.event)).toEqual(['request', 'response'])
    expect(JSON.stringify(read)).not.toMatch(/private-|headers|postData/)
  })
  it('stops one reader without deleting a sibling or disabling its native domain', async () => {
    const f = fixture(), a = await f.owner.watch(), b = await f.owner.watch()
    f.owner.stop(a); f.request(); f.response()
    expect(() => f.owner.read(a)).toThrow(/explicitly stopped/)
    expect(f.owner.read(b).observations).toHaveLength(2)
    expect(f.sendCommand.mock.calls.some(([method]) => method === 'Network.disable')).toBe(false)
    f.owner.stop(b); expect(f.listeners.size).toBe(0)
  })
  it('does not attribute another frame, loader or child session to this original document', async () => {
    const f = fixture(), reader = await f.owner.watch()
    f.request('subframe', { frameId: 'other-frame' }); f.response('subframe', { frameId: 'other-frame' })
    f.request('previous-document', { loaderId: 'previous-loader' }); f.response('previous-document', { loaderId: 'previous-loader' })
    f.request('oopif', {}, 'child-session'); f.response('oopif', {}, 'child-session')
    expect(f.owner.read(reader).observations).toEqual([])
    f.request(); f.response(); expect(f.owner.read(reader).observations).toHaveLength(2)
  })
  it('reports bounded retention and unattributed late responses without fabricating completeness', async () => {
    const f = fixture(), reader = await f.owner.watch({ maxEntries: 2 })
    for (let i = 0; i < 6; i++) f.request(String(i))
    f.response('0'); f.response('5')
    const read = f.owner.read(reader)
    expect(read.observations).toHaveLength(2); expect(read.dropped).toBeGreaterThan(0); expect(read.unattributed).toBe(1)
    expect(read.observations.at(-1)?.status).toBe(201)
    expect(f.owner.read(reader, { afterSequence: read.observations.at(-1)!.sequence }).observations).toEqual([])
  })
  it('rejects navigation during activation before enabling a reader, and releases its subscription', async () => {
    const f = fixture(); f.hook(method => { if (method === 'Page.getFrameTree') f.navigate() })
    await expect(f.owner.watch()).rejects.toThrow(/original document/)
    expect(f.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Page.getFrameTree'])
    expect(f.listeners.size).toBe(0)
  })
  it('navigation and Stop reject pending waits, remove readers, and ignore late events', async () => {
    for (const cause of ['navigation', 'stop'] as const) {
      const f = fixture(), reader = await f.owner.watch(), result = f.owner.waitForResponse(reader)
      const rejected = expect(result).rejects.toThrow(cause === 'navigation' ? /navigated/ : /stopped/)
      cause === 'navigation' ? f.navigate() : f.signal.abort()
      await rejected; expect(f.listeners.size).toBe(0)
      f.request(); f.response(); expect(() => f.owner.read(reader)).toThrow()
    }
  })
  it('observes an exact native disconnect even with no further network event', async () => {
    vi.useFakeTimers()
    const f = fixture(), reader = await f.owner.watch(), waiting = f.owner.waitForResponse(reader)
    const rejected = expect(waiting).rejects.toThrow(/native connection detached/)
    f.ended(); await vi.advanceTimersByTimeAsync(30); await rejected
    expect(f.listeners.size).toBe(0)
  })
  it('a completed program cannot lend its reader to a later program on the same healthy page', async () => {
    const f = fixture(), reader = await f.owner.watch(), waiting = f.owner.waitForResponse(reader)
    const rejected = expect(waiting).rejects.toThrow(/program ended/); f.owner.dispose(); await rejected
    const later = f.make()
    expect(() => later.read(reader)).toThrow(/does not belong/)
    const current = await later.watch(); f.request(); f.response()
    expect(later.read(current).observations).toHaveLength(2)
  })
  it('invalid budgets are refused before any native observation; a timeout never repeats a request', async () => {
    const f = fixture()
    await expect(f.owner.watch({ maxEntries: 1001 })).rejects.toThrow(/budget/)
    expect(f.sendCommand).not.toHaveBeenCalled()
    const reader = await f.owner.watch(); vi.useFakeTimers()
    const waiting = f.owner.waitForResponse(reader, {}, { timeoutMs: 10 }), rejected = expect(waiting).rejects.toThrow(/No matching response/)
    await vi.advanceTimersByTimeAsync(25); await rejected
    expect(f.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Page.getFrameTree', 'Network.enable'])
  })
})

it('retains bounded URL metadata and marks truncation while omitting URL credentials', async () => {
  const f = fixture(), reader = await f.owner.watch()
  f.request('long', { request: { method: 'GET', url: 'https://private-user:private-password@example.test/' + 'x'.repeat(20000) } })
  f.response('long')
  const read = f.owner.read(reader)
  expect(read.observations.every(row => row.url.length <= 8192 && row.truncated)).toBe(true)
  expect(JSON.stringify(read)).not.toMatch(/private-user|private-password/)
  expect(JSON.stringify(read).length).toBeLessThan(20000)
})

it('paginates retained events without skipping the first event of the next page', async () => {
  const f = fixture(), reader = await f.owner.watch()
  f.request('one'); f.response('one'); f.request('two'); f.response('two')
  const a = f.owner.read(reader, { maxEntries: 2 }), b = f.owner.read(reader, { afterSequence: a.nextAfterSequence, maxEntries: 2 })
  expect([...a.observations, ...b.observations].map(row => row.sequence)).toEqual([1, 2, 3, 4])
  expect(b.nextAfterSequence).toBe(4); expect(a.observedThroughSequence).toBe(4)
  expect(f.owner.stop(reader)).toEqual({ stopped: true }); expect(f.owner.stop(reader)).toEqual({ stopped: true })
})

it('bounds a metadata read in bytes and preserves a continuation without returning an oversized result', async () => {
  const f = fixture(), reader = await f.owner.watch({ maxEntries: 1000 })
  for (let i = 0; i < 30; i++) f.request(String(i), { request: { method: 'GET', url: 'https://example.test/' + 'x'.repeat(8000) } })
  const first = f.owner.read(reader, { maxEntries: 1000 })
  expect(first.hasMore).toBe(true); expect(first.observationBytes).toBeLessThanOrEqual(65536)
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(128 * 1024)
  const second = f.owner.read(reader, { afterSequence: first.nextAfterSequence })
  expect(second.observations[0]?.sequence).toBe(first.nextAfterSequence + 1)
})


it('does not retain reader identities or sensitive response URL filters in replay facts', () => {
  const operation: any = { url: 'https://example.test/current?private=1', steps: [] }
  for (const method of ['watchRequests', 'readRequests', 'waitForResponse', 'stopWatchingRequests']) {
    const step = startBrowserOperationStep(operation, method, [{ id: 'ephemeral-reader', navigationId: 'original' }, { url: 'https://example.test/private?secret=one' }])
    expect(isSensitiveBrowserPageCall(method)).toBe(true)
    expect(step.replay?.args).toEqual([]); expect(step.replay?.blockedReason).toMatch(/original program/)
  }
  expect(JSON.stringify(operation.steps)).not.toMatch(/ephemeral-reader|secret=one|private=1/)
})

it('observes only HTTP metadata and never exposes inline data bodies, local paths or non-HTTP targets', async () => {
  const f = fixture(), reader = await f.owner.watch()
  for (const [i, url] of ['data:text/plain,private-inline-body', 'file:///private/local-secret.txt', 'ws://example.test/private-socket', 'blob:https://example.test/private-object'].entries()) {
    f.request(String(i), { request: { method: 'GET', url } }); f.response(String(i))
  }
  expect(f.owner.read(reader).observations).toEqual([])
  f.request('http'); f.response('http')
  expect(f.owner.read(reader).observations).toHaveLength(2)
  expect(JSON.stringify(f.owner.read(reader))).not.toMatch(/private-inline-body|local-secret|private-socket|private-object/)
})

it('does not misattribute a non-HTTP redirect or reused request ID to an earlier HTTP request', async () => {
  const f = fixture(), reader = await f.owner.watch()
  f.request('same-id')
  f.request('same-id', { request: { method: 'GET', url: 'data:text/plain,private-inline-body' } })
  f.response('same-id')
  const rows = f.owner.read(reader).observations
  expect(rows.map(row => row.event)).toEqual(['request'])
  expect(JSON.stringify(rows)).not.toContain('private-inline-body')
})
