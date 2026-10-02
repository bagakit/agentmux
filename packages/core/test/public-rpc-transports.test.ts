import { fixturePath as upstreamFixturePath, fixtureDisplayPath as upstreamFixtureDisplayPath } from './helpers/fixture-values.js'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { stat } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createConnection, createServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, agentMuxRpcHttpOptions } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc as SourceConnect, agentMuxRpcEndpoint, agentMuxRpcSshArguments } from '../src/public-rpc-client.js'
import { AgentMuxRpcLines, AgentMuxRpcDispatcher, type AgentMuxRpcConnection } from '../src/public-rpc-wire.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AGENTMUX_RPC_MAX_MESSAGE_BYTES } from '../src/public-rpc-frame.js'
import { AgentMuxError } from '../src/errors.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import type { AgentMuxControlRequest } from '../src/control.js'
import { focusFacts } from './fixtures/desktop-focus-facts.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { parseAgentMuxControlRequest } from '../src/control-codec.js'

const connectAgentMuxRpc: typeof SourceConnect = process.env.AGENTMUX_TEST_RPC_CLIENT_ENTRY
  ? (await import(/* @vite-ignore */ pathToFileURL(process.env.AGENTMUX_TEST_RPC_CLIENT_ENTRY).href)).connectAgentMuxRpc : SourceConnect
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const catalog = { spaces: [{ spaceId: 'space', kind: 'folder' as const, name: '中文 Space', hostId: 'local', directoryPath: upstreamFixturePath("fixture"), projectId: 'project' }],
  zones: [], tabs: [], regions: [], bindings: [], locations: [] }
async function endpoint(options: ConstructorParameters<typeof AgentMuxControlServer>[0] = {}) {
  const root = await mkdtemp(upstreamFixtureDisplayPath("tmp/amx-rpc-wire-")), path = join(root, 'owner.sock')
  const owner = new AgentMuxControlServer({ coreClients: () => [], execute: async () => ({ operation: 'space.ls', catalog }), ...options, socketPath: path })
  await owner.start(); cleanups.push(async () => { await owner.stop(); await rm(root, { recursive: true, force: true }) })
  return { root, path, owner }
}
async function raw(path: string, request: unknown): Promise<any> {
  const socket = createConnection(path), lines = new AgentMuxRpcLines()
  return await new Promise((resolve, reject) => {
    socket.once('connect', () => socket.write(JSON.stringify(request) + '\n'))
    socket.on('data', chunk => { try { lines.accept(chunk, value => { socket.destroy(); resolve(value) }) } catch (error) { socket.destroy(); reject(error) } })
    socket.once('error', reject)
  })
}
describe('one public JSON-RPC service over bounded transports', () => {
  it('preserves finite fractional filesystem Wiki timestamps through the actual snapshot boundary', async () => {
    const topic = { id: 'topic', topicId: 'topic', workspaceId: 'scratch', hostId: 'local', path: upstreamFixturePath("scratch/topic"), spaceId: 'space',
      kind: 'topic' as const, directoryPath: 'topic', topicPath: 'topic/Topic.md', title: 'Topic', summary: '', collaborators: [],
      wiki: { path: 'topic/Wiki.md', content: '# Wiki', version: 'original', source: 'user' as const, enabled: true, updatedAt: 123.75 } }
    const h = await endpoint({ snapshot: async () => ({ topics: [topic] }) })
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: h.path } })
    try {
      const result = await client.call('app.snapshot', { include: ['topics'] })
      expect(result.topics).toHaveLength(1); expect(result.topics[0]!.wiki!.updatedAt).toBe(topic.wiki.updatedAt)
      for (const updatedAt of [-1, NaN, Infinity, '123.75']) {
        expect(() => parseRpcNativeResult('app.snapshot', { ...result, topics: [{ ...topic, wiki: { ...topic.wiki, updatedAt } }] }, {})).toThrow()
      }
    } finally { await client.dispose() }
  })
  it('bounds ordinary HTTP and Unix responses identically without truncating facts or losing the owner', async () => {
    const h = await endpoint({ http: { host: '127.0.0.1', port: 0, token: 'private-budget' }, snapshot: async () => ({ topics: [
      { id: 'topic', topicId: 'topic', workspaceId: 'scratch', hostId: 'local', path: upstreamFixturePath("scratch/topic"), spaceId: 'space', kind: 'topic',
        directoryPath: 'topic', topicPath: 'topic/Topic.md', title: 'Topic', summary: 'x'.repeat(AGENTMUX_RPC_MAX_MESSAGE_BYTES + 1), collaborators: [] }
    ] }) })
    for (const endpoint of [{ transport: 'unix' as const, path: h.path }, { transport: 'http' as const,
      url: `http://127.0.0.1:${h.owner.httpAddress!.port}/`, token: 'private-budget' }]) {
      const client = await connectAgentMuxRpc({ endpoint })
      try {
        const bounded = await client.call('app.snapshot', { include: ['topics'] }).then(() => 'unexpected-success', error => error.code)
        expect(bounded).toBe('CONTROL_PROTOCOL_ERROR')
        expect((await client.call('space.ls', { target: {} })).catalog.spaces).toEqual(catalog.spaces)
        expect((await client.call('system.endpoint', {})).endpoint).toEqual({ transport: 'unix', path: h.path })
      } finally { await client.dispose() }
    }
  })
  it('preserves the actual Focus presentation DTO instead of stripping space.inspect enrichment from every result', async () => {
    const h = await endpoint({ execute: async request => {
      if (request.operation !== 'focus') throw new Error('Unexpected owner operation')
      return focusFacts(request)
    } })
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: h.path } })
    try {
      const result = await client.call('space.focus', { operationId: 'focus-original', target: { kind: 'space', regionId: 'selected' }, inputPolicy: 'preserve' })
      expect(result.presentation).toEqual({ provenance: 'unknown', state: 'unknown', tabId: 'tab', regionId: 'selected', blockers: [] })
      expect(result.partial).toBe(true); expect(result.navigation.selection.space!.regionId).toBe('selected')
    } finally { await client.dispose() }
  })
  it.each(['unix', 'http'] as const)('preserves an admitted finite layout write and its exact late receipt over %s', async transport => {
    const applied: string[] = []
    const h = await endpoint({ http: { host: '127.0.0.1', port: 0, token: 'private-late-receipt' }, execute: async request => {
      if (request.operation !== 'focus') throw new Error('Unexpected admitted owner operation')
      applied.push(request.requestId)
      await delay(2_300)
      return focusFacts(request)
    } })
    const client = await connectAgentMuxRpc({ endpoint: transport === 'unix' ? { transport, path: h.path }
      : { transport, url: `http://127.0.0.1:${h.owner.httpAddress!.port}/`, token: 'private-late-receipt' } })
    try {
      const operationId = `original-${transport}-late-focus`
      const receipt = await client.call('space.focus', { operationId, target: { kind: 'space', regionId: 'selected' }, inputPolicy: 'preserve' })
      expect(applied, 'the original admitted write is never replayed').toEqual([operationId])
      expect(receipt.navigation.selection.space!.regionId).toBe('selected')
      expect(receipt.presentation).toEqual({ provenance: 'unknown', state: 'unknown', tabId: 'tab', regionId: 'selected', blockers: [] })
    } finally { await client.dispose() }
  }, 10_000)
  it('flushes the final live cursor arriving between drain completion and its settlement', async () => {
    let push!: (event: { sequence: number; event: unknown }) => void
    const cursors: number[] = []
    const service = new AgentMuxRpcService({ coreClients: () => [], subscribeBrowserOperation: async (_request, receive) => {
      push = receive; push({ sequence: 4, event: {} }); return { runOperation: null, gap: null, dispose: vi.fn() }
    } })
    const dispatcher = new AgentMuxRpcDispatcher(service), controller = new AbortController()
    const channel: AgentMuxRpcConnection = { signal: controller.signal, stream: true, afterResponse: [], activate: vi.fn(), cancel: async () => true,
      send: frame => Promise.resolve().then(() => {
        if (!('params' in frame)) return
        const sequence = (frame.params as any).event.data.sequence
        cursors.push(sequence)
        if (sequence === 4) queueMicrotask(() => queueMicrotask(() => push({ sequence: 5, event: {} })))
      }) }
    try {
      expect(await dispatcher.receive({ jsonrpc: '2.0', id: 'final-live', method: 'browser.follow', params: { operationId: 'original-operation' } }, channel))
        .toMatchObject({ id: 'final-live', result: { method: 'browser.follow' } })
      expect(channel.afterResponse).toHaveLength(1)
      await channel.afterResponse[0]!()
      await vi.waitFor(() => expect(cursors).toEqual([4, 5]))
    } finally { controller.abort(); await service.dispose() }
  })
  it('keeps original Browser cursors ordered when a live event arrives during replay backpressure', async () => {
    let push!: (event: { sequence: number; event: unknown }) => void, release!: () => void, entered!: () => void
    const first = new Promise<void>(yes => { entered = yes }), gate = new Promise<void>(yes => { release = yes }), cursors: number[] = [], disposed = vi.fn()
    const service = new AgentMuxRpcService({ coreClients: () => [], subscribeBrowserOperation: async (_request, receive) => {
      push = receive; push({ sequence: 4, event: {} }); push({ sequence: 5, event: {} }); return { runOperation: null, gap: null, dispose: disposed }
    } })
    const dispatcher = new AgentMuxRpcDispatcher(service), controller = new AbortController()
    const channel: AgentMuxRpcConnection = { signal: controller.signal, stream: true, afterResponse: [], activate: vi.fn(), cancel: async () => { disposed(); return true },
      send: async frame => { if ('params' in frame) { cursors.push((frame.params as any).event.data.sequence); if (cursors.length === 1) { entered(); await gate } } } }
    const response = await dispatcher.receive({ jsonrpc: '2.0', id: 'correlation', method: 'browser.follow', params: { operationId: 'original-operation' } }, channel)
    expect(response).toMatchObject({ id: 'correlation', result: { method: 'browser.follow' } }); expect(channel.afterResponse).toHaveLength(1)
    const flush = Promise.resolve(channel.afterResponse[0]!()); await first
    push({ sequence: 6, event: {} }); release(); await flush
    expect(cursors).toEqual([4, 5, 6]); expect(disposed).not.toHaveBeenCalled(); controller.abort(); await service.dispose()
  })
  it('separates wire id from operationId, rejects old envelopes/methods, preserves batch arrays and notifications', async () => {
    const seen: AgentMuxControlRequest[] = [], h = await endpoint({ execute: async request => { seen.push(request); return { operation: 'space.ls', catalog } } })
    const request = { jsonrpc: '2.0', id: 31, method: 'space.ls', params: { operationId: 'business-independent', target: {} } }
    expect(await raw(h.path, request)).toMatchObject({ jsonrpc: '2.0', id: 31, result: { catalog } })
    expect(seen).toHaveLength(1); expect(seen[0]).toMatchObject({ requestId: 'business-independent', operation: 'space.ls' })
    expect(await raw(h.path, { schemaVersion: 5, requestId: 'old-wire', operation: 'space.ls', target: {} })).toMatchObject({ id: null, error: { code: -32600 } })
    expect(await raw(h.path, { ...request, id: 'wrong-version', jsonrpc: '1.0' })).toMatchObject({ id: 'wrong-version', error: { code: -32600 } })
    expect(await raw(h.path, { ...request, id: 'old-envelope-field', schemaVersion: 5 })).toMatchObject({ id: 'old-envelope-field', error: { code: -32600 } })
    expect(await raw(h.path, { jsonrpc: '2.0', id: 'old-method', method: 'list.agents' })).toMatchObject({ error: { code: -32601 } })
    for (const method of ['constructor', '__proto__', 'toString']) expect(await raw(h.path, { jsonrpc: '2.0', id: method, method })).toMatchObject({ id: method, error: { code: -32601 } })
    const batch = await raw(h.path, [{ ...request, id: 32 }, { jsonrpc: '2.0', method: 'space.ls', params: { target: {} } }])
    expect(batch).toHaveLength(1); expect(batch[0].id).toBe(32); expect(seen).toHaveLength(3)
    expect((await stat(h.path)).mode & 0o777).toBe(0o600)
  })
  it.each(['agent.open', 'space.mv', 'space.bind'] as const)('validates %s with the actual durable operationId, independent of wire correlation', async method => {
    const save = { layoutApplied: true, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'unconfirmed' as const, reason: null }
    const binding = { kind: 'zone-space' as const, zoneId: 'zone', spaceId: 'space' }, seen: AgentMuxControlRequest[] = []
    const h = await endpoint({ execute: async request => { seen.push(request)
      if (request.operation === 'space.bind') return { operation: request.operation, requestId: request.requestId, outcome: 'linked', binding, catalog, save, issues: [] }
      if (request.operation === 'agent.open' || request.operation === 'space.mv') return {
        operation: request.operation, requestId: request.requestId, outcome: request.operation === 'agent.open' ? 'opened' : 'moved',
        from: null, to: null, agent: null, resource: null, save, issues: [] }
      throw new Error('Unexpected original owner operation')
    } })
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: h.path } })
    const operationId = 'durable-' + method
    try {
      const pending = method === 'space.bind' ? client.call(method, { operationId, binding })
        : method === 'agent.open' ? client.call(method, { operationId, content: { kind: 'agent-session', agentSessionId: 'existing' }, destination: { zoneId: 'zone', newTab: true }, focus: false })
        : client.call(method, { operationId, fromRegionId: 'source', expectedAgentSessionId: 'existing', destination: { zoneId: 'zone', newTab: true }, focus: false })
      await expect(pending).resolves.toMatchObject({ operationId })
      const reply = await pending
      expect(reply.operationId).toBe(operationId); expect(seen).toHaveLength(1); expect(seen[0]!.requestId).toBe(operationId)
    } finally { await client.dispose() }
  })
  it('default send resolves a prefix once, retains a distinct message id and reads the same receipt without repeating input', async () => {
    const sdk = await rpcOwnerFixture(['caller', 'recipient-canonical']); cleanups.push(sdk.close)
    const sent: AgentMuxControlRequest[] = []
    const h = await endpoint({ coreClients: sdk.coreClients, execute: async request => {
      if (request.operation === 'list.active-agents') return { operation: request.operation, agents: [{ agentSessionId: 'recipient-canonical',
        promptCondition: { expectedRun: { runId: 'run-recipient-canonical' }, afterSubmissionId: null }, projectId: null, projectName: null,
        workspacePath: sdk.root, providerId: 'codex', executorId: 'codex', processState: 'running', status: 'idle', updatedAt: 1 }] }
      if (request.operation === 'send') { sent.push(request); return { operation: request.operation, agentSessionId: 'recipient-canonical' } }
      throw new Error('Unexpected original owner operation')
    } })
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: h.path } })
    const params = { operationId: 'default-send-operation', target: { kind: 'agent-session' as const, agentSessionId: 'recipient' }, text: 'Original task body' }
    try {
      const first = await client.call('agent.send', params), repeated = await client.call('agent.send', params)
      expect(() => parseAgentMuxControlRequest({ ...sent[0], message: undefined })).toThrow(expect.objectContaining({ code: 'MESSAGE_ENVELOPE_INVALID' }))
      expect(() => parseAgentMuxControlRequest({ ...sent[0], caller: sdk.credentials })).toThrow(expect.objectContaining({ code: 'MESSAGE_SENDER_MISMATCH' }))
      expect(first.messageId).not.toBe(params.operationId); expect(first.envelope.recipientSessionId).toBe('recipient-canonical')
      expect(repeated).toEqual(expect.objectContaining({ messageId: first.messageId, envelope: first.envelope, delivery: first.delivery }))
      const explicit = await client.call('agent.send', { ...params, messageId: first.messageId, operationId: 'later-read-operation' })
      expect(explicit.envelope.operationId).toBe(params.operationId)
      expect(sent).toHaveLength(1); expect(sent[0]).toMatchObject({ target: { kind: 'agent-session', agentSessionId: 'recipient-canonical' } })
      expect(sdk.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await client.dispose() }
  })
  it('uses identical owner facts and typed capability errors on Unix and explicitly authorized HTTP', async () => {
    const sdk = await rpcOwnerFixture(); cleanups.push(sdk.close)
    const h = await endpoint({ coreClients: sdk.coreClients, http: { host: '127.0.0.1', port: 0, token: 'private-fixture-http-token' } })
    const address = h.owner.httpAddress!, http = { transport: 'http' as const, url: `http://127.0.0.1:${address.port}/`, token: 'private-fixture-http-token' }
    for (const carrier of [{ transport: 'unix' as const, path: h.path }, http]) {
      const client = await connectAgentMuxRpc({ endpoint: carrier }), unauthorized = await connectAgentMuxRpc({ endpoint: carrier, credentials: { ...sdk.credentials, capability: 'bad-private-claim' } })
      try {
        expect((await client.call('space.ls', { target: {} })).catalog.spaces).toEqual(catalog.spaces)
        await expect(unauthorized.call('space.ls', { target: {} })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
      } finally { await client.dispose(); await unauthorized.dispose() }
    }
    const unauthenticated = await fetch(http.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"space.ls","params":{"target":{}}}' })
    expect(unauthenticated.status).toBe(401); expect(agentMuxRpcHttpOptions({})).toBeUndefined()
    expect(() => agentMuxRpcHttpOptions({ AGENTMUX_RPC_HTTP_BIND: '127.0.0.1:1' })).toThrow()
    expect(sdk.inner.kernel.stop).not.toHaveBeenCalled()
  })
  it.each(['unix', 'http'] as const)('sends one response before synchronous replay notifications and disposes only its %s reader', async transport => {
    const disposals: number[] = []
    const h = await endpoint({ http: { host: '127.0.0.1', port: 0, token: 'private-token' },
      subscribeBrowserOperation: async (_request, push) => {
        push({ sequence: 4, event: { kind: 'private-progress', text: '中文 event' } }); push({ sequence: 5, event: { kind: 'private-progress-end' } })
        return { runOperation: null, gap: { droppedThrough: 3 }, dispose: () => { disposals.push(1) } }
      } })
    const client = await connectAgentMuxRpc({ endpoint: transport === 'unix' ? { transport, path: h.path }
      : { transport, url: `http://127.0.0.1:${h.owner.httpAddress!.port}/`, token: 'private-token' } })
    const phases: string[] = [], frames: any[] = [], events: any[] = []
    const sub = await client.subscribe('browser.follow', { operationId: 'business-browser', afterSequence: 2 }, {
      onInitial: initial => { phases.push('initial'); expect(initial.gap).toEqual({ droppedThrough: 3 }) },
      onEvent: event => { phases.push(event.type); events.push(event) }, onFrame: frame => { frames.push(frame) } })
    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(phases).toEqual(['initial', 'progress', 'progress']); expect(frames).toHaveLength(3)
    expect(frames[0]).toMatchObject({ jsonrpc: '2.0', id: expect.any(String), result: { method: 'browser.follow', subscriptionId: sub.subscriptionId } })
    expect(frames.slice(1).map(frame => frame.params.sequence)).toEqual([1, 2])
    expect(frames.slice(1).map(frame => frame.params.event.data.sequence)).toEqual([4, 5])
    await sub.dispose(); await client.dispose(); await vi.waitFor(() => expect(disposals).toEqual([1]))
  })
  it('closes a delayed cancelled reader after establishment without a late notification', async () => {
    let complete!: (value: { runOperation: null; gap: null; dispose(): void }) => void, enter!: () => void
    const entered = new Promise<void>(yes => { enter = yes }), disposed = vi.fn()
    const h = await endpoint({ subscribeBrowserOperation: () => { enter(); return new Promise(yes => { complete = yes }) } })
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: h.path } }), controller = new AbortController(), events = vi.fn()
    const promise = client.subscribe('browser.follow', { operationId: 'delayed' }, { onInitial: vi.fn(), onEvent: events, signal: controller.signal })
    const rejected = expect(promise).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
    await entered; controller.abort(); await rejected
    complete({ runOperation: null, gap: null, dispose: disposed }); await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce())
    expect(events).not.toHaveBeenCalled(); await client.dispose()
  })
  it('strictly decodes UTF-8 across chunks and rejects both incomplete EOF forms', () => {
    const bytes = Buffer.from('{"jsonrpc":"2.0","method":"中文"}\n'), found: unknown[] = [], decoder = new AgentMuxRpcLines()
    for (const byte of bytes) decoder.accept(Uint8Array.from([byte]), value => { found.push(value) })
    expect(found).toEqual([{ jsonrpc: '2.0', method: '中文' }]); decoder.end()
    for (const source of ['{"jsonrpc":"2.0"}', '{"jsonrpc":']) {
      const incomplete = new AgentMuxRpcLines(); incomplete.accept(Buffer.from(source), vi.fn())
      expect(() => incomplete.end()).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    }
  })
  it('rejects a foreign RPC response identity, malformed candidate sets and old wire responses', async () => {
    for (const result of ['foreign-id', 'old-envelope', 'missing-candidates']) {
      const root = await mkdtemp(upstreamFixtureDisplayPath("tmp/amx-rpc-invalid-")), path = join(root, 'bad.sock')
      const server = createServer(socket => socket.once('data', chunk => {
        const request = JSON.parse(chunk.toString())
        socket.end(JSON.stringify(result === 'old-envelope' ? { schemaVersion: 5, requestId: request.id, ok: true, operation: 'space.ls', result: { catalog } }
          : { jsonrpc: '2.0', id: result === 'foreign-id' ? 'someone-else' : request.id,
            error: { code: -32000, message: 'not unique', data: { code: 'MESSAGE_TARGET_NOT_UNIQUE', candidates: [] } } }) + '\n')
      }))
      await new Promise<void>(yes => server.listen(path, yes))
      const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
      try { await expect(client.call('space.ls', { target: {} })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' }) }
      finally { await client.dispose(); await new Promise<void>(yes => server.close(() => yes())); await rm(root, { recursive: true, force: true }) }
    }
  })
  it('rejects malformed native DTOs and foreign Session/Run facts over the real client transport', async () => {
    const sdk = await rpcOwnerFixture(); cleanups.push(sdk.close)
    const session = sdk.client.agentSession('caller'), current = await sdk.client.statusAgent('caller')
    const cases = [{}, { session: { ...session, agentSessionId: 'other' }, status: null, displayName: { override: null, availability: 'unavailable' }, unavailable: [] },
      { session, status: { ...current, run: { ...current.run, runId: 'foreign' } }, displayName: { override: null, availability: 'unavailable' }, unavailable: [] }]
    expect(cases).toHaveLength(3)
    for (const result of cases) {
      const root = await mkdtemp(upstreamFixtureDisplayPath("tmp/amx-rpc-native-invalid-")), path = join(root, 'bad.sock')
      const server = createServer(socket => socket.once('data', chunk => { const request = JSON.parse(chunk.toString()); socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n') }))
      await new Promise<void>(yes => server.listen(path, yes)); const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
      try { await expect(client.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'caller' } })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' }) }
      finally { await client.dispose(); await new Promise<void>(yes => server.close(() => yes())); await rm(root, { recursive: true, force: true }) }
    }
  })
  it('rejects foreign-domain and mismatched output Gaps at the actual stream opening', async () => {
    const sdk = await rpcOwnerFixture(); cleanups.push(sdk.close)
    const session = sdk.client.agentSession('caller'), run = (await sdk.client.statusAgent('caller')).run
    const gaps = [{ droppedThrough: 3 }, { requestedAfterByte: -1, firstAvailableByte: 3 },
      { requestedAfterByte: 1, firstAvailableByte: 3 }, { requestedAfterByte: 0, firstAvailableByte: 0 }]
    expect(gaps).toHaveLength(4)
    for (const gap of gaps) {
      const root = await mkdtemp(upstreamFixtureDisplayPath("tmp/amx-rpc-gap-")), path = join(root, 'gap.sock')
      const server = createServer(socket => socket.once('data', chunk => { const request = JSON.parse(chunk.toString())
        socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { subscriptionId: 'reader', method: 'agent.output',
          initial: { session, run, gap, terminal: { type: 'not-requested' }, resizeRevision: 7 } } }) + '\n')
      }))
      await new Promise<void>(yes => server.listen(path, yes)); const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
      try { await expect(client.subscribe('agent.output', { agentSessionId: 'caller', afterByte: 0, follow: false },
        { onInitial: vi.fn(), onEvent: vi.fn() })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' }) }
      finally { await client.dispose(); await new Promise<void>(yes => server.close(() => yes())); await rm(root, { recursive: true, force: true }) }
    }
  })
  it('accepts a canonical output opening for an admitted unique prefix and keeps ordered raw bytes', async () => {
    const sdk = await rpcOwnerFixture(['unique-canonical']); cleanups.push(sdk.close)
    const h = await endpoint({ coreClients: sdk.coreClients }), client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: h.path } })
    const initial: unknown[] = [], events: any[] = []
    try {
      const reader = await client.subscribe('agent.output', { agentSessionId: 'unique', afterByte: 1, follow: false }, { onInitial: value => initial.push(value), onEvent: value => events.push(value) })
      await vi.waitFor(() => expect(events.at(-1)?.type).toBe('end'))
      expect(initial).toHaveLength(1); expect(initial[0]).toMatchObject({ session: { agentSessionId: 'unique-canonical' } })
      expect(events.filter(e => e.type === 'output').flatMap(e => [...Buffer.from(e.data.dataBase64, 'base64')])).toEqual([0xb8])
      await reader.dispose(); await vi.waitFor(() => expect(sdk.closes).toHaveBeenCalledOnce()); expect(sdk.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await client.dispose() }
  })
  it('SSH shares the remote Unix owner through the standard CLI stdio entry, not a second Runtime', () => {
    const endpoint = agentMuxRpcEndpoint('ssh://private-host/?socket=%2Ftmp%2Fprivate-owner.sock&command=agentmux')
    expect(endpoint.transport).toBe('ssh'); if (endpoint.transport !== 'ssh') throw new Error('Expected SSH')
    expect(agentMuxRpcSshArguments(endpoint)).toEqual(['-T', '-o', 'BatchMode=yes', '-o', 'ClearAllForwardings=yes', '--', 'private-host',
      ("'agentmux' '--endpoint' 'unix:" + (upstreamFixturePath("tmp/private-owner.sock")) + "' 'system' 'endpoint' '--stdio'")])
  })
  it('allows bounded cold SSH child startup before an admitted finite owner receipt', async () => {
    const h = await endpoint(), bin = join(h.root, 'bin'), ready = join(h.root, 'ssh-child.pid')
    await mkdir(bin)
    // A real private child models remote CLI startup. Actual OpenSSH is proved
    // independently by verify-public-rpc-transports, without this fixture.
    await writeFile(join(bin, 'ssh'), `#!/usr/bin/env node
const net = require('node:net'), fs = require('node:fs')
const alive = setInterval(() => {}, 1000)
process.once('SIGUSR2', () => {
  clearInterval(alive)
  const socket = net.createConnection(${JSON.stringify(h.path)})
  socket.once('connect', () => { process.stdin.pipe(socket); socket.pipe(process.stdout) })
  socket.once('error', () => { process.exitCode = 1 })
})
fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid))
`, { mode: 0o700 })
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'ssh', host: 'private-startup-fixture' } })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const pending = client.call('space.ls', { target: {} })
      let openingFailure: unknown
      void pending.catch(error => { openingFailure = error })
      let pid: number | undefined
      const deadline = Date.now() + 2500
      while (!pid && Date.now() < deadline) {
        try { pid = Number(await readFile(ready, 'utf8')) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        if (!pid) await delay(10)
      }
      expect(openingFailure, 'The private SSH child must reach startup before any RPC opening failure').toBeUndefined()
      expect(pid).toBeGreaterThan(0)
      // Move only this client's deadline clock beyond the original 2 s before
      // the child can connect. Its finite owner still owns its eventual receipt.
      await vi.advanceTimersByTimeAsync(2300)
      try { process.kill(pid!, 'SIGUSR2') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      await expect(pending).resolves.toEqual({ catalog })
    } finally { await client.dispose(); vi.useRealTimers() }
  })
  it('snapshot supplies the original catalog target and keeps independent Workspace metadata', async () => {
    const workspace = { workspaceId: 'w', projectId: 'project', hostId: 'local', path: upstreamFixturePath("fixture"), name: 'Work', kind: 'root', repoPath: null, branch: null }
    const seen: AgentMuxControlRequest[] = []
    const h = await endpoint({ snapshot: async () => ({ workspaces: [workspace] }), execute: async request => {
      seen.push(parseAgentMuxControlRequest(request)); return { operation: 'space.ls', catalog }
    } })
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: h.path } })
    try {
      const result = await client.call('app.snapshot', { include: ['workspaces', 'spaces'] })
      expect(result.spaces).toEqual(catalog.spaces); expect(result.workspaces).toEqual([workspace])
      expect(result.unavailable).toEqual([]); expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ operation: 'space.ls', target: {} })
    } finally { await client.dispose() }
  })
})
