import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxError } from '../src/errors.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import type { AgentMuxRuntimeOwnerIdentity } from '../src/hosted-client-contract.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import type { AgentMuxRpcCoreClient } from '../src/public-rpc-service.js'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

async function fixture(ids = ['caller', 'peer-a', 'peer-b']) {
  const h = await rpcOwnerFixture(ids); cleanup.push(h.close)
  const entered = deferred(), release = deferred(), read = h.client.readAgentSessions.bind(h.client)
  // Hold only the original event opening; independent metadata reads still use the real Store.
  const reads = vi.spyOn(h.client, 'readAgentSessions').mockImplementationOnce(async () => {
    entered.resolve(); await release.promise; return await read()
  })
  const connect = vi.spyOn(h.client, 'connect'), connectRuntime = vi.spyOn(h.client, 'connectRuntime')
  // Run status uses the existing named Native port in rpcOwnerFixture. This is a
  // Hosted/Store/public-RPC proof, not an installed Native or App performance claim.
  vi.spyOn(h.client, 'runtimeProjection').mockResolvedValue({ hostId: 'local', subjects: [] })
  const owner: AgentMuxRuntimeOwnerIdentity = { protocolVersion: 2, runtimeId: 'discovery-runtime', ownerInstanceId: 'discovery-owner',
    processId: process.pid, availability: 'connected', ctxmux: null }
  const service = new AgentMuxHostedRuntimeService(h.client, null, () => owner); cleanup.push(() => service.dispose())
  const source = new AgentMuxControlServer({ socketPath: join(h.root, 'hosted.sock'), coreClients: h.coreClients, hostedRuntime: () => service })
  await source.start(); cleanup.push(() => source.stop())
  const sourceRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: source.path } }); cleanup.push(() => sourceRpc.dispose())
  const hosted = await connectHostedAgentMux({ rpc: sourceRpc, waitForReady: false }); cleanup.push(() => hosted.dispose())
  cleanup.push(async () => { release.resolve() })
  await entered.promise
  const scopes: AgentMuxRpcCoreClient[] = [{ hostId: 'local', client: hosted }]
  const server = new AgentMuxControlServer({ socketPath: join(h.root, 'aggregate.sock'), coreClients: () => scopes })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  return { ...h, reads, connect, connectRuntime, service, sourceRpc, source, hosted, scopes, rpc, owner }
}

it.each([{ ids: [] }, { ids: ['caller', 'peer-a', 'peer-b'] }])('reads the original namespace and discovers $ids before the Hosted bootstrap opens', async ({ ids }) => {
  const h = await fixture(ids)
  expect(() => h.hosted.agentMessageQueuePath()).toThrow('The semantic Host identity is not confirmed.')
  await expect(h.hosted.readAgentMessageQueuePath()).resolves.toBe(h.client.agentMessageQueuePath())
  expect(h.reads).toHaveBeenCalledTimes(1)
  expect(h.connect).not.toHaveBeenCalled(); expect(h.connectRuntime).not.toHaveBeenCalled()
  const parsed = await parseAgentMuxCliInvocation(['agent', 'ls', '--provider', 'codex', '--status', 'running'])
  const page = await h.rpc.call('agent.ls', parsed.params)
  expect(page.sessions.map(entry => entry.session.agentSessionId)).toEqual(ids)
  expect(page.errors).toEqual([]); expect(page.nextCursor).toBeNull()
  expect(() => h.hosted.agentMessageQueuePath()).toThrow('The semantic Host identity is not confirmed.')
  expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('isolates an unavailable namespace and binds paging to the original sources and their availability', async () => {
  const h = await fixture(), remote = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore(), providers: [] })
  cleanup.push(() => remote.dispose())
  const namespace = vi.spyOn(remote, 'readAgentMessageQueuePath').mockRejectedValue(new AgentMuxError('Remote owner unavailable.', 'CONTROL_UNAVAILABLE'))
  const remoteReads = vi.spyOn(remote, 'readAgentSessions'), remoteHistory = vi.spyOn(remote, 'sessionHistorySources')
  h.scopes.push({ hostId: 'remote', client: remote })
  const first = await h.rpc.call('agent.ls', { limit: 1 })
  expect(first.sessions.map(entry => entry.session.agentSessionId)).toEqual(['caller'])
  expect(first.errors).toEqual([{ hostId: 'remote', agentSessionId: null, code: 'CONTROL_UNAVAILABLE', message: 'Remote owner unavailable.' }])
  expect(first.nextCursor).not.toBeNull()
  expect(remoteReads).not.toHaveBeenCalled(); expect(remoteHistory).not.toHaveBeenCalled()
  const cursor = first.nextCursor!
  const next = await h.rpc.call('agent.ls', { limit: 1, cursor })
  expect(next.sessions.map(entry => entry.session.agentSessionId)).toEqual(['peer-a'])
  // Error wording is not a namespace fact. It must not invalidate this original cut.
  namespace.mockRejectedValue(new AgentMuxError('Still unavailable.', 'CONTROL_UNAVAILABLE'))
  await expect(h.rpc.call('agent.ls', { limit: 1, cursor })).resolves.toMatchObject({ sessions: [{ session: { agentSessionId: 'peer-a' } }] })
  namespace.mockRestore()
  await expect(h.rpc.call('agent.ls', { limit: 1, cursor })).rejects.toMatchObject({ code: 'AGENT_DISCOVERY_CURSOR_INVALID' })
  const available = await h.rpc.call('agent.ls', { limit: 1 })
  expect(available.errors).toEqual([])
  const original = h.client.agentMessageQueuePath()
  const localNamespace = vi.spyOn(h.client, 'readAgentMessageQueuePath').mockResolvedValue(original + '.replacement')
  await expect(h.rpc.call('agent.ls', { limit: 1, cursor: available.nextCursor! })).rejects.toMatchObject({ code: 'AGENT_DISCOVERY_CURSOR_INVALID' })
  localNamespace.mockRestore()
  h.scopes.splice(1)
  await expect(h.rpc.call('agent.ls', { limit: 1, cursor })).rejects.toMatchObject({ code: 'AGENT_DISCOVERY_CURSOR_INVALID' })
})

it('reports every unavailable source without inventing an empty healthy inventory', async () => {
  const h = await fixture()
  vi.spyOn(h.client, 'readAgentMessageQueuePath').mockRejectedValue(new AgentMuxError('Owner namespace read failed.', 'CONTROL_UNAVAILABLE'))
  const page = await h.rpc.call('agent.ls', { agentSessionId: 'caller' })
  expect(page).toEqual({ sessions: [], unavailableSessions: [], retired: [], nextCursor: null,
    errors: [{ hostId: 'local', agentSessionId: 'caller', code: 'CONTROL_UNAVAILABLE', message: 'Owner namespace read failed.' }] })
  expect(h.reads).toHaveBeenCalledTimes(1)
  expect(h.connectRuntime).not.toHaveBeenCalled()
})

it('keeps the owner fence, argument contract, response codec and managed-caller boundary on the namespace read', async () => {
  const h = await fixture(), request = { consumerId: 'namespace-reader', fence: { runtimeId: h.owner.runtimeId, ownerInstanceId: h.owner.ownerInstanceId },
    invocation: { method: 'readAgentMessageQueuePath' as const, args: [] as [] } }
  await expect(h.sourceRpc.call('runtime.invoke', { ...request, fence: { ...request.fence, ownerInstanceId: 'foreign-owner' } }))
    .rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
  await expect(h.sourceRpc.call('runtime.invoke', { ...request, invocation: { ...request.invocation, args: ['foreign'] } } as never))
    .rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  const managed = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: h.source.path }, credentials: h.credentials }); cleanup.push(() => managed.dispose())
  await expect(managed.call('runtime.invoke', request)).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  vi.spyOn(h.client, 'readAgentMessageQueuePath').mockResolvedValue('')
  await expect(h.hosted.readAgentMessageQueuePath()).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  expect(h.connectRuntime).not.toHaveBeenCalled()
})
