import { fixturePath } from './helpers/fixture-values.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxError } from '../src/errors.js'
import { loadAgentSessions } from '../src/agent-session-store.js'
import { AgentMuxControlServer as SourceServer, type AgentMuxControlServerOptions } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { encodeHostedValue, decodeHostedValue, AgentMuxHostedTransferReader } from '../src/hosted-value.js'
import type { AgentMuxHostedInvocation, AgentMuxRuntimeOwnerIdentity, AgentMuxHostedStreamValue } from '../src/hosted-client-contract.js'
import type { AgentMuxClientEvent, AgentProviderSessionHistoryObservationContext } from '../src/types.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxRpcDispatcher, AgentMuxRpcError, type AgentMuxRpcConnection, type AgentMuxRpcFrame } from '../src/public-rpc-wire.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'

const AgentMuxControlServer: typeof SourceServer = process.env.AGENTMUX_TEST_RPC_SERVER_ENTRY
  ? (await import(/* @vite-ignore */ pathToFileURL(process.env.AGENTMUX_TEST_RPC_SERVER_ENTRY).href)).AgentMuxControlServer : SourceServer
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const catalog = { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] }
function invocation<T extends AgentMuxHostedInvocation>(value: T): T {
  return encodeHostedValue(value) as T
}
async function hostedFixture(ids = ['source-agent', 'recipient-agent']) {
  const core = await rpcOwnerFixture(ids)
  cleanups.push(() => core.close())
  core.inner.kernel.identity = () => ({ buildIdentity: 'private-sdk-fixture', protocolVersion: 1, daemonInstanceId: 'original-sdk-owner' })
  const inputs: Array<{ runId: string; data: number[] }> = []
  core.inner.kernel.input = vi.fn(async (runId: string, input: { data: string | Uint8Array; expectedByte: number }) => {
    const data = typeof input.data === 'string' ? new TextEncoder().encode(input.data) : input.data
    inputs.push({ runId, data: [...data] })
    return { run: { ...core.run(runId), acceptedInputBytes: input.expectedByte + data.byteLength },
      appliedByteRange: { startByte: input.expectedByte, endByte: input.expectedByte + data.byteLength } }
  })
  core.inner.kernel.attach = vi.fn(async (runId: string) => ({ run: core.run(runId), gap: null, replay: [] }))
  core.inner.kernel.replay = vi.fn(async (runId: string) => ({ run: core.run(runId), gap: null, replay: [] }))
  const owner: AgentMuxRuntimeOwnerIdentity = { runtimeId: 'private-hosted-runtime', ownerInstanceId: 'private-hosted-epoch',
    protocolVersion: 1, processId: process.pid, ctxmux: core.client.runtimeIdentity(), availability: 'connected' }
  const fence = { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }
  const hosted = new AgentMuxHostedRuntimeService(core.client, join(core.root, 'sessions.json'), () => owner)
  cleanups.push(() => hosted.dispose())
  const publisher = core.client as unknown as { publisher: { publish(event: AgentMuxClientEvent): void } }
  return { ...core, hosted, owner, fence, inputs, publish: (event: AgentMuxClientEvent) => publisher.publisher.publish(event) }
}
async function endpoint(options: AgentMuxControlServerOptions = {}) {
  const root = await mkdtemp(fixturePath("tmp/amx-host-join-")), path = join(root, 'owner.sock')
  const owner = new AgentMuxControlServer({ coreClients: () => [], execute: async () => ({ operation: 'space.ls', catalog }), ...options, socketPath: path })
  cleanups.push(async () => { await owner.stop(); await rm(root, { recursive: true, force: true }) })
  await owner.start()
  return { owner, path, url: () => `http://127.0.0.1:${owner.httpAddress!.port}/` }
}
describe('one public service borrowed by a long-lived Runtime Host', () => {
  it('preserves a large retained Session bootstrap through the real Hosted consumer', async () => {
    const ids = Array.from({ length: 127 }, (_, index) => `session-${String(index).padStart(3, '0')}`)
    const f = await hostedFixture(ids)
    for (const previous of await loadAgentSessions(f.store)) {
      await f.store.compareAndSwap(previous, { ...previous,
        retiredRuns: Array.from({ length: 16 }, (_, index) => ({ runId: `${previous.agentSessionId}-original-run-${index}-${'a'.repeat(96)}` })) })
      await f.client.refreshAgentSession(previous.agentSessionId, previous.run)
    }
    const original = f.client.agentSessions()
    expect(Buffer.byteLength(JSON.stringify(f.hosted.bootstrap()))).toBeGreaterThan(256 * 1024)
    const h = await endpoint({ coreClients: f.coreClients, hostedRuntime: () => f.hosted })
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: h.path } })
    cleanups.push(() => rpc.dispose())
    const reader = await connectHostedAgentMux({ rpc })
    cleanups.push(() => reader.dispose())
    expect(reader.agentSessions()).toEqual(original)
    expect(reader.agentSessions()).toHaveLength(127)
    expect(f.inputs).toEqual([])
    expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  }, 15_000)
  it.each(['unix', 'http'] as const)('preserves a large ordered Run replay over the real %s Hosted consumer', async transport => {
    const f = await hostedFixture(), runId = 'run-recipient-agent'
    const bytes = new TextEncoder().encode('Original ordered output.\n'.repeat(32_768))
    f.inner.kernel.replay = vi.fn(async () => ({ run: { ...f.run(runId), latestOutputBytes: bytes.byteLength }, gap: null,
      terminal: { type: 'not-requested' }, resizeRevision: 7,
      replay: [{ type: 'data', runId, startByte: 0, endByte: bytes.byteLength, data: new TextDecoder().decode(bytes), dataBytes: bytes }] }))
    const h = await endpoint({ coreClients: f.coreClients, hostedRuntime: () => f.hosted,
      http: { host: '127.0.0.1', port: 0, token: 'large-original-replay' } })
    const rpc = await connectAgentMuxRpc({ endpoint: transport === 'unix'
      ? { transport, path: h.path } : { transport, url: h.url(), token: 'large-original-replay' } })
    cleanups.push(() => rpc.dispose())
    const reader = await connectHostedAgentMux({ rpc })
    cleanups.push(() => reader.dispose())
    const replay = await reader.readRunReplay({ runId }, 0, 'raw')
    expect(Buffer.byteLength(JSON.stringify(encodeHostedValue(replay)))).toBeGreaterThan(256 * 1024)
    expect(replay.replay).toEqual([{ type: 'data', runId, startByte: 0, endByte: bytes.byteLength,
      data: new TextDecoder().decode(bytes), dataBytes: bytes }])
    expect(f.inner.kernel.replay).toHaveBeenCalledExactlyOnceWith(runId, 0, 'raw')
    expect(f.client.agentSession('recipient-agent').run).toEqual({ runId })
    expect(f.inputs).toEqual([])
    expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  })
  it.each(['not_applied', 'unknown', 'prompt readiness is unconfirmed'])('preserves original Core detail %s over actual Unix and HTTP wire', async detail => {
    const error = Object.assign(new AgentMuxError('Original owner decision.', 'AGENT_PROMPT_STATE_UNCONFIRMED', detail), {
      details: { actualOwner: 'original' }, candidates: [{ identity: 'unchanged' }]
    })
    const h = await endpoint({ http: { host: '127.0.0.1', port: 0, token: 'private-detail' }, execute: async () => { throw error } })
    for (const carrier of [{ transport: 'unix' as const, path: h.path }, { transport: 'http' as const, url: h.url(), token: 'private-detail' }]) {
      const client = await connectAgentMuxRpc({ endpoint: carrier }); cleanups.push(() => client.dispose())
      await expect(client.call('space.ls', { target: {} })).rejects.toMatchObject({ code: error.code, message: error.message,
        detail, details: error.details, candidates: error.candidates })
    }
  })
  it('passes a real Web request to the original route/authority and keeps unmatched RPC on the same endpoint', async () => {
    const routes: Array<{ method: string; path: string }> = [], dispose = vi.fn(), authorized: Array<{ cookie: string | null; body: unknown; connected: boolean }> = []
    const h = await endpoint({ http: { host: '127.0.0.1', port: 0,
      route: request => { routes.push({ method: request.method, path: new URL(request.url).pathname })
        if (new URL(request.url).pathname !== '/claim') return null
        return new Response('Original private route.', { status: 201, headers: { 'X-Original-Route': 'true', 'Set-Cookie': 'private=accepted; HttpOnly' } }) },
      authorize: async request => { authorized.push({ cookie: request.headers.get('cookie'), body: await request.json(), connected: !request.signal.aborted })
        return { principal: { kind: 'device', id: 'approved-private-device' }, dispose } }
    } })
    const route = await fetch(new URL('claim', h.url()))
    expect(route.status).toBe(201); expect(route.headers.get('x-original-route')).toBe('true')
    expect(route.headers.get('set-cookie')).toContain('private=accepted'); expect(await route.text()).toBe('Original private route.')
    expect(authorized).toEqual([])
    const request = { jsonrpc: '2.0', id: 'owned-correlation', method: 'space.ls', params: { target: {} } }
    const response = await fetch(h.url(), { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'private=accepted' }, body: JSON.stringify(request) })
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: request.id, result: { catalog } })
    expect(authorized).toEqual([{ cookie: 'private=accepted', body: request, connected: true }])
    expect(routes).toEqual([{ method: 'GET', path: '/claim' }, { method: 'POST', path: '/' }])
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1))
  })
  it('keeps the established Unix service alive when explicit optional TLS cannot be constructed', async () => {
    const h = await endpoint({ http: { host: '127.0.0.1', port: 0, token: 'private-tls', tls: { key: 'invalid-private-key', cert: 'invalid-private-certificate' } } })
    expect(h.owner.httpAddress).toBeNull(); expect(h.owner.httpUnavailable).toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    expect(h.owner.httpUnavailable!.detail).toEqual(expect.any(String))
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: h.path } }); cleanups.push(() => client.dispose())
    expect((await client.call('space.ls', { target: {} })).catalog).toEqual(catalog)
    expect((await client.call('system.endpoint', {})).endpoint).toEqual({ transport: 'unix', path: h.path })
  })
  it('uses the same approved device over different POSTs while isolating foreign consumers and preserving original Core input fences', async () => {
    const f = await hostedFixture(), consumerId = 'same-original-consumer'
    const approvedDevices = new Set(['device-A', 'device-B'])
    const h = await endpoint({ coreClients: f.coreClients, hostedRuntime: () => f.hosted,
      http: { host: '127.0.0.1', port: 0, authorize: request => {
        const id = request.headers.get('cookie'); return id && approvedDevices.has(id) ? { principal: { kind: 'device', id } } : null
      } } })
    const controller = new AbortController()
    cleanups.push(() => controller.abort())
    const stream = await fetch(h.url(), { method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Cookie: 'device-A' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'runtime.events', params: { fence: f.fence, consumerId } }) })
    expect(stream.headers.get('content-type')).toContain('text/event-stream')
    const reader = stream.body!.getReader(); cleanups.push(() => reader.cancel())
    const first = new TextDecoder().decode((await reader.read()).value)
    const transfer = new AgentMuxHostedTransferReader(), decoder = new TextDecoder()
    let buffer = first, initial: AgentMuxHostedStreamValue | undefined
    while (!initial) {
      let separator: number
      while ((separator = buffer.indexOf('\n\n')) >= 0) {
        const frame = JSON.parse(buffer.slice(0, separator).split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'))
        buffer = buffer.slice(separator + 2)
        if (frame.result) expect(frame.result.initial.owner).toEqual(f.owner)
        if (frame.params?.event?.type === 'snapshot') initial = transfer.accept(frame.params.event.data) as AgentMuxHostedStreamValue | undefined
      }
      if (!initial) { const next = await reader.read(); expect(next.done).toBe(false); buffer += decoder.decode(next.value, { stream: true }) }
    }
    expect(initial).toMatchObject({ kind: 'initial', value: { sessions: [
      { agentSessionId: 'source-agent' }, { agentSessionId: 'recipient-agent' }
    ] } })
    let requestId = 2
    const request = (id: string, method: string, params: unknown) => fetch(h.url(), { method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: id },
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId++, method, params }) })
    const post = async (id: string, method: string, params: unknown) => {
      const response = await request(id, method, params)
      expect(response.status).toBe(200)
      return await response.json() as Record<string, any>
    }
    expect(await post('device-B', 'runtime.release-consumer', { fence: f.fence, consumerId })).toMatchObject({ result: { released: false } })
    const data = Uint8Array.from([0xe4, 0xb8, 0xad, 0, 0xff])
    const input = invocation({ method: 'writeAgent', args: [{ agentSessionId: 'recipient-agent',
      expectedRun: { runId: 'run-recipient-agent' }, data, source: 'user' }] })
    // Each approved device owns its input authority; A's observation is no prerequisite for B.
    const independent = await post('device-B', 'runtime.invoke', { fence: f.fence, consumerId, invocation: input })
    expect(decodeHostedValue(independent.result.value)).toEqual({ runId: 'run-recipient-agent',
      appliedByteRange: { startByte: 0, endByte: data.length }, acceptedThroughByte: data.length })
    const ack = await post('device-A', 'runtime.invoke', { fence: f.fence, consumerId, invocation: input })
    expect(decodeHostedValue(ack.result.value)).toEqual({ runId: 'run-recipient-agent',
      appliedByteRange: { startByte: 0, endByte: data.length }, acceptedThroughByte: data.length })
    expect(f.inputs).toEqual(Array.from({ length: 2 }, () => ({ runId: 'run-recipient-agent', data: [...data] })))
    const stale = invocation({ method: 'writeAgent', args: [{ agentSessionId: 'recipient-agent',
      expectedRun: { runId: 'foreign-run' }, data, source: 'user' }] })
    expect(await post('device-A', 'runtime.invoke', { fence: f.fence, consumerId, invocation: stale })).toMatchObject({ error: { data: { code: 'STALE_AGENT_SESSION' } } })
    expect(f.inputs).toHaveLength(2)
    expect(await post('device-A', 'runtime.release-consumer', { fence: f.fence, consumerId })).toMatchObject({ result: { released: true } })
    const afterRelease = await post('device-A', 'runtime.invoke', { fence: f.fence, consumerId, invocation: input })
    expect(decodeHostedValue(afterRelease.result.value)).toEqual({ runId: 'run-recipient-agent',
      appliedByteRange: { startByte: 0, endByte: data.length }, acceptedThroughByte: data.length })
    expect(f.inputs).toHaveLength(3)
    approvedDevices.delete('device-A')
    const denied = await request('device-A', 'runtime.invoke', { fence: f.fence, consumerId, invocation: input })
    expect(denied.status).toBe(401)
    expect(f.inputs).toHaveLength(3)
    expect(f.inner.kernel.stop).not.toHaveBeenCalled()
    expect(f.client.agentSession('recipient-agent').run).toEqual({ runId: 'run-recipient-agent' })
  })
  it('rejects all runtime methods for a managed Agent before any borrowed SDK input or forged principal can be admitted', async () => {
    const f = await hostedFixture(), borrowed = vi.fn(() => f.hosted), authorize = vi.spyOn(f.client, 'authorizeRetainedAgentCaller')
    const h = await endpoint({ coreClients: f.coreClients, hostedRuntime: borrowed })
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: h.path }, credentials: f.credentials })
    cleanups.push(() => client.dispose())
    const consumerId = 'managed-consumer'
    await expect(client.call('runtime.bootstrap', { fence: f.fence, consumerId })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    await expect(client.call('runtime.invoke', { fence: f.fence, consumerId, invocation: invocation({ method: 'writeAgent', args: [{
      agentSessionId: 'recipient-agent', expectedRun: { runId: 'run-recipient-agent' }, data: 'forbidden', source: 'user' }] }) })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    await expect(client.call('runtime.release-consumer', { fence: f.fence, consumerId })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    await expect(client.call('runtime.owner.identity', {})).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    await expect(client.call('runtime.owner.shutdown', { fence: f.fence })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    const callbacks = { onInitial: vi.fn(), onEvent: vi.fn() }
    await expect(client.subscribe('runtime.events', { fence: f.fence, consumerId }, callbacks)).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    await expect(client.subscribe('runtime.history-watch', { fence: f.fence, consumerId, agentSessionId: 'recipient-agent' }, callbacks)).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    for (const method of ['runtime.attachment-watch', 'runtime.replay-watch'] as const) await expect(client.subscribe(method, { consumerId, fence: f.fence,
      target: { kind: 'terminal-run', runId: 'run-recipient-agent' }, afterByte: 0, view: 'raw' }, callbacks)).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    expect(borrowed).not.toHaveBeenCalled(); expect(authorize).not.toHaveBeenCalled(); expect(f.inputs).toEqual([])
    expect(callbacks.onInitial).not.toHaveBeenCalled(); expect(callbacks.onEvent).not.toHaveBeenCalled()
    const raw = new AgentMuxRpcService({ coreClients: f.coreClients, hostedRuntime: borrowed })
    await expect(raw.call('runtime.bootstrap', { fence: f.fence, consumerId })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    const user = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: h.path } }); cleanups.push(() => user.dispose())
    await expect(user.call('runtime.bootstrap', { fence: f.fence, consumerId, principal: { kind: 'user', id: 'forged' } } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    expect(borrowed).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  })
  it('keeps incremental output, resize and semantic events in exact order while the first notification is held', async () => {
    const f = await hostedFixture(), service = new AgentMuxRpcService({ coreClients: f.coreClients, hostedRuntime: () => f.hosted })
    const dispatcher = new AgentMuxRpcDispatcher(service), frames: AgentMuxRpcFrame[] = [], controller = new AbortController()
    let unblock!: () => void, held!: () => void
    const blocked = new Promise<void>(yes => { unblock = yes }), arrived = new Promise<void>(yes => { held = yes })
    cleanups.push(() => { unblock(); controller.abort() })
    const disposers = new Map<string, () => void | Promise<void>>()
    const principal = { kind: 'user' as const, id: 'original-private-user' }
    const channel: AgentMuxRpcConnection = { principal,
      signal: controller.signal, stream: true, afterResponse: [],
      send: async frame => { frames.push(frame); if (frames.length === 1) { held(); await blocked } },
      activate: (id, _method, dispose) => { disposers.set(id, dispose) },
      cancel: async id => { const dispose = disposers.get(id); if (!dispose) return false; disposers.delete(id); await dispose(); return true }
    }
    const result = await dispatcher.receive({ jsonrpc: '2.0', id: 'original-request', method: 'runtime.events',
      params: { fence: f.fence, consumerId: 'ordered-consumer' } }, channel)
    expect(result).toMatchObject({ result: { initial: { owner: f.owner, transferId: expect.any(String) } } })
    await service.call('runtime.invoke', { fence: f.fence, consumerId: 'ordered-consumer', invocation: { method: 'reattachAgent', args: ['recipient-agent'] } },
      { principal })
    // Ignore the original attach's process observation, then admit the explicit
    // mixed event batch before opening so snapshot-label coalescing is exposed.
    const opening = channel.afterResponse[0]!()
    await arrived
    const evidence = { source: 'terminal-output' as const, observedAt: 1, run: { runId: 'run-recipient-agent' } }
    f.publish({ type: 'terminal-output', agentSessionId: 'recipient-agent', run: evidence.run,
      data: 'a', dataBytes: Uint8Array.from([97]), evidence: { ...evidence, outputByteRange: { startByte: 0, endByte: 1 } } })
    f.publish({ type: 'terminal-resized', run: evidence.run, cols: 90, rows: 30, throughByte: 1, resizeRevision: 7 })
    f.publish({ type: 'agent-session', session: f.client.agentSession('recipient-agent') })
    unblock(); await opening
    await vi.waitFor(() => expect(frames).toHaveLength(5))
    const events = frames.map(frame => (frame as any).params)
    expect(events.map(p => p.sequence)).toEqual([1, 2, 3, 4, 5])
    const transfer = new AgentMuxHostedTransferReader(), values = events.map(p => transfer.accept(p.event.data) as AgentMuxHostedStreamValue)
    expect(values[0]).toMatchObject({ kind: 'initial', value: { sessions: [expect.anything(), expect.anything()] } })
    expect(values.slice(1).map(value => value.kind === 'event' ? value.event.type : value.kind)).toEqual(['process-state', 'terminal-output', 'terminal-resized', 'agent-session'])
    expect(values[2]).toMatchObject({ kind: 'event', event: { dataBytes: Uint8Array.from([97]) } })
    expect(values[3]).toMatchObject({ kind: 'event', event: { throughByte: 1, resizeRevision: 7 } })
    for (const id of [...disposers.keys()]) await channel.cancel(id)
    expect(f.inner.kernel.detach).toHaveBeenCalledTimes(1); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  })
  it('borrows the original exact native history observer and closes only this consumer on release', async () => {
    const f = await hostedFixture(), previous = (await loadAgentSessions(f.store)).find(session => session.agentSessionId === 'recipient-agent')!
    await f.store.compareAndSwap(previous, { ...previous,
      nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-native-history' } })
    await f.client.refreshAgentSession('recipient-agent', previous.run)
    let context!: AgentProviderSessionHistoryObservationContext
    const disposed = vi.fn()
    const provider = f.client.providers.get('codex'), originalObserver = provider.observeSessionHistory
    if (!originalObserver) throw new Error('The original Provider must expose native history observation.')
    cleanups.push(() => { provider.observeSessionHistory = originalObserver })
    provider.observeSessionHistory = vi.fn(async (value: AgentProviderSessionHistoryObservationContext) => {
      context = value; return { source: value.source, dispose: disposed }
    })
    const h = await endpoint({ coreClients: f.coreClients, hostedRuntime: () => f.hosted })
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: h.path } }); cleanups.push(() => client.dispose())
    const consumerId = 'original-history-consumer', events = await client.subscribe('runtime.events', { fence: f.fence, consumerId }, { onInitial: vi.fn(), onEvent: vi.fn() })
    const observed: unknown[] = [], openings: unknown[] = [], transfer = new AgentMuxHostedTransferReader()
    const history = await client.subscribe('runtime.history-watch', { fence: f.fence, consumerId, agentSessionId: 'recipient-agent',
      options: { env: { signal: 'ordinary-environment-data' } } }, {
      onInitial: value => openings.push(value), onEvent: value => { if (value.type === 'snapshot') { const observation = transfer.accept(value.data) as AgentMuxHostedStreamValue | undefined; if (observation?.kind === 'history') observed.push(observation.observation) } }
    })
    expect(openings).toEqual([{ owner: f.owner, source: { providerId: 'codex', nativeSessionId: 'original-native-history' } }])
    expect(context.env.signal).toBe('ordinary-environment-data'); expect(context.signal).toBeInstanceOf(AbortSignal)
    context.onChange({ kind: 'invalidated', source: context.source })
    await vi.waitFor(() => expect(observed).toEqual([{ kind: 'invalidated', source: context.source, agentSessionId: 'recipient-agent' }]))
    expect(await client.call('runtime.release-consumer', { fence: f.fence, consumerId })).toEqual({ released: true })
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledTimes(1))
    await history.dispose(); await events.dispose()
    expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.client.agentSession('recipient-agent').run).toEqual(previous.run)
  })
  it('forwards the real connection cancellation signal to the original SDK prompt owner, never a JSON signal', async () => {
    const f = await hostedFixture()
    let started!: () => void, observedSignal: AbortSignal | undefined
    const entered = new Promise<void>(yes => { started = yes })
    vi.spyOn(f.client, 'submitAgentPrompt').mockImplementation(async input => {
      observedSignal = input.signal; started()
      await new Promise<void>((_resolve, reject) => {
        input.signal!.addEventListener('abort', () => reject(new AgentMuxError('Original prompt reader cancelled.', 'CONTROL_CANCELLED')), { once: true })
      })
    })
    const h = await endpoint({ coreClients: f.coreClients, hostedRuntime: () => f.hosted })
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: h.path } }); cleanups.push(() => client.dispose())
    const consumerId = 'signal-consumer'
    const events = await client.subscribe('runtime.events', { fence: f.fence, consumerId }, { onInitial: vi.fn(), onEvent: vi.fn() })
    cleanups.push(() => events.dispose())
    const controller = new AbortController(), pending = client.call('runtime.invoke', { fence: f.fence, consumerId,
      invocation: { method: 'submitAgentPrompt', args: [{ agentSessionId: 'recipient-agent', expectedRun: { runId: 'run-recipient-agent' },
        operationId: 'original-prompt', afterSubmissionId: null, prompt: 'Original prompt', signal: 'forged-json-signal' as never }] }
    }, { signal: controller.signal })
    const rejection = expect(pending).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
    await entered; expect(observedSignal).toBeInstanceOf(AbortSignal); expect(observedSignal!.aborted).toBe(false)
    controller.abort(); await rejection
    await vi.waitFor(() => expect(observedSignal!.aborted).toBe(true))
    expect(f.inputs).toEqual([]); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  })
  it('forwards managed caller and signal once to the GUI spatial owner and preserves its actual business errors', async () => {
    const f = await hostedFixture(), requests: unknown[] = []
    const region = { kind: 'agent' as const, tabId: 'desktop-tab', regionId: 'desktop-region', workspaceId: 'desktop-workspace',
      agentSessionId: 'source-agent', providerId: 'codex', executorId: 'codex', bounds: { x: 0, y: 0, width: 1, height: 1 },
      neighbors: { left: { kind: 'none' as const }, right: { kind: 'none' as const }, up: { kind: 'none' as const }, down: { kind: 'none' as const } } }
    const gui = await endpoint({ coreClients: f.coreClients, execute: async request => {
      requests.push(request)
      if (request.operation === 'inspect.region') return { operation: request.operation, region }
      if (request.operation === 'space.inspect') return { operation: request.operation, catalog }
      if (request.operation === 'space.ls') throw Object.assign(new AgentMuxError('Original GUI target refused.', 'SPACE_TARGET_INVALID', 'not_applied'), {
        details: { refusedBy: 'original-gui' }, candidates: [{ zoneId: 'actual-candidate' }] })
      throw new AgentMuxError('The GUI business owner is temporarily unavailable.', 'CONTROL_UNAVAILABLE', 'unknown')
    } })
    const contexts: unknown[] = []
    const host = await endpoint({ coreClients: f.coreClients, execute: undefined, forwardControl: async (method, params, context) => {
      contexts.push({ caller: context.caller, signal: context.signal instanceof AbortSignal })
      const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: gui.path },
        ...(context.caller ? { credentials: context.caller } : {}) })
      try { return await client.call(method, params, { ...(context.signal ? { signal: context.signal } : {}) }) }
      finally { await client.dispose() }
    } })
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: host.path }, credentials: f.credentials }); cleanups.push(() => client.dispose())
    const observedSpace = client.call('space.inspect', { target: { regionId: 'self' } })
    await expect(observedSpace).resolves.toMatchObject({ catalog, presentation: { region } })
    const result = await observedSpace
    expect(result.catalog).toEqual(catalog); expect(result.presentation!.region).toEqual(region)
    expect(requests).toEqual([
      expect.objectContaining({ operation: 'inspect.region', caller: f.credentials, target: { kind: 'self' } }),
      expect.objectContaining({ operation: 'space.inspect', target: { regionId: region.regionId } })
    ])
    expect(contexts).toEqual([{ caller: f.credentials, signal: true }])
    await expect(client.call('space.ls', { target: {} })).rejects.toMatchObject({ code: 'SPACE_TARGET_INVALID', detail: 'not_applied',
      details: { refusedBy: 'original-gui' }, candidates: [{ zoneId: 'actual-candidate' }] })
    await expect(client.call('goal.activity', {})).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE', detail: 'unknown' })
    const observed = f.client.agentSession('source-agent')
    const bad = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: host.path }, credentials: { ...f.credentials, capability: 'invalid-capability' } })
    cleanups.push(() => bad.dispose())
    const before = contexts.length
    await expect(bad.call('space.ls', { target: {} })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    expect(contexts).toHaveLength(before); expect(f.client.agentSession('source-agent')).toEqual(observed); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
    expect(f.inputs).toEqual([])
  })
  it("keeps a remote caller's original Core facts and the actual Desktop-owned self view", async () => {
    const f = await hostedFixture()
    const forwardRpc = vi.fn(async () => { throw new Error('The remote semantic owner must not claim the Desktop projection') })
    const client = Object.assign(f.client, { forwardRpc })
    const region = { kind: 'agent' as const, tabId: 'desktop-tab', regionId: 'desktop-region', workspaceId: 'desktop-workspace',
      agentSessionId: 'source-agent', providerId: 'codex', executorId: 'codex', bounds: { x: 0, y: 0, width: 1, height: 1 },
      neighbors: { left: { kind: 'none' as const }, right: { kind: 'none' as const }, up: { kind: 'none' as const }, down: { kind: 'none' as const } } }
    const execute = vi.fn(async (request: import('../src/control.js').AgentMuxControlRequest) => {
      if (request.operation !== 'inspect.region') throw new Error('Only the original Desktop view is observed')
      expect(request.caller).toEqual(f.credentials)
      return { operation: 'inspect.region' as const, region }
    })
    const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'remote', client }], execute })
    const self = await service.call('whoami', {}, { caller: f.credentials })
    expect(self.session.agentSessionId).toBe('source-agent'); expect(self.status!.run.state).toBe('running')
    expect(self.view).toEqual({ attached: true, region })
    expect(self.unavailable).toEqual([]); expect(execute).toHaveBeenCalledOnce(); expect(forwardRpc).not.toHaveBeenCalled()
    expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  })
  it('keeps known Host Core facts only when forwarding reports a real local transport absence', async () => {
    const f = await hostedFixture(), absent = new AgentMuxError('The private GUI socket is absent.', 'CONTROL_UNAVAILABLE')
    const service = new AgentMuxRpcService({ coreClients: f.coreClients, forwardControl: async () => { throw absent } })
    const self = await service.call('whoami', {}, { caller: f.credentials })
    expect(self.session.agentSessionId).toBe('source-agent'); expect(self.status!.run.state).toBe('running')
    expect(self.view).toMatchObject({ attached: false, reason: 'view-unavailable', error: { code: 'CONTROL_UNAVAILABLE' } })
    const snapshot = await service.call('app.snapshot', { include: ['sessions', 'projects'] })
    expect(snapshot.sessions.map(value => value.session.agentSessionId)).toEqual(['source-agent', 'recipient-agent'])
    expect(snapshot.projects).toEqual([]); expect(snapshot.unavailable).toEqual([expect.objectContaining({ source: 'projects', code: 'CONTROL_UNAVAILABLE' })])
    const refused = new AgentMuxRpcError('GUI denied this caller.', 'CONTROL_UNAVAILABLE', -32000, { originalOwner: true }, undefined, 'not_applied')
    const business = new AgentMuxRpcService({ coreClients: f.coreClients, forwardControl: async () => { throw refused } })
    await expect(business.call('whoami', {}, { caller: f.credentials })).rejects.toBe(refused)
    expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  })
  it('reports an absent borrowed runtime owner without activating another SDK or inventing a bootstrap', async () => {
    const coreClients = vi.fn(() => { throw new Error('Runtime lookup must not activate a fallback SDK') })
    const service = new AgentMuxRpcService({ coreClients })
    await expect(service.call('runtime.bootstrap', { consumerId: 'known-user-consumer', fence: { runtimeId: 'absent-owner', ownerInstanceId: 'absent-epoch' } }, {
      principal: { kind: 'user', id: 'transport-approved-user' }
    })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    expect(coreClients).not.toHaveBeenCalled()
    await service.dispose()
  })
  it('forwards a managed GUI subscription with its real signal and disposes its original reader without changing any Run', async () => {
    const f = await hostedFixture(), disposed = vi.fn()
    let progress!: Parameters<NonNullable<AgentMuxControlServerOptions['subscribeBrowserOperation']>>[1]
    const gui = await endpoint({ coreClients: f.coreClients, subscribeBrowserOperation: async (_request, onEvent) => {
      progress = onEvent; return { runOperation: null, gap: null, dispose: disposed }
    } })
    const contexts: unknown[] = []
    const host = await endpoint({ coreClients: f.coreClients, forwardSubscription: async (method, params, handlers, context) => {
      contexts.push({ caller: context.caller, signal: context.signal instanceof AbortSignal, sameSignal: handlers.signal === context.signal })
      const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: gui.path },
        ...(context.caller ? { credentials: context.caller } : {}) })
      const subscription = await client.subscribe(method, params, handlers)
      return { subscriptionId: subscription.subscriptionId, dispose: async () => { await subscription.dispose(); await client.dispose() } }
    } })
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: host.path }, credentials: f.credentials }); cleanups.push(() => client.dispose())
    const initial: unknown[] = [], events: unknown[] = []
    const controller = new AbortController(), sub = await client.subscribe('browser.follow', { operationId: 'original-browser-operation', afterSequence: 0 }, {
      signal: controller.signal, onInitial: value => initial.push(value), onEvent: value => events.push(value)
    })
    expect(contexts).toEqual([{ caller: f.credentials, signal: true, sameSignal: true }])
    expect(initial).toEqual([{ runOperation: null, gap: null }])
    const event = { sequence: 1, event: { type: 'status', status: 'running' } }
    progress(event)
    await vi.waitFor(() => expect(events).toEqual([{ type: 'progress', data: event }]))
    controller.abort(); await sub.dispose()
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledTimes(1))
    expect(f.inputs).toEqual([]); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  })
})
