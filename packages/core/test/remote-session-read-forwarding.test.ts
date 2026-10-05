import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import type { AgentMuxRuntimeOwnerIdentity } from '../src/hosted-client-contract.js'
import type { AgentMuxRpcServiceOptions } from '../src/public-rpc-service.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxRpcError } from '../src/public-rpc-wire.js'
import type { AgentMuxRpcStreamEvent } from '../src/public-rpc.js'
import type { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

/** Three real Unix RPC services; only ctxmux's byte source is deterministic. */
async function fixture(localIds = ['source-local'], desktopPorts: AgentMuxRpcServiceOptions = {}) {
  const local = await rpcOwnerFixture(localIds)
  cleanups.push(local.close)
  const target = await rpcOwnerFixture(['remote-target'])
  cleanups.push(target.close)
  // The real Hosted reader waits for its complete initial byte cut. This fixture
  // retains exactly two bytes, including an incomplete UTF-8 code point.
  const kernel = target.inner.kernel as unknown as CtxmuxRunAdapter
  const observe = kernel.observeOutput.bind(kernel)
  vi.spyOn(kernel, 'observeOutput').mockImplementation(async (...args) => {
    const observed = await observe(...args)
    return { ...observed, run: { ...observed.run, latestOutputBytes: 2 } }
  })
  kernel.status = vi.fn(async id => ({ ...target.run(id), latestOutputBytes: 2 }))
  target.inner.kernel.identity = () => ({ buildIdentity: 'target-fixture', protocolVersion: 1, daemonInstanceId: 'target-native' })
  const input = vi.fn(), stop = vi.spyOn(target.inner.kernel, 'stop'), localInput = vi.fn()
  target.inner.kernel.input = input
  local.inner.kernel.input = localInput
  const identity: AgentMuxRuntimeOwnerIdentity = { runtimeId: 'target-runtime', ownerInstanceId: 'target-owner-instance',
    protocolVersion: 1, processId: process.pid, ctxmux: target.client.runtimeIdentity(), availability: 'connected' }
  const hosted = new AgentMuxHostedRuntimeService(target.client, join(target.root, 'sessions.json'), () => identity)
  cleanups.push(() => hosted.dispose())
  const targetServer = new AgentMuxControlServer({ socketPath: join(target.root, 'target.sock'),
    coreClients: target.coreClients, hostedRuntime: () => hosted })
  await targetServer.start(); cleanups.push(() => targetServer.stop())
  const targetRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: targetServer.path } })
  cleanups.push(() => targetRpc.dispose())
  const targetSdk = await connectHostedAgentMux({ rpc: targetRpc, waitForReady: true, expectedRuntimeId: identity.runtimeId })
  cleanups.push(() => targetSdk.dispose())
  // connectSshAgentMux adds this business port to the same Hosted SDK. Reads must
  // borrow its SDK methods, rather than forwarding the source managed caller.
  const targetBusiness = vi.fn(async () => {
    throw new Error('A source capability must never cross into target public business RPC')
  })
  Object.assign(targetSdk, { forwardRpc: targetBusiness })
  const desktop = new AgentMuxControlServer({ socketPath: join(local.root, 'desktop.sock'),
    coreClients: () => [...local.coreClients(), { hostId: 'remote-route', client: targetSdk }], ...desktopPorts })
  await desktop.start(); cleanups.push(() => desktop.stop())
  const forwardedCalls = vi.fn<NonNullable<AgentMuxRpcServiceOptions['forwardControl']>>(async (method, params, context) => {
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktop.path },
      ...(context.caller ? { credentials: context.caller } : {}) })
    try { return await rpc.call(method, params, { ...(context.signal ? { signal: context.signal } : {}) }) }
    finally { await rpc.dispose() }
  })
  const forwardedStreams = vi.fn<NonNullable<AgentMuxRpcServiceOptions['forwardSubscription']>>(async (method, params, handlers, context) => {
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktop.path },
      ...(context.caller ? { credentials: context.caller } : {}) })
    try {
      const sub = await rpc.subscribe(method, params, handlers)
      return { subscriptionId: sub.subscriptionId, dispose: async () => { await sub.dispose(); await rpc.dispose() } }
    } catch (error) { await rpc.dispose(); throw error }
  })
  const host = new AgentMuxControlServer({ socketPath: join(local.root, 'control.sock'), coreClients: local.coreClients,
    forwardControl: forwardedCalls, forwardSubscription: forwardedStreams })
  await host.start(); cleanups.push(() => host.stop())
  const env = objectCliEnvironment(local.root, { AGENTMUX_AGENT_SESSION_ID: local.credentials.agentSessionId,
    AGENTMUX_AGENT_CAPABILITY: local.capability })
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: host.path }, credentials: local.credentials })
  cleanups.push(() => rpc.dispose())
  return { local, target, desktop, host, rpc, targetSdk, targetBusiness, input, stop, localInput, env, forwardedCalls, forwardedStreams,
    cli: (args: readonly string[]) => runCompiledObjectCli(args, env) }
}

function noWrites(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  expect(f.localInput).not.toHaveBeenCalled(); expect(f.local.inner.kernel.stop).not.toHaveBeenCalled()
}

function isolatedService(f: Awaited<ReturnType<typeof fixture>>, ports: AgentMuxRpcServiceOptions = {}) {
  const service = new AgentMuxRpcService({ coreClients: f.local.coreClients, ...ports })
  cleanups.push(() => service.dispose())
  return service
}

it('compiled CLI inspects an exact remote SID through the default Host and Desktop borrowed target SDK', async () => {
  const f = await fixture()
  const result = await f.cli(['agent', 'inspect', '--session', 'remote-target'])
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, operation: 'agent.inspect', result: {
    routeHostId: 'remote-route', session: { agentSessionId: 'remote-target', hostId: 'local', run: { runId: 'run-remote-target' } }
  } })
  expect(f.forwardedCalls).toHaveBeenCalledOnce(); expect(f.targetBusiness).not.toHaveBeenCalled()
  expect(f.input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})

it('compiled CLI output keeps the remote initial frame and exact ordered bytes without target business forwarding', async () => {
  const f = await fixture()
  const result = await f.cli(['agent', 'output', '--session', 'remote-target'])
  expect(result.code, result.stderr).toBe(0)
  const frames = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  expect(frames[0]).toMatchObject({ result: { method: 'agent.output', initial: {
    session: { agentSessionId: 'remote-target', hostId: 'local' }, run: { runId: 'run-remote-target' }
  } } })
  const bytes = frames.slice(1).filter(frame => frame.params.event.type === 'output')
    .flatMap(frame => [...Buffer.from(frame.params.event.data.dataBase64, 'base64')])
  expect(bytes).toEqual([0xe4, 0xb8])
  expect(frames.at(-1)).toMatchObject({ params: { event: { type: 'end' } } })
  expect(f.forwardedStreams).toHaveBeenCalledOnce(); expect(f.targetBusiness).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(f.target.closes).toHaveBeenCalledOnce())
  expect(f.input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})

it('compiled CLI lists local and remote owners even when the default Host local inventory is nonempty', async () => {
  const f = await fixture()
  const result = await f.cli(['agent', 'ls'])
  expect(result.code, result.stderr).toBe(0)
  const listed = JSON.parse(result.stdout).result
  expect(listed.sessions.map((item: { routeHostId: string; session: { agentSessionId: string; hostId: string } }) =>
    [item.routeHostId, item.session.agentSessionId, item.session.hostId])).toEqual([
    ['local', 'source-local', 'local'], ['remote-route', 'remote-target', 'local']
  ])
  expect(listed.errors).toEqual([])
  expect(f.forwardedCalls).toHaveBeenCalledOnce(); expect(f.targetBusiness).not.toHaveBeenCalled()
  expect(f.input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})

it('known local inspect and output remain on their original owner without Desktop forwarding', async () => {
  const f = await fixture()
  expect((await f.cli(['agent', 'inspect', '--session', 'source-local'])).code).toBe(0)
  expect((await f.cli(['agent', 'output', '--session', 'source-local'])).code).toBe(0)
  expect(f.forwardedCalls).not.toHaveBeenCalled(); expect(f.forwardedStreams).not.toHaveBeenCalled()
  expect(f.target.inner.kernel.observeOutput).not.toHaveBeenCalled(); expect(f.targetBusiness).not.toHaveBeenCalled()
  noWrites(f)
})

it('an absent Desktop transport keeps nonempty local inventory and a truthful read error', async () => {
  const f = await fixture()
  await f.desktop.stop()
  const reading = f.rpc.call('agent.ls', {})
  await expect(reading).resolves.toHaveProperty('sessions')
  const listed = await reading
  expect(listed.sessions.map(item => item.session.agentSessionId)).toEqual(['source-local'])
  expect(listed.errors).toHaveLength(1)
  expect(listed.errors[0]).toMatchObject({ code: 'CONTROL_UNAVAILABLE', message: expect.stringContaining('only local observations') })
  expect(listed.errors[0]!.message).toContain('RPC owner is unavailable')
  expect(f.forwardedCalls).toHaveBeenCalledOnce(); noWrites(f)
})

it('a real Desktop CONTROL_UNAVAILABLE response remains a RpcError and cannot masquerade as an absent transport', async () => {
  const refused = Object.assign(new AgentMuxError('Original Desktop explicitly refused this read', 'CONTROL_UNAVAILABLE'),
    { details: { originalOwner: 'desktop' }, candidates: [{ agentSessionId: 'retained-target' }] })
  const f = await fixture(['source-local'], { coreClients: () => { throw refused } })
  const result = f.rpc.call('agent.ls', {})
  await expect(result).rejects.toBeInstanceOf(AgentMuxRpcError)
  await expect(result).rejects.toMatchObject({ code: refused.code, message: refused.message,
    details: refused.details, candidates: refused.candidates })
  expect(f.forwardedCalls).toHaveBeenCalledOnce(); noWrites(f)
})

it.each(['agent.inspect', 'agent.output', 'agent.ls'] as const)('%s preserves an authoritative forwarded RpcError rather than treating it as transport absence', async method => {
  const f = await fixture()
  const original = new AgentMuxRpcError('Original Desktop refused this read', 'CONTROL_UNAVAILABLE', -32000,
    { originalOwner: 'desktop' }, [{ agentSessionId: 'retained-target' }], 'original-detail')
  const forward = vi.fn(async () => { throw original })
  const service = isolatedService(f, { forwardControl: forward, forwardSubscription: forward })
  const context = { caller: f.local.credentials, signal: new AbortController().signal }
  const read = method === 'agent.output'
    ? service.subscribe(method, { agentSessionId: 'remote-target' }, vi.fn(), context)
    : method === 'agent.inspect'
      ? service.call(method, { target: { kind: 'agent-session', agentSessionId: 'remote-target' } }, context)
      : service.call(method, {}, context)
  await expect(read).rejects.toBe(original)
  expect(forward).toHaveBeenCalledOnce(); noWrites(f)
})

it('invalid source credentials cannot invoke either Desktop forwarding port', async () => {
  const f = await fixture(), invalid = { ...f.local.credentials, capability: 'forged-capability' }
  await expect(f.rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'remote-target' } },
    { credentials: invalid })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  const bad = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.host.path }, credentials: invalid })
  cleanups.push(() => bad.dispose())
  await expect(bad.subscribe('agent.output', { agentSessionId: 'remote-target' }, {
    onInitial: vi.fn(), onEvent: vi.fn()
  })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  expect(f.forwardedCalls).not.toHaveBeenCalled(); expect(f.forwardedStreams).not.toHaveBeenCalled(); noWrites(f)
})

it.each(['agent.inspect', 'agent.output'] as const)('%s never delegates an ambiguous local target', async method => {
  const f = await fixture(['source-local', 'same-prefix-one', 'same-prefix-two'])
  const read = method === 'agent.inspect'
    ? f.rpc.call(method, { target: { kind: 'agent-session', agentSessionId: 'same-prefix' } })
    : f.rpc.subscribe(method, { agentSessionId: 'same-prefix' }, { onInitial: vi.fn(), onEvent: vi.fn() })
  await expect(read).rejects.toMatchObject({ code: 'AMBIGUOUS_AGENT_SESSION' })
  expect(f.forwardedCalls).not.toHaveBeenCalled(); expect(f.forwardedStreams).not.toHaveBeenCalled(); noWrites(f)
})

it.each(['agent.inspect', 'agent.output'] as const)('%s never turns an unconfirmed local Store read into remote fallback', async method => {
  const f = await fixture(), read = f.local.client.readAgentSessions.bind(f.local.client)
  vi.spyOn(f.local.client, 'readAgentSessions').mockImplementationOnce(read)
    .mockRejectedValue(new AgentMuxError('Original Store unreadable', 'AGENT_SESSION_STORE_READ_UNCONFIRMED'))
  const result = method === 'agent.inspect'
    ? f.rpc.call(method, { target: { kind: 'agent-session', agentSessionId: 'remote-target' } })
    : f.rpc.subscribe(method, { agentSessionId: 'remote-target' }, { onInitial: vi.fn(), onEvent: vi.fn() })
  await expect(result).rejects.toMatchObject({ code: 'AGENT_SESSION_STORE_READ_UNCONFIRMED' })
  expect(f.forwardedCalls).not.toHaveBeenCalled(); expect(f.forwardedStreams).not.toHaveBeenCalled(); noWrites(f)
})

it.each([
  { target: { kind: 'agent-session', agentSessionId: 'remote-target', extra: true } },
  { target: { kind: 'agent-session', agentSessionId: 'remote-target' }, extra: true },
  { target: { kind: 'unsupported', agentSessionId: 'remote-target' } }
])('rejects malformed inspect parameters before any read delegation: %j', async params => {
  const f = await fixture()
  await expect(f.rpc.call('agent.inspect', params as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  expect(f.forwardedCalls).not.toHaveBeenCalled(); noWrites(f)
})

it.each([
  { kind: 'run' as const, run: { runId: 'foreign-run' } },
  { kind: 'provider-native' as const, providerId: 'codex', sessionId: 'foreign-native' }
])('unknown native/run inspection keeps its existing local lookup without remote fallback: %j', async target => {
  const f = await fixture()
  await expect(f.rpc.call('agent.inspect', { target })).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
  expect(f.forwardedCalls).not.toHaveBeenCalled(); noWrites(f)
})

it.each([
  { agentSessionId: 'remote-target', afterByte: -1 },
  { agentSessionId: 'remote-target', follow: 'yes' },
  { agentSessionId: 'remote-target', extra: true }
])('rejects malformed output parameters before any stream delegation: %j', async params => {
  const f = await fixture()
  await expect(f.rpc.subscribe('agent.output', params as never, { onInitial: vi.fn(), onEvent: vi.fn() }))
    .rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  expect(f.forwardedStreams).not.toHaveBeenCalled(); noWrites(f)
})

it('remote follow sends its opening response before bytes and cancellation closes only the target reader once', async () => {
  const f = await fixture(), frames: unknown[] = [], events: AgentMuxRpcStreamEvent<'agent.output'>[] = []
  const abort = new AbortController()
  const reading = f.rpc.subscribe('agent.output', { agentSessionId: 'remote-target', afterByte: 1, follow: true }, {
    signal: abort.signal, onInitial: vi.fn(), onFrame: frame => { frames.push(frame) }, onEvent: event => { events.push(event) }
  })
  await expect(reading).resolves.toMatchObject({ subscriptionId: expect.any(String) })
  const sub = await reading
  await vi.waitFor(() => expect(events.filter(event => event.type === 'output')).toHaveLength(1))
  expect(frames[0]).toMatchObject({ result: { initial: { session: { agentSessionId: 'remote-target' } } } })
  for (const push of f.target.observers) push({ type: 'data', runId: 'run-remote-target', data: '中',
    dataBytes: Uint8Array.from([0xb8, 0xad]), startByte: 1, endByte: 3 })
  await vi.waitFor(() => expect(events.filter(event => event.type === 'output')).toHaveLength(2))
  expect(events.filter(event => event.type === 'output').flatMap(event =>
    [...Buffer.from(event.data.dataBase64, 'base64')])).toEqual([0xb8, 0xad])
  abort.abort(); await sub.dispose(); await sub.dispose()
  await vi.waitFor(() => expect(f.target.closes).toHaveBeenCalledOnce())
  expect(f.target.observers.size).toBe(0); expect(f.local.closes).not.toHaveBeenCalled()
  expect(f.targetBusiness).not.toHaveBeenCalled(); noWrites(f)
})
