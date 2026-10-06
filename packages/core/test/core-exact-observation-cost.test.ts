import { fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxRpcCorePort } from '../src/public-rpc-service.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
const core = await import(/* @vite-ignore */ new URL('../dist/index.js', import.meta.url).href) as typeof import('../src/index.js')
const { AgentMuxRpcService } = await import(/* @vite-ignore */ new URL('../dist/public-rpc-service.js', import.meta.url).href) as typeof import('../src/public-rpc-service.js')
const { AgentMuxControlServer } = await import(/* @vite-ignore */ new URL('../dist/public-rpc-server.js', import.meta.url).href) as typeof import('../src/public-rpc-server.js')
const { connectAgentMuxRpc } = await import(/* @vite-ignore */ new URL('../dist/public-rpc-client.js', import.meta.url).href) as typeof import('../src/public-rpc-client.js')
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture() {
  const h = await rpcOwnerFixture(['caller', 'recipient'], core)
  h.inner.kernel.identity = () => ({ daemonInstanceId: 'exact-observation-runtime', protocolVersion: 1, buildIdentity: 'private' })
  const metadata = vi.spyOn(h.store, 'readMetadata'), catalog = vi.spyOn(h.store, 'loadMetadata')
  const inventories = vi.spyOn(h.client, 'readAgentSessions')
  const queue = new core.DurableAgentMuxMessageQueue(h.client.agentMessageQueuePath())
  await queue.append({ messageId: 'source', operationId: 'source-operation', createdAt: reshapeFixtureEpoch(0, 0, 1),
    sender: { kind: 'agent-session', agentSessionId: 'caller' }, recipient: { kind: 'agent-session', agentSessionId: 'recipient' },
    senderSessionId: 'caller', senderRunId: 'run-caller', recipientSessionId: 'recipient', recipientRunId: 'run-recipient',
    replyTo: null, threadId: 'thread', correlationId: 'source', workspaceId: null, body: 'Original source' })
  const path = join(h.root, 'exact.sock'), server = new AgentMuxControlServer({ socketPath: path, coreClients: h.coreClients })
  await server.start(); const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path }, credentials: h.credentials })
  const clear = () => { metadata.mockClear(); catalog.mockClear(); inventories.mockClear() }
  const counts = () => ({ metadata: metadata.mock.calls.map(([id]) => id), catalogs: catalog.mock.calls.length, inventories: inventories.mock.calls.length })
  return { ...h, metadata, catalog, inventories, rpc, queue, server, path, clear, counts,
    close: async () => { await rpc.dispose(); await server.stop(); await h.close() } }
}
describe('exact Core status and single confirmed Host authentication', () => {
  it('keeps actual FileStore status and managed CLI reads bounded when one hundred unrelated Sessions are added', async () => {
    const h = await fixture()
    const env = objectCliEnvironment(h.root, { AGENTMUX_AGENT_SESSION_ID: 'caller', AGENTMUX_AGENT_CAPABILITY: h.capability })
    const observe = async () => {
      h.clear()
      const status = await h.client.statusAgent('recipient')
      expect(status.session.agentSessionId).toBe('recipient'); expect(status.run.runId).toBe('run-recipient')
      expect(status.run.state).toBe('running')
      const statusReads = h.counts()
      expect(statusReads.catalogs).toBe(0); expect(statusReads.inventories).toBe(0)
      expect(statusReads.metadata.length).toBeGreaterThan(0)
      expect(new Set(statusReads.metadata)).toEqual(new Set(['recipient']))
      h.clear()
      const cli = await runCompiledObjectCli(['--endpoint', 'unix://' + h.path, 'message', 'read', '--operation-id', 'source-operation'], env)
      expect(cli.code, cli.stderr).toBe(0)
      expect(JSON.parse(cli.stdout).result.message.envelope.body).toBe('Original source')
      const callerReads = h.counts()
      expect(callerReads.catalogs).toBe(0); expect(callerReads.inventories).toBe(0)
      expect(callerReads.metadata.length).toBeGreaterThan(0)
      expect(new Set(callerReads.metadata)).toEqual(new Set(['caller']))
      return { statusReads, callerReads }
    }
    try {
      const baseline = await observe(), template = (await h.store.load()).find(session => session.agentSessionId === 'recipient')!
      for (let index = 0; index < 100; index++) await h.store.compareAndSwap(null, { ...template,
        agentSessionId: 'unrelated-' + index, run: { runId: 'unrelated-run-' + index }, hookBindingId: 'unrelated-hook-' + index })
      expect(await observe()).toEqual(baseline)
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  }, 20_000)

  it('admits one original cold durable binding before status without requiring unrelated metadata', async () => {
    const h = await fixture(), cold = new core.AgentMuxClient({ store: h.store })
    const inner = cold as unknown as typeof h.inner
    inner.connected = true; inner.kernel.isConnected = () => true
    inner.kernel.status = vi.fn(async (id: string) => h.run(id)); inner.kernel.identity = h.inner.kernel.identity
    inner.kernel.stop = vi.fn()
    try {
      expect(() => cold.agentSession('recipient')).toThrow('Unknown Agent Session')
      h.catalog.mockRejectedValue(new core.AgentMuxError('Unrelated cold inventory is unavailable.', 'AGENT_SESSION_STORE_READ_UNCONFIRMED'))
      h.clear()
      const status = await cold.statusAgent('recipient')
      expect(status.session).toMatchObject({ agentSessionId: 'recipient', providerId: 'codex', hostId: 'local', run: { runId: 'run-recipient' } })
      expect(status.run).toMatchObject({ runId: 'run-recipient', state: 'running' })
      expect(cold.agentSession('recipient').run.runId).toBe('run-recipient')
      expect(() => cold.agentSession('caller')).toThrow('Unknown Agent Session')
      expect(h.catalog).not.toHaveBeenCalled(); expect(h.inventories).not.toHaveBeenCalled()
      expect(h.metadata.mock.calls.length).toBeGreaterThan(0)
      expect(new Set(h.metadata.mock.calls.map(([id]) => id))).toEqual(new Set(['recipient']))
      expect(inner.kernel.stop).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await cold.dispose(); await h.close() }
  })

  it('keeps a selected healthy status available when unrelated catalog observation fails', async () => {
    const h = await fixture()
    try {
      h.catalog.mockRejectedValue(new core.AgentMuxError('Unrelated inventory is unreadable.', 'AGENT_SESSION_STORE_READ_UNCONFIRMED'))
      const status = await h.client.statusAgent('recipient')
      expect(status.run).toMatchObject({ runId: 'run-recipient', state: 'running' })
      expect(h.catalog).not.toHaveBeenCalled()
      expect((await h.rpc.call('message.read', { operationId: 'source-operation' })).message!.envelope.messageId).toBe('source')
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it('refreshes the exact durable Run and preserves Provider facts without reading neighboring metadata', async () => {
    const h = await fixture()
    try {
      const original = (await h.store.load()).find(session => session.agentSessionId === 'recipient')!
      await h.store.compareAndSwap(original, { ...original, run: { runId: 'continued-original-session-run' }, retiredRuns: [original.run],
        semanticStatus: { state: 'done', source: 'native-hook', observedAt: reshapeFixtureEpoch(0, 0, 100), stateEnteredAt: reshapeFixtureEpoch(0, 0, 100) }, updatedAt: reshapeFixtureEpoch(0, 0, 101) })
      const neighbor = h.client.agentSession('caller')
      h.clear()
      const current = await h.client.statusAgent('recipient')
      expect(current.session.run.runId).toBe('continued-original-session-run')
      expect(current.run.runId).toBe('continued-original-session-run')
      expect(current.capabilities).toEqual(h.client.catalog().find(provider => provider.id === 'codex')!.capabilities)
      expect(current.observation.semantic).toBe('idle')
      expect(h.client.agentSession('caller')).toEqual(neighbor)
      expect(new Set(h.metadata.mock.calls.map(([id]) => id))).toEqual(new Set(['recipient']))
      expect(h.catalog).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it('rejects another Run workspace or shared binding while retaining the original healthy identities', async () => {
    const h = await fixture()
    try {
      const before = h.client.agentSession('recipient')
      h.inner.kernel.status = vi.fn(async (id: string) => ({ ...h.run(id), workspacePath: join(h.root, 'wrong-workspace') }))
      await expect(h.client.statusAgent('recipient')).rejects.toMatchObject({ code: 'AGENT_SESSION_RUN_MISMATCH' })
      h.inner.kernel.status = vi.fn(async (id: string) => h.run(id))
      const read = (id: string) => core.AgentMuxFileAgentSessionStore.prototype.readMetadata.call(h.store, id)
      h.metadata.mockImplementation(async id => { const record = await read(id); return id === 'recipient' && record ? { ...record, run: { runId: 'run-caller' } } : record })
      await expect(h.client.statusAgent('recipient')).rejects.toMatchObject({ code: 'AGENT_SESSION_IDENTITY_CONFLICT' })
      expect(h.client.agentSession('recipient')).toEqual(before)
      h.metadata.mockImplementation(read)
      expect((await h.client.statusAgent('recipient')).run.runId).toBe('run-recipient')
      expect((await h.client.statusAgent('caller')).run.state).toBe('running')
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it('reauthorizes the exact durable capability and never substitutes a stale cache after a read failure', async () => {
    const h = await fixture()
    try {
      const execute = vi.fn(async () => ({ operation: 'space.ls' as const, catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] } }))
      const service = new AgentMuxRpcService({ coreClients: h.coreClients, execute })
      await service.call('space.ls', { target: {} }, { caller: h.credentials })
      await h.rpc.call('message.read', { operationId: 'source-operation' })
      const previous = (await h.store.load()).find(session => session.agentSessionId === 'caller')!
      const nextCapability = core.issueAgentCapability()
      await h.store.compareAndSwap(previous, { ...previous, capabilityHash: core.hashAgentCapability(nextCapability), updatedAt: previous.updatedAt + 1 })
      h.clear()
      await expect(h.rpc.call('message.read', { operationId: 'source-operation' })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
      await expect(service.call('space.ls', { target: {} }, { caller: h.credentials })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
      expect(execute).toHaveBeenCalledOnce()
      expect(h.inventories).not.toHaveBeenCalled()
      const current = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: h.path }, credentials: { ...h.credentials, capability: nextCapability } })
      try {
        expect((await current.call('message.read', { operationId: 'source-operation' })).message!.envelope.messageId).toBe('source')
        h.metadata.mockRejectedValueOnce(new core.AgentMuxError('Exact authority read is unconfirmed.', 'AGENT_SESSION_STORE_READ_UNCONFIRMED'))
        await expect(current.call('message.read', { operationId: 'source-operation' })).rejects.toMatchObject({ code: 'AGENT_SESSION_STORE_READ_UNCONFIRMED' })
        expect((await current.call('message.read', { operationId: 'source-operation' })).message!.envelope.messageId).toBe('source')
      } finally { await current.dispose() }
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it.each(['identity', 'host'] as const)('rejects a mismatched exact authenticated %s returned by a single Host port', async mismatch => {
    const h = await fixture()
    try {
      const original = h.client.agentSession('caller')
      vi.spyOn(h.client, 'authorizeRetainedAgentCaller').mockResolvedValue({ ...original,
        ...(mismatch === 'identity' ? { agentSessionId: 'another-session' } : { hostId: 'another-host' }) })
      await expect(h.rpc.call('message.read', { operationId: 'source-operation' })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
      expect(h.inventories).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it('keeps prefix rejection and multi-Host ambiguity in the original discovery boundary', async () => {
    const h = await fixture(), other = await rpcOwnerFixture(['caller'], core)
    try {
      const alias = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: h.path }, credentials: { ...h.credentials, agentSessionId: 'call' } })
      try { await expect(alias.call('message.read', { operationId: 'source-operation' })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' }) }
      finally { await alias.dispose() }
      expect(h.inventories).toHaveBeenCalled()
      const remote = new Proxy(other.client, { get(target, property) {
        if (property === 'forwardRpc') return async () => { throw new Error('No operation can cross an ambiguous owner') }
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
      } }) as unknown as AgentMuxRpcCorePort
      const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: h.client }, { hostId: 'remote', client: remote }] })
      await expect(service.call('message.read', { operationId: 'source-operation' }, { caller: h.credentials })).rejects.toMatchObject({ code: 'AMBIGUOUS_AGENT_SESSION' })
      expect(h.inner.kernel.stop).not.toHaveBeenCalled(); expect(other.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await other.close(); await h.close() }
  })

  it('keeps an unverified endpoint unknown instead of authenticating through its cached inventory', async () => {
    const h = await fixture()
    try {
      const authorize = vi.spyOn(h.client, 'authorizeRetainedAgentCaller')
      const unverified = new Proxy(h.client, { get(target, property) {
        if (property === 'runtimeOwnerIdentity') return () => ({ availability: 'unverified' })
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
      } }) as unknown as AgentMuxRpcCorePort
      const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: unverified }] })
      await expect(service.call('message.read', { operationId: 'source-operation' }, { caller: h.credentials })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
      expect(authorize).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })
})
