import { fixturePath } from '../../../test/fixture-values.mjs'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxHostedBootstrap } from '@agentmux/core/hosted'
import { HostedHttpRpcPort, connectPrivateHostedClient } from '../src/connection/hosted-rpc'
import { MobileConnectionRoot } from '../src/connection/MobileConnectionRoot'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { history, mount, mounted, session } from './conversation-fixture'

const origin = 'https://192.168.1.20:7443', issuer = 'approved-device-issuer'
const bootstrap: AgentMuxHostedBootstrap = {
  identity: { instanceId: 'original-daemon', ownership: 'owned', hostId: 'local',
    buildIdentity: 'test-runtime', protocolVersion: 1, processId: 123 },
  storePath: fixturePath("original/sessions.json"), hostProcessId: 123, catalog: [], sessions: [session()],
  messageQueuePath: fixturePath("original/messages.ndjson")
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' }
})
const ports: HostedHttpRpcPort[] = [], clients: Array<{ dispose(): Promise<void> }> = []
const failure = (promise: Promise<unknown>) => promise.catch(error => error)
function port(fetch: typeof globalThis.fetch) {
  const value = new HostedHttpRpcPort({ origin, fetch }); ports.push(value); return value
}

function wire() {
  const requests: Array<{ method: string; params: Record<string, any>; init: RequestInit }> = []
  const streams: Array<{ method: string; consumerId?: string; cancelled: boolean;
    send(event: unknown, overrides?: Record<string, unknown>): void }> = []
  const device = { deviceId: 'device-original', name: 'iPhone', createdAt: 1 }
  let reply: ((request: typeof requests[number]) => unknown) | undefined
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (String(url).endsWith('/_agentmux/device')) return json({ hostId: issuer })
    if (String(url).endsWith('/_agentmux/device/status')) return json({ hostId: issuer, device })
    expect(String(url)).toBe(`${origin}/`)
    const request = JSON.parse(String(init?.body)) as { id: string; method: string; params: Record<string, any> }
    const recorded = { method: request.method, params: request.params, init: init! }; requests.push(recorded)
    if (['runtime.events', 'runtime.history-watch', 'agent.output'].includes(request.method)) {
      const subscriptionId = `subscription-${streams.length}`, encoder = new TextEncoder()
      let controller!: ReadableStreamDefaultController<Uint8Array>, sequence = 0
      const initial = request.method === 'runtime.events' ? { bootstrap }
        : request.method === 'runtime.history-watch' ? { source: history().source }
        : { session: session(), run: { runId: 'run-original', agentSessionId: 'session-original',
          latestOutputBytes: 0, state: 'running', pid: 123 }, gap: null }
      const stream = { method: request.method, consumerId: request.params.consumerId as string | undefined,
        cancelled: false, send(event: unknown, overrides: Record<string, unknown> = {}) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'system.subscription.event',
            params: { subscriptionId, method: request.method, sequence: ++sequence, event, ...overrides } })}\n\n`))
        } }
      const body = new ReadableStream<Uint8Array>({ start(value) {
        controller = value
        // Deliberately fragment a multibyte JSON response through the actual shared HTTP decoder.
        const first = encoder.encode(`data: ${JSON.stringify({ jsonrpc: '2.0', id: request.id,
          result: { subscriptionId, method: request.method, initial } })}\n\n`)
        controller.enqueue(first.subarray(0, 17)); controller.enqueue(first.subarray(17))
      }, cancel() { stream.cancelled = true } })
      streams.push(stream)
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    let result: unknown = reply?.(recorded)
    if (result === undefined) {
      if (request.method === 'runtime.bootstrap') result = bootstrap
      else if (request.method === 'runtime.release-consumer') result = { released: true }
      else {
        const method = request.params.invocation.method
        result = { value: method === 'runtimeProjection' ? { hostId: 'local', subjects: [] }
          : method === 'sessionHistoryPage' ? history()
          : method === 'sessionTimeline' ? { agentSessionId: 'session-original', revision: 1, items: [] }
          : { $agentmuxValue: 'undefined' } }
      }
    }
    return json({ jsonrpc: '2.0', id: request.id, result })
  })
  return { fetch, requests, streams, setReply(value: typeof reply) { reply = value } }
}
beforeEach(() => {
  window.happyDOM.setURL(`${origin}/`); localStorage.clear()
  getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
})
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  for (const client of clients.splice(0)) await client.dispose()
  for (const value of ports.splice(0)) value.dispose()
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

describe('Mobile public HTTP adapter and real Hosted SDK consumer', () => {
  it('uses the sole public writer/parser with root HTTPS, cookie include and unchanged finite tuples', async () => {
    const f = wire(), value = port(f.fetch)
    expect(await value.call('runtime.bootstrap', { consumerId: 'reader-original' })).toEqual(bootstrap)
    await value.call('runtime.invoke', { consumerId: 'reader-original',
      invocation: { method: 'writeTerminal', args: ['run-original', '中文\u0000bytes'] } })
    expect(f.requests[1]!.params).toEqual({ consumerId: 'reader-original',
      invocation: { method: 'writeTerminal', args: ['run-original', '中文\u0000bytes'] } })
    for (const { init } of f.requests) {
      expect(init).toMatchObject({ method: 'POST', credentials: 'include', redirect: 'error' })
      expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
    }
    const forbidden = await failure(value.call('runtime.bootstrap', { consumerId: 'x', caller: { user: true } } as never))
    expect(forbidden).toMatchObject({ code: 'INVALID_CONTROL_REQUEST' }); expect(f.requests).toHaveLength(2)
  })

  it('feeds genuine SDK event/history/output observations through their original subscriptions and closes only own leases', async () => {
    const f = wire(), client = await connectPrivateHostedClient({ origin, hostId: issuer, signal: new AbortController().signal, fetch: f.fetch })
    clients.push(client)
    expect(client.runtimeIdentity().hostId).toBe('local') // Device issuer is a separate identity.
    expect(client.agentSessions()).toEqual(bootstrap.sessions)
    const observations: unknown[] = [], handle = await client.observeSessionHistory('session-original', value => observations.push(value))
    expect(handle.source).toEqual(history().source)
    f.streams.find(value => value.method === 'runtime.history-watch')!.send({ type: 'snapshot',
      data: { observation: { kind: 'invalidated', agentSessionId: 'session-original', source: history().source } } })
    await vi.waitFor(() => expect(observations).toHaveLength(1))
    const outputEvents: unknown[] = [], output = await client.observeAgentOutput('session-original', 0, value => outputEvents.push(value))
    expect(output.attachment.replay).toEqual([])
    const outputStream = f.streams.find(value => value.method === 'agent.output')!
    outputStream.send({ type: 'output', data: { runId: 'run-original', replay: false, startByte: 0, endByte: 3, dataBase64: '5Lit' } })
    await vi.waitFor(() => expect(outputEvents).toHaveLength(1))
    expect(outputEvents[0]).toMatchObject({ type: 'terminal-output', data: '中' })
    await output.close(); handle.dispose()
    await vi.waitFor(() => expect(outputStream.cancelled).toBe(true))
    expect(f.streams.find(value => value.method === 'runtime.events')!.cancelled).toBe(false)
    await client.dispose()
    expect(f.requests.at(-1)).toMatchObject({ method: 'runtime.release-consumer' })
    expect(f.requests.some(value => value.method === 'runtime.invoke' && ['stopAgent', 'stopTerminal'].includes(value.params.invocation.method))).toBe(false)
  })

  it('rejects wrong response identity through the shared parser and refuses HTTP or another endpoint before fetch', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ jsonrpc: '2.0', id: 'another-request', result: bootstrap }))
    const value = port(fetch)
    expect(await failure(value.call('runtime.bootstrap', { consumerId: 'reader' }))).toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    for (const target of ['http://192.168.1.20:7443', `${origin}/extra`, `${origin}/`, `${origin}?token=secret`]) {
      expect(() => new HostedHttpRpcPort({ origin: target, fetch })).toThrow()
    }
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('rejects subscription method, ID and sequence swaps without delivering a foreign event', async () => {
    for (const overrides of [{ method: 'agent.output' }, { subscriptionId: 'another-reader' }, { sequence: 2 }]) {
      const f = wire(), value = port(f.fetch), events = vi.fn(), end = vi.fn()
      await value.subscribe('runtime.events', { consumerId: 'reader' }, { onInitial() {}, onEvent: events, onEnd: end })
      f.streams[0]!.send({ type: 'snapshot', data: { event: { type: 'agent-session', session: session() } } }, overrides)
      await vi.waitFor(() => expect(end).toHaveBeenCalledOnce())
      expect(end.mock.calls[0]![0]).toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
      expect(events).not.toHaveBeenCalled(); expect(f.streams[0]!.cancelled).toBe(true)
    }
  })

  it('cancels pending admission and rejects late or malformed shared HTTP frames without making a client', async () => {
    const controller = new AbortController(), fetch = vi.fn<typeof globalThis.fetch>((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const pending = connectPrivateHostedClient({ origin, hostId: issuer, signal: controller.signal, fetch })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce()); controller.abort()
    expect(await failure(pending)).toMatchObject({ code: 'CONTROL_CANCELLED' })
    const malformed = port(vi.fn<typeof globalThis.fetch>(async () => new Response('data: {"jsonrpc":"2.0"}', {
      headers: { 'Content-Type': 'text/event-stream' } })))
    expect(await failure(malformed.call('runtime.bootstrap', { consumerId: 'reader' }))).toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  })

  it('keeps another device consumer alive when one SDK is disposed and does not bind lifetime to a later admission attempt', async () => {
    const f = wire(), firstAdmission = new AbortController()
    const a = await connectPrivateHostedClient({ origin, hostId: issuer, signal: firstAdmission.signal, fetch: f.fetch })
    const b = await connectPrivateHostedClient({ origin, hostId: issuer, signal: new AbortController().signal, fetch: f.fetch })
    clients.push(a, b)
    firstAdmission.abort(); await Promise.resolve()
    expect(f.streams[0]!.cancelled).toBe(false)
    await a.dispose(); expect(f.streams[0]!.cancelled).toBe(true); expect(f.streams[1]!.cancelled).toBe(false)
    await b.submitAgentPrompt({ agentSessionId: 'session-original', prompt: '原输入' } as never)
    expect(f.requests.filter(value => value.method === 'runtime.invoke' && value.params.invocation.method === 'submitAgentPrompt')).toHaveLength(1)
  })

  it('does not replay an unconfirmed write and retains independent observation after a lost reply', async () => {
    const f = wire(), value = port(f.fetch), events = vi.fn()
    await value.subscribe('runtime.events', { consumerId: 'reader' }, { onInitial() {}, onEvent: events })
    const losingFetch = vi.fn<typeof globalThis.fetch>(async () => new Response('', { headers: { 'Content-Type': 'application/json' } }))
    const writer = port(losingFetch)
    expect(await failure(writer.call('runtime.invoke', { consumerId: 'reader',
      invocation: { method: 'writeTerminal', args: ['run-original', 'one-write'] } }))).toBeInstanceOf(Error)
    await Promise.resolve(); expect(losingFetch).toHaveBeenCalledOnce()
    f.streams[0]!.send({ type: 'snapshot', data: { event: { type: 'agent-session', session: session() } } })
    await vi.waitFor(() => expect(events).toHaveBeenCalledOnce()); expect(f.streams[0]!.cancelled).toBe(false)
  })

  it('uses the injected native raw fetch without browser transport or a JS authorization header', async () => {
    const f = wire(), browserFetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error('Browser must not send this native request') })
    vi.stubGlobal('fetch', browserFetch)
    const result = await failure(connectPrivateHostedClient({ origin, hostId: issuer, signal: new AbortController().signal, fetch: f.fetch }))
    expect(result).toHaveProperty('agentSessions')
    if (result instanceof Error) return
    clients.push(result as Awaited<ReturnType<typeof connectPrivateHostedClient>>)
    expect(f.fetch).toHaveBeenCalled(); expect(browserFetch).not.toHaveBeenCalled()
    expect(f.requests.every(value => !Object.hasOwn(value.init.headers ?? {}, 'Authorization'))).toBe(true)
  })

  it('preserves public rich business errors in both unary replies and stream end receipts', async () => {
    const error = { code: 'MESSAGE_TARGET_NOT_UNIQUE', message: 'Choose the original target', detail: 'exact session',
      details: { target: 'retained' }, candidates: [{ agentSessionId: 'session-original', regionIds: ['region-original'] }] }
    const unary = port(vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      const { message, ...data } = error
      return json({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message, data } })
    }))
    expect(await failure(unary.call('runtime.bootstrap', { consumerId: 'reader' }))).toMatchObject({ ...error, rpcCode: -32000 })
    const f = wire(), value = port(f.fetch), ended = vi.fn(), event = vi.fn()
    await value.subscribe('agent.output', { agentSessionId: 'session-original', afterByte: 0, follow: true },
      { onInitial() {}, onEvent: event, onEnd: ended })
    f.streams[0]!.send({ type: 'error', error })
    await vi.waitFor(() => expect(ended).toHaveBeenCalledOnce())
    expect(ended.mock.calls[0]![0]).toMatchObject({ ...error, rpcCode: -32000 })
    expect(event).toHaveBeenCalledWith({ type: 'error', error })
  })

  it('the mounted application uses the actual factory and SDK after admission, with original conversation facts and no secret in JS state', async () => {
    const workface = emptyDeviceWorkface(); workface.selectedSessionId = 'session-original'
    getDeviceWorkface().replaceBackup(workface)
    const f = wire(); vi.stubGlobal('fetch', f.fetch)
    const view = await mount(<MobileConnectionRoot platform={createBrowserPlatform()} native={false} connectClient={connectPrivateHostedClient} />)
    await vi.waitFor(() => expect(view.element.querySelector('[data-connection="connected"]')).not.toBeNull())
    await vi.waitFor(() => expect(view.element.textContent).toContain('原生回答'))
    expect(f.requests.some(value => value.method === 'runtime.events')).toBe(true)
    expect(f.requests.some(value => value.method === 'runtime.history-watch')).toBe(true)
    expect(f.requests.some(value => value.method === 'runtime.invoke' && value.params.invocation.method === 'sessionHistoryPage')).toBe(true)
    expect(getDeviceWorkface().snapshot().record.host).toEqual({ origin, hostId: issuer })
    expect(JSON.stringify(getDeviceWorkface().snapshot())).not.toMatch(/credential|Bearer|cookie/)
  })
})
