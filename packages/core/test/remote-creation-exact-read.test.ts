import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { fixturePath } from './helpers/fixture-values.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient, hostAgentCreationIntent, type AgentMuxHostAgentCreateInput } from '../src/client.js'
import { AgentMuxCreationAuthority, agentCreationIntentDigest } from '../src/agent-creation-authority.js'
import { AgentMuxHostExecutorOwner } from '../src/executor-owner.js'
import { AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore, agentLifecycleOperationIdentity, type AgentMuxAgentSessionStore } from '../src/agent-session-store.js'
import { readCurrentSessionDatabase } from '../src/agent-session-database.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import { hostedTestClient } from './helpers/hosted-runtime-port.js'

const roots: string[] = [], clients: AgentMuxClient[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})
const input: AgentMuxHostAgentCreateInput = { agentSessionId: 'original-session', createOperationId: 'original-operation',
  executorId: 'target-executor', executorRevision: 'e'.repeat(64), workspacePath: fixturePath("target/work"), prompt: 'original task' }
function session(): AgentMuxStoredAgentSession {
  return { kind: 'agent', agentSessionId: input.agentSessionId!, hostId: 'local', providerId: 'claude', executorId: input.executorId,
    workspacePath: input.workspacePath, run: { runId: 'original-run' }, retiredRuns: [], hookBindingId: 'b'.repeat(43), hookToken: 't'.repeat(43),
    capabilityHash: 'c'.repeat(43), createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1),
    creation: { createOperationId: input.createOperationId!, intentDigest: hostAgentCreationIntent(input), executorRevision: input.executorRevision,
      initialPrompt: 'unknown', agentMuxContext: 'unknown' } }
}
async function fixture(kind: 'memory' | 'file') {
  const root = await mkdtemp(join(tmpdir(), 'amux-creation-exact-')); roots.push(root)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  const store = kind === 'file' ? new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')) : new AgentMuxMemoryAgentSessionStore()
  const client = new AgentMuxClient({ store,
    creationAuthority: new AgentMuxCreationAuthority({ stateDirectory: root, runtimeId: 'target-runtime' }),
    hostExecutorOwner: new AgentMuxHostExecutorOwner({ path: join(root, 'executors.json'), runtimeId: 'target-runtime', catalog: () => client.catalog() }) })
  clients.push(client)
  const inner = client as any
  const start = vi.spyOn(inner.kernel, 'start').mockRejectedValue(new Error('Must not create another process'))
  const stop = vi.spyOn(inner.kernel, 'stop').mockRejectedValue(new Error('Must not stop the healthy process'))
  const send = vi.spyOn(inner.kernel, 'input').mockRejectedValue(new Error('Must not repeat the first task'))
  const metadata = vi.spyOn(store, 'readMetadata')
  const forbidCatalogue = () => vi.spyOn(store, 'loadMetadata').mockRejectedValue(new Error('Unrelated malformed Session metadata must not be read'))
  return { root, client, inner, store, start, stop, send, metadata, forbidCatalogue }
}

async function retire(store: AgentMuxAgentSessionStore, original: AgentMuxStoredAgentSession) {
  const reservation = { kind: 'stop' as const, reservationId: `retire-${original.agentSessionId}`, ownerId: 'retirement-owner', ownerPid: process.pid,
    agentSessionId: original.agentSessionId, expectedRun: original.run, operationId: `stop-${original.agentSessionId}`, expiresAt: Date.now() + 60_000,
    stopOperation: { daemonInstance: 'private-unconnected', operationKey: `stop-${original.agentSessionId}`, runId: original.run.runId } }
  await store.reserveLifecycle(reservation)
  await store.commitLifecycle(reservation, null)
  return (await store.readRetiredAgentSession(original.agentSessionId))!
}

describe.each(['memory', 'file'] as const)('exact creation reads through the %s Store', kind => {
  it.runIf(kind === 'file')('uses the retired operation index without scanning unrelated retired records', async () => {
    const f = await fixture(kind), original = session()
    await f.store.compareAndSwap(null, original)
    const retired = await retire(f.store, original)
    const database = (await readCurrentSessionDatabase(join(f.root, 'sessions.json')))!
    try {
      const plan = database.prepare("EXPLAIN QUERY PLAN SELECT json FROM retired_sessions WHERE json_extract(json,'$.history.creation.createOperationId')=?")
        .all(input.createOperationId!)
      expect(plan).toHaveLength(1)
      expect(plan[0]!.detail).toContain('SEARCH retired_sessions USING INDEX retired_creation_operation')
    } finally { database.close() }
    expect(await f.client.resolveAgentCreationSessionId(input.createOperationId!)).toBe(original.agentSessionId)
    expect(await f.store.readRetiredAgentSession(original.agentSessionId)).toEqual(retired)
  })

  it('Hosted reads confirmed creation after retirement ahead of a stale registry without Runtime or replay', async () => {
    const f = await fixture(kind), original = session()
    original.creation = { ...original.creation!, initialPrompt: 'confirmed', agentMuxContext: 'confirmed' }
    await f.store.compareAndSwap(null, original)
    await f.inner.registry.load('local')
    const retired = await retire(f.store, original)
    f.inner.registry.rememberStartedCreation({ ...original, creation: { ...original.creation, persistence: 'unconfirmed' } })
    const native = vi.spyOn(f.inner.kernel, 'connect').mockRejectedValue(new Error('Private Native is unavailable'))
    const list = vi.spyOn(f.inner.kernel, 'list').mockRejectedValue(new Error('Retirement needs no Runtime inventory'))
    vi.spyOn(f.inner.kernel, 'isConnected').mockReturnValue(false)
    const h = await hostedTestClient(f.client)
    const catalogue = f.forbidCatalogue()
    native.mockClear(); list.mockClear()
    try {
      expect(await h.sdk.inspectAgentCreation(original.agentSessionId)).toEqual({ kind: 'retired-agent', ...retired })
      expect(await h.sdk.resolveAgentCreationSessionId(input.createOperationId!)).toBe(original.agentSessionId)
      expect(await h.sdk.inspectAgentCreation(original.agentSessionId)).not.toHaveProperty('creation')
      expect(native).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled(); expect(catalogue).not.toHaveBeenCalled()
      expect(f.start).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })

  it('refuses to replay a retired creation through Host or direct create, including a substituted Session identity', async () => {
    const f = await fixture(kind), original = session()
    await f.store.compareAndSwap(null, original)
    const retired = await retire(f.store, original)
    f.inner.registry.rememberStartedCreation({ ...original, creation: { ...original.creation!, persistence: 'unconfirmed' } })
    f.inner.connected = true; vi.spyOn(f.inner.kernel, 'isConnected').mockReturnValue(true)
    const h = await hostedTestClient(f.client)
    const direct = { agentSessionId: original.agentSessionId, createOperationId: input.createOperationId,
      providerId: original.providerId, executorId: original.executorId, workspacePath: original.workspacePath }
    try {
      await expect(h.sdk.createHostAgentWithDelivery(input)).rejects.toMatchObject({ code: 'AGENT_CREATION_RETIRED', controlFailure: { disposition: 'not_applied' } })
      await expect(h.sdk.createAgent(direct)).rejects.toMatchObject({ code: 'AGENT_CREATION_RETIRED', controlFailure: { disposition: 'not_applied' } })
      await expect(h.sdk.createAgent({ ...direct, agentSessionId: undefined })).rejects.toMatchObject({ code: 'AGENT_CREATION_RETIRED' })
      await expect(h.sdk.createAgent({ ...direct, agentSessionId: 'substitute-session' })).rejects.toMatchObject({ code: 'AGENT_CREATION_OPERATION_CONFLICT' })
      await expect(h.sdk.createHostAgentWithDelivery({ ...input, agentSessionId: 'substitute-session' })).rejects.toMatchObject({ code: 'AGENT_CREATION_OPERATION_CONFLICT' })
      await expect(h.sdk.createAgent({ ...direct, createOperationId: 'another-operation' })).rejects.toMatchObject({ code: 'AGENT_CREATION_OPERATION_CONFLICT' })
      expect(await f.store.readRetiredAgentSession(original.agentSessionId)).toEqual(retired)
      expect(await f.store.readMetadata(original.agentSessionId)).toBeNull()
      expect(await f.store.loadCreationCorrelation(original.agentSessionId)).toBeNull()
      expect(f.start).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })

  it('rejects conflicting active or retired identities for the same original operation', async () => {
    const f = await fixture(kind), original = session()
    await f.store.compareAndSwap(null, original)
    await retire(f.store, original)
    const other = { ...original, agentSessionId: 'other-session', run: { runId: 'other-run' } }
    await f.store.compareAndSwap(null, other)
    await expect(f.client.resolveAgentCreationSessionId(input.createOperationId!)).rejects.toMatchObject({ code: 'AGENT_CREATION_OPERATION_CONFLICT' })
    await retire(f.store, other)
    await expect(f.client.resolveAgentCreationSessionId(input.createOperationId!)).rejects.toMatchObject({ code: 'AGENT_CREATION_OPERATION_CONFLICT' })
    expect(f.start).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
  })

  it('keeps retired creation unknown when its original creation fact is missing', async () => {
    const f = await fixture(kind), original = session()
    const { creation: _creation, ...withoutCreation } = original
    await f.store.compareAndSwap(null, withoutCreation)
    await retire(f.store, withoutCreation)
    f.inner.registry.rememberStartedCreation({ ...original, creation: { ...original.creation!, persistence: 'unconfirmed' } })
    await expect(f.client.inspectAgentCreation(original.agentSessionId)).rejects.toMatchObject({ code: 'AGENT_CREATION_UNKNOWN' })
    expect(f.start).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  })

  it('preserves an exact retirement read failure instead of using an unconfirmed cached creation', async () => {
    const f = await fixture(kind), original = session()
    f.inner.registry.rememberStartedCreation({ ...original, creation: { ...original.creation!, persistence: 'unconfirmed' } })
    vi.spyOn(f.store, 'readRetiredAgentSession').mockRejectedValue(new Error('Original retirement observation unavailable'))
    await expect(f.client.inspectAgentCreation(original.agentSessionId)).rejects.toThrow('Original retirement observation unavailable')
    expect(f.start).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  })

  it('Hosted reads the original receipt and UNKNOWN without connecting an unavailable Native', async () => {
    const f = await fixture(kind), original = session()
    await f.store.compareAndSwap(null, original)
    const native = vi.spyOn(f.inner.kernel, 'connect').mockRejectedValue(new Error('Private Native is unavailable'))
    vi.spyOn(f.inner.kernel, 'isConnected').mockReturnValue(false)
    const load = vi.spyOn(f.inner.registry, 'load')
    const h = await hostedTestClient(f.client)
    native.mockClear()
    try {
      expect(await h.sdk.inspectAgentCreation(original.agentSessionId)).toMatchObject({ run: original.run, creation: original.creation })
      await expect(h.sdk.inspectAgentCreation('unknown-operation-session')).rejects.toMatchObject({ code: 'AGENT_CREATION_UNKNOWN' })
      expect(native).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled()
      expect(f.start).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })

  it('reads the original Host creation and inspection once each without the catalogue', async () => {
    const f = await fixture(kind), original = session()
    await f.store.compareAndSwap(null, original)
    const catalogue = f.forbidCatalogue()
    expect(await f.client.createHostAgentWithDelivery(input)).toMatchObject({ session: { agentSessionId: original.agentSessionId,
      run: original.run }, promptConfirmed: false, creation: { initialPrompt: 'unknown' } })
    expect(await f.client.inspectAgentCreation(original.agentSessionId)).toMatchObject({ run: original.run, creation: original.creation })
    expect(f.metadata.mock.calls).toEqual([[original.agentSessionId], [original.agentSessionId]])
    expect(catalogue).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  })

  it('keeps durable facts ahead of a stale unconfirmed local projection', async () => {
    const f = await fixture(kind), original = session()
    await f.store.compareAndSwap(null, original)
    f.inner.registry.rememberStartedCreation({ ...original, run: { runId: 'stale-local-run' },
      creation: { ...original.creation!, persistence: 'unconfirmed' } })
    f.forbidCatalogue()
    expect((await f.client.inspectAgentCreation(original.agentSessionId)).run).toEqual(original.run)
    expect((await f.client.createHostAgentWithDelivery(input)).session.run).toEqual(original.run)
  })

  it('retains an actually started unconfirmed projection and refuses to replace an unresolved original operation', async () => {
    const f = await fixture(kind), original = session()
    f.inner.registry.rememberStartedCreation({ ...original, creation: { ...original.creation!, persistence: 'unconfirmed' } })
    f.forbidCatalogue()
    await expect(f.client.inspectAgentCreation(original.agentSessionId)).resolves.toMatchObject({ run: original.run,
      creation: { createOperationId: input.createOperationId, persistence: 'unconfirmed' } })
    await expect(f.client.createHostAgentWithDelivery(input)).resolves.toMatchObject({ session: { run: original.run }, promptConfirmed: false })
    await expect(f.client.inspectAgentCreation('unknown-session')).rejects.toMatchObject({ code: 'AGENT_CREATION_UNKNOWN' })
    expect(f.start).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
  })

  it('does not promote an ordinary stale registry record to a durable creation', async () => {
    const f = await fixture(kind), original = session()
    await f.store.compareAndSwap(null, original); await f.inner.registry.load('local')
    await f.store.compareAndSwap(original, null)
    f.forbidCatalogue()
    await expect(f.client.inspectAgentCreation(original.agentSessionId)).rejects.toMatchObject({ code: 'AGENT_CREATION_UNKNOWN' })
    expect(f.start).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  })

  it('reconciles only the original prepared Run without catalogue, start or input', async () => {
    const f = await fixture(kind), original = session(), op = agentLifecycleOperationIdentity('create', original.agentSessionId, input.createOperationId!)
    const reservation = { kind: 'create' as const, agentSessionId: original.agentSessionId, operationId: op,
      reservationId: 'original-reservation', ownerId: 'released-owner', ownerPid: process.pid, expiresAt: Date.now() + 60000 }
    await f.store.reserveLifecycle(reservation)
    const { run: _run, retiredRuns: _retired, ...seed } = original
    await f.store.prepareCreate(reservation, seed)
    await f.store.releaseReopenOwner(reservation.ownerId)
    f.inner.connected = true; vi.spyOn(f.inner.kernel, 'isConnected').mockReturnValue(true)
    const observation = vi.spyOn(f.inner.kernel, 'inspectCreation').mockResolvedValue({ runId: original.run.runId, lifecycleOperationId: op,
      workspacePath: original.workspacePath, program: '/bin/sh', args: [], pid: process.pid, state: { type: 'running' },
      cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0, nativeService: null })
    const inventory = vi.spyOn(f.inner.kernel, 'list').mockRejectedValue(new Error('Unrelated Runtime observation failed'))
    f.inner.hookServer.isRunning = () => true
    f.inner.hookServer.createBinding = () => ({ bindRun: async () => {}, close: async () => {} })
    const catalogue = f.forbidCatalogue()
    expect(await f.client.inspectAgentCreation(original.agentSessionId)).toMatchObject({ run: original.run, creation: original.creation })
    expect(catalogue).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
    expect(observation).toHaveBeenCalledExactlyOnceWith(op); expect(inventory).not.toHaveBeenCalled()
  })

  it('uses the same exact reader for the existing durable fork creation before requiring a parent', async () => {
    const f = await fixture(kind), original = session()
    const forkSource = { agentSessionId: 'parent-session', expectedRun: { runId: 'parent-run' },
      expectedNativeHandle: { kind: 'provider' as const, providerId: 'claude', sessionId: 'native-parent' } }
    const request = { agentSessionId: original.agentSessionId, createOperationId: input.createOperationId!, providerId: original.providerId,
      executorId: original.executorId, workspacePath: original.workspacePath, injectAgentMuxGuide: false, prompt: input.prompt, forkSource }
    const creation = { ...original.creation!, intentDigest: agentCreationIntentDigest(request) }
    await f.store.compareAndSwap(null, { ...original, forkedFrom: forkSource, creation })
    f.inner.connected = true; vi.spyOn(f.inner.kernel, 'isConnected').mockReturnValue(true)
    const catalogue = f.forbidCatalogue()
    expect(await f.client.createAgentWithDelivery(request)).toMatchObject({ session: { run: original.run, forkedFrom: forkSource }, promptConfirmed: false })
    expect(f.metadata.mock.calls).toEqual([[original.agentSessionId]])
    expect(catalogue).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
  })

  it('propagates an exact metadata read failure rather than trusting the cached projection', async () => {
    const f = await fixture(kind), original = session()
    f.inner.registry.rememberStartedCreation({ ...original, creation: { ...original.creation!, persistence: 'unconfirmed' } })
    f.forbidCatalogue(); f.metadata.mockRejectedValue(new Error('Original exact row is unreadable'))
    await expect(f.client.inspectAgentCreation(original.agentSessionId)).rejects.toThrow('Original exact row is unreadable')
    expect(f.start).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  })
})
