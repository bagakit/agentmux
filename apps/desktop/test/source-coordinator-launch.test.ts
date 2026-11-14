import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { AgentMuxMemoryAgentSessionStore, LocalExecutionHost } from '@agentmux/core'
import { AgentMuxHostExecutorOwner } from '../../../packages/core/src/executor-owner'
import { AgentProviderRegistry } from '../../../packages/core/src/agent-provider'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client'
import { createSpaceSessionsFixture } from '../../../packages/core/test/helpers/space-session-fixture'
import { RuntimeController } from '../src/main/runtime-controller'
import type { AgentLaunchInput } from '../src/shared/contracts'
import { DEFAULT_CONFIG } from '../src/main/config-store'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

async function fixture() {
  const f = await createSpaceSessionsFixture(cleanup), a = f.b, b = f.d, home = join(a.root, 'original-home')
  // The existing agentCreationAuthority invocation prepares session observation;
  // this metadata fixture controls that Native leaf, as it already controls
  // connectRuntime. It does not replace Main or public RPC authorization.
  vi.spyOn(a.core, 'connect').mockResolvedValue(); vi.spyOn(b.core, 'connect').mockResolvedValue()
  Object.assign(a.core, { hostExecutorOwner: new AgentMuxHostExecutorOwner({ path: join(a.root, 'executors.json'), runtimeId: a.owner.runtimeId,
    catalog: () => new AgentProviderRegistry().catalog() }) })
  await a.core.configureHostExecutor({ executorId: 'original-executor', config: { providerId: 'claude', label: 'Original A Executor', command: '/private/unlaunched-cli', args: [], env: {}, injectAgentMuxGuide: false } })
  const descriptor = (await a.core.listHostExecutors({ executorId: 'original-executor', refresh: false })).executors[0]!
  const homeRead = vi.spyOn(a.core, 'hostEnvironment').mockResolvedValue({ homeDirectory: home })
  // The Resource control identity and final Coordinator dispatch are explicit
  // leaves. Host SDK/public Unix framing and Main validation remain production.
  vi.spyOn(b.core, 'agentCreationAuthority').mockResolvedValue({ runtimeId: b.owner.runtimeId, publicKey: 'private-resource-key', fingerprint: 'private-resource-fingerprint' })
  const client = async (owner: typeof a) => await connectHostedAgentMux({ rpc: owner.rpc, expectedRuntimeId: owner.owner.runtimeId, connectOnDemand: true,
    forwardRpc: (method, params, context, fence) => owner.rpc.call(method, params, { ...context, ...(fence ? { runtimeFence: fence } : {}) }) })
  const aClient = await client(a), bClient = await client(b)
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), async () => { throw Error('No implicit Host acquisition in this consumer') })
  Object.assign(runtime, { hosts: new Map([['local', { client: aClient, config: DEFAULT_CONFIG.hosts[0]!, executionHost: new LocalExecutionHost(), unsubscribe: () => {}, historyObservationDisposers: new Set() }],
    ['source-B', { client: bClient, config: { id: 'source-B', kind: 'ssh', label: 'Original B', hostname: 'private.invalid' }, executionHost: new LocalExecutionHost(), unsubscribe: () => {}, historyObservationDisposers: new Set() }]]) })
  cleanup.push(() => runtime.dispose())
  const resource = { id: 'original-B-project', hostId: 'source-B', name: 'Original B project', path: '/original/B/project', kind: 'folder' as const }
  const config = { ...DEFAULT_CONFIG, hosts: [DEFAULT_CONFIG.hosts[0]!, { id: 'source-B', kind: 'ssh' as const, label: 'Original B', hostname: 'private.invalid' }], workspaces: [resource] }
  const input: AgentLaunchInput = { executorId: descriptor.executorId, executorRevision: descriptor.configRevision, hostId: 'local', workspacePath: home,
    agentSessionId: 'original-A-session', createOperationId: 'original-A-create', prompt: '  exact original task\n', agentMuxNote: ' Separate original note\n', launchOptions: { model: 'retained-original-choice' },
    toolWorkspace: { id: resource.id, hostId: resource.hostId, path: resource.path },
    sourceCoordinator: { hostId: 'local', runtimeId: a.owner.runtimeId, resourceRuntimeId: b.owner.runtimeId, workingDirectory: 'device-home' } }
  const create = vi.fn(async (_input: Parameters<NonNullable<Parameters<RuntimeController['launchAgent']>[3]>['create']>[0]) => { throw Error('Private original Coordinator dispatch reached') })
  return { ...f, a, b, homeRead, runtime, resource, config, input, create }
}

it('the real Main creation owner accepts an exact Source resource and independent Coordinator home without a fake A project', async () => {
  const f = await fixture()
  await expect(f.runtime.launchAgent(f.input, f.config, undefined, { create: f.create })).rejects.toThrow('Private original Coordinator dispatch reached')
  expect(f.create).toHaveBeenCalledOnce(); expect(f.homeRead).toHaveBeenCalledOnce()
  expect(f.create.mock.calls[0]![0]).toMatchObject({ agentHostId: 'local', agentRuntimeId: f.a.owner.runtimeId,
    resourceHostId: 'source-B', resourceRuntimeId: f.b.owner.runtimeId, resourceWorkspacePath: f.resource.path,
    agent: { agentSessionId: f.input.agentSessionId, createOperationId: f.input.createOperationId, workspacePath: f.input.workspacePath,
      prompt: f.input.prompt, agentMuxNote: f.input.agentMuxNote, launchOptions: f.input.launchOptions } })
  expect(f.config.workspaces).toEqual([f.resource]); expect(f.a.runs).not.toHaveBeenCalled(); expect(f.b.runs).not.toHaveBeenCalled()
})

it.each(['A-Runtime', 'B-Runtime', 'Executor-Runtime', 'A-home', 'managed'] as const)('the original Main owner rejects only a wrong %s Reach attempt before Coordinator dispatch', async wrong => {
  const f = await fixture(), input = { ...f.input, sourceCoordinator: { ...f.input.sourceCoordinator! } }
  if (wrong === 'A-Runtime') input.sourceCoordinator.runtimeId = 'other-A-Runtime'
  if (wrong === 'B-Runtime') input.sourceCoordinator.resourceRuntimeId = 'other-B-Runtime'
  if (wrong === 'Executor-Runtime') vi.spyOn(f.a.core, 'listHostExecutors').mockResolvedValueOnce({ ...await f.a.core.listHostExecutors({ executorId: input.executorId }), runtimeId: 'other-Executor-Runtime' })
  if (wrong === 'A-home') input.workspacePath = '/another/home'
  if (wrong === 'managed') input.creationCaller = { agentSessionId: 'managed-caller', capability: 'private-caller' }
  await expect(f.runtime.launchAgent(input, f.config, undefined, { create: f.create })).rejects.toHaveProperty('code')
  expect(f.create).not.toHaveBeenCalled()
  await expect(f.runtime.launchAgent(f.input, f.config, undefined, { create: f.create })).rejects.toThrow('Private original Coordinator dispatch reached')
  expect(f.create).toHaveBeenCalledOnce(); expect(f.a.runs).not.toHaveBeenCalled(); expect(f.b.runs).not.toHaveBeenCalled()
})

it('an unchanged old toolWorkspace request still requires its original registered execution project', async () => {
  const f = await fixture(), { sourceCoordinator: _new, ...legacy } = f.input
  await expect(f.runtime.launchAgent(legacy, f.config, undefined, { create: f.create })).rejects.toMatchObject({ code: 'EXECUTION_BINDING_MISMATCH' })
  expect(f.create).not.toHaveBeenCalled(); expect(f.homeRead).not.toHaveBeenCalled()
})
