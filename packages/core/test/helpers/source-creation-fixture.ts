import { vi, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxError } from '@agentmux/core'
import { AgentMuxControlServer } from '../../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../src/public-rpc-client.js'
import { AgentMuxSpatialStateStore } from '../../src/spatial-state.js'
import { createHostSpatialAgentControl } from '../../../../apps/host/src/spatial-agent-control.js'
import type { AgentMuxHeadlessRuntime } from '../../src/headless-runtime.js'
import type { AgentExecutionOpenInput } from '../../src/agent-execution-coordinator.js'
import type { AgentMuxAgentSession, AgentMuxAgentCreationInspection } from '../../src/types.js'

/** This preflight isolates spatial ownership: target control/Native creation are
 * explicit leaves. It is not the separate two-Core Native execution proof. */
export async function sourceCreationFixture(releases: Array<() => unknown | Promise<unknown>>, sourceContext = '  Source business context\n') {
  const root = await mkdtemp(join(tmpdir(), 'amx-spatial-target-')); releases.push(() => rm(root, { recursive: true, force: true }))
  const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  const folder = await spatial.registerFolder({ id: 'b-workspace', hostId: 'local', name: 'B project', path: '/b/project' })
  let retired: AgentMuxAgentCreationInspection | undefined
  let observed: AgentMuxAgentSession | undefined, runtimeId = 'runtime-d', pending = false, partialAfterStart = false, bindingConnected = false, frozen: AgentExecutionOpenInput | undefined
  const create = vi.fn(async (input: AgentExecutionOpenInput['agent']) => {
    observed = { kind: 'agent', agentSessionId: input.agentSessionId, hostId: 'local', providerId: 'codex', executorId: input.executorId,
      workspacePath: input.workspacePath, run: { runId: 'original-d-run' }, createdAt: 1, updatedAt: 1, retiredRuns: [],
      ...(frozen ? { toolExecution: { bindingId: frozen.bindingId, resourceHostId: frozen.resourceHostId, resourceRuntimeId: frozen.resourceRuntimeId, workspacePath: frozen.resourceWorkspacePath } } : {}),
      hookBindingId: 'test-binding', hookToken: 'test-token', creation: { createOperationId: input.createOperationId,
        executorRevision: input.executorRevision, createdRun: { runId: 'original-d-run' }, initialPrompt: 'not-requested' } } as AgentMuxAgentSession
    return { session: observed, creation: observed.creation! }
  })
  const agentInput = vi.fn(async () => { throw Error('No Agent input belongs to this Host continuation fixture.') })
  const client = { writeAgent: agentInput, pasteAgent: agentInput, submitAgentPrompt: agentInput, resolveAgentCreationSessionId: vi.fn(async () => 'original-d-session'),
    inspectAgentCreation: vi.fn(async () => { if (retired) return retired; if (!observed) throw new AgentMuxError('No original creation is observed.', 'AGENT_CREATION_UNKNOWN'); return observed }),
    listHostExecutors: vi.fn(async () => ({ runtimeId, executors: [{ executorId: 'd-executor', configRevision: 'd'.repeat(64), creationContract: { ordinaryLaunch: 1 } }] })),
    hostEnvironment: vi.fn(async () => ({ homeDirectory: '/d/home' })), createHostAgentWithDelivery: create }
  const bindings = { create: vi.fn(async (input: AgentExecutionOpenInput) => {
      frozen = structuredClone(input)
      if (pending) throw new AgentMuxError('Original helper preparation remains unconfirmed.', 'EXECUTION_HELPER_UNAVAILABLE', undefined, undefined, undefined, undefined, undefined,
        { reference: { bindingId: input.bindingId, agentSessionId: input.agent.agentSessionId, createOperationId: input.agent.createOperationId }, hostId: input.resourceHostId, role: 'executor', stage: 'prepare' })
      const created = await create(input.agent)
      bindingConnected = !partialAfterStart
      if (partialAfterStart) throw new AgentMuxError('The Agent exists but its original binding is not connected.', 'EXECUTION_READER_UNAVAILABLE')
      return { ...created, execution: {} }
    }), continueOriginal: vi.fn(async reference => {
      expect(reference).toEqual({ bindingId: frozen!.bindingId, agentSessionId: frozen!.agent.agentSessionId, createOperationId: frozen!.agent.createOperationId })
      bindingConnected = true
      const created = observed ?? (await create(frozen!.agent)).session
      const { hookBindingId, hookToken, ...session } = created
      return { session, execution: await bindings.inspect(frozen!.bindingId) }
    }), inspect: vi.fn(async (bindingId: string) => frozen && bindingId === frozen.bindingId ? { bindingId: frozen.bindingId, agentHostId: frozen.agentHostId,
      resourceHostId: frozen.resourceHostId, agentSessionId: frozen.agent.agentSessionId, resourceWorkspacePath: frozen.resourceWorkspacePath,
      continuation: { bindingId: frozen.bindingId, agentSessionId: frozen.agent.agentSessionId, createOperationId: frozen.agent.createOperationId },
      state: bindingConnected ? 'connected' as const : 'unavailable' as const,
      ...(!bindingConnected ? { diagnostic: { code: 'EXECUTION_READER_UNAVAILABLE', message: 'The original binding is not connected.' } } : {}) } : null) }
  const identity = { runtimeId: 'runtime-b', ownerInstanceId: 'instance-b', protocolVersion: 2, processId: process.pid, ctxmux: null, availability: 'connected' }
  const runtime = { client: { inspectAgentCreation: vi.fn(async () => { throw Error('A B-local SID lookup cannot locate a D Session.') }) }, ownerIdentity: () => identity,
    executionHost: vi.fn(async (hostId: string) => { expect(hostId).toBe('D-in-B'); return { runtimeId, client } }), executionBindings: bindings } as unknown as AgentMuxHeadlessRuntime
  const control = createHostSpatialAgentControl({ configurationPath: join(root, 'unused-local-executor-config.json'), spatial, runtime: () => runtime,
    agentMuxContext: async () => sourceContext })
  const server = new AgentMuxControlServer({ socketPath: join(root, 'rpc.sock'), spatialState: spatial, coreClients: () => [], spatialAgentControl: control, executionBindings: bindings as never,
    hostedRuntime: () => ({ call: async () => ({ owner: identity }), assertFence: () => {}, subscribe: async () => { throw Error('General Host events are not a source admission prerequisite.') } }) as never })
  Object.assign(runtime, { server })
  releases.push(() => server.stop()); await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); releases.push(() => rpc.dispose())
  const input = { operationId: 'source-create-operation', content: { kind: 'new-agent' as const, executorId: 'd-executor', agentTarget: { hostId: 'D-in-B', runtimeId } },
    destination: { spaceId: folder.spaceId, zoneId: folder.zoneId, newTab: true as const }, focus: false }
  return { root, rpc, spatial, runtime, server, client, create, bindings, input, folder, control, agentInput,
    retire: (history: 'matching' | 'missing' | 'other-creation' = 'matching') => {
      if (!observed) throw Error('Retirement needs the original controlled creation first.')
      const { providerId, executorId, workspacePath, toolExecution, createdAt, creation } = observed
      retired = { kind: 'retired-agent', agentSessionId: observed.agentSessionId, hostId: observed.hostId, run: observed.run, source: 'user', observedAt: 2,
        ...(history === 'missing' ? {} : { history: { providerId, executorId, workspacePath, toolExecution, createdAt, creation: history === 'other-creation' ? { ...creation!, createOperationId: 'other-creation' } : creation } }) }
    }, pending: () => { pending = true }, partialAfterStart: () => { partialAfterStart = true }, changeRuntime: () => { runtimeId = 'another-runtime' }, frozen: () => frozen }
}

