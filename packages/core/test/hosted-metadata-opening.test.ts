import { fixtureDisplayPath as reshapeFixtureDisplayPath, fixtureEpoch as reshapeFixtureEpoch, fixturePath as reshapeFixturePath } from './helpers/fixture-values.js'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { metadataTestRuntime } from './helpers/metadata-test-runtime.js'
const { AgentMuxClient, AgentMuxError, AgentMuxMemoryAgentSessionStore, AgentMuxHostedRuntimeService, AgentMuxControlServer,
  connectAgentMuxRpc, connectHostedAgentMux, hostedTransfer, parseHostedBootstrap } = metadataTestRuntime
import type { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession } from '../src/types.js'
import type { AgentMuxRuntimeOwnerIdentity, AgentMuxHostedRpcPort } from '../src/hosted-client-contract.js'

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })
const original: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-opening-session', providerId: 'codex', executorId: 'codex',
  hostId: 'local', workspacePath: reshapeFixturePath("private/metadata-opening"), run: { runId: 'opening-run-1' }, retiredRuns: [],
  nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'opening-native-1' }, hookBindingId: 'opening-hook-binding', hookToken: 'opening-hook-token', createdAt: reshapeFixtureEpoch(0, 0, 100), updatedAt: reshapeFixtureEpoch(0, 0, 100) }
async function fixture() {
  const root = await mkdtemp(reshapeFixtureDisplayPath("private/tmp/amx-cut-")); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const store = new AgentMuxMemoryAgentSessionStore(), core = new AgentMuxClient({ store, providers: [] })
  cleanup.push(() => core.dispose())
  // These tests isolate metadata/event ordering. Native observation is a named collaborator;
  // the official Native/public lifecycle is exercised by the separate integration test.
  vi.spyOn(core, 'connect').mockResolvedValue()
  vi.spyOn(core, 'runtimeProjection').mockResolvedValue({ hostId: 'local', subjects: [] })
  const inner = core as unknown as { registry: AgentMuxAgentSessionRegistry; publishSession(session: AgentMuxStoredAgentSession): void }
  await inner.registry.put(original)
  const owner: AgentMuxRuntimeOwnerIdentity = { protocolVersion: 2, runtimeId: 'metadata-runtime', ownerInstanceId: 'metadata-owner',
    processId: process.pid, availability: 'connected', ctxmux: { hostId: 'local', instanceId: 'metadata-native', processId: 123,
      buildIdentity: 'isolated-native-collaborator', protocolVersion: 22, ownership: 'owned' } }
  const service = new AgentMuxHostedRuntimeService(core, null, () => owner), path = join(root, 'control.sock')
  cleanup.push(() => service.dispose())
  const server = new AgentMuxControlServer({ socketPath: path, coreClients: () => [{ hostId: 'local', client: core }], hostedRuntime: () => service })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); cleanup.push(() => rpc.dispose())
  return { store, core, inner, service, rpc, owner }
}

it('takes exact SID metadata cuts without replaying older same-millisecond Run/native bindings', async () => {
  const f = await fixture(), loading = deferred(), loadRelease = deferred(), reading = deferred(), readRelease = deferred()
  cleanup.push(async () => { loadRelease.resolve(); readRelease.resolve() })
  const load = f.store.loadMetadata.bind(f.store), read = f.store.readMetadata.bind(f.store)
  vi.spyOn(f.store, 'loadMetadata').mockImplementationOnce(async () => { loading.resolve(); await loadRelease.promise; return await load() })
  vi.spyOn(f.store, 'readMetadata').mockImplementationOnce(async id => { const value = await read(id); reading.resolve(); await readRelease.promise; return value })
  const client = await connectHostedAgentMux({ rpc: f.rpc, waitForReady: false }); cleanup.push(() => client.dispose())
  const seen: AgentMuxClientEvent[] = []; client.onEvent(event => seen.push(event))
  const opening = client.connect(); await loading.promise
  const second = { ...original, run: { runId: 'opening-run-2' }, nativeHandle: { ...original.nativeHandle!, sessionId: 'opening-native-2' } }
  const third = { ...second, run: { runId: 'opening-run-3' }, nativeHandle: { ...second.nativeHandle, sessionId: 'opening-native-3' } }
  await f.inner.registry.put(second, original.run); f.inner.publishSession(second)
  await f.inner.registry.put(third, second.run)
  // This late caller still owns its old operation receipt, but only current facts are published.
  f.inner.publishSession(second)
  loadRelease.resolve()
  // A removed scoped cut opens immediately and replays the queued old binding.
  // Race the actual opening, so that mutant fails on identity regression rather
  // than merely on whether an internal read was called.
  await Promise.race([reading.promise, opening])
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(seen.filter(event => event.type === 'agent-session').map(event => event.session.run.runId),
    'the opening must never replay the superseded binding').not.toContain('opening-run-2')
  const fourth = { ...third, run: { runId: 'opening-run-4' }, nativeHandle: { ...third.nativeHandle, sessionId: 'opening-native-4' } }
  const later = f.inner.registry.put(fourth, third.run).then(value => { f.inner.publishSession(value); return value })
  expect(f.inner.registry.get(original.agentSessionId).run).toEqual(third.run)
  readRelease.resolve(); await opening; await later
  await vi.waitFor(() => expect(client.agentSession(original.agentSessionId).run).toEqual(fourth.run))
  const bindings = seen.filter(event => event.type === 'agent-session').map(event => [event.session.run.runId, event.session.nativeHandle?.sessionId, event.session.updatedAt])
  expect(bindings).toEqual([['opening-run-3', 'opening-native-3', 100], ['opening-run-4', 'opening-native-4', 100]])
  expect(f.store.readMetadata).toHaveBeenCalledTimes(1)
  expect(f.store.loadMetadata).toHaveBeenCalledTimes(1)
})

it.each(['positive', 'error'])('rejects a late old-lease projection %s before it can publish into a new opening', async shape => {
  const f = await fixture(), entered = deferred(), release = deferred()
  cleanup.push(async () => { release.resolve() })
  let held = true
  vi.spyOn(f.core, 'runtimeProjection').mockImplementation(async () => {
    if (!held) return { hostId: 'local', subjects: [] }
    held = false; entered.resolve(); await release.promise
    if (shape === 'error') throw new Error('stale-projection-from-prior-lease')
    return { hostId: 'local', subjects: [{ kind: 'terminal', run: { nativeService: null, runId: 'stale-opening-run', kind: 'terminal',
      providerId: null, executorId: null, agentSessionId: null, workspacePath: reshapeFixturePath("private/metadata-opening"), pid: 123, state: 'running',
      cols: 80, rows: 24, observedAt: reshapeFixtureEpoch(0, 0, 1), latestOutputBytes: 0, acceptedInputBytes: 0 } }] }
  })
  const client = await connectHostedAgentMux({ rpc: f.rpc }); cleanup.push(() => client.dispose())
  await entered.promise
  const seen: AgentMuxClientEvent[] = []; client.onEvent(event => seen.push(event))
  await client.disconnect(); await client.connect()
  const before = seen.length
  release.resolve(); await vi.waitFor(() => expect(f.core.runtimeProjection).toHaveBeenCalledTimes(2))
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(seen.slice(before).filter(event => event.type === 'process-state' && event.run.runId === 'stale-opening-run')).toEqual([])
  expect(seen.filter(event => event.type === 'agent-error' && event.message.includes('stale-projection-from-prior-lease'))).toEqual([])
  expect(client.agentSession(original.agentSessionId).run).toEqual(original.run)
})

it('dependency readiness cannot cancel the original six-attempt recovery owner after a public handshake still fails', async () => {
  const core = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore(), providers: [] }); cleanup.push(() => core.dispose())
  const waiting = deferred(), release = deferred(); cleanup.push(async () => { release.resolve() })
  let connected = false, failing = false, sleeps = 0, lost!: () => void, available!: () => void
  const kernel = { isConnected: () => connected, connect: vi.fn(async () => {
    if (failing) throw new Error('Private ready Native public handshake still unconfirmed')
    connected = true
  }), resetConnection: () => { connected = false }, disconnect: () => { connected = false },
    identity: () => ({ buildIdentity: 'isolated-readiness-collaborator', protocolVersion: 22, daemonInstanceId: 'original-ready-native' }),
    list: async () => [], onEvent: () => () => {}, onError: () => () => {},
    onConnectionLost: (listener: () => void) => { lost = listener; return () => {} },
    onConnectionAvailable: (listener: () => void) => { available = listener; return () => {} } }
  const inner = core as unknown as { reconnectController: AbortController | null; hookServer: { port: number } }
  Object.assign(core, { kernel, reconnectSleep: async () => { if (++sleeps === 1) return; waiting.resolve(); await release.promise } })
  inner.hookServer.port = 0
  await core.connect()
  const events: AgentMuxClientEvent[] = []; core.onEvent(event => events.push(event))
  failing = true; connected = false; lost(); await waiting.promise
  const originalOwner = inner.reconnectController!
  available()
  await vi.waitFor(() => expect(kernel.connect).toHaveBeenCalledTimes(3))
  await new Promise(resolve => setImmediate(resolve))
  expect(originalOwner.signal.aborted, 'automatic readiness observation is not an explicit Retry intent').toBe(false)
  expect(inner.reconnectController).toBe(originalOwner)
  release.resolve()
  await vi.waitFor(() => expect(kernel.connect).toHaveBeenCalledTimes(8))
  await vi.waitFor(() => expect(events.filter(event => event.type === 'connection-state').map(event => event.state)).toEqual(['lost', 'retrying']))
})

it('cancels an actual Unix opening promptly and cannot revive the released reader after metadata completes', async () => {
  const f = await fixture(), loading = deferred(), release = deferred(), load = f.store.loadMetadata.bind(f.store)
  cleanup.push(async () => { release.resolve() })
  vi.spyOn(f.store, 'loadMetadata').mockImplementationOnce(async () => { loading.resolve(); await release.promise; return await load() })
  const signal = new AbortController(), onInitial = vi.fn(), onEvent = vi.fn()
  const opening = f.rpc.subscribe('runtime.events', { consumerId: 'cancelled-metadata-reader', fence: { runtimeId: f.owner.runtimeId, ownerInstanceId: f.owner.ownerInstanceId } }, { signal: signal.signal, onInitial, onEvent })
    .then(value => ({ value }), error => ({ error }))
  await loading.promise; signal.abort()
  await vi.waitFor(async () => expect(await opening).toHaveProperty('error'))
  await vi.waitFor(() => expect((f.service as unknown as { consumers: Map<string, unknown> }).consumers.size).toBe(0))
  release.resolve(); await new Promise(resolve => setImmediate(resolve))
  expect(onInitial).not.toHaveBeenCalled(); expect(onEvent).not.toHaveBeenCalled()
  const newReader = await f.rpc.subscribe('runtime.events', { consumerId: 'cancelled-metadata-reader', fence: { runtimeId: f.owner.runtimeId, ownerInstanceId: f.owner.ownerInstanceId } }, { onInitial, onEvent })
  cleanup.push(() => newReader.dispose())
  expect(onInitial).toHaveBeenCalledTimes(1)
})

it('ends the original service opening wait on cancellation while its readonly metadata read finishes later', async () => {
  const f = await fixture(), loading = deferred(), release = deferred(), load = f.store.loadMetadata.bind(f.store)
  cleanup.push(async () => { release.resolve() })
  vi.spyOn(f.store, 'loadMetadata').mockImplementationOnce(async () => { loading.resolve(); await release.promise; return await load() })
  const signal = new AbortController(), emit = vi.fn()
  const opening = f.service.subscribe('runtime.events', { consumerId: 'cancelled-original-opening',
    fence: { runtimeId: f.owner.runtimeId, ownerInstanceId: f.owner.ownerInstanceId } }, emit, { signal: signal.signal })
    .then(value => ({ value }), error => ({ error }))
  await loading.promise; signal.abort(new AgentMuxError('Private opening reader cancelled.', 'CONTROL_CANCELLED'))
  const phase = await Promise.race([opening.then(() => 'settled'), new Promise<string>(done => setTimeout(() => done('pending'), 50))])
  expect(phase, 'the original cancelled opening must release its reply wait before metadata finishes').toBe('settled')
  expect(await opening).toMatchObject({ error: { code: 'CONTROL_CANCELLED' } })
  expect((f.service as unknown as { consumers: Map<string, unknown> }).consumers.size).toBe(0)
  release.resolve(); await new Promise(resolve => setImmediate(resolve))
  expect(emit).not.toHaveBeenCalled()
})

it.each(['retained', 'cleared', 'new-run'])('keeps only the exact current local output warning at an opening cut (%s)', async shape => {
  const f = await fixture(), loading = deferred(), release = deferred(), load = f.store.loadMetadata.bind(f.store)
  cleanup.push(async () => { release.resolve() })
  vi.spyOn(f.store, 'loadMetadata').mockImplementationOnce(async () => { loading.resolve(); await release.promise; return await load() })
  const client = await connectHostedAgentMux({ rpc: f.rpc, waitForReady: false }); cleanup.push(() => client.dispose())
  const opening = client.connect(); await loading.promise
  const events: AgentMuxClientEvent[] = []; f.core.onEvent(event => events.push(event))
  const inner = f.core as unknown as { publishOutputChannelSevered(session: AgentMuxStoredAgentSession): Promise<void>;
    clearOutputChannel(session: AgentMuxStoredAgentSession): Promise<void>;
    publishSession(session: AgentMuxStoredAgentSession, origin: undefined, field: 'terminalOutputChannel'): void }
  vi.spyOn(f.store, 'compareAndSwapMetadata').mockRejectedValueOnce(new Error('Private metadata write failed before replacement'))
  await inner.publishOutputChannelSevered(original)
  const warning = events.find(event => event.type === 'agent-session')
  expect(warning).toMatchObject({ type: 'agent-session', session: { run: original.run, terminalOutputChannel: { state: 'severed', run: original.run } } })
  expect(await f.store.readMetadata(original.agentSessionId)).not.toHaveProperty('terminalOutputChannel')
  if (shape === 'cleared') await inner.clearOutputChannel((warning as Extract<AgentMuxClientEvent, { type: 'agent-session' }>).session as AgentMuxStoredAgentSession)
  if (shape === 'new-run') {
    const current = { ...original, run: { runId: 'replacement-opening-run' } }
    await f.inner.registry.put(current, original.run); f.inner.publishSession(current)
    const before = events.length
    inner.publishSession((warning as Extract<AgentMuxClientEvent, { type: 'agent-session' }>).session as AgentMuxStoredAgentSession, undefined, 'terminalOutputChannel')
    expect(events).toHaveLength(before)
  }
  release.resolve(); await opening
  const projected = client.agentSession(original.agentSessionId)
  if (shape === 'retained') await vi.waitFor(() => expect(client.agentSession(original.agentSessionId).terminalOutputChannel).toMatchObject({ state: 'severed', run: original.run }))
  else expect(projected.terminalOutputChannel).toBeUndefined()
  expect(client.runtimeIdentity()).toEqual(f.owner.ctxmux)
  expect(projected.nativeHandle).toEqual(original.nativeHandle)
})

it.each(['missing-kind', 'wrong-kind', 'invalid-state', 'array-state'])('does not revoke a confirmed Native or event lease for %s wire observation', async shape => {
  const f = await fixture()
  let handlers: Parameters<AgentMuxHostedRpcPort['subscribe']>[2] | undefined
  const subscribe = f.rpc.subscribe.bind(f.rpc)
  const port = { call: f.rpc.call.bind(f.rpc), subscribe: (async (method, params, next) => {
    if (method === 'runtime.events') handlers = next
    return await subscribe(method, params, next)
  }) as AgentMuxHostedRpcPort['subscribe'] }
  const client = await connectHostedAgentMux({ rpc: port }); cleanup.push(() => client.dispose())
  const seen: AgentMuxClientEvent[] = []; client.onEvent(event => seen.push(event))
  const before = (f.service as unknown as { consumers: Map<string, unknown> }).consumers.size
  const event = { type: 'connection-state', state: shape === 'invalid-state' ? 'dead' : shape === 'array-state' ? ['lost'] : 'lost',
    observationOrigin: { ...(shape === 'missing-kind' ? {} : { kind: shape === 'wrong-kind' ? 'agent-observation' : 'runtime-connection' }), boundary: 'core-ctxmux' },
    evidence: { source: 'agentmux', observedAt: reshapeFixtureEpoch(0, 0, 1) } }
  for (const data of hostedTransfer({ kind: 'event', event }, `corrupt-${shape}`)) handlers!.onEvent({ type: 'snapshot', data })
  expect(client.runtimeIdentity()).toEqual(f.owner.ctxmux)
  expect((f.service as unknown as { consumers: Map<string, unknown> }).consumers.size).toBe(before)
  expect(seen).toMatchObject([{ type: 'agent-error', code: 'CONTROL_PROTOCOL_ERROR' }])
  await expect(client.readAgentSessions()).resolves.toMatchObject([{ agentSessionId: original.agentSessionId }])
  await expect(client.runtimeProjection()).resolves.toEqual({ hostId: 'local', subjects: [] })
  const snapshot = await f.service.bootstrap()
  expect(() => parseHostedBootstrap({ ...snapshot, connection: event })).toThrow()
})
