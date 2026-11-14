import { afterEach, expect, test, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxCreationAuthority, agentCreationIntentDigest } from '../src/agent-creation-authority.js'
import { executionRouteScope } from '../src/host-route-execution.js'
import { HostRouteGateway, delegatedHostRouteActor } from '../src/host-route-gateway.js'
import { hostRouteTransport, routedAgentMuxRpc, executionRouteRpc } from '../src/host-route-rpc.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc, type AgentMuxRpcClient } from '../src/public-rpc-client.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import type { AdoptedHostRoute, HostRouteIdentity, HostRouteGrant, HostRouteExecutionAuthorization } from '../src/host-route.js'
import type { AgentMuxRpcServiceOptions, AgentMuxRpcCallContext } from '../src/public-rpc-service.js'

type BorrowedRuntime = Awaited<ReturnType<NonNullable<AgentMuxRpcServiceOptions['hostedRuntime']>>>
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const principal = { kind: 'user' as const, id: `local-user:${process.getuid?.() ?? 'current'}` }
async function fixture(realHosted = false) {
  const intercept = new Map<string, (method: string, params: unknown, context: AgentMuxRpcCallContext) => Promise<unknown>>()
  const directory = await mkdtemp(join(tmpdir(), 'amux-route-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const producers = new Map<string, { emit(event: unknown): void | Promise<void>; disposed: number }>()
  let identityUnavailable = false
  const traffic: { node: string; edge: string; kind: string }[] = []
  const peers = new Map<string, AgentMuxRpcClient>(), arrivals: { immediate: string | undefined; actor: unknown; consumer: unknown }[] = []
  const nodes = new Map<string, { authority: AgentMuxCreationAuthority; gateway: HostRouteGateway; rpc: AgentMuxRpcClient; identity: HostRouteIdentity }>()
  for (const name of ['B', 'C', 'D', 'E']) {
    const authority = new AgentMuxCreationAuthority({ stateDirectory: join(directory, name), runtimeId: `runtime-${name}` })
    const identity = await authority.identity()
    let server: AgentMuxControlServer
    const gateway = new HostRouteGateway({ stateDirectory: join(directory, name), authority,
      edge: id => { const peer = peers.get(id); if (!peer) throw Error(`Unconfigured edge ${id}`); const transport = hostRouteTransport(peer); return { identity: signal => { traffic.push({ node: name, edge: id, kind: 'identity' }); if (identityUnavailable) throw Error('Independent edge metadata is unavailable'); return transport.identity(signal) }, call: (...args) => { traffic.push({ node: name, edge: id, kind: 'call' }); return transport.call(...args) }, watch: (...args) => { traffic.push({ node: name, edge: id, kind: 'watch' }); return transport.watch(...args) } } },
      call: async (method, params, context) => {
        arrivals.push({ immediate: context.principal?.id, actor: delegatedHostRouteActor(context), consumer: null })
        if (intercept.has(name)) return await intercept.get(name)!(method, params, context) as never
        return await server.callRpc(method, params, context)
      },
      subscribe: (method, params, emit, context) => server.subscribeRpc(method, params, emit, context),
    })
    const borrowed = { call: vi.fn(async (_method: string, params: Record<string, unknown>) => {
      arrivals.at(-1)!.consumer = params.consumerId
      return { value: null }
    }), subscribe: vi.fn(async (_method: string, _params: unknown, emit: (event: unknown) => void | Promise<void>) => {
      const producer = { emit, disposed: 0 }; producers.set(name, producer)
      return { initial: { fixture: 'original-producer' }, start: () => emit({ type: 'snapshot', data: { sample: 1 } }), dispose: () => { producer.disposed++ } }
    }), assertFence: vi.fn() } satisfies Record<string, unknown>
    let runtime: BorrowedRuntime = borrowed as unknown as BorrowedRuntime
    if (realHosted) {
      const core = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore(), providers: [] })
      vi.spyOn(core, 'connectRuntime').mockResolvedValue()
      const service = new AgentMuxHostedRuntimeService(core, null, () => ({ runtimeId: identity.runtimeId, ownerInstanceId: 'fixture-instance', protocolVersion: 2,
        processId: process.pid, availability: 'connected', ctxmux: null }))
      cleanups.push(async () => { await service.dispose(); await core.dispose() })
      runtime = service
    }
    server = new AgentMuxControlServer({ hostRoutes: gateway, hostedRuntime: () => runtime }, join(directory, name + '.sock'))
    await server.start()
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(directory, name + '.sock') } })
    cleanups.push(async () => { gateway.dispose(); await rpc.dispose(); await server.stop() })
    peers.set(name, rpc); nodes.set(name, { authority, gateway, rpc, identity })
  }
  const b = nodes.get('B')!, c = nodes.get('C')!, d = nodes.get('D')!, e = nodes.get('E')!
  const route: AdoptedHostRoute = { source: b.identity, hops: [{ edgeId: 'C', target: c.identity }, { edgeId: 'D', target: d.identity }] }
  const sourceActor = { source: b.identity, ...principal }
  const grant = (id: string, delegator: HostRouteIdentity, actor = sourceActor): HostRouteGrant => ({ id, delegator, actor, destination: d.identity, scopes: ['runtime.invoke/readAgentSession'] })
  const configure = async (node: typeof b, routes: { id: string; route: AdoptedHostRoute }[], grants: HostRouteGrant[]) => {
    const original = await node.rpc.call('route.inspect', {})
    return await node.rpc.call('route.configure', { expectedRevision: original.revision, operationId: `save-${Math.random()}`, configuration: { routes, grants } })
  }
  await configure(b, [{ id: 'D', route }], [])
  await configure(c, [], [grant('from-B', b.identity)])
  await configure(d, [], [grant('via-C', c.identity)])
  const call = { method: 'runtime.invoke', params: { consumerId: 'same-consumer', fence: { runtimeId: d.identity.runtimeId, ownerInstanceId: 'fixture-instance' }, invocation: { method: 'readAgentSession', args: ['original-SID'] } } }
  return { b, c, d, e, route, call, grant, configure, arrivals, producers, intercept, peers, traffic, failIdentity: () => { identityUnavailable = true } }
}

test('actual public RPC traverses only configured edges and original receiver grants into the Hosted dispatcher', async () => {
  const f = await fixture(), sdk = routedAgentMuxRpc(f.b.rpc, 'D', f.route)
  const packet = await sdk.call('runtime.invoke', f.call.params).catch(error => ({ error: { code: error.code, message: error.message } }))
  expect(packet).toEqual({ value: null })
  expect(f.arrivals).toHaveLength(1)
  expect(f.arrivals[0]!.immediate).toBe(principal.id)
  expect(f.arrivals[0]!.actor).toEqual({ source: f.b.identity, ...principal })
  expect(f.arrivals[0]!.consumer).not.toBe('same-consumer')
})

test('same immediate Unix user and consumer stay isolated by original Runtime/key actor', async () => {
  const f = await fixture(), route = { ...f.route, source: f.e.identity }
  await f.configure(f.e, [{ id: 'D', route }], [])
  await f.configure(f.c, [], [f.grant('from-B', f.b.identity), f.grant('from-E', f.e.identity, { source: f.e.identity, ...principal })])
  await f.configure(f.d, [], [f.grant('via-C-B', f.c.identity), f.grant('via-C-E', f.c.identity, { source: f.e.identity, ...principal })])
  await routedAgentMuxRpc(f.b.rpc, 'D', f.route).call('runtime.invoke', f.call.params)
  await routedAgentMuxRpc(f.e.rpc, 'D', route).call('runtime.invoke', f.call.params)
  expect(new Set(f.arrivals.map(item => item.consumer)).size).toBe(2)
})

test('an existing configured connection never substitutes missing receiver delegation', async () => {
  const f = await fixture(); await f.configure(f.c, [], [])
  const error = await routedAgentMuxRpc(f.b.rpc, 'D', f.route).call('runtime.invoke', f.call.params).then(() => null, error => ({ code: error.code }))
  expect(error).toEqual({ code: 'HOST_ROUTE_NOT_DELEGATED' })
  expect(f.arrivals).toHaveLength(0)
})

test('Hosted administration is rejected by its inner invocation before any downstream dispatch', async () => {
  const f = await fixture()
  await expect(routedAgentMuxRpc(f.b.rpc, 'D', f.route).call('runtime.invoke', { ...f.call.params, invocation: { method: 'trustCreationSource', args: [] } })).rejects.toMatchObject({ code: 'HOST_ROUTE_INVALID' })
  expect(f.arrivals).toHaveLength(0)
})

test('a changed configured route cannot silently replace the adopted chain, even to the same D', async () => {
  const f = await fixture(), changed = { ...f.route, hops: [{ edgeId: 'other-C', target: f.c.identity }, f.route.hops[1]!] }
  await f.configure(f.b, [{ id: 'D', route: changed }], [])
  await expect(routedAgentMuxRpc(f.b.rpc, 'D', f.route).call('runtime.invoke', f.call.params)).rejects.toMatchObject({ code: 'HOST_ROUTE_CHANGED' })
  expect(f.arrivals).toHaveLength(0)
})

test('business JSON and managed context cannot construct verified route authority', async () => {
  const f = await fixture()
  const context: AgentMuxRpcCallContext = { principal, caller: { agentSessionId: 'managed', capability: 'retained' } }
  await expect(f.b.gateway.call({ routeId: 'D', adoptedRoute: f.route, requestId: 'original', call: f.call }, context)).rejects.toMatchObject({ code: 'HOST_ROUTE_ACTOR_REQUIRED' })
  await expect(f.b.rpc.call('route.call', { routeId: 'D', adoptedRoute: f.route, requestId: 'original', call: { ...f.call, params: { ...f.call.params, principal } } })).rejects.toMatchObject({ code: 'HOST_ROUTE_INVALID' })
  expect(f.arrivals).toHaveLength(0)
})


test('the signed original call digest cannot be reused for another Session payload', async () => {
  const f = await fixture()
  const envelope = await f.b.authority.endorseHostRoute(await f.b.authority.attestHostRoute({ schema: 'agentmux.host-route.v1', purpose: 'host-route',
    route: f.route, actor: { source: f.b.identity, ...principal }, requestId: 'original-request', method: f.call.method, paramsDigest: agentCreationIntentDigest(f.call.params) }))
  const altered = { ...f.call, params: { ...f.call.params, invocation: { method: 'readAgentSession', args: ['another-SID'] } } }
  const error = await f.c.rpc.call('route.receive', { envelope, call: altered }).then(() => null, error => ({ code: error.code }))
  expect(error).toEqual({ code: 'HOST_ROUTE_TARGET_MISMATCH' })
  expect(f.arrivals).toHaveLength(0)
})

test('actual routed stream keeps unrelated policy edits and revokes only its original downstream reader', async () => {
  const f = await fixture(), cGrant = f.grant('from-B', f.b.identity), dGrant = f.grant('via-C', f.c.identity)
  cGrant.scopes.push('runtime.events'); dGrant.scopes.push('runtime.events')
  await f.configure(f.c, [], [cGrant]); await f.configure(f.d, [], [dGrant])
  const events: { type?: string; error?: { code: string }; event?: unknown }[] = []
  const reader = await f.b.rpc.subscribe('route.watch', { routeId: 'D', adoptedRoute: f.route, requestId: 'original-watch',
    call: { method: 'runtime.events', params: { consumerId: 'reader', fence: f.call.params.fence } } }, { onInitial: () => {}, onEvent: event => events.push(event) })
  await vi.waitFor(() => expect(events).toHaveLength(1))
  const producer = f.producers.get('D')!
  await f.configure(f.c, [], [cGrant, f.grant('unrelated-E', f.e.identity, { source: f.e.identity, ...principal })])
  await producer.emit({ type: 'snapshot', data: { sample: 2 } })
  await vi.waitFor(() => expect(events).toHaveLength(2))
  expect(producer.disposed).toBe(0)
  cGrant.scopes.push('runtime.invoke/runtimeSubject')
  await f.configure(f.c, [], [cGrant])
  await producer.emit({ type: 'snapshot', data: { sample: 3 } })
  await vi.waitFor(() => expect(events).toHaveLength(3))
  expect(producer.disposed).toBe(0)
  await f.configure(f.c, [], [])
  await vi.waitFor(() => expect(events.some(event => event.type === 'error' && event.error?.code === 'HOST_ROUTE_NOT_DELEGATED')).toBe(true))
  await vi.waitFor(() => expect(producer.disposed).toBeGreaterThan(0))
  await reader.dispose()
})


test('A original parent admits one B child, keeps A actor through C/D and refuses changed target/SID or renewed actor', async () => {
  const f = await fixture(), a = f.e, actor = { source: a.identity, ...principal }
  const parentRoute: AdoptedHostRoute = { source: a.identity, hops: [{ edgeId: 'B', target: f.b.identity }] }
  const input = { bindingId: 'original-binding', agentHostId: 'D-over-C', agentRuntimeId: f.d.identity.runtimeId, agentRoute: f.route,
    resourceHostId: 'local', resourceRuntimeId: f.b.identity.runtimeId, resourceWorkspacePath: '/B/original', resourceGrant: { scope: 'host-user' as const, bindingId: 'original-binding' },
    agent: { agentSessionId: 'original-SID', createOperationId: 'original-CID', executorId: 'selected', executorRevision: 'revision', workspacePath: '/D/original' } }
  let frozen: HostRouteExecutionAuthorization | undefined, received: AgentMuxRpcCallContext | undefined
  await f.configure(a, [{ id: 'B', route: parentRoute }], [])
  await f.configure(f.b, [{ id: 'D', route: f.route }], [{ id: 'from-A', delegator: a.identity, actor, destination: f.b.identity, scopes: ['agent.execution.create'] }])
  await f.configure(f.c, [], [{ ...f.grant('from-B', f.b.identity, actor) }])
  await f.configure(f.d, [], [{ ...f.grant('via-C', f.c.identity, actor) }])
  f.intercept.set('B', async (_method, _params, context) => {
    received = context
    frozen = await f.b.gateway.authorizeExecution(input, context)
    return { admitted: true }
  })
  await routedAgentMuxRpc(a.rpc, 'B', parentRoute).call('agent.execution.create', input)
  expect(frozen!.actor).toEqual(actor)
  expect(frozen!.coordinator).toEqual(f.b.identity)
  expect(frozen!.parent!.statement.paramsDigest).toBe(agentCreationIntentDigest(input))
  // The original public request ended. Frozen B authorization is not a live
  // request lease, transport nonce, or a newly invented local-user principal.
  const restored = JSON.parse(JSON.stringify(frozen)) as HostRouteExecutionAuthorization
  await executionRouteRpc(f.b.gateway, f.route, restored).call('runtime.invoke', f.call.params)
  expect(f.arrivals.at(-1)!.actor).toEqual(actor)
  expect(f.arrivals.at(-1)!.immediate).toBe(principal.id)
  await expect(executionRouteRpc(f.b.gateway, f.route, restored).call('runtime.invoke', {
    ...f.call.params, invocation: { method: 'readAgentSession', args: ['wrong-SID'] }
  })).rejects.toMatchObject({ code: 'HOST_ROUTE_DERIVATION_MISMATCH' })
  await expect(f.b.gateway.authorizeExecution({ ...input, agent: { ...input.agent, agentSessionId: 'wrong-SID' } }, received!)).rejects.toMatchObject({ code: 'HOST_ROUTE_READER_CLOSED' })
  const changed = { ...restored, actor: { ...restored.actor, source: f.b.identity } }
  await expect(executionRouteRpc(f.b.gateway, f.route, changed).call('runtime.invoke', f.call.params)).rejects.toMatchObject({ code: 'HOST_ROUTE_SIGNATURE_INVALID' })
})


test('the actual Hosted helper target DTO is scoped to its original Run and unrelated Runs cannot attach', async () => {
  const f = await fixture()
  const input = { bindingId: 'binding', agentHostId: 'D', agentRuntimeId: f.d.identity.runtimeId, agentRoute: f.route,
    resourceHostId: 'local', resourceRuntimeId: f.b.identity.runtimeId, resourceWorkspacePath: '/B/project', resourceGrant: { scope: 'host-user' as const, bindingId: 'binding' },
    agent: { agentSessionId: 'SID', createOperationId: 'CID', executorId: 'selected', executorRevision: 'revision', workspacePath: '/D/agent' } }
  const authorization = await f.b.gateway.authorizeExecution(input, { principal })
  const cGrant = f.grant('B', f.b.identity), dGrant = f.grant('C', f.c.identity)
  cGrant.scopes.push('runtime.attachment-watch'); dGrant.scopes.push('runtime.attachment-watch')
  await f.configure(f.c, [], [cGrant]); await f.configure(f.d, [], [dGrant])
  const client = executionRouteRpc(f.b.gateway, f.route, authorization, () => ({ role: 'frontend', runId: 'original-helper', ownerInstanceId: 'original-Native' }))
  let initial = false
  const params = { consumerId: 'original-reader', fence: f.call.params.fence, target: { kind: 'terminal-run' as const, runId: 'original-helper' }, afterByte: 0, view: 'raw' as const }
  const reader = await client.subscribe('runtime.attachment-watch', params, { onInitial: () => { initial = true }, onEvent: () => {} })
  expect(initial).toBe(true)
  await expect(client.subscribe('runtime.attachment-watch', { ...params, target: { ...params.target, runId: 'unrelated-run' } }, { onInitial: () => {}, onEvent: () => {} })).rejects.toMatchObject({ code: 'HOST_ROUTE_DERIVATION_MISMATCH' })
  await reader.dispose()
})

test('a different bounded scope cannot release another same-actor Hosted consumer while its own release still works', async () => {
  const f = await fixture(true)
  const source = { kind: 'space-reader' as const, runtimeId: f.b.identity.runtimeId, spaceId: 'original-space' }
  const original = await f.b.gateway.authorizeObservation({ kind: 'observation', targetRuntimeId: f.d.identity.runtimeId, agentSessionIds: ['original-SID'], source }, { principal })
  const other = await f.b.gateway.authorizeObservation({ kind: 'observation', targetRuntimeId: f.d.identity.runtimeId, agentSessionIds: ['unrelated-SID'], source }, { principal })
  const cGrant = f.grant('B', f.b.identity), dGrant = f.grant('C', f.c.identity)
  cGrant.scopes.push('runtime.events', 'runtime.release-consumer'); dGrant.scopes.push('runtime.events', 'runtime.release-consumer')
  await f.configure(f.c, [], [cGrant]); await f.configure(f.d, [], [dGrant])
  const own = executionRouteRpc(f.b.gateway, f.route, original), foreign = executionRouteRpc(f.b.gateway, f.route, other)
  const params = { consumerId: 'known-original-consumer', fence: f.call.params.fence, sessions: 'summary' as const, agentSessionIds: ['original-SID'] }
  let ended = false
  const reader = await own.subscribe('runtime.events', params, { onInitial: () => {}, onEvent: () => {}, onEnd: () => { ended = true } })
  try {
    const unrelated = await foreign.call('runtime.release-consumer', { consumerId: params.consumerId, fence: params.fence })
    expect(unrelated.released, 'another scope must not release the known same-actor consumer').toBe(false)
    expect(ended).toBe(false)
    const released = await own.call('runtime.release-consumer', { consumerId: params.consumerId, fence: params.fence })
    expect(released.released, 'positive guard: the original scope still owns its consumer').toBe(true)
  } finally { await reader.dispose() }
})

test('an exact current viewer member parent preserves A and refuses another payload, member or human approval', async () => {
  const f = await fixture(), a = f.e, actor = { source: a.identity, ...principal }
  const parentRoute = { source: a.identity, hops: [{ edgeId: 'B', target: f.b.identity }] }
  const target = { reference: { runtimeId: f.b.identity.runtimeId, spaceId: 'original-space' }, regionId: 'original-region', runtimeId: f.d.identity.runtimeId,
    agentSessionId: 'original-SID', expectedRun: { runId: 'original-agent-run' }, expectedAdmission: { kind: 'creation' as const, operationId: 'original-member-CID' } }
  const input = { target, call: { method: 'runtime.invoke' as const, params: { consumerId: 'original-viewer', fence: f.call.params.fence,
    invocation: { method: 'writeAgent' as const, args: [{ agentSessionId: target.agentSessionId, expectedRun: target.expectedRun, source: 'user' as const, data: 'original-bytes' }] } } } } satisfies import('../src/space-member.js').SpaceMemberParams['space.member.call']
  await f.configure(a, [{ id: 'B', route: parentRoute }], [])
  await f.configure(f.b, [{ id: 'D', route: f.route }], [{ id: 'A-member', delegator: a.identity, actor, destination: f.b.identity, scopes: ['space.member.call'] }])
  const cGrant = f.grant('B-member', f.b.identity, actor), dGrant = f.grant('C-member', f.c.identity, actor)
  cGrant.scopes.push('runtime.invoke/writeAgent'); dGrant.scopes.push('runtime.invoke/writeAgent')
  await f.configure(f.c, [], [cGrant]); await f.configure(f.d, [], [dGrant])
  let change = false, wrongMember = false, wrongParent = false, wrongAdmission = false
  f.intercept.set('B', async (_method, params, context) => {
    const request = structuredClone(params) as typeof input
    if (wrongAdmission) request.target.expectedAdmission.operationId = 'another-C-same-SID-Run'
    if (wrongParent) request.call.params.invocation.args[0]!.data = 'not-the-original-A-input'
    const authorization = await f.b.gateway.authorizeMemberControl({ ...request, createOperationId: 'original-member-CID' }, context)
    const forwarded = structuredClone(request.call.params)
    if (change) forwarded.invocation.args[0]!.data = 'other-bytes'
    if (wrongMember) forwarded.invocation.args[0]!.agentSessionId = 'unrelated-SID'
    return await executionRouteRpc(f.b.gateway, f.route, authorization, undefined, context).call('runtime.invoke', forwarded)
  })
  const sdk = routedAgentMuxRpc(a.rpc, 'B', parentRoute)
  expect(await sdk.call('space.member.call', input)).toEqual({ value: null })
  expect(f.arrivals.at(-1)?.actor).toEqual(actor)
  const delivered = f.arrivals.filter(value => value.consumer !== null).length
  change = true
  const changed = await sdk.call('space.member.call', input).then(() => ({ code: 'INCORRECTLY_DELIVERED' }), error => ({ code: error.code }))
  expect(changed).toEqual({ code: 'HOST_ROUTE_DERIVATION_MISMATCH' })
  change = false; wrongMember = true
  await expect(sdk.call('space.member.call', input)).rejects.toMatchObject({ code: 'SPACE_MEMBER_TARGET_MISMATCH' })
  expect(f.arrivals.filter(value => value.consumer !== null)).toHaveLength(delivered)
  wrongMember = false; wrongParent = true
  const invented = await sdk.call('space.member.call', input).then(() => ({ code: 'INCORRECTLY_DELIVERED' }), error => ({ code: error.code }))
  expect(invented).toEqual({ code: 'HOST_ROUTE_DERIVATION_MISMATCH' })
  wrongParent = false; wrongAdmission = true
  const otherCreation = await sdk.call('space.member.call', input).then(() => ({ code: 'INCORRECTLY_DELIVERED' }), error => ({ code: error.code }))
  expect(otherCreation).toEqual({ code: 'HOST_ROUTE_DERIVATION_MISMATCH' });expect(f.arrivals.filter(value => value.consumer !== null)).toHaveLength(delivered)
  wrongAdmission = false
  const human = structuredClone(input) as unknown as { target: typeof target; call: { method: string; params: Record<string, unknown> } }
  human.call.params.invocation = { method: 'respondAgentInteraction', args: [{ agentSessionId: target.agentSessionId, expectedRun: target.expectedRun, operationId: 'original-permission', decision: 'allow' }] }
  await expect(sdk.call('space.member.call', human as never)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(f.arrivals.filter(value => value.consumer !== null)).toHaveLength(delivered)
})

test('one exact member keeps its original Hosted namespace across actions and another Run cannot release it', async () => {
  const f = await fixture(true), target = { reference: { runtimeId: f.b.identity.runtimeId, spaceId: 'original-space' }, regionId: 'original-region',
    runtimeId: f.d.identity.runtimeId, agentSessionId: 'original-SID', expectedRun: { runId: 'original-run' } }
  const cGrant = f.grant('B', f.b.identity), dGrant = f.grant('C', f.c.identity)
  cGrant.scopes.push('runtime.events', 'runtime.release-consumer'); dGrant.scopes.push('runtime.events', 'runtime.release-consumer')
  await f.configure(f.c, [], [cGrant]); await f.configure(f.d, [], [dGrant])
  const params = { consumerId: 'original-member-reader', fence: f.call.params.fence, sessions: 'full' as const, agentSessionIds: [target.agentSessionId] }
  const initial = await f.b.gateway.authorizeMemberControl({ target, createOperationId: 'original-CID', call: { method: 'runtime.events', params } }, { principal })
  const reader = await executionRouteRpc(f.b.gateway, f.route, initial).subscribe('runtime.events', params, { onInitial: () => {}, onEvent: () => {} })
  const releaseParams = { consumerId: params.consumerId, fence: params.fence }
  try {
    const foreign = await f.b.gateway.authorizeMemberControl({ target: { ...target, expectedRun: { runId: 'another-run' } }, createOperationId: 'original-CID', call: { method: 'runtime.release-consumer', params: releaseParams } }, { principal })
    expect(await executionRouteRpc(f.b.gateway, f.route, foreign).call('runtime.release-consumer', releaseParams)).toEqual({ released: false })
    const original = await f.b.gateway.authorizeMemberControl({ target, createOperationId: 'original-CID', call: { method: 'runtime.release-consumer', params: releaseParams } }, { principal })
    expect(await executionRouteRpc(f.b.gateway, f.route, original).call('runtime.release-consumer', releaseParams)).toEqual({ released: true })
  } finally { await reader.dispose() }
})

test('the receiving Core cannot delegate native human approval through the member transport user', async () => {
  const f = await fixture(), grant = f.grant('not-a-human-proof', f.c.identity)
  grant.scopes.push('runtime.invoke/respondAgentInteraction')
  const result = await f.configure(f.d, [], [grant]).then(() => ({ code: 'INCORRECTLY_GRANTED' }), error => ({ code: error.code }))
  expect(result).toEqual({ code: 'HOST_ROUTE_INVALID' })
  expect(f.arrivals).toHaveLength(0)
})


test('the actual wrong receiver refuses its adopted identity before any business dispatch', async () => {
  const f = await fixture(true), route = { source: f.b.identity, hops: [{ edgeId: 'D', target: f.d.identity }] }
  await f.configure(f.b, [{ id: 'D', route }], [])
  await f.configure(f.e, [], [f.grant('B-on-wrong-endpoint', f.b.identity)])
  f.peers.set('D', f.e.rpc)
  const params = { ...f.call.params, fence: { ...f.call.params.fence, runtimeId: f.e.identity.runtimeId } }
  const result = await routedAgentMuxRpc(f.b.rpc, 'D', route).call('runtime.invoke', params).then(() => ({ code: 'INCORRECTLY_DISPATCHED' }), error => ({ code: error.code }))
  expect(result).toEqual({ code: 'HOST_ROUTE_TARGET_MISMATCH' })
  expect(f.traffic.filter(item => item.kind === 'identity')).toHaveLength(0)
  expect(f.traffic.filter(item => item.node === 'B' && item.kind === 'call')).toHaveLength(1)
  expect(f.arrivals).toHaveLength(0)
})

test('a healthy two-hop write uses one receive per hop when independent edge metadata is unavailable', async () => {
  const f = await fixture(), c = f.grant('B-write', f.b.identity), d = f.grant('C-write', f.c.identity)
  c.scopes.push('runtime.invoke/writeAgent'); d.scopes.push('runtime.invoke/writeAgent')
  await f.configure(f.c, [], [c]); await f.configure(f.d, [], [d]); f.failIdentity()
  const params = { ...f.call.params, invocation: { method: 'writeAgent' as const, args: [{ agentSessionId: 'original-SID', expectedRun: { runId: 'original-run' }, data: 'x', source: 'user' as const }] } }
  const result = await routedAgentMuxRpc(f.b.rpc, 'D', f.route).call('runtime.invoke', params).then(value => ({ value }), error => ({ error: error.code }))
  expect(result).toEqual({ value: { value: null } })
  expect(f.traffic.map(value => ({ node: value.node, kind: value.kind }))).toEqual([{ node: 'B', kind: 'call' }, { node: 'C', kind: 'call' }])
  expect(f.arrivals).toHaveLength(1)
})

test('a slow actual public route reader is bounded without truncating legitimate cumulative content', async () => {
  const f = await fixture(), route = { source: f.b.identity, hops: [{ edgeId: 'D', target: f.d.identity }] }
  const grant = f.grant('direct-B', f.b.identity); grant.scopes.push('runtime.events')
  await f.configure(f.d, [], [grant])
  const call = { method: 'runtime.events', params: { consumerId: 'bounded-reader', fence: f.call.params.fence } }
  const envelope = await f.b.authority.endorseHostRoute(await f.b.authority.attestHostRoute({ schema: 'agentmux.host-route.v1', purpose: 'host-route',
    route, actor: { source: f.b.identity, ...principal }, requestId: 'slow-original', method: call.method, paramsDigest: agentCreationIntentDigest(call.params) }))
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), failures: string[] = []
  const controller = new AbortController()
  const reader = await hostRouteTransport(f.d.rpc).watch({ envelope, call }, async event => {
    const value = event as { type: string; error?: { code: string } }
    if (value.type === 'error') failures.push(value.error!.code)
    else await held
  }, controller.signal)
  try {
    await reader.start?.()
    const block = 'x'.repeat(1024 * 1024)
    for (let index = 0; index < 67; index++) {
      try { await f.producers.get('D')!.emit({ type: 'snapshot', data: { index, block } }) }
      catch (error) { expect(error).toMatchObject({ code: 'HOST_ROUTE_READER_CLOSED' }); break }
    }
    await vi.waitFor(() => expect(failures).toContain('RUNTIME_READER_BUDGET_EXCEEDED'), { timeout: 5000 })
    await vi.waitFor(() => expect(f.producers.get('D')!.disposed).toBeGreaterThan(0))
  } finally { release(); await reader.dispose() }
}, 15000)

test('a routed A parent cannot borrow B direct SSH owner authority for an undelegated foreign target', async () => {
  const f = await fixture(), a = f.e, actor = { source: a.identity, ...principal }
  const parentRoute = { source: a.identity, hops: [{ edgeId: 'B', target: f.b.identity }] }
  const input = { bindingId: 'original-binding', agentHostId: 'saved-D', agentRuntimeId: f.d.identity.runtimeId,
    resourceHostId: 'local', resourceRuntimeId: f.b.identity.runtimeId, resourceWorkspacePath: '/B/project', resourceGrant: { scope: 'host-user' as const, bindingId: 'original-binding' },
    agent: { agentSessionId: 'SID', createOperationId: 'CID', executorId: 'selected', executorRevision: 'revision', workspacePath: '/D/agent' } }
  await f.configure(a, [{ id: 'B', route: parentRoute }], [])
  await f.configure(f.b, [], [{ id: 'A-create', delegator: a.identity, actor, destination: f.b.identity, scopes: ['agent.execution.create'] }])
  f.intercept.set('B', async (_method, _params, context) => {
    await f.b.gateway.retainExecution(input, context, undefined, false)
    return { admitted: true }
  })
  const error = await routedAgentMuxRpc(a.rpc, 'B', parentRoute).call('agent.execution.create', input).then(() => null, error => ({ code: error.code }))
  expect(error).toEqual({ code: 'HOST_ROUTE_AUTHORIZATION_REQUIRED' })
  expect(f.traffic.filter(item => item.node === 'B')).toHaveLength(0)
  // The same real B user's original direct owner path does not acquire a new route gate.
  expect(await f.b.gateway.retainExecution(input, { principal }, undefined, false)).toBeUndefined()
})


test('related route cost stays two pinned edges and zero unrelated dispatches with a thousand other receiver grants', async () => {
  const f = await fixture(), sdk = routedAgentMuxRpc(f.b.rpc, 'D', f.route)
  await sdk.call('runtime.invoke', f.call.params)
  const first = f.traffic.map(value => value.kind).sort()
  const extra = Array.from({ length: 1000 }, (_, index) => f.grant('unrelated-' + index, f.e.identity,
    { source: f.e.identity, kind: 'user', id: 'unrelated-' + index }))
  await f.configure(f.c, [], [f.grant('original-C', f.b.identity), ...extra])
  await f.configure(f.d, [], [f.grant('original-D', f.c.identity), ...extra])
  f.traffic.length = 0
  await sdk.call('runtime.invoke', f.call.params)
  expect(f.traffic.map(value => value.kind).sort()).toEqual(first)
  expect(first).toEqual(['call', 'call'])
  expect(f.arrivals).toHaveLength(2)
})

test('an actual spatial parent binds the complete caller launch contribution and actual target child without rewriting old scopes', async () => {
  const f = await fixture(), a = f.e, actor = {source:a.identity,...principal}
  const parentRoute: AdoptedHostRoute = {source:a.identity,hops:[{edgeId:'B',target:f.b.identity}]}
  const launch = {agentMuxNote:'  Caller note\n',launchOptions:{mode:'selected'},cols:117,rows:39}
  const input = {bindingId:'launch-binding',agentHostId:'D-over-C',agentRuntimeId:f.d.identity.runtimeId,agentRoute:f.route,
    resourceHostId:'local',resourceRuntimeId:f.b.identity.runtimeId,resourceWorkspacePath:'/B/project',resourceGrant:{scope:'host-user' as const,bindingId:'launch-binding'},
    agent:{agentSessionId:'launch-SID',createOperationId:'launch-CID',executorId:'selected',executorRevision:'revision',workspacePath:'/D/home',prompt:'  task\n',...launch,sourceAgentMuxNote:'Source-owned context'}}
  await f.configure(a,[{id:'B',route:parentRoute}],[])
  await f.configure(f.b,[{id:'D',route:f.route}],[{id:'A-open',delegator:a.identity,actor,destination:f.b.identity,scopes:['agent.open']}])
  for (const [node,delegator] of [[f.c,f.b.identity],[f.d,f.c.identity]] as const)
    await f.configure(node,[],[{...f.grant('exact-create',delegator,actor),scopes:['runtime.invoke/createHostAgentWithDelivery']}])
  let retained: HostRouteExecutionAuthorization | undefined
  f.intercept.set('B',async (_method,_params,context) => {
    retained = await f.b.gateway.authorizeExecution(input,context)
    await expect(f.b.gateway.authorizeExecution({...input,agent:{...input.agent,agentMuxNote:'changed'}},context)).rejects.toMatchObject({code:'HOST_ROUTE_DERIVATION_MISMATCH'})
    return {admitted:true}
  })
  const request = {operationId:'launch-CID',content:{kind:'new-agent' as const,executorId:'selected',agentTarget:{hostId:'D-over-C',runtimeId:f.d.identity.runtimeId,adoptedRoute:f.route},prompt:'  task\n',...launch},destination:{spaceId:'B-space',zoneId:'B-zone',newTab:true as const},focus:false}
  await routedAgentMuxRpc(a.rpc,'B',parentRoute).call('agent.open',request)
  expect(retained!.scope.kind).toBe('execution')
  expect(retained!.parent!.statement.operation).toMatchObject({kind:'spatial',launchDigest:agentCreationIntentDigest(launch)})
  const child = {...input.agent,toolExecution:{bindingId:input.bindingId,resourceHostId:input.resourceHostId,resourceRuntimeId:input.resourceRuntimeId,workspacePath:input.resourceWorkspacePath}}
  const sdk = executionRouteRpc(f.b.gateway,f.route,retained!)
  await sdk.call('runtime.invoke',{...f.call.params,invocation:{method:'createHostAgentWithDelivery',args:[child]}})
  await expect(sdk.call('runtime.invoke',{...f.call.params,invocation:{method:'createHostAgentWithDelivery',args:[{...child,sourceAgentMuxNote:'changed source'}]}})).rejects.toMatchObject({code:'HOST_ROUTE_DERIVATION_MISMATCH'})
  // A real old-shaped parent cannot authorize extra contributions on a new child.
  const {agentMuxNote:_note,launchOptions:_options,cols:_cols,rows:_rows,...oldContent}=request.content
  await expect(routedAgentMuxRpc(a.rpc,'B',parentRoute).call('agent.open',{...request,content:oldContent})).rejects.toMatchObject({code:'HOST_ROUTE_DERIVATION_MISMATCH'})
})


test('an original signed scope remains byte-identical during continuation and its full input digest cannot be widened', async () => {
  const f = await fixture()
  const input = {bindingId:'legacy-binding',agentHostId:'D',agentRuntimeId:f.d.identity.runtimeId,agentRoute:f.route,
    resourceHostId:'local',resourceRuntimeId:f.b.identity.runtimeId,resourceWorkspacePath:'/B/project',resourceGrant:{scope:'host-user' as const,bindingId:'legacy-binding'},
    agent:{agentSessionId:'legacy-SID',createOperationId:'legacy-CID',executorId:'selected',executorRevision:'revision',workspacePath:'/D/home',agentMuxNote:'Original historic note',launchOptions:{mode:'original'},cols:80}}
  const scope = executionRouteScope(input,false)
  const original = await f.b.authority.attestHostRouteExecution({schema:'agentmux.host-route-execution.v1',purpose:'host-route-execution',actor:{source:f.b.identity,...principal},scope})
  const bytes = JSON.stringify(original)
  expect(await f.b.gateway.retainExecution(input,{principal},original,true)).toEqual(original)
  expect(JSON.stringify(original)).toBe(bytes);expect(original.scope).not.toHaveProperty('launchDigest')
  await expect(f.b.gateway.retainExecution({...input,agent:{...input.agent,cols:81}},{principal},original,true)).rejects.toMatchObject({code:'HOST_ROUTE_DERIVATION_MISMATCH'})
})

test('Source contract metadata requires its own exact read grant and reports the actual remote assembly', async () => {
  const f = await fixture(true), sdk = routedAgentMuxRpc(f.b.rpc,'D',f.route)
  await expect(sdk.call('agent.open.describe',{expectedRuntimeId:f.d.identity.runtimeId})).rejects.toMatchObject({code:'HOST_ROUTE_NOT_DELEGATED'})
  for (const [node,delegator] of [[f.c,f.b.identity],[f.d,f.c.identity]] as const)
    await f.configure(node,[],[{...f.grant('source-metadata',delegator),scopes:['agent.open.describe']}])
  expect(await sdk.call('agent.open.describe',{expectedRuntimeId:f.d.identity.runtimeId})).toEqual({source:{runtimeId:f.d.identity.runtimeId,ownerInstanceId:'fixture-instance'},contracts:{ordinaryLaunch:null,externalAssociation:null}})
  expect(f.arrivals.at(-1)!.actor).toEqual({source:f.b.identity,...principal})
  await expect(sdk.call('agent.open.describe',{expectedRuntimeId:'another-Source'})).rejects.toMatchObject({code:'RUNTIME_OWNER_MISMATCH'})
})
