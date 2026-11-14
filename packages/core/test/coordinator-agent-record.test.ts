import { afterEach, expect, test, vi } from 'vitest'
import { join } from 'node:path'
import { createSpaceSessionsFixture } from './helpers/space-session-fixture.js'
import { inspectCoordinatorAgentRecord } from '../src/agent-open-reference.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc, type AgentMuxRpcClient } from '../src/public-rpc-client.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

async function fixture() {
  const f = await createSpaceSessionsFixture(cleanup), original = await f.d.put('same-SID')
  const session: AgentMuxStoredAgentSession = { ...original,
    creation: { createOperationId: 'original-C', initialPrompt: 'not-requested' },
    toolExecution: { bindingId: 'original-binding', resourceHostId: 'B-in-A', resourceRuntimeId: f.b.owner.runtimeId, workspacePath: '/b/project' } }
  const put = async (value: AgentMuxStoredAgentSession) => {
    await (f.d.core as unknown as { registry: { put(session: AgentMuxStoredAgentSession, expectedRun: AgentMuxStoredAgentSession['run']): Promise<void> } }).registry.put(value, original.run)
  }
  await put(session)
  const native = vi.spyOn(f.d.core, 'connectRuntime').mockRejectedValue(Error('Metadata must not open Native'))
  const general = vi.spyOn(f.d.core, 'connect').mockRejectedValue(Error('Metadata must not open general observation'))
  const subject = vi.spyOn(f.d.core, 'runtimeSubject').mockRejectedValue(Error('Metadata must not probe the Run'))
  const reference = { kind: 'coordinator-agent' as const, runtimeId: f.d.owner.runtimeId,
    binding: { bindingId: 'original-binding', agentSessionId: session.agentSessionId, createOperationId: 'original-C' } }
  const resource = { runtimeId: f.b.owner.runtimeId, workspaceId: 'B-project', workspacePath: '/b/project' }
  return { ...f, session, put, native, general, subject, reference, resource }
}

test('the public fenced local metadata port matches the original C without a creation journal or a Run probe', async () => {
  const f = await fixture(), calls = vi.spyOn(f.d.rpc, 'call')
  const result = await inspectCoordinatorAgentRecord(f.d.rpc, f.reference, f.resource)
  expect(result).toEqual({ state: 'matched', reference: f.reference,
    owner: { runtimeId: f.d.owner.runtimeId, ownerInstanceId: f.d.owner.ownerInstanceId },
    resource: { runtimeId: f.b.owner.runtimeId, workspacePath: '/b/project' }, run: f.session.run })
  expect(result).not.toHaveProperty('witness')
  expect(result).not.toHaveProperty('creationPersistence')
  expect(result).not.toHaveProperty('resource.workspaceId')
  expect(calls.mock.calls.some(([method]) => method === 'runtime.invoke')).toBe(true)
  expect(calls.mock.calls.some(([method]) => method === 'agent.execution.binding' || method === 'agent.inspect' || method === 'runtime.bootstrap')).toBe(false)
  expect(f.native).not.toHaveBeenCalled(); expect(f.general).not.toHaveBeenCalled(); expect(f.subject).not.toHaveBeenCalled()
  expect(f.d.inventory).not.toHaveBeenCalled(); expect(f.d.runs).not.toHaveBeenCalled(); expect(f.d.all).not.toHaveBeenCalled()
})

test.each(['host', 'C', 'binding', 'resource-runtime', 'resource-path'] as const)('a different original %s never qualifies the retained reference', async field => {
  const f = await fixture(), changed = structuredClone(f.session)
  if (field === 'host') changed.hostId = 'foreign-same-SID'
  if (field === 'C') changed.creation!.createOperationId = 'other-C'
  if (field === 'binding') changed.toolExecution!.bindingId = 'other-binding'
  if (field === 'resource-runtime') changed.toolExecution!.resourceRuntimeId = 'other-B'
  if (field === 'resource-path') changed.toolExecution!.workspacePath = '/other/project'
  await f.put(changed)
  const retained = await f.d.core.readAgentSession(f.session.agentSessionId)
  expect(await inspectCoordinatorAgentRecord(f.d.rpc, f.reference, f.resource)).toMatchObject({ state: 'unconfirmed', reference: f.reference,
    issue: { code: 'AGENT_ASSOCIATION_CREATION_UNCONFIRMED' } })
  expect(await f.d.core.readAgentSession(f.session.agentSessionId)).toEqual(retained)
  expect(f.native).not.toHaveBeenCalled(); expect(f.d.inventory).not.toHaveBeenCalled()
})

test('an unconfirmed creation commit remains an accurate diagnosis rather than another input or identity gate', async () => {
  const f = await fixture()
  await f.put({ ...f.session, creation: { ...f.session.creation!, persistence: 'unconfirmed' } })
  expect(await inspectCoordinatorAgentRecord(f.d.rpc, f.reference, f.resource)).toMatchObject({ state: 'matched', reference: f.reference,
    creationPersistence: 'unconfirmed', run: f.session.run })
  expect(f.native).not.toHaveBeenCalled(); expect(f.subject).not.toHaveBeenCalled()
})

test('a failed exact read retains the original record and a new explicit read can recover it without creating or resuming', async () => {
  const f = await fixture(), original = await f.d.core.readAgentSession(f.session.agentSessionId)
  const read = vi.spyOn(f.d.core, 'readAgentSession').mockRejectedValueOnce(Object.assign(Error('Original metadata read is unconfirmed'), { code: 'AGENT_SESSION_STORE_READ_UNCONFIRMED' }))
  expect(await inspectCoordinatorAgentRecord(f.d.rpc, f.reference, f.resource)).toMatchObject({ state: 'unconfirmed', reference: f.reference })
  read.mockRestore()
  expect(await inspectCoordinatorAgentRecord(f.d.rpc, f.reference, f.resource)).toMatchObject({ state: 'matched', run: f.session.run })
  expect(await f.d.core.readAgentSession(f.session.agentSessionId)).toEqual(original)
  expect(f.native).not.toHaveBeenCalled(); expect(f.subject).not.toHaveBeenCalled()
})

test('the exact Hosted owner never falls through to a configured foreign same-SID Session', async () => {
  const f = await fixture()
  const server = new AgentMuxControlServer({ socketPath: join(f.b.root, 'record-reader.sock'), spatialState: f.b.spatial,
    coreClients: () => [{ hostId: 'local', client: f.b.core }, { hostId: 'foreign-A', client: f.d.core }], hostedRuntime: () => f.b.hosted })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const foreign = vi.spyOn(f.d.core, 'readAgentSession')
  const reference = { ...f.reference, runtimeId: f.b.owner.runtimeId }
  expect(await inspectCoordinatorAgentRecord(rpc, reference, f.resource)).toMatchObject({ state: 'unconfirmed', reference })
  expect(foreign).not.toHaveBeenCalled()
  expect(f.b.inventory).not.toHaveBeenCalled(); expect(f.d.inventory).not.toHaveBeenCalled()
})

test('wrong Runtime and an instance change refuse only this observation and never replay the metadata call', async () => {
  const f = await fixture()
  expect(await inspectCoordinatorAgentRecord(f.d.rpc, { ...f.reference, runtimeId: 'another-A' }, f.resource)).toMatchObject({ state: 'unconfirmed' })
  let swap = true, metadataReads = 0
  const rpc: Pick<AgentMuxRpcClient, 'call' | 'subscribe'> = {
    async call(method, params, options) {
      if (method === 'runtime.invoke') metadataReads++
      const result = await f.d.rpc.call(method, params, options)
      if (method === 'runtime.owner.identity' && swap) { swap = false; f.d.owner.ownerInstanceId += '-renewed' }
      return result
    },
    subscribe: f.d.rpc.subscribe.bind(f.d.rpc)
  }
  expect(await inspectCoordinatorAgentRecord(rpc, f.reference, f.resource)).toMatchObject({ state: 'unconfirmed' })
  expect(metadataReads).toBe(1)
  expect(await inspectCoordinatorAgentRecord(rpc, f.reference, f.resource)).toMatchObject({ state: 'matched',
    owner: { runtimeId: f.d.owner.runtimeId, ownerInstanceId: f.d.owner.ownerInstanceId }, run: f.session.run })
  expect(metadataReads).toBe(2)
  expect(f.native).not.toHaveBeenCalled(); expect(f.subject).not.toHaveBeenCalled()
})

test('the original managed caller cannot acquire the protected Hosted metadata domain through this helper', async () => {
  const f = await fixture()
  const retained = await f.d.core.readAgentSession(f.session.agentSessionId)
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.d.server.path },
    credentials: { agentSessionId: f.session.agentSessionId, capability: 'private-original-capability' } })
  cleanup.push(() => rpc.dispose())
  expect(await inspectCoordinatorAgentRecord(rpc, f.reference, f.resource)).toMatchObject({ state: 'unconfirmed', issue: { code: 'AGENT_CAPABILITY_INVALID' } })
  expect(await inspectCoordinatorAgentRecord(f.d.rpc, f.reference, f.resource)).toMatchObject({ state: 'matched' })
  expect(f.native).not.toHaveBeenCalled(); expect(await f.d.core.readAgentSession(f.session.agentSessionId)).toEqual(retained)
})
