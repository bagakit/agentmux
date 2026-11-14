// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import * as core from '../../../packages/core/src/index'
import { AGENTMUX_RUNTIME_OWNER_PROTOCOL_VERSION } from '../../../packages/core/src/runtime-owner-protocol'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner'
import { RuntimeController } from '../src/main/runtime-controller'
import { registerHostRoutesIpc } from '../src/main/host-routes-ipc'
import { assertAppDocumentSender } from '../src/main/ipc-sender-trust'
import { createRendererHostRoutes } from '../src/renderer/src/lib/host-routes-client'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'
const captured = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => { captured.api = api } }, ipcRenderer: { invoke: captured.invoke, on: vi.fn(), removeListener: vi.fn() }, webFrame: { getZoomFactor: () => 1 } }))
import '../src/preload/index'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const dispose of cleanups.splice(0).reverse()) await dispose(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const failureCode = (request: Promise<unknown>) => request.then(() => null, error => ({ code: error.code }))
type Call = { method: string; params: unknown; context: core.AgentMuxRpcCallContext; fence?: core.AgentMuxRuntimeFence }
class Sender extends EventEmitter {
  id = 51
  mainFrame = { url: 'file:///private/review/index.html', detached: false, isDestroyed: () => false }
  isDestroyed() { return false }
}
async function fixture() {
  const directory = await mkdtemp('/tmp/route-bridge-'); cleanups.push(() => rm(directory, { recursive: true, force: true }))
  type Node = { rpc: core.AgentMuxRpcClient; identity: core.HostRouteIdentity; owner: core.AgentMuxRuntimeOwnerIdentity; calls: Call[];
    carrier: { forwardRpc<M extends core.AgentMuxRpcMethod>(method: M, params: core.AgentMuxRpcParams<M>, context?: core.AgentMuxRpcCallContext, fence?: core.AgentMuxRuntimeFence): Promise<core.AgentMuxRpcResult<M>> } }
  const nodes = new Map<string, Node>(), intercepts = new Map<string, (call: Call, result: unknown) => Promise<unknown>>()
  for (const name of ['D', 'C', 'B', 'A']) {
    const issuer = await rpcOwnerFixture(['original-' + name], core); cleanups.push(issuer.close)
    const authority = new core.AgentMuxCreationAuthority({ stateDirectory: join(directory, name), runtimeId: name + '-runtime' }), identity = await authority.identity()
    const owner = { runtimeId: identity.runtimeId, ownerInstanceId: name + '-instance', protocolVersion: AGENTMUX_RUNTIME_OWNER_PROTOCOL_VERSION, processId: process.pid, availability: 'connected' as const, ctxmux: null }
    const hosted = new core.AgentMuxHostedRuntimeService(issuer.client, null, () => owner); cleanups.push(() => hosted.dispose())
    let server: core.AgentMuxControlServer
    const gateway = new core.HostRouteGateway({ stateDirectory: join(directory, name), authority,
      edges: async () => name === 'C' ? [{ edgeId: 'D-in-C', label: 'Saved D', kind: 'ssh', runtimeId: nodes.get('D')!.identity.runtimeId }] : [],
      edge: id => core.hostRouteTransport(nodes.get(id === 'D-in-C' ? 'D' : id)!.rpc), call: (method, params, context) => server.callRpc(method, params, context), subscribe: (method, params, emit, context) => server.subscribeRpc(method, params, emit, context) })
    server = new core.AgentMuxControlServer({ hostRoutes: gateway, hostedRuntime: () => hosted }, join(directory, name + '.sock')); await server.start()
    const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    cleanups.push(async () => { await rpc.dispose(); gateway.dispose(); await server.stop() })
    const calls: Call[] = []
    const carrier = { async forwardRpc<M extends core.AgentMuxRpcMethod>(method: M, params: core.AgentMuxRpcParams<M>, context: core.AgentMuxRpcCallContext = {}, fence?: core.AgentMuxRuntimeFence): Promise<core.AgentMuxRpcResult<M>> {
      const call = { method, params, context, ...(fence ? { fence } : {}) }; calls.push(call)
      const result = await rpc.call(method, params, { ...(context.signal ? { signal: context.signal } : {}), ...(fence ? { runtimeFence: fence } : {}) })
      return (intercepts.has(name) ? await intercepts.get(name)!(call, result) : result) as core.AgentMuxRpcResult<M>
    } }
    nodes.set(name, { rpc, identity, owner, carrier, calls })
  }
  const a = nodes.get('A')!, b = nodes.get('B')!, c = nodes.get('C')!, d = nodes.get('D')!, routes = new Map([['source', { client: a.carrier }], ['policy-C', { client: c.carrier }]])
  const runtime = Object.assign(Object.create(RuntimeController.prototype), { hosts: routes, hostReconfigurationReservations: new Map() }) as RuntimeController
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
  const handlers = new Map<string, Handler>(), sender = new Sender(), event = { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent
  const registration = registerHostRoutesIpc({ handle: (channel, listener) => handlers.set(channel, ((e: IpcMainInvokeEvent, ...args: unknown[]) => {
    assertAppDocumentSender(e, sender, { current: { mode: 'prod', filePath: '/private/review/index.html' }, loading: null })
    return (listener as Handler)(e, ...args)
  })), call: runtime.callHostRoute.bind(runtime) })
  cleanups.push(async () => registration.dispose())
  const invoke = async (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args)
  captured.invoke.mockImplementation(invoke)
  const bridge = createRendererHostRoutes(captured.api!.hostRoutes)
  const configure = async (node: Node, configuration: core.HostRouteConfiguration) => {
    const before = await node.rpc.call('route.inspect', {})
    return await node.rpc.call('route.configure', { expectedRevision: before.revision, operationId: 'fixture-save-' + Math.random(), configuration })
  }
  const actor = { source: a.identity, kind: 'user' as const, id: `local-user:${process.getuid?.() ?? 'current'}` }
  const adoptedRoute = { source: a.identity, hops: [{ edgeId: 'B', target: b.identity }, { edgeId: 'C', target: c.identity }] }
  const target = { hostId: 'source', expectedRuntimeId: c.identity.runtimeId, via: { routeId: 'saved-C', adoptedRoute } }
  await configure(a, { routes: [{ id: 'saved-C', route: adoptedRoute }], grants: [] })
  const grant = (delegator: core.HostRouteIdentity): core.HostRouteGrant => ({ id: 'exact-discovery', delegator, actor, destination: c.identity, scopes: ['route.edges', 'route.edge.inspect'] })
  return { directory, a, b, c, d, nodes, runtime, routes, bridge, event, handlers, sender, target, actor, configure, grant, intercepts }
}

test('real configured Main, trusted IPC, original preload and Renderer adapter read and save only the exact policy Core', async () => {
  const f = await fixture(), target = { hostId: 'policy-C', expectedRuntimeId: f.c.identity.runtimeId }
  const firstIdentity = await f.bridge.call({ hostId: 'policy-C' }, 'route.identity', {}).then(value => ({ value }), error => ({ code: error.code }))
  expect(firstIdentity).toEqual({ value: f.c.identity })
  const before = await f.bridge.call(target, 'route.inspect', {})
  const input = { expectedRevision: before.revision, operationId: 'original-save', configuration: { routes: [], grants: [] } }
  const saved = await f.bridge.call(target, 'route.configure', input)
  expect(saved.diskDurability).toBe('confirmed'); expect(saved.settings.operation?.operationId).toBe('original-save')
  expect(f.c.calls.at(-1)).toMatchObject({ method: 'route.configure', params: input, fence: { runtimeId: f.c.owner.runtimeId, ownerInstanceId: f.c.owner.ownerInstanceId } })
  expect(f.a.calls).toEqual([])
  expect(f.c.calls.every(call => call.context.caller === undefined && call.context.principal === undefined)).toBe(true)
  expect(await failureCode(f.bridge.call({ ...target, expectedRuntimeId: f.a.identity.runtimeId }, 'route.inspect', {}))).toEqual({ code: 'RUNTIME_OWNER_MISMATCH' })
})

test('a saved prefix discovers its exact owner and original actor only after each receiving Core grants the finite read', async () => {
  const f = await fixture()
  expect(await failureCode(f.bridge.call(f.target, 'route.edges', {}))).toEqual({ code: 'HOST_ROUTE_NOT_DELEGATED' })
  await f.configure(f.b, { routes: [], grants: [f.grant(f.a.identity)] })
  expect(await failureCode(f.bridge.call(f.target, 'route.edges', {}))).toEqual({ code: 'HOST_ROUTE_NOT_DELEGATED' })
  await f.configure(f.c, { routes: [], grants: [f.grant(f.b.identity)] })
  const edges = await f.bridge.call(f.target, 'route.edges', {})
  expect(edges).toMatchObject({ identity: f.c.identity, actor: f.actor, edges: [{ edgeId: 'D-in-C', label: 'Saved D', kind: 'ssh', runtimeId: f.d.identity.runtimeId }] })
  const inspected = await f.bridge.call(f.target, 'route.edge.inspect', { edgeId: 'D-in-C' })
  expect(inspected.identity).toEqual(f.c.identity); expect(inspected.actor).toEqual(f.actor); expect(inspected.target).toEqual(f.d.identity)
  expect(f.a.calls.filter(call => call.method === 'route.call')).toHaveLength(4)
  expect(f.c.calls).toEqual([])
})

test('the finite bridge refuses arbitrary RPC, delegated policy access and incomplete or mismatched targets before sending', async () => {
  const f = await fixture(), target = { hostId: 'policy-C', expectedRuntimeId: f.c.identity.runtimeId }
  for (const [original, method, input] of [
    [target, 'route.call', {}], [f.target, 'route.configure', {}], [f.target, 'route.inspect', {}], [f.target, 'route.identity', {}],
    [{ hostId: 'policy-C' }, 'route.configure', {}], [{ ...f.target, expectedRuntimeId: f.a.identity.runtimeId }, 'route.edges', {}],
    [{ ...target, principal: { kind: 'user', id: 'invented' } }, 'route.inspect', {}], [target, 'route.edge.inspect', { edgeId: 'D', endpoint: 'arbitrary' }],
  ] as const) {
    const reply = await f.handlers.get('hostRoutes:call')!(f.event, 'invalid-call', original, method, input) as { ok: boolean }
    expect(reply.ok).toBe(false)
  }
  expect([...f.nodes.values()].every(node => node.calls.length === 0)).toBe(true)
  expect(() => f.handlers.get('hostRoutes:call')!({ ...f.event, senderFrame: { ...f.sender.mainFrame } } as unknown as IpcMainInvokeEvent, 'foreign-frame', target, 'route.inspect', {})).toThrow('Untrusted application')
})

test('a late reply cannot adopt a replaced configured transport even when its Runtime and Host label are unchanged', async () => {
  const f = await fixture(), target = { hostId: 'policy-C', expectedRuntimeId: f.c.identity.runtimeId }
  let release!: () => void, observed = false
  const pending = new Promise<void>(resolve => { release = resolve })
  f.intercepts.set('C', async (call, result) => { if (call.method === 'route.inspect') { observed = true; await pending } return result })
  const read = failureCode(f.bridge.call(target, 'route.inspect', {}))
  await vi.waitFor(() => expect(observed).toBe(true))
  f.routes.set('policy-C', { client: { ...f.c.carrier } }); release()
  expect(await read).toEqual({ code: 'RUNTIME_OWNER_MISMATCH' })
})

test('an applied save with an unknown public ACK preserves its original typed failure and never resends', async () => {
  const f = await fixture(), target = { hostId: 'policy-C', expectedRuntimeId: f.c.identity.runtimeId }, before = await f.bridge.call(target, 'route.inspect', {})
  f.intercepts.set('C', async (call, value) => { if (call.method === 'route.configure') throw Object.assign(new Error('Original save ACK lost'), { code: 'ORIGINAL_SAVE_ACK_UNKNOWN', controlFailure: { disposition: 'unknown', confirmedInputBytes: null } }); return value })
  const error = await f.bridge.call(target, 'route.configure', { expectedRevision: before.revision, operationId: 'retain-original-OP', configuration: { routes: [], grants: [] } }).then(() => null, error => error)
  expect(error).toMatchObject({ code: 'ORIGINAL_SAVE_ACK_UNKNOWN', controlFailure: { disposition: 'unknown' } })
  const observed = await f.bridge.call(target, 'route.inspect', {})
  expect(observed.operation?.operationId).toBe('retain-original-OP')
  expect(f.c.calls.filter(call => call.method === 'route.configure')).toHaveLength(1)
})

test('cancelling or navigating away releases only that sender request and never closes another reader or policy', async () => {
  const f = await fixture(), target = { hostId: 'policy-C', expectedRuntimeId: f.c.identity.runtimeId }, signals: AbortSignal[] = []
  f.intercepts.set('C', async (call, value) => {
    if (call.method === 'route.inspect') await new Promise<void>((resolve, reject) => {
      const signal = call.context.signal!; signals.push(signal); signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    return value
  })
  const first = f.handlers.get('hostRoutes:call')!(f.event, 'first', target, 'route.inspect', {}) as Promise<{ ok: boolean }>
  await vi.waitFor(() => expect(signals).toHaveLength(1))
  const second = f.handlers.get('hostRoutes:call')!(f.event, 'second', target, 'route.inspect', {}) as Promise<{ ok: boolean }>
  await vi.waitFor(() => expect(signals).toHaveLength(2))
  f.handlers.get('hostRoutes:cancel')!(f.event, 'first')
  expect(signals[0]!.aborted).toBe(true); expect(signals[1]!.aborted).toBe(false); expect((await first).ok).toBe(false)
  f.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  expect((await second).ok).toBe(false); expect(signals[1]!.aborted).toBe(true)
  f.intercepts.clear()
  expect((await f.bridge.call(target, 'route.inspect', {})).identity).toEqual(f.c.identity)
})

test('a reply for another Runtime and a lost IPC envelope remain typed unknown failures, not a successful save', async () => {
  const f = await fixture(), target = { hostId: 'policy-C', expectedRuntimeId: f.c.identity.runtimeId }
  f.intercepts.set('C', async (call, value) => call.method === 'route.inspect' ? { ...(value as object), identity: f.d.identity } : value)
  expect(await failureCode(f.bridge.call(target, 'route.inspect', {}))).toEqual({ code: 'RUNTIME_OWNER_MISMATCH' })
  captured.invoke.mockRejectedValueOnce(Object.assign(new Error('IPC reply lost'), { code: 'ORIGINAL_IPC_LOSS' }))
  const error = await f.bridge.call(target, 'route.inspect', {}).then(() => null, error => error)
  expect(error).toMatchObject({ code: 'ORIGINAL_IPC_LOSS', controlFailure: { disposition: 'unknown', confirmedInputBytes: null } })
})
