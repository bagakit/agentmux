import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore,
  type AgentMuxLifecycleReservation, type AgentMuxPreparedCreation } from '../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(kind: 'memory' | 'file') {
  const root = await mkdtemp(join(tmpdir(), 'amux-tool-binding-')); roots.push(root)
  const path = join(root, 'sessions.sqlite')
  const store = kind === 'memory' ? new AgentMuxMemoryAgentSessionStore() : new AgentMuxFileAgentSessionStore(path)
  const now = Date.now()
  const original: AgentMuxStoredAgentSession = {
    kind: 'agent', agentSessionId: 'original-session', providerId: 'codex', executorId: 'configured-codex', hostId: 'local', workspacePath: root,
    toolExecution: { bindingId: 'original-binding', resourceHostId: 'resource-host', resourceRuntimeId: 'resource-owner', workspacePath: '/resource/project' },
    run: { runId: 'original-run' }, retiredRuns: [], hookBindingId: 'original-hook', hookToken: 'original-hook-token', capabilityHash: 'original-capability',
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-conversation' }, createdAt: now, updatedAt: now,
  }
  const owner = (purpose: string) => ({ agentSessionId: original.agentSessionId, reservationId: purpose + '-reservation', operationId: purpose + '-operation',
    ownerId: 'test-owner', ownerPid: process.pid, expiresAt: Date.now() + 60_000 })
  const reader = () => kind === 'file' ? new AgentMuxFileAgentSessionStore(path) : store
  const retire = async () => {
    await store.compareAndSwap(null, original)
    const stop: Extract<AgentMuxLifecycleReservation, { kind: 'stop' }> = { ...owner('stop'), kind: 'stop', expectedRun: original.run,
      stopOperation: { daemonInstance: 'original-runtime', operationKey: 'stop-operation', runId: original.run.runId } }
    await store.reserveLifecycle(stop); await store.commitLifecycle(stop, null)
    const retained = (await reader().readRetiredAgentSession(original.agentSessionId))!
    const reopen: Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }> = { ...owner('reopen'), kind: 'reopen', expectedRetirement: retained }
    await store.reserveLifecycle(reopen)
    return { retained, reopen }
  }
  const nextRun = (runId: string): AgentMuxStoredAgentSession => ({ ...original, run: { runId }, retiredRuns: [original.run], updatedAt: now + 1 })
  return { original, store, reader, owner, retire, nextRun }
}
function changedTargets(original: AgentMuxStoredAgentSession): AgentMuxStoredAgentSession[] {
  const { toolExecution, ...withoutBinding } = original
  return [{ ...original, toolExecution: { ...toolExecution!, resourceRuntimeId: 'different-resource-owner' } }, withoutBinding]
}

describe.each(['memory', 'file'] as const)('%s Store exact tool execution binding', kind => {
  it('retains the binding in original no-Run preparation and acknowledged creation across reader reopen', async () => {
    const h = await fixture(kind), { run, retiredRuns: _retired, ...seedIdentity } = h.original
    const seed: AgentMuxPreparedCreation = { ...seedIdentity, creation: { createOperationId: 'create-original', intentDigest: 'a'.repeat(64), initialPrompt: 'not-requested' } }
    const reservation: Extract<AgentMuxLifecycleReservation, { kind: 'create' }> = { ...h.owner('create'), kind: 'create' }
    await h.store.reserveLifecycle(reservation)
    const prepared = await h.store.prepareCreate(reservation, seed)
    expect((await h.reader().loadCreationCorrelation(h.original.agentSessionId))?.preparedCreation?.toolExecution).toEqual(h.original.toolExecution)
    const created: AgentMuxStoredAgentSession = { ...h.original, creation: { ...seed.creation!, createdRun: run } }
    for (const wrong of changedTargets(created)) await expect(h.store.commitLifecycle(prepared, wrong)).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE' })
    await h.store.commitLifecycle(prepared, created)
    expect(await h.reader().readMetadata(h.original.agentSessionId)).toMatchObject({ run, toolExecution: h.original.toolExecution, nativeHandle: h.original.nativeHandle })
  })

  it('preserves the original resource through retirement history and same-Session reopen', async () => {
    const h = await fixture(kind), { retained, reopen } = await h.retire()
    expect(retained.history?.toolExecution).toEqual(h.original.toolExecution)
    const prepared = await h.store.prepareReopen(reopen, h.original)
    const reopened: AgentMuxStoredAgentSession = { ...h.nextRun('reopened-run'), reopenedFrom: { run: retained.run, source: retained.source, observedAt: retained.observedAt } }
    await h.store.commitLifecycle(prepared, reopened)
    expect(await h.reader().readMetadata(h.original.agentSessionId)).toMatchObject({ agentSessionId: h.original.agentSessionId, toolExecution: h.original.toolExecution,
      nativeHandle: h.original.nativeHandle, run: { runId: 'reopened-run' }, retiredRuns: [h.original.run] })
    expect(await h.reader().readRetiredAgentSession(h.original.agentSessionId)).toBeNull()
  })

  it('rejects replacing or omitting the tool target at prepared resume and final resume commit', async () => {
    const h = await fixture(kind)
    await h.store.compareAndSwap(null, h.original)
    const reservation: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }> = { ...h.owner('resume'), kind: 'resume', expectedRun: h.original.run }
    await h.store.reserveLifecycle(reservation)
    for (const wrong of changedTargets(h.original)) await expect(h.store.prepareResume(reservation, wrong)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
    const prepared = await h.store.prepareResume(reservation, h.original), next = h.nextRun('resumed-run')
    for (const wrong of changedTargets(next)) await expect(h.store.commitLifecycle(prepared, wrong)).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE' })
    expect(await h.reader().readMetadata(h.original.agentSessionId)).toMatchObject({ run: h.original.run, toolExecution: h.original.toolExecution })
    await h.store.commitLifecycle(prepared, next)
    expect(await h.reader().readMetadata(h.original.agentSessionId)).toMatchObject({ run: next.run, toolExecution: h.original.toolExecution })
  })

  it('rejects replacing or omitting the tool target at prepared reopen and final reopen commit', async () => {
    const h = await fixture(kind), { retained, reopen } = await h.retire()
    for (const wrong of changedTargets(h.original)) await expect(h.store.prepareReopen(reopen, wrong)).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE' })
    const prepared = await h.store.prepareReopen(reopen, h.original)
    const next: AgentMuxStoredAgentSession = { ...h.nextRun('reopened-run'), reopenedFrom: { run: retained.run, source: retained.source, observedAt: retained.observedAt } }
    for (const wrong of changedTargets(next)) await expect(h.store.commitLifecycle(prepared, wrong)).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE' })
    expect((await h.reader().readRetiredAgentSession(h.original.agentSessionId))?.history?.toolExecution).toEqual(h.original.toolExecution)
    await h.store.commitLifecycle(prepared, next)
    expect(await h.reader().readMetadata(h.original.agentSessionId)).toMatchObject({ run: next.run, toolExecution: h.original.toolExecution })
  })
})
