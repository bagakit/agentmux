import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { RuntimeController } from '../src/main/runtime-controller'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service'
import { hostedTestOwner } from '../../../packages/core/test/helpers/hosted-runtime-port'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner'
import { createConnectionServices } from '../../../packages/connectors/src/connection-services'
import { ChannelStorage } from '../../../packages/connectors/src/channel-storage'
vi.mock('electron', () => ({ app: {}, nativeImage: {} }))
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('original profile Runtime selection keeps aliases and separates identical subjects through the real owner fence and public metadata', async () => {
  const config = { connectionId: 'same-connection', adapterId: 'discord', application: { domain: 'discord.com', appId: '100' }, label: 'Original bot', enabled: false, credentialRef: 'private-ref' }
  const subject = { kind: 'conversation' as const, externalConversationId: '300' }
  async function owner(runtimeId: string, name: string) {
    const f = await rpcOwnerFixture([]); cleanup.push(f.close)
    const identity = { ...hostedTestOwner(f.client), runtimeId }
    const hosted = new AgentMuxHostedRuntimeService(f.client, f.store.path, () => identity); cleanup.push(() => hosted.dispose())
    const services = await createConnectionServices({ directory: join(f.root, 'connections') }); cleanup.push(() => services.close())
    const server = new AgentMuxControlServer({ socketPath: join(f.root, 'metadata.sock'), connections: services.connections, hostedRuntime: () => hosted, coreClients: f.coreClients })
    await server.start(); cleanup.push(() => server.stop())
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
    await rpc.call('connection.configure', { operationId: 'original-configure', expectedRevision: null, connection: config })
    new ChannelStorage(services.database!).namespace(config).put({ key: 'conversation-profile:' + JSON.stringify(subject.externalConversationId), expectedRevision: null,
      value: { kind: 'json', value: { application: config.application, externalConversationId: subject.externalConversationId, state: 'observed', freshness: 'current', checkedAt: 1, profile: { name, observedAt: 1 } } } })
    const requests: Array<{ method: string; params: unknown; fence: unknown }> = []
    const client = Object.assign(f.client, { runtimeOwnerIdentity: () => identity, forwardRpc: async (method: any, params: any, context: any, fence: any) => {
      requests.push({ method, params, fence })
      return rpc.call(method, params, { ...(context.caller ? { credentials: context.caller } : {}), ...(fence ? { runtimeFence: fence } : {}) })
    } })
    return { ...f, client, identity, requests }
  }
  const original = await owner('original-profile-runtime', 'Original room'), other = await owner('other-profile-runtime', 'Other room')
  const runtime = new RuntimeController(original.store), routes = Reflect.get(runtime, 'hosts') as Map<string, unknown>
  cleanup.push(async () => { routes.clear(); await runtime.dispose() })
  const alias = new Proxy(original.client, { get(target, key, receiver) {
    return key === 'runtimeOwnerIdentity' ? () => ({ ...original.identity, ownerInstanceId: 'prior-observed-instance' }) : Reflect.get(target, key, receiver)
  } })
  routes.set('other', { client: other.client }); routes.set('local', { client: original.client }); routes.set('original-alias', { client: alias })
  const target = await runtime.connectionHostingTarget({ runtimeId: original.identity.runtimeId })
  expect(target).toEqual({ hostId: 'local', runtimeId: original.identity.runtimeId })
  expect(await runtime.connectionHostingTarget()).toEqual(target)
  expect((await runtime.callConnectionHost(target, 'connection.metadata.get', { connectionId: config.connectionId, subject })).entry.observation.profile?.name).toBe('Original room')
  const otherTarget = await runtime.connectionHostingTarget({ runtimeId: other.identity.runtimeId })
  expect(otherTarget.hostId).toBe('other')
  expect((await runtime.callConnectionHost(otherTarget, 'connection.metadata.get', { connectionId: config.connectionId, subject })).entry.observation.profile?.name).toBe('Other room')
  routes.delete('local')
  const aliasTarget = await runtime.connectionHostingTarget({ runtimeId: original.identity.runtimeId })
  expect(aliasTarget.hostId).toBe('original-alias')
  expect((await runtime.callConnectionHost(aliasTarget, 'connection.metadata.get', { connectionId: config.connectionId, subject })).entry.observation.profile?.name).toBe('Original room')
  await expect(runtime.callConnectionHost({ ...otherTarget, runtimeId: original.identity.runtimeId }, 'connection.metadata.get', { connectionId: config.connectionId, subject })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  await expect(runtime.connectionHostingTarget({ runtimeId: 'unobserved-runtime' })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  for (const owner of [original, other]) {
    const reads = owner.requests.filter(request => request.method === 'connection.metadata.get')
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.every(read => JSON.stringify(read.fence) === JSON.stringify({ runtimeId: owner.identity.runtimeId, ownerInstanceId: owner.identity.ownerInstanceId }))).toBe(true)
    expect(owner.inner.kernel.stop).not.toHaveBeenCalled()
  }
})
