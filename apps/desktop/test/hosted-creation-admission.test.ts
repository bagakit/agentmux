// @vitest-environment happy-dom
import { bridge, owningBridge } from './helpers/first-execution-ipc-bridge.js'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { BrowserProfileManager } from '../src/main/browser-profile-manager.js'
import type { AgentLaunchInput, AppConfig } from '../src/shared/contracts.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client.js'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service.js'
import { AgentExecutionBindingService } from '../../../packages/core/src/agent-execution-coordinator.js'
import type { AgentMuxHostedRpcPort } from '../../../packages/core/src/hosted-client-contract.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })

async function owner(role: string) {
  const f = await rpcOwnerFixture(['retained-' + role])
  cleanups.push(() => f.close())
  const identity = { runtimeId: role + '-runtime', ownerInstanceId: role + '-instance', protocolVersion: 2 as const,
    processId: process.pid, availability: 'connected' as const, ctxmux: f.client.runtimeIdentity() }
  const service = new AgentMuxHostedRuntimeService(f.client, join(f.root, 'sessions.json'), () => ({ ...identity }))
  cleanups.push(() => service.dispose())
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'consumer.sock'), hostedRuntime: () => service, coreClients: f.coreClients })
  cleanups.push(() => server.stop()); await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  cleanups.push(() => rpc.dispose())
  const invocations: unknown[] = [], observations = vi.fn(async () => { throw new Error('General Host observation unavailable') })
  const port: AgentMuxHostedRpcPort = {
    call: async (method, params, options) => { if (method === 'runtime.invoke') invocations.push(structuredClone(params)); return rpc.call(method, params, options) },
    subscribe: async (...args) => { if (args[0] === 'runtime.events') return observations(); return rpc.subscribe(...args) }
  }
  const client = await connectHostedAgentMux({ rpc: port, expectedRuntimeId: identity.runtimeId, waitForReady: false })
  cleanups.push(() => client.dispose())
  // The actual Hosted SDK, Unix RPC dispatcher, Runtime owner fence and Main run.
  // These domain response leaves are controlled; no Provider or Native Agent is started.
  const inventory = vi.spyOn(f.client, 'listHostExecutors').mockResolvedValue({ runtimeId: identity.runtimeId, executors: [{
    executorId: 'original-executor', label: 'Original', providerId: 'codex', command: '/bin/sh', source: 'registered',
    configRevision: role + '-revision', availability: 'available'
  }] })
  const authority = vi.spyOn(f.client, 'agentCreationAuthority').mockResolvedValue({ runtimeId: identity.runtimeId, publicKey: 'controlled-public-key' })
  const create = vi.spyOn(f.client, 'createHostAgentWithDelivery').mockImplementation(async input => {
    const original = f.client.agentSession('retained-' + role)!
    const creation = { createOperationId: input.createOperationId!, initialPrompt: 'not-requested' as const }
    return { session: { ...original, agentSessionId: input.agentSessionId!, workspacePath: input.workspacePath, creation }, creation }
  })
  let helperStarted = false
  const helperRun = { runId: role + '-helper-run', kind: 'terminal' as const, providerId: null, executorId: null, agentSessionId: null,
    workspacePath: f.root, pid: null, state: 'running' as const, cols: 80, rows: 24, observedAt: Date.now(), latestOutputBytes: 0, acceptedInputBytes: 0 }
  const prepare = vi.spyOn(f.client, 'prepareAgentExecutionHelper').mockImplementation(async input => ({
    bindingId: input.bindingId, role: input.role, providerId: input.providerId,
    prepared: { createOperationId: input.createOperationId, workspacePath: input.workspacePath, launch: 'controlled-native-leaf' }
  }))
  const start = vi.spyOn(f.client, 'createPreparedTerminal').mockImplementation(async () => { helperStarted = true; return helperRun })
  vi.spyOn(f.client, 'inspectPreparedTerminal').mockImplementation(async () => helperStarted ? helperRun : null)
  vi.spyOn(f.client, 'attachTerminal').mockResolvedValue({ run: helperRun, gap: null, replay: [] })
  vi.spyOn(f.client, 'refreshRunAttachment').mockResolvedValue({ run: helperRun, gap: null, replay: [] })
  vi.spyOn(f.client, 'readRunReplay').mockResolvedValue({ run: helperRun, gap: null, replay: [] })
  // This environment accessor is a local fixture path; event observation stays unavailable.
  Object.assign(client, { agentMessageQueuePath: () => f.client.agentMessageQueuePath() })
  return { ...f, client, core: f.client, identity, observations, inventory, authority, create, invocations, prepare, start }
}

async function fixture(registerController = true) {
  const agent = await owner('agent'), resource = await owner('resource')
  const controller = new RuntimeController(agent.store, async () => { throw new Error('Only exact supplied owners are available') })
  const hosts: AppConfig['hosts'] = [{ id: 'remote-agent', kind: 'ssh', label: 'Agent', hostname: 'private.invalid' }, { id: 'local', kind: 'local', label: 'Tools' }]
  const config: AppConfig = { version: 9, hosts, executors: {}, workspaces: [
    { id: 'agent-workspace', hostId: hosts[0]!.id, name: 'Agent', kind: 'folder', path: agent.root },
    { id: 'tools-workspace', hostId: 'local', name: 'Tools', kind: 'folder', path: resource.root }
  ], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  if (registerController) controller.commit({ hosts: hosts.map((host, index) => ({ id: host.id, config: host, client: index === 0 ? agent.client : resource.client,
    executionHost: { kind: host.kind, dispose: vi.fn() } as never })), removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  cleanups.push(() => controller.dispose())
  const request: AgentLaunchInput = { executorId: 'original-executor', executorRevision: 'agent-revision', hostId: 'remote-agent',
    workspacePath: agent.root, executionWorkspaceId: 'agent-workspace', agentSessionId: 'original-new-session', createOperationId: 'original-create-operation',
    toolWorkspace: { id: 'tools-workspace', hostId: 'local', path: resource.root } }
  return { controller, config, request, agent, resource }
}

it('actual registered IPC and durable binding create through two Hosted RPC fences while general observation rejects', async () => {
  const f = await fixture(false)
  // The reused IPC fixture controls Browser/Profile IO outside this consumer.
  Object.defineProperty(BrowserProfileManager.prototype, 'cookieFiles', { configurable: true, value: { setFileOwner: vi.fn(), setConfirmationHandler: vi.fn() } })
  Object.defineProperty(BrowserProfileManager.prototype, 'extensions', { configurable: true, value: { setConfirmationHandler: vi.fn() } })
  const original = await owningBridge({ client: f.resource.client, store: f.agent.store, config: f.config })
  cleanups.push(() => original.dispose())
  const host = f.config.hosts[0]!
  original.runtime.commit({ hosts: [{ id: host.id, config: host, client: f.agent.client,
    executionHost: { kind: host.kind, dispose: vi.fn() } as never }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  await expect(f.agent.client.connect()).rejects.toThrow('General Host observation unavailable')
  await expect(f.resource.client.connect()).rejects.toThrow('General Host observation unavailable')
  const launch = bridge.api!.sessions.launchAgent(f.request)
  await expect(launch).resolves.toMatchObject({ created: { agentSessionId: f.request.agentSessionId }, creation: { createOperationId: f.request.createOperationId } })
  const result = await launch
  expect(result.created.agentSessionId).toBe(f.request.agentSessionId)
  expect(result.creation?.createOperationId).toBe(f.request.createOperationId)
  const db = new DatabaseSync(join(dirname(original.workbenchUserState.path), 'execution-bindings', 'bindings.sqlite'), { readOnly: true })
  try {
    const rows = db.prepare('SELECT input FROM binding_intents').all()
    expect(rows).toHaveLength(1)
    expect(JSON.parse(String(rows[0]!.input))).toMatchObject({ agentHostId: 'remote-agent', agentRuntimeId: 'agent-runtime', resourceHostId: 'local', resourceRuntimeId: 'resource-runtime',
      agent: { agentSessionId: f.request.agentSessionId, createOperationId: f.request.createOperationId } })
  } finally { db.close() }
  for (const endpoint of [f.agent, f.resource]) {
    expect(endpoint.observations).toHaveBeenCalled()
    expect(endpoint.invocations.length).toBeGreaterThan(0)
    for (const invocation of endpoint.invocations) expect(invocation).toMatchObject({ fence: { runtimeId: endpoint.identity.runtimeId, ownerInstanceId: endpoint.identity.ownerInstanceId } })
  }
  expect(f.agent.inventory).toHaveBeenCalledTimes(2); expect(f.resource.authority).toHaveBeenCalledTimes(2); expect(f.agent.create).toHaveBeenCalledOnce()
  for (const endpoint of [f.agent, f.resource]) { expect(endpoint.prepare).toHaveBeenCalledOnce(); expect(endpoint.start).toHaveBeenCalledOnce() }
})

it('the actual Runtime rejects a replaced owner before exact creation and never retries', async () => {
  const f = await fixture()
  await f.agent.client.agentCreationAuthority()
  f.agent.identity.ownerInstanceId = 'replacement-owner'
  await expect(f.controller.launchAgent(f.request, f.config, undefined, { create: vi.fn() })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
  expect(f.agent.inventory).not.toHaveBeenCalled(); expect(f.agent.create).not.toHaveBeenCalled()
  expect(f.request).toMatchObject({ agentSessionId: 'original-new-session', createOperationId: 'original-create-operation' })
})

it('the durable binding owner retains UNKNOWN_HOST for an unavailable original Main route', async () => {
  const f = await fixture()
  const binding = new AgentExecutionBindingService(join(f.agent.root, 'unknown-bindings'), { resolveHost: id => f.controller.executionBindingHost(id) })
  cleanups.push(() => binding.dispose())
  await expect(binding.create({ bindingId: 'original-unknown-binding', agentHostId: 'missing-original-host', agentRuntimeId: 'missing-runtime',
    resourceHostId: 'local', resourceRuntimeId: 'resource-runtime', resourceWorkspacePath: f.resource.root,
    resourceGrant: { scope: 'host-user', bindingId: 'original-unknown-binding' },
    agent: { executorId: f.request.executorId, executorRevision: 'agent-revision', workspacePath: f.agent.root,
      agentSessionId: f.request.agentSessionId!, createOperationId: f.request.createOperationId! }
  })).rejects.toMatchObject({ code: 'UNKNOWN_HOST' })
  expect((await binding.inspect('original-unknown-binding'))?.diagnostic?.code).toBe('UNKNOWN_HOST')
  expect(f.agent.create).not.toHaveBeenCalled(); expect(f.agent.start).not.toHaveBeenCalled(); expect(f.resource.start).not.toHaveBeenCalled()
})
