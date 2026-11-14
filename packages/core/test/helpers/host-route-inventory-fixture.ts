import { vi } from 'vitest'
import { join } from 'node:path'
import { AgentMuxCreationAuthority } from '../../src/agent-creation-authority.js'
import { AgentMuxHostExecutorOwner } from '../../src/executor-owner.js'
import { AgentProviderRegistry } from '../../src/agent-provider.js'
import { AgentMuxHostedRuntimeService } from '../../src/hosted-runtime-service.js'
import { HostRouteGateway, delegatedHostRouteActor, type HostRouteTransport } from '../../src/host-route-gateway.js'
import { hostRouteTransport, routedAgentMuxRpc } from '../../src/host-route-rpc.js'
import { type AdoptedHostRoute, type HostRouteEnvelope, type HostRouteGrant } from '../../src/host-route.js'
import { AgentMuxControlServer, type AgentMuxControlServerOptions } from '../../src/public-rpc-server.js'
import { connectAgentMuxRpc, type AgentMuxRpcClient } from '../../src/public-rpc-client.js'
import { rpcOwnerFixture } from './public-rpc-owner.js'


export const hostRouteInventoryPrincipal = { kind: 'user' as const, id: 'local-user:' + (process.getuid?.() ?? 'current') }
const principal = hostRouteInventoryPrincipal

export async function createHostRouteInventoryFixture(cleanups: (() => Promise<void>)[], sourceB?: Pick<AgentMuxControlServerOptions, 'spatialState' | 'spatialAgentControl' | 'hostedRuntime' | 'coreClients'>) {
  const original = await rpcOwnerFixture(), collision = await rpcOwnerFixture(); cleanups.push(original.close, collision.close)
  for (const [owner, runtimeId] of [[original, 'runtime-D'], [collision, 'runtime-C']] as const) {
    Object.assign(owner.client, { hostExecutorOwner: new AgentMuxHostExecutorOwner({ path: join(owner.root, 'executors.json'), runtimeId,
      catalog: () => new AgentProviderRegistry().catalog() }) })
    await owner.client.configureHostExecutor({ executorId: 'same-executor', config: { label: runtimeId + ' original', providerId: 'claude', command: '/private/' + runtimeId + '/original-command',
      args: ['private-argument'], env: { SECRET: 'private-environment' }, injectAgentMuxGuide: false } })
  }
  const connect = vi.spyOn(original.client, 'connect').mockRejectedValue(new Error('Optional whole-Host observation is unavailable'))
  const native = vi.spyOn(original.client, 'connectRuntime').mockRejectedValue(new Error('Inventory must not connect Native'))
  const inventory = vi.spyOn(original.client, 'listHostExecutors')
  const creation = vi.spyOn(original.client, 'agentCreationAuthority').mockRejectedValue(new Error('Inventory is not creation qualification'))
  let servingRuntime = 'runtime-D'
  const hosted = new AgentMuxHostedRuntimeService(original.client, null, () => ({ runtimeId: servingRuntime, ownerInstanceId: 'original-D-instance', protocolVersion: 2,
    processId: process.pid, availability: 'connected', ctxmux: original.client.runtimeIdentity() }))
  cleanups.push(() => hosted.dispose())
  const peers = new Map<string, AgentMuxRpcClient>(), parents: HostRouteEnvelope[] = [], arrivals: { method: string; actor: unknown }[] = []
  const nodes = new Map<string, { authority: AgentMuxCreationAuthority; gateway: HostRouteGateway; rpc: AgentMuxRpcClient; identity: Awaited<ReturnType<AgentMuxCreationAuthority['identity']>> }>()
  for (const name of ['A','B','C','D']) {
    const authority = new AgentMuxCreationAuthority({ stateDirectory: join(original.root, name), runtimeId: 'runtime-' + name }), identity = await authority.identity()
    let server: AgentMuxControlServer
    const edge = (id: string): HostRouteTransport => {
      const rpc = peers.get(id); if (!rpc) throw Error('Unconfigured test edge ' + id)
      const transport = hostRouteTransport(rpc)
      return { ...transport, call: (method, params, signal) => {
        if (name === 'A' && params.call.method === 'route.executors') parents.push(params.envelope)
        return transport.call(method, params, signal)
      } }
    }
    const gateway = new HostRouteGateway({ stateDirectory: join(original.root, name), authority, edge,
      call: (method, params, context) => {
        if (name === 'D') arrivals.push({ method, actor: delegatedHostRouteActor(context) })
        return server.callRpc(method, params, context)
      }, subscribe: (method, params, emit, context) => server.subscribeRpc(method, params, emit, context) })
    server = new AgentMuxControlServer({ hostRoutes: gateway,
      ...(name === 'D' ? { hostedRuntime: () => hosted } : {}),
      coreClients: () => name === 'B' ? [{ hostId: 'collision', client: collision.client }] : name === 'A' || name === 'D' ? original.coreClients() : [],
      ...(name === 'B' ? sourceB : {})
    }, join(original.root, name + '.sock'))
    await server.start()
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    cleanups.push(async () => { gateway.dispose(); await rpc.dispose(); await server.stop() })
    peers.set(name, rpc); nodes.set(name, { authority, gateway, rpc, identity })
  }
  const a = nodes.get('A')!, b = nodes.get('B')!, c = nodes.get('C')!, d = nodes.get('D')!, actor = { source: a.identity, ...principal }
  const access: AdoptedHostRoute = { source: a.identity, hops: [{ edgeId: 'B', target: b.identity }] }
  const route: AdoptedHostRoute = { source: b.identity, hops: [{ edgeId: 'C', target: c.identity }, { edgeId: 'D', target: d.identity }] }
  const configure = async (node: typeof a, routes: { id: string; route: AdoptedHostRoute }[], grants: HostRouteGrant[]) => {
    const current = await node.rpc.call('route.inspect', {})
    await node.rpc.call('route.configure', { expectedRevision: current.revision, operationId: 'save-' + Math.random(), configuration: { routes, grants } })
  }
  const grant = (id: string, delegator: typeof a.identity, destination: typeof a.identity, scopes: string[]): HostRouteGrant => ({ id, delegator, destination, actor, scopes })
  const reads = ['runtime.owner.identity','runtime.invoke/listHostExecutors']
  await configure(a, [{ id: 'B', route: access }], [])
  await configure(b, [{ id: 'collision', route }], [grant('original-A', a.identity, b.identity, ['route.choices','route.executors'])])
  await configure(c, [], [grant('original-B', b.identity, d.identity, reads)])
  await configure(d, [], [grant('original-C', c.identity, d.identity, reads)])
  return { original, collision, a,b,c,d, actor, route, access, rpc: routedAgentMuxRpc(a.rpc,'B',access), connect,native,inventory,creation,parents,arrivals,configure,grant,reads,
    wrongRuntime: () => { servingRuntime = 'another-runtime' } }
}

