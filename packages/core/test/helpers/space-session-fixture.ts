import { vi } from 'vitest'
import type { AdoptedHostRoute } from '../../src/host-route.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hashAgentCapability } from '../../src/agent-capability.js'
import { AgentMuxClient } from '../../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../../src/agent-session-store.js'
import { AgentMuxHostedRuntimeService } from '../../src/hosted-runtime-service.js'
import { AgentMuxControlServer } from '../../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../src/public-rpc-client.js'
import { AgentMuxSpatialStateStore } from '../../src/spatial-state.js'
import type { AgentMuxAgentSessionRegistry } from '../../src/agent-session-registry.js'
import type { AgentMuxStoredAgentSession } from '../../src/types.js'
import type { AgentMuxRuntimeSubject } from '../../src/runtime.js'
import type { AgentMuxRpcCoreClient } from '../../src/public-rpc-service.js'


async function coreFixture(cleanup: Array<() => unknown | Promise<unknown>>, runtimeId: string, clients: () => AgentMuxRpcCoreClient[] = () => [], authoritySocketPath?: string) {
  const root = await mkdtemp(join(tmpdir(), 'amx-space-sessions-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  const core = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore(), providers: [] }); cleanup.push(() => core.dispose())
  const inner = core as unknown as { registry: AgentMuxAgentSessionRegistry; publishSession(session: AgentMuxStoredAgentSession): void }
  const owner = { runtimeId, ownerInstanceId: runtimeId + '-instance', protocolVersion: 2 as const, processId: process.pid, ctxmux: null, availability: 'connected' as const }
  vi.spyOn(core, 'connectRuntime').mockResolvedValue()
  const inventory = vi.spyOn(core, 'readAgentSessions').mockRejectedValue(Error('A Space reader must not enumerate unrelated Sessions.'))
  const runs = vi.spyOn(core, 'listRuns').mockRejectedValue(Error('A Space reader must not enumerate all Native Runs.'))
  const all = vi.spyOn(core, 'runtimeProjection').mockRejectedValue(Error('A Space reader must not read a whole Runtime projection.'))
  // Native/ctxmux process state is the explicit external leaf in this metadata proof.
  // The separate native driver proves actual Runs and control effects.
  vi.spyOn(core, 'runtimeSubject').mockImplementation(async target => {
    if (target.kind !== 'agent-session') throw Error('Expected the exact selected Session')
    const session = await core.readAgentSession(target.agentSessionId)
    if (!session) throw Error('Exact original Session is absent')
    return { kind: 'agent', subjectId: session.agentSessionId, hostId: 'local', workspacePath: session.workspacePath,
      providerId: session.providerId, executorId: session.executorId, agentSession: session, run: { ...session.run,
        kind: 'agent', nativeService: null, providerId: session.providerId, executorId: session.executorId,
        agentSessionId: session.agentSessionId, workspacePath: session.workspacePath, pid: 10, state: 'running', cols: 80, rows: 24,
        observedAt: 1, latestOutputBytes: 0, acceptedInputBytes: 0 } } as AgentMuxRuntimeSubject
  })
  const hosted = new AgentMuxHostedRuntimeService(core, null, () => owner); cleanup.push(() => hosted.dispose())
  const serverOptions = { socketPath: join(root, 'rpc.sock'), spatialState: spatial, coreClients: () => [{ hostId: 'local', client: core }, ...clients()], ...(authoritySocketPath ? { forwardingPeer: { authoritySocketPath } } : {}), hostedRuntime: () => hosted }
  let server = new AgentMuxControlServer(serverOptions)
  cleanup.push(() => server.stop()); await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const put = async (id: string, updatedAt = 1) => {
    const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: id, hostId: 'local', providerId: 'codex', executorId: 'test-executor',
      workspacePath: '/' + runtimeId + '/home', capabilityHash: hashAgentCapability('private-original-capability'), hookBindingId: 'private-binding', hookToken: 'private-token', run: { runId: runtimeId + '-run-' + id }, retiredRuns: [], createdAt: 1, updatedAt }
    const previous = await core.readAgentSession(id); await inner.registry.put(session, previous?.run); inner.publishSession(session); return session
  }
  return { root, spatial, core, hosted, rpc, get server() { return server }, owner, inventory, runs, all, put,
    disconnect: async () => { await server.stop() },
    reconnect: async () => { owner.ownerInstanceId += '-renewed'; server = new AgentMuxControlServer(serverOptions); await server.start() } }
}
export async function createSpaceSessionsFixture(cleanup: Array<() => unknown | Promise<unknown>>) {
  const remotes: AgentMuxRpcCoreClient[] = []
  const b = await coreFixture(cleanup, 'runtime-b', () => remotes)
  const d = await coreFixture(cleanup, 'runtime-d', () => [], b.server.path)
  remotes.push({ hostId: 'D-in-B', client: { forwardRpc: d.rpc.call.bind(d.rpc), subscribeRpc: d.rpc.subscribe.bind(d.rpc) } } as AgentMuxRpcCoreClient)
  const folder = await b.spatial.registerFolder({ id: 'original-b-project', hostId: 'local', name: 'B project', path: '/b/project' })
  const reference = { runtimeId: b.owner.runtimeId, spaceId: folder.spaceId }
  const admit = async (hostId: string, runtimeId: string, sid: string, operationId: string, adoptedRoute?: AdoptedHostRoute) => {
    const admitted = await b.spatial.admitAgentOpen({ request: { schemaVersion: 5, requestId: operationId, operation: 'agent.open',
      content: { kind: 'new-agent', executorId: 'test-executor', ...(hostId === 'local' ? {} : { agentTarget: { hostId, runtimeId, ...(adoptedRoute ? { adoptedRoute } : {}) } }) },
      destination: { spaceId: folder.spaceId, zoneId: folder.zoneId, newTab: true }, focus: false }, agentSessionId: sid,
      execution: { hostId, runtimeId, ...(adoptedRoute ? { adoptedRoute } : {}), executorRevision: 'original-executor-revision', workspacePath: hostId === 'local' ? '/b/project' : '/runtime-d/home', workspaceId: hostId === 'local' ? 'original-b-project' : null },
      ...(hostId === 'local' ? {} : { placement: { runtimeId: b.owner.runtimeId, hostId: 'local', workspacePath: '/b/project', workspaceId: 'original-b-project' } }), regionResource: {} })
    return admitted.record
  }
  return { b, d, reference, admit }
}
