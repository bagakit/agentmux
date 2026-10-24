import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient, type AgentMuxAgentCreateInput } from '../src/client.js'
import { AgentMuxFileAgentSessionStore, parseAgentCreationFact } from '../src/agent-session-store.js'
import { AgentMuxCreationAuthority } from '../src/agent-creation-authority.js'
import { AgentMuxHostExecutorOwner } from '../src/executor-owner.js'
import { AgentMuxError } from '../src/errors.js'
import { parseRpcAgentSession } from '../src/rpc-native-codec.js'
import { rpcControlRequest } from '../src/rpc-business-codec.js'
import { creationInputOwner } from './helpers/creation-input-owner.js'
import { hostedTestClient } from './helpers/hosted-runtime-port.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const spatialIntent = { tabId: 'original-tab', regionId: 'original-region', executionWorkspaceId: 'explicit-execution-workspace' }
async function fixture() {
  const h = await creationInputOwner(); cleanups.push(() => h.close())
  const request: AgentMuxAgentCreateInput = { agentSessionId: 'spatial-creation-session', createOperationId: 'spatial-creation-operation',
    providerId: 'codex', executorId: 'codex', workspacePath: h.root, injectAgentMuxGuide: false, spatialIntent }
  return { ...h, request }
}

it('freezes exact spatial intent before Start, retains it through the real FileStore and strict public Session receipt, and refuses changed intent', async () => {
  const h = await fixture(), start = h.inner.kernel.start
  h.inner.kernel.start = vi.fn(async (input: any) => {
    expect((await h.store.loadCreationCorrelation(h.request.agentSessionId!))?.preparedCreation?.creation?.spatialIntent).toEqual(spatialIntent)
    return await start(input)
  })
  const creation = h.client.createAgentWithDelivery(h.request)
  await expect(creation).resolves.toMatchObject({ creation: { spatialIntent } })
  const created = await creation
  expect(created.session.creation?.spatialIntent).toEqual(spatialIntent)
  expect(parseRpcAgentSession(created.session).creation?.spatialIntent).toEqual(spatialIntent)
  const reopened = new AgentMuxFileAgentSessionStore(join(h.root, 'sessions.json'))
  expect((await reopened.readMetadata(created.session.agentSessionId))?.creation?.spatialIntent).toEqual(spatialIntent)
  expect((await h.client.readAgentSessions()).find(session => session.agentSessionId === created.session.agentSessionId)?.creation?.spatialIntent).toEqual(spatialIntent)
  for (const field of ['tabId', 'regionId', 'executionWorkspaceId'] as const)
    await expect(h.client.createAgentWithDelivery({ ...h.request, spatialIntent: { ...spatialIntent, [field]: 'another-original' } })).rejects.toMatchObject({ code: 'AGENT_FORK_OPERATION_CONFLICT' })
  await expect(h.client.createAgentWithDelivery(h.request)).resolves.toMatchObject({ session: { run: created.session.run }, creation: { spatialIntent } })
  expect(h.started).toHaveLength(1)
  expect((await reopened.readMetadata(created.session.agentSessionId))?.creation).toEqual(created.creation)
})

it('reopens the prepared original position after a lost Start reply without another Start or input', async () => {
  const h = await fixture(), start = h.inner.kernel.start
  let originalRun: any
  h.inner.kernel.start = vi.fn(async (input: any) => {
    originalRun = await start(input)
    throw new AgentMuxError('Original Start reply was lost', 'CONTROL_UNAVAILABLE')
  })
  await expect(h.client.createAgentWithDelivery(h.request)).rejects.toMatchObject({ code: 'AGENT_CREATION_UNCONFIRMED' })
  const store = new AgentMuxFileAgentSessionStore(join(h.root, 'sessions.json'))
  expect((await store.loadCreationCorrelation(h.request.agentSessionId!))?.preparedCreation?.creation?.spatialIntent).toEqual(spatialIntent)
  await h.client.dispose()
  const reader = new AgentMuxClient({ store, providers: [h.provider] }); cleanups.push(() => reader.dispose())
  const inner = reader as any; inner.connected = true
  inner.kernel.isConnected = () => true; inner.kernel.inspectCreation = vi.fn(async () => originalRun)
  inner.kernel.start = vi.fn(); inner.kernel.input = vi.fn()
  inner.hookServer.isRunning = () => true
  inner.hookServer.createBinding = () => ({ bindRun: async () => {}, close: async () => {} })
  await expect(reader.inspectAgentCreation(h.request.agentSessionId!)).resolves.toMatchObject({ kind: 'agent', run: { runId: originalRun.runId }, creation: { spatialIntent } })
  expect((await store.readMetadata(h.request.agentSessionId!))?.creation?.spatialIntent).toEqual(spatialIntent)
  expect(inner.kernel.start).not.toHaveBeenCalled(); expect(inner.kernel.input).not.toHaveBeenCalled()
  expect(h.started).toHaveLength(1)
})

it('rejects malformed spatial claims before Start and grants no trusted source, role, placement or public JSON capability', async () => {
  const h = await fixture()
  for (const value of [null, {}, { ...spatialIntent, tabId: '' }, { ...spatialIntent, regionId: new String('region') },
    { ...spatialIntent, executionWorkspaceId: 'bad\0id' }, { ...spatialIntent, source: 'desktop' }, { ...spatialIntent, trusted: true }, { ...spatialIntent, goalId: 'claimed-goal' }]) {
    await expect(h.client.createAgentWithDelivery({ ...h.request, spatialIntent: value as never })).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE' })
    expect(() => parseAgentCreationFact({ createOperationId: 'original-operation', initialPrompt: 'not-requested', spatialIntent: value })).toThrow()
  }
  expect(h.started).toHaveLength(0)
  expect(await h.store.readMetadata(h.request.agentSessionId!)).toBeNull()
  const open = { content: { kind: 'new-agent', executorId: 'codex' }, destination: { zoneId: 'original-zone', newTab: true }, focus: false }
  expect(() => rpcControlRequest('agent.open', open)).not.toThrow()
  expect(() => rpcControlRequest('agent.open', { ...open, content: { ...open.content, spatialIntent } })).toThrow()
})

it('does not infer position for an old or newly unscoped creation and rejects corrupt strict receipt fields', async () => {
  const h = await fixture(), { spatialIntent: _position, ...unscoped } = h.request
  const created = await h.client.createAgentWithDelivery(unscoped)
  expect(created.creation).not.toHaveProperty('spatialIntent')
  expect((await new AgentMuxFileAgentSessionStore(join(h.root, 'sessions.json')).readMetadata(unscoped.agentSessionId!))?.creation).not.toHaveProperty('spatialIntent')
  expect(parseRpcAgentSession(created.session).creation).not.toHaveProperty('spatialIntent')
  expect(() => parseRpcAgentSession({ ...created.session, creation: { ...created.creation, spatialIntent: { ...spatialIntent, source: 'desktop' } } })).toThrow()
  expect(() => parseRpcAgentSession({ ...created.session, creation: { ...created.creation, spatialIntent: { ...spatialIntent, regionId: null } } })).toThrow()
  await expect(h.client.createAgentWithDelivery({ ...unscoped, spatialIntent })).rejects.toMatchObject({ code: 'AGENT_FORK_OPERATION_CONFLICT' })
  expect(h.started).toHaveLength(1)
})

it('carries the same spatial intent through the real Hosted target creation contract and target-owned intent digest', async () => {
  const h = await fixture(), owner = new AgentMuxHostExecutorOwner({ path: join(h.root, 'executors.json'), runtimeId: 'original-target', catalog: () => h.client.catalog() })
  const config = await owner.configure({ executorId: 'codex', config: { label: 'Original configured executor', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: false } })
  h.inner.hostExecutorOwner = owner
  h.inner.creationAuthority = new AgentMuxCreationAuthority({ stateDirectory: join(h.root, 'authority'), runtimeId: 'original-target' })
  const hosted = await hostedTestClient(h.client); cleanups.push(() => hosted.dispose())
  const request = { agentSessionId: h.request.agentSessionId!, createOperationId: h.request.createOperationId!, executorId: 'codex',
    executorRevision: config.executor.configRevision, workspacePath: h.root, spatialIntent }
  await expect(hosted.sdk.createHostAgentWithDelivery(request)).resolves.toMatchObject({ creation: { spatialIntent } })
  expect((await h.store.readMetadata(request.agentSessionId))?.creation?.spatialIntent).toEqual(spatialIntent)
  await expect(hosted.sdk.createHostAgentWithDelivery({ ...request, spatialIntent: { ...spatialIntent, regionId: 'changed-position' } })).rejects.toMatchObject({ code: 'AGENT_CREATION_OPERATION_CONFLICT' })
  expect(h.started).toHaveLength(1)
})
