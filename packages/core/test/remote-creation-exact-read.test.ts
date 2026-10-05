import { fixturePath } from './helpers/fixture-values.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient, hostAgentCreationIntent, type AgentMuxHostAgentCreateInput } from '../src/client.js'
import { AgentMuxCreationAuthority, agentCreationIntentDigest } from '../src/agent-creation-authority.js'
import { AgentMuxHostExecutorOwner } from '../src/executor-owner.js'
import { AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore, agentLifecycleOperationIdentity } from '../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

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
    capabilityHash: 'c'.repeat(43), createdAt: 1, updatedAt: 1,
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

describe.each(['memory', 'file'] as const)('exact creation reads through the %s Store', kind => {
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
    vi.spyOn(f.inner.kernel, 'list').mockResolvedValue([{ runId: original.run.runId, lifecycleOperationId: op,
      workspacePath: original.workspacePath, program: '/bin/sh', args: [], pid: process.pid, state: { type: 'running' },
      cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0, nativeService: null }])
    f.inner.hookServer.isRunning = () => true
    f.inner.hookServer.createBinding = () => ({ bindRun: async () => {}, close: async () => {} })
    const catalogue = f.forbidCatalogue()
    expect(await f.client.inspectAgentCreation(original.agentSessionId)).toMatchObject({ run: original.run, creation: original.creation })
    expect(catalogue).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
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
