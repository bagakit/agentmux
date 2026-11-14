import { afterEach, expect, test, vi } from 'vitest'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import * as core from '@agentmux/core'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { configuredRouteEdge, configuredRouteEdges } from '../src/host-route-edges.js'
import { startAgentMuxHost } from '../src/host.js'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { try { for (const close of cleanup.splice(0).reverse()) await close() } finally { vi.restoreAllMocks(); vi.unstubAllEnvs() } })
const principal = { kind: 'user' as const, id: `local-user:${process.getuid?.() ?? 'current'}` }
const failureCode = (request: Promise<unknown>) => request.then(() => null, error => ({ code: error.code }))
async function fixture() {
  const original = await rpcOwnerFixture(['managed'], core)
  cleanup.push(original.close); await original.client.dispose()
  const nodes = new Map<string, { rpc: core.AgentMuxRpcClient; identity: core.HostRouteIdentity; path: string }>()
  const identityReads: string[] = [], edgeReads: string[] = []
  let pausedIdentity: Promise<void> | undefined
  const configuration = (label: string, runtimeId?: string) => ({ hosts: [
    { id: 'local', kind: 'local', label },
    { id: 'next', kind: 'ssh', label: label + ' saved peer', hostname: 'private-hostname', user: 'private-user', identityFile: '/private/key', remoteSocketPath: '/private/socket', remoteCommand: 'private-command', ...(runtimeId ? { runtimeId } : {}) },
    { id: 'offline', kind: 'ssh', label: label + ' offline', hostname: 'unavailable', transport: 'tailcat', tailcat: { address: 'tcPrivateAddress', keyFile: '/private/tailcat-key' } },
  ], executors: {}, workspaces: [] })
  for (const name of ['D', 'C', 'A']) {
    const directory = join(original.root, name), authority = new core.AgentMuxCreationAuthority({ stateDirectory: directory, runtimeId: 'original-' + name })
    const identity = await authority.identity(), path = join(original.root, name + '.json')
    await writeFile(path, JSON.stringify(configuration(name, nodes.get(name === 'C' ? 'D' : 'C')?.identity.runtimeId)))
    let server: core.AgentMuxControlServer
    const gateway = new core.HostRouteGateway({ stateDirectory: directory, authority, edges: () => configuredRouteEdges(path),
      edge: id => { edgeReads.push(name + '/' + id); const peer = nodes.get(name === 'C' ? 'D' : 'B')!
        const edge = configuredRouteEdge(selected => selected === 'next' ? [{ hostId: 'next', client: { forwardRpc: peer.rpc.call.bind(peer.rpc), subscribeRpc: peer.rpc.subscribe.bind(peer.rpc) } as core.AgentMuxHostedClient }] : [], id)
        return { ...edge, identity: signal => { identityReads.push(name + '/' + id); return edge.identity(signal) } } },
      call: (method, params, context) => server.callRpc(method, params, context), subscribe: (method, params, emit, context) => server.subscribeRpc(method, params, emit, context) })
    server = new core.AgentMuxControlServer({ hostRoutes: gateway }, join(original.root, name + '.sock')); await server.start()
    const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(original.root, name + '.sock') } })
    cleanup.push(async () => { gateway.dispose(); await rpc.dispose(); await server.stop() }); nodes.set(name, { rpc, identity, path })
  }
  const path = join(original.root, 'B.json'); await writeFile(path, JSON.stringify(configuration('B', nodes.get('C')!.identity.runtimeId)))
  const connection = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function (this: core.AgentMuxClient) {
    const inner = this as unknown as typeof original.inner
    await inner.registry.load('local'); inner.connected = true; inner.kernel.isConnected = () => false
  })
  let host: Awaited<ReturnType<typeof startAgentMuxHost>>
  try { host = await startAgentMuxHost({ store: original.store, configurationPath: path, socketPath: join(original.root, 'B.sock'), desktopSocketPath: join(original.root, 'absent-desktop.sock'), mobileBuildDirectory: join(original.root, 'absent-mobile'),
    connections: { directory: join(original.root, 'connections'), adapters: [], clients: selected => selected === 'next' || selected === undefined ? [{ hostId: 'next', client: {
      forwardRpc: (async (...args: Parameters<core.AgentMuxRpcClient['call']>) => { if (args[0] === 'route.identity') { identityReads.push('B/next'); await pausedIdentity } return await nodes.get('C')!.rpc.call(...args) }) as core.AgentMuxHostedClient['forwardRpc'],
      subscribeRpc: nodes.get('C')!.rpc.subscribe.bind(nodes.get('C')!.rpc),
    } as core.AgentMuxHostedClient }] : [] } }) }
  finally { connection.mockRestore() }
  cleanup.push(() => host.dispose())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(original.root, 'B.sock') } }); cleanup.push(() => rpc.dispose())
  const identity = await rpc.call('route.identity', {}); nodes.set('B', { rpc, identity, path })
  const a = nodes.get('A')!, b = nodes.get('B')!, c = nodes.get('C')!, d = nodes.get('D')!
  const configure = async (node: typeof a, routes: core.HostRouteDefinition[], grants: core.HostRouteGrant[]) => {
    const before = await node.rpc.call('route.inspect', {})
    return await node.rpc.call('route.configure', { expectedRevision: before.revision, operationId: 'save-' + Math.random(), configuration: { routes, grants } })
  }
  return { original, nodes, a, b, c, d, configure, identityReads, edgeReads, pauseIdentity: (pending: Promise<void>) => { pausedIdentity = pending } }
}

test('actual default Host exposes only saved safe edges and inspects exactly one configured peer without writing', async () => {
  const f = await fixture(), before = await readFile(f.b.path, 'utf8'), policy = await f.b.rpc.call('route.inspect', {})
  const listed = await f.b.rpc.call('route.edges', {})
  expect(listed).toEqual({ identity: f.b.identity, actor: { source: f.b.identity, ...principal }, observedAt: expect.any(Number), edges: [
    { edgeId: 'next', label: 'B saved peer', kind: 'ssh', runtimeId: f.c.identity.runtimeId }, { edgeId: 'offline', label: 'B offline', kind: 'ssh' },
  ] })
  expect(f.identityReads).toEqual([]); expect(f.edgeReads).toEqual([])
  const inspected = await f.b.rpc.call('route.edge.inspect', { edgeId: 'next' })
  expect(inspected).toEqual({ identity: f.b.identity, actor: listed.actor, edge: listed.edges[0], target: f.c.identity, observedAt: expect.any(Number) })
  expect(f.identityReads).toEqual(['B/next']); expect(f.edgeReads).toEqual([])
  await expect(f.b.rpc.call('route.edge.inspect', { edgeId: 'missing' })).rejects.toMatchObject({ code: 'HOST_ROUTE_EDGE_UNAVAILABLE' })
  expect(f.identityReads).toEqual(['B/next'])
  expect(await readFile(f.b.path, 'utf8')).toBe(before); expect(await f.b.rpc.call('route.inspect', {})).toEqual(policy)
  expect((await f.original.store.loadMetadata()).map(row => row.agentSessionId)).toEqual(['managed'])
})

test('actual routed discovery reports the receiving owner and original actor, with independent read grants at every hop', async () => {
  const f = await fixture(), actor = { source: f.a.identity, ...principal }
  const route = { source: f.a.identity, hops: [{ edgeId: 'next', target: f.b.identity }, { edgeId: 'next', target: f.c.identity }] }
  await f.configure(f.a, [{ id: 'saved-prefix', route }], [])
  const reader = core.routedAgentMuxRpc(f.a.rpc, 'saved-prefix', route)
  const grant = (delegator: core.HostRouteIdentity): core.HostRouteGrant => ({ id: 'discovery', delegator, actor, destination: f.c.identity, scopes: ['route.edges', 'route.edge.inspect'] })
  expect(await failureCode(reader.call('route.edges', {}))).toEqual({ code: 'HOST_ROUTE_NOT_DELEGATED' })
  await f.configure(f.b, [], [grant(f.a.identity)])
  expect(await failureCode(reader.call('route.edges', {}))).toEqual({ code: 'HOST_ROUTE_NOT_DELEGATED' })
  await f.configure(f.c, [], [grant(f.b.identity)])
  const listed = await reader.call('route.edges', {})
  expect(listed.identity).toEqual(f.c.identity); expect(listed.actor).toEqual(actor)
  expect(listed.edges[0]).toEqual({ edgeId: 'next', kind: 'ssh', label: 'C saved peer', runtimeId: f.d.identity.runtimeId })
  expect(f.identityReads).toEqual([])
  const inspected = await reader.call('route.edge.inspect', { edgeId: 'next' })
  expect(inspected).toMatchObject({ identity: f.c.identity, actor, target: f.d.identity, edge: listed.edges[0] })
  expect(f.identityReads).toEqual(['C/next'])
  await expect(reader.call('route.inspect', {})).rejects.toMatchObject({ code: 'HOST_ROUTE_INVALID' })
  const before = await f.c.rpc.call('route.inspect', {})
  await f.configure(f.c, [], [])
  expect(await failureCode(reader.call('route.edge.inspect', { edgeId: 'next' }))).toEqual({ code: 'HOST_ROUTE_NOT_DELEGATED' })
  expect(f.identityReads).toEqual(['C/next'])
  expect((await f.c.rpc.call('route.inspect', {})).routes).toEqual(before.routes)
})

test('a saved pin mismatch rejects only inspection and never substitutes a saved identity or takes away listing', async () => {
  const f = await fixture(), config = JSON.parse(await readFile(f.b.path, 'utf8'))
  config.hosts[1].runtimeId = 'original-different-runtime'; await writeFile(f.b.path, JSON.stringify(config))
  expect(await failureCode(f.b.rpc.call('route.edge.inspect', { edgeId: 'next' }))).toEqual({ code: 'HOST_ROUTE_TARGET_MISMATCH' })
  expect((await f.b.rpc.call('route.edges', {})).edges[0]?.runtimeId).toBe('original-different-runtime')
  expect(await readFile(f.b.path, 'utf8')).toBe(JSON.stringify(config))
  expect(await f.b.rpc.call('route.identity', {})).toEqual(f.b.identity)
})

test('managed credentials and business JSON cannot promote discovery or read delegated policy', async () => {
  const f = await fixture(), managed = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.original.root, 'B.sock') }, credentials: f.original.credentials }); cleanup.push(() => managed.dispose())
  await expect(managed.call('route.edges', {})).rejects.toMatchObject({ code: 'HOST_ROUTE_ACTOR_REQUIRED' })
  await expect(f.b.rpc.call('route.edge.inspect', { edgeId: 'next', principal } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  expect(f.identityReads).toEqual([])
})

test('cancelling one exact inspection retains the policy, saved edges and other public capabilities', async () => {
  const f = await fixture(), policy = await f.b.rpc.call('route.inspect', {}), controller = new AbortController()
  let release!: () => void
  f.pauseIdentity(new Promise<void>(resolve => { release = resolve }))
  const pending = f.b.rpc.call('route.edge.inspect', { edgeId: 'next' }, { signal: controller.signal })
  const cancelled = expect(pending).rejects.toBeInstanceOf(Error)
  await vi.waitFor(() => expect(f.identityReads).toEqual(['B/next']))
  controller.abort(); release(); await cancelled
  expect(await f.b.rpc.call('route.inspect', {})).toEqual(policy)
  expect((await f.b.rpc.call('route.edges', {})).edges).toHaveLength(2)
  expect(await f.b.rpc.call('route.identity', {})).toEqual(f.b.identity)
})

test('the actual compiled CLI discovers the same owner and explicitly inspects one edge, including a granted prefix', async () => {
  const f = await fixture(), env = objectCliEnvironment(f.original.root)
  const run = async (node: string, args: string[], input = '') => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + join(f.original.root, node + '.sock'), ...args], env, input)
    expect(result.code, result.stderr).toBe(0)
    return JSON.parse(result.stdout)
  }
  const listed = await run('B', ['route', 'edges'])
  expect(listed).toMatchObject({ ok: true, operation: 'route.edges', result: { identity: f.b.identity, actor: { source: f.b.identity, ...principal }, edges: [{ edgeId: 'next', label: 'B saved peer', kind: 'ssh', runtimeId: f.c.identity.runtimeId }, { edgeId: 'offline', label: 'B offline', kind: 'ssh' }] } })
  expect(f.identityReads).toEqual([])
  const inspected = await run('B', ['route', 'edge', 'inspect', '--edge', 'next'])
  expect(inspected).toMatchObject({ ok: true, operation: 'route.edge.inspect', result: { identity: f.b.identity, target: f.c.identity } })
  const actor = { source: f.a.identity, ...principal }, route = { source: f.a.identity, hops: [{ edgeId: 'next', target: f.b.identity }] }
  await f.configure(f.a, [{ id: 'saved-prefix', route }], [])
  await f.configure(f.b, [], [{ id: 'finite-read', delegator: f.a.identity, actor, destination: f.b.identity, scopes: ['route.edges', 'route.edge.inspect'] }])
  const input = { routeId: 'saved-prefix', adoptedRoute: route, requestId: 'original-cli-discovery', call: { method: 'route.edge.inspect', params: { edgeId: 'next' } } }
  const routed = await run('A', ['route', 'call', '--input', '-'], JSON.stringify(input))
  expect(routed).toMatchObject({ ok: true, result: { value: { identity: f.b.identity, actor, target: f.c.identity }, observation: { actor, logicalHops: 1 } } })
  for (const args of [['route', '--help'], ['route', 'edges', '--help'], ['route', 'edge', 'inspect', '--help'], ['route', '--skill']]) {
    const help = await runCompiledObjectCli(args, env)
    expect(help.code).toBe(0)
    expect(help.stdout).toContain(args.includes('edges') || args[1] === '--help' ? 'route edges' : 'route edge inspect')
  }
})
