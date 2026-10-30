import { vi, expect } from 'vitest'
import { join, resolve } from 'node:path'
import * as core from '../../../core/src/index.js'
import { hostedTestOwner } from '../../../core/test/helpers/hosted-runtime-port.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../core/test/helpers/object-cli-rpc.js'
import { ingressFixture } from './ingress.js'
import { feishuConfig } from './feishu.js'
import { feishuSocketTransport } from './feishu-socket.js'
import { FeishuAdapter } from '../../src/adapters/feishu/index.js'
import { createConnectionServices } from '../../src/connection-services.js'
import type { ConnectionPort, ConnectionReceiverRecoverInput } from '@agentmux/core/connections'
export const waitReceiver = (read: () => void | Promise<void>, timeout = 9000) => vi.waitFor(read, { interval: 30, timeout })
export async function receiverRecoveryFixture(cleanup: Array<() => void | Promise<void>>, options: { endpointCode?: number; botWait?: Promise<void>; observationFails?: () => boolean; endpointWait?: () => Promise<void> | undefined } = {}) {
  const wire = await feishuSocketTransport(options); cleanup.push(wire.close)
  const f = await ingressFixture(true, feishuConfig); cleanup.push(f.close)
  const starts = vi.spyOn(f.inner.kernel, 'start')
  const originalHttp = wire.http.request.bind(wire.http)
  const adapter = new FeishuAdapter({ http: { ...wire.http, request: async input => {
    if (input.url?.endsWith('/bot/v3/info')) await options.botWait
    if (input.url?.endsWith('/callback/ws/endpoint')) await options.endpointWait?.()
    return originalHttp(input)
  } } })
  if (options.observationFails) {
    const originalStart = adapter.transport.start.bind(adapter.transport)
    vi.spyOn(adapter.transport, 'start').mockImplementation(async input => {
      const receiver = await originalStart(input)
      return { ...receiver, lifecycle: () => { if (options.observationFails!()) throw Error('Read observation unavailable'); return receiver.lifecycle() } }
    })
  }
  const create = () => createConnectionServices({ directory: join(f.root, 'receiver-host'), adapters: [adapter],
    bindings: { spatial: f.spatial, checkpoint: ref => f.client.conversationCheckpoint(ref) },
    ingress: { core: host => host === 'local' ? f.client : undefined } })
  let services = await create(); cleanup.push(() => services.close())
  const owner = new Proxy({} as ConnectionPort, { get(_target, key) { return Reflect.get(services.connections, key) } })
  const secret = await services.secrets.store({ operationId: 'receiver-secret', secret: 'fixture-credential' })
  await owner.configure({ operationId: 'receiver-config', expectedRevision: null, connection: { ...feishuConfig, credentialRef: secret.credentialRef } })
  await owner.bindings!.bind(f.input, { actor: { kind: 'user', id: 'original-user' } })
  await owner.bindings!.grant(f.grant, { actor: { kind: 'user', id: 'original-user' } })
  const identity = hostedTestOwner(f.client), runtime = new core.AgentMuxHostedRuntimeService(f.client, f.store.path, () => identity)
  cleanup.push(() => runtime.dispose())
  const downstream = new core.AgentMuxRpcService({ coreClients: f.coreClients, connections: owner, hostedRuntime: () => runtime })
  cleanup.push(() => downstream.dispose())
  const forwarded: string[] = []
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'receiver.sock'), coreClients: f.coreClients, hostedRuntime: () => runtime,
    forwardControl: async (method, params, context) => { forwarded.push(method); return downstream.call(method, params, context) } })
  await server.start(); cleanup.push(() => server.stop())
  const directServer = new core.AgentMuxControlServer({ socketPath: join(f.root, 'receiver-original.sock'), coreClients: f.coreClients,
    hostedRuntime: () => runtime, connections: owner })
  await directServer.start(); cleanup.push(() => directServer.stop())
  let rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const hosted = await core.connectHostedAgentMux({ rpc, waitForReady: false,
    forwardRpc: (method, params, context = {}) => rpc.call(method, params, { ...(context.runtimeFence ? { runtimeFence: context.runtimeFence } : {}), ...(context.signal ? { signal: context.signal } : {}) }) }); cleanup.push(() => hosted.dispose())
  const fence = { runtimeId: identity.runtimeId, ownerInstanceId: identity.ownerInstanceId }
  const current = async () => (await rpc.call('connection.inspect', { connectionId: feishuConfig.connectionId })).connection!
  const target = async (operationId: string): Promise<ConnectionReceiverRecoverInput> => ({ operationId, connectionId: feishuConfig.connectionId, expectedRevision: 1, receiverRef: (await current()).receiver?.ref ?? null })
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const callCli = (path: string, args: string[], input = '') => runCompiledObjectCli(['--endpoint', 'unix:' + path, 'connection', ...args,
    ...(args[0] === 'receiver' && !args.includes('--help') && !args.includes('--runtime') ? ['--runtime', fence.runtimeId] : [])], objectCliEnvironment(f.root), input)
  const cli = (args: string[], input = '') => callCli(directServer.path, args, input)
  const rootCli = (args: string[], input = '') => runCompiledObjectCli(['--endpoint', 'unix:' + directServer.path, ...args], objectCliEnvironment(f.root), input)
  const cliForwarded = (args: string[], input = '') => callCli(server.path, args, input)
  const recover = (input: ConnectionReceiverRecoverInput) => hosted.forwardRpc!('connection.receiver.recover', input)
  const ready = () => waitReceiver(async () => expect((await current()).receiver?.state).toBe('ready'))
  const unchanged = () => { expect(f.client.agentSession(f.input.agentSessionId).run).toEqual(f.session.run); expect(starts).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.attach).not.toHaveBeenCalled() }
  return { ...f, wire, owner, get services() { return services }, adapter, get rpc() { return rpc }, hosted, downstream, server, directServer, fence, identity, forwarded, current, target, recover, cli, rootCli, cliForwarded, ready, unchanged,
    async reconnect() { rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }) },
    async restart() { await services.close(); services = await create() } }
}
