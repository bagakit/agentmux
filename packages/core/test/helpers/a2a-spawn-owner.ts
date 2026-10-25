import { join } from 'node:path'
import { vi } from 'vitest'
import { AgentMuxClient } from '../../src/client.js'
import { AgentMuxControlServer } from '../../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../src/public-rpc-client.js'
import { AgentMuxSpatialStateStore } from '../../src/spatial-state.js'
import { AgentMuxCreationAuthority } from '../../src/agent-creation-authority.js'
import { AgentMuxHostExecutorOwner } from '../../src/executor-owner.js'
import type { AgentMuxAgentCreateInput } from '../../src/client.js'
import type { AgentMuxAgentSession } from '../../src/types.js'
import type { CtxmuxAdapterRun } from '../../src/ctxmux-run-adapter.js'
import { rpcOwnerFixture } from './public-rpc-owner.js'

export async function spawnOwnerFixture(cleanups: Array<() => Promise<void>>, remote = false) {
  let h = await rpcOwnerFixture(['creator', 'unrelated'])
  cleanups.push(h.close)
  if (remote) {
    const catalog = () => h.client.catalog()
    const owner = new AgentMuxHostExecutorOwner({ path: join(h.root, 'executors.json'), runtimeId: 'target-runtime', catalog })
    const client = new AgentMuxClient({ store: h.store, hostExecutorOwner: owner,
      creationAuthority: new AgentMuxCreationAuthority({ stateDirectory: join(h.root, 'target-authority'), runtimeId: 'target-runtime' }) })
    const inner = client as unknown as typeof h.inner
    await inner.registry.load('local'); inner.connected = true
    Object.assign(inner.kernel, h.inner.kernel)
    h = { ...h, client, inner, coreClients: () => [{ hostId: 'local', client }] }
    cleanups.push(() => client.dispose())
    await client.configureHostExecutor({ executorId: 'private-executor', config: { label: 'Private fixture', providerId: 'claude',
      command: '/bin/sh', args: [], env: {}, injectAgentMuxGuide: false } })
  }
  const inner = h.client as unknown as { hookServer: Record<string, unknown>; ensureManagedHooks: unknown;
    ensureTerminalHandshakeOrDegrade: unknown }
  const runs: CtxmuxAdapterRun[] = [], launches: Array<{ env: Record<string, string>; args: readonly string[] }> = []
  const start = vi.fn(async (input: { operationKey: string; cwd: string; program: string; args: readonly string[]; env: Record<string, string> }) => {
    launches.push(input)
    const run: CtxmuxAdapterRun = { ...h.run('child-run-' + launches.length), program: input.program,
      args: [...input.args], workspacePath: input.cwd, lifecycleOperationId: input.operationKey }
    runs.push(run); return run
  })
  Object.assign(h.inner.kernel, { start, list: vi.fn(async () => runs),
    prepareStop: vi.fn(async (runId: string, operationKey: string) => ({ daemonInstance: 'fixture-runtime', operationKey, runId })) })
  inner.hookServer.isRunning = () => true
  inner.hookServer.createBinding = () => ({ bindingId: 'b'.repeat(43),
    endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
  inner.ensureManagedHooks = async () => {}
  inner.ensureTerminalHandshakeOrDegrade = async (session: AgentMuxAgentSession) => session
  vi.spyOn(h.client as unknown as { probePreparedAgent: typeof h.client.probeAgent }, 'probePreparedAgent').mockImplementation(async providerId => ({ providerId, executable: providerId,
    installed: true, capabilities: h.client.providers.get(providerId).catalog.capabilities }))
  const spatial = new AgentMuxSpatialStateStore(join(h.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: { spaces: [], zones: [], bindings: [], layouts: {},
    tabs: [], regions: [], tabLayouts: {}, resources: { draft: 'Preserve the unfinished user request.' } } })
  const server = new AgentMuxControlServer({ spatialState: spatial, coreClients: h.coreClients, socketPath: join(h.root, 'spawn.sock') })
  await server.start(); cleanups.push(() => server.stop())
  const endpoint = { transport: 'unix' as const, path: server.path }
  const rpc = await connectAgentMuxRpc({ endpoint, credentials: h.credentials }); cleanups.push(() => rpc.dispose())
  const create = (overrides: Partial<AgentMuxAgentCreateInput> = {}, separateCreator = true) => h.client.createAgentWithDelivery({
    agentSessionId: 'child', createOperationId: 'original-spawn', providerId: 'claude', executorId: 'private-executor',
    workspacePath: h.root, injectAgentMuxGuide: false,
    ...(separateCreator ? { creationCaller: { agentSessionId: 'creator', capability: h.capability } } : {}), ...overrides })
  return { ...h, start, runs, launches, create, rpc, endpoint, spatial }
}
