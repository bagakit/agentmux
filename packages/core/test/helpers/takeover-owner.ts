import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostSpatialAgentControl } from '../../../../apps/host/src/spatial-agent-control.js'
import { AgentMuxControlServer } from '../../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../src/public-rpc-client.js'
import { AgentMuxSpatialStateStore } from '../../src/spatial-state.js'
import { AgentMuxHostedRuntimeService } from '../../src/hosted-runtime-service.js'
import { AgentMuxHostExecutorOwner } from '../../src/executor-owner.js'
import { AgentMuxCreationAuthority } from '../../src/agent-creation-authority.js'
import { creationInputOwner } from './creation-input-owner.js'

/** Real original Core/Host admission and first input with an isolated deterministic Native port. */
export async function createTakeoverOwnerFixture(cleanup: Array<() => unknown | Promise<unknown>>, options: { authoritySocketPath?: string; postLaunch?: boolean; runtimeId?: string } = {}) {
  const h = await creationInputOwner(options.postLaunch); cleanup.push(() => h.close())
  const runtimeId = options.runtimeId ?? 'original-takeover-core', owner = { runtimeId, ownerInstanceId: 'original-takeover-instance', protocolVersion: 2 as const, processId: process.pid, ctxmux: null, availability: 'connected' as const }
  h.inner.creationAuthority = new AgentMuxCreationAuthority({ stateDirectory: join(h.root, 'creation-authority'), runtimeId })
  const executors = new AgentMuxHostExecutorOwner({ path: join(h.root, 'executors.json'), runtimeId, catalog: () => h.client.catalog() })
  await executors.configure({ executorId: 'codex', config: { label: 'Original executor', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: false } }); h.inner.hostExecutorOwner = executors
  const spatial = new AgentMuxSpatialStateStore(join(h.root, 'spatial.json'))
  const source = (await h.client.readAgentSession('source'))!, a = await spatial.registerFolder({ id: 'project-a', hostId: 'local', path: source.workspacePath, name: 'A' })
  const directory = join(h.root, 'target-project'); await mkdir(directory)
  const b = await spatial.registerFolder({ id: 'project-b', hostId: 'local', path: directory, name: 'B' })
  const state = (await spatial.read())!, graph = state.graph
  graph.tabs.push({ tabId: 'original-tab', workspaceId: 'project-a', zoneId: a.zoneId, name: null, regionIds: ['original-region'] })
  graph.regions.push({ tabId: 'original-tab', regionId: 'original-region', kind: 'agent', agentSessionId: source.agentSessionId, runId: source.run.runId, execution: { hostId: 'local', runtimeId, cwd: source.workspacePath } })
  graph.layouts['project-a'] = { root: { type: 'leaf', groupId: 'original-group' }, activeGroupId: 'original-group', groups: [{ id: 'original-group', activeTabId: 'original-tab', tabOrder: ['original-tab'], recentTabIds: ['original-tab'] }] }
  graph.tabLayouts['original-tab'] = { root: { type: 'leaf', regionId: 'original-region' }, activeRegionId: 'original-region' }; graph.resources['region:original-region'] = { draft: 'Keep the unsent original.', workspaceId: 'project-a' }; graph.resources['tab:original-tab'] = { titleRegionId: 'original-region' }
  await spatial.commit({ expectedRevision: state.revision, graph })
  const configurationPath = join(h.root, 'config.json'); await writeFile(configurationPath, JSON.stringify({ workspaces: [{ id: 'project-a', hostId: 'local', path: source.workspacePath }, { id: 'project-b', hostId: 'local', path: directory }], promotion: { enabled: true } }))
  const extraClients: import('../../src/public-rpc-service.js').AgentMuxRpcCoreClient[] = []
  let server: AgentMuxControlServer
  const runtime = { client: h.client, ownerIdentity: () => owner, get server() { return server } }
  const hosted = new AgentMuxHostedRuntimeService(h.client, null, () => owner); cleanup.push(() => hosted.dispose())
  server = new AgentMuxControlServer({ socketPath: join(h.root, 'takeover.sock'), ...(options.authoritySocketPath ? { forwardingPeer: { authoritySocketPath: options.authoritySocketPath } } : {}), spatialState: spatial, coreClients: () => [{ hostId: 'local', client: h.client }, ...extraClients], hostedRuntime: () => hosted,
    executionBindings: { inspect: (...args: Parameters<import('../../src/agent-execution-coordinator.js').AgentExecutionBindingService['inspect']>) => (runtime as unknown as import('../../src/headless-runtime.js').AgentMuxHeadlessRuntime).executionBindings.inspect(...args) } as never,
    forwardControl: async () => { throw Error('Takeover must stay on the original Core/Host owner, without a focused Renderer creator.') },
    spatialAgentControl: createHostSpatialAgentControl({ configurationPath, spatial, runtime: () => runtime as never }) })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  return { ...h, rpc, spatial, a, b, source, owner, configurationPath, directory, endpointPath: server.path, runtime, extraClients }
}
