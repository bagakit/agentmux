import { fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore, type AgentMuxAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function fixture(kind: 'memory' | 'file', ended = false) {
  const root = await mkdtemp(join(tmpdir(), 'amux-stop-retry-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const store: AgentMuxAgentSessionStore = kind === 'file' ? new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')) : new AgentMuxMemoryAgentSessionStore()
  const original: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-agent', hostId: 'local',
    providerId: 'claude', executorId: 'claude', workspacePath: root, run: { runId: 'original-run' }, retiredRuns: [],
    hookBindingId: 'original-hook', hookToken: 'private-token', createdAt: reshapeFixtureEpoch(0, 0, 1), updatedAt: reshapeFixtureEpoch(0, 0, 1),
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'original-native' } }
  await store.compareAndSwap(null, original)
  const client = new AgentMuxClient({ store })
  const internal = client as any
  await internal.registry.load('local')
  let exited = false, lose = true
  const run = () => ({ runId: original.run.runId, lifecycleOperationId: null, program: 'private-agent', args: [],
    workspacePath: root, pid: exited ? null : 42, state: exited ? { type: 'exited', code: 0, signal: null } : { type: 'running' },
    cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0, nativeService: null })
  internal.connected = true
  internal.kernel.isConnected = () => true
  internal.kernel.identity = () => ({ daemonInstanceId: 'original-daemon', protocolVersion: 1, buildIdentity: 'private' })
  internal.kernel.status = vi.fn(async () => run())
  internal.kernel.detach = vi.fn(async () => {})
  internal.kernel.disconnect = vi.fn(async () => {})
  internal.kernel.prepareStop = vi.fn(async (runId: string, operationKey: string) => ({ daemonInstance: 'original-daemon', operationKey, runId }))
  internal.kernel.stop = vi.fn(async () => {
    if (ended || !lose) exited = true
    if (lose) throw new Error('original stop receipt lost')
  })
  cleanup.push(() => client.dispose())
  return { client, internal, store, original, allowReceipt: () => { lose = false } }
}

describe('explicit Stop retry continues the original lifecycle', () => {
  it.each(['memory', 'file'] as const)('continues same-owner lost Stop in %s without minting another Runtime operation', async kind => {
    const f = await fixture(kind)
    await expect(f.client.stopAgent(f.original.agentSessionId, f.original.run)).rejects.toThrow('original stop receipt lost')
    const operation = f.internal.kernel.stop.mock.calls[0][0]
    f.allowReceipt()
    await expect(f.client.stopAgent(f.original.agentSessionId, f.original.run)).resolves.toBeUndefined()
    expect(f.internal.kernel.prepareStop).toHaveBeenCalledTimes(1)
    expect(f.internal.kernel.stop.mock.calls.map((call: any[]) => call[0])).toEqual([operation, operation])
    expect(await f.store.loadMetadata()).toEqual([])
    expect((await f.store.loadRetiredAgentSessions()).map(row => row.agentSessionId)).toEqual([f.original.agentSessionId])
  })
  it('finishes retirement after the original Run ended without another stop submission', async () => {
    const f = await fixture('file', true)
    await expect(f.client.stopAgent(f.original.agentSessionId, f.original.run)).rejects.toThrow('original stop receipt lost')
    f.allowReceipt()
    await expect(f.client.stopAgent(f.original.agentSessionId, f.original.run)).resolves.toBeUndefined()
    expect(f.internal.kernel.stop).toHaveBeenCalledTimes(1)
    expect(f.internal.kernel.prepareStop).toHaveBeenCalledTimes(1)
    expect((await f.store.loadRetiredAgentSessions())[0]?.history?.nativeHandle).toEqual(f.original.nativeHandle)
  })
  it('concurrent exact-Run readers use one original operation and retire once', async () => {
    const f = await fixture('memory')
    let release!: () => void
    const barrier = new Promise<void>(done => { release = done })
    f.internal.kernel.stop.mockImplementation(async () => { await barrier })
    const first = f.client.stopAgent(f.original.agentSessionId, f.original.run)
    await vi.waitFor(() => expect(f.internal.kernel.stop).toHaveBeenCalledTimes(1))
    const second = f.client.stopAgent(f.original.agentSessionId, f.original.run)
    await vi.waitFor(() => expect(f.internal.kernel.stop).toHaveBeenCalledTimes(2))
    release()
    await Promise.all([first, second])
    expect(f.internal.kernel.prepareStop).toHaveBeenCalledTimes(1)
    expect(f.internal.kernel.stop.mock.calls[0]).toEqual(f.internal.kernel.stop.mock.calls[1])
    expect(await f.store.loadMetadata()).toEqual([])
  })
  it('a pending original receipt cannot block explicit retry or duplicate retirement when it returns late', async () => {
    const f = await fixture('file')
    let release!: () => void
    const barrier = new Promise<void>(done => { release = done })
    const events: any[] = []
    f.client.onEvent(event => events.push(event))
    f.internal.kernel.stop.mockImplementation(async () => { await barrier })
    const first = f.client.stopAgent(f.original.agentSessionId, f.original.run)
    await vi.waitFor(() => expect(f.internal.kernel.stop).toHaveBeenCalledTimes(1))
    const observed = await f.internal.kernel.status()
    f.internal.kernel.status.mockResolvedValue({ ...observed, state: { type: 'exited', code: 0, signal: null }, pid: null })
    const second = f.client.stopAgent(f.original.agentSessionId, f.original.run)
    try {
      await vi.waitFor(async () => { expect(await f.store.loadMetadata()).toEqual([]) })
      await second
      expect(events.filter(event => event.type === 'run-removed')).toHaveLength(1)
      await expect(f.client.stopAgent(f.original.agentSessionId, { runId: 'wrong-run' })).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
    } finally { release() }
    await first
    expect(events.filter(event => event.type === 'run-removed')).toHaveLength(1)
    expect(f.internal.kernel.prepareStop).toHaveBeenCalledTimes(1)
    expect(f.internal.kernel.stop).toHaveBeenCalledTimes(1)
  })
  it.each(['memory', 'file'] as const)('preserves an uncertain original Stop through retry observation failure in %s', async kind => {
    const f = await fixture(kind)
    await expect(f.client.stopAgent(f.original.agentSessionId, f.original.run)).rejects.toThrow('original stop receipt lost')
    const operation = f.internal.kernel.stop.mock.calls[0][0]
    f.internal.kernel.status.mockRejectedValueOnce(new Error('Runtime observation unavailable'))
    await expect(f.client.stopAgent(f.original.agentSessionId, f.original.run)).rejects.toThrow('Runtime observation unavailable')
    expect(await f.store.readMetadata(f.original.agentSessionId)).toEqual(f.original)
    f.allowReceipt()
    await expect(f.client.stopAgent(f.original.agentSessionId, f.original.run)).resolves.toBeUndefined()
    expect(f.internal.kernel.prepareStop).toHaveBeenCalledTimes(1)
    expect(f.internal.kernel.stop.mock.calls.map((call: any[]) => call[0])).toEqual([operation, operation])
  })
  it('a delayed status reader joins retirement confirmed by another reader', async () => {
    const f = await fixture('memory')
    const observed = await f.internal.kernel.status()
    let release!: () => void
    const barrier = new Promise<void>(done => { release = done })
    f.internal.kernel.status.mockImplementationOnce(async () => { await barrier; return observed })
    f.allowReceipt()
    const first = f.client.stopAgent(f.original.agentSessionId, f.original.run)
    await vi.waitFor(() => expect(f.internal.kernel.status).toHaveBeenCalledTimes(2))
    try { await expect(f.client.stopAgent(f.original.agentSessionId, f.original.run)).resolves.toBeUndefined() }
    finally { release() }
    await expect(first).resolves.toBeUndefined()
    expect(f.internal.kernel.stop).toHaveBeenCalledTimes(1)
  })
  it('late readers retain confirmed retirement errors and preserve a subsequently reopened Run', async () => {
    const f = await fixture('file')
    const observed = await f.internal.kernel.status()
    let releaseStop!: () => void, releaseClose!: () => void
    const stopBarrier = new Promise<void>(done => { releaseStop = done })
    const closeBarrier = new Promise<void>(done => { releaseClose = done })
    f.internal.kernel.stop.mockImplementation(async () => { await stopBarrier })
    f.internal.acp.unbind = vi.fn(async () => { await closeBarrier; throw new Error('old ACP close failed') })
    const outcome = (promise: Promise<void>) => promise.then(() => null, error => error.message)
    const first = outcome(f.client.stopAgent(f.original.agentSessionId, f.original.run))
    await vi.waitFor(() => expect(f.internal.kernel.stop).toHaveBeenCalledTimes(1))
    f.internal.kernel.status.mockResolvedValue({ ...observed, state: { type: 'exited', code: 0, signal: null }, pid: null })
    const second = outcome(f.client.stopAgent(f.original.agentSessionId, f.original.run))
    try {
      await vi.waitFor(() => expect(f.internal.registry.has(f.original.agentSessionId)).toBe(false))
      const retired = (await f.store.loadRetiredAgentSessions())[0]!
      let reservation = await f.internal.registry.reserveReopen(f.original.agentSessionId, retired.observedAt, 'reopen-original', 'explicit-reopen')
      const prepared = { ...f.original, capabilityHash: 'c'.repeat(64) }
      reservation = await f.internal.registry.prepareReopen(reservation, prepared)
      const reopened = { ...prepared, run: { runId: 'reopened-run' }, retiredRuns: [f.original.run],
        reopenedFrom: { run: f.original.run, source: 'user', observedAt: retired.observedAt } }
      await f.internal.registry.commitLifecycle(reservation, reopened)
      f.internal.agentInputCursors.set(f.original.agentSessionId, 999)
      f.internal.agentInputTails.set(f.original.agentSessionId, { tail: Promise.resolve(), renderObservations: new Set() })
      releaseClose()
      expect(await second).toBe('Agent stopped but Agent Session cleanup failed.')
      expect(f.internal.registry.get(f.original.agentSessionId).run).toEqual({ runId: 'reopened-run' })
      expect(f.internal.agentInputCursors.get(f.original.agentSessionId)).toBe(999)
      expect(f.internal.agentInputTails.has(f.original.agentSessionId)).toBe(true)
      f.internal.kernel.status.mockResolvedValue({ ...observed, runId: 'reopened-run' })
      f.internal.kernel.stop.mockImplementation(async () => {})
      f.internal.acp.unbind.mockImplementation(async () => {})
      await expect(f.client.stopAgent(f.original.agentSessionId, { runId: 'reopened-run' })).resolves.toBeUndefined()
    } finally { releaseClose(); releaseStop() }
    expect(await first).toBe('Agent stopped but Agent Session cleanup failed.')
    expect(f.internal.acp.unbind).toHaveBeenCalledTimes(2)
    expect(f.internal.registry.has(f.original.agentSessionId)).toBe(false)
    expect((await f.store.loadRetiredAgentSessions())[0]?.run).toEqual({ runId: 'reopened-run' })
  })
  it.each(['memory', 'file'] as const)('claims only the exact Stop target and leaves another lifecycle untouched in %s', async kind => {
    const f = await fixture(kind)
    const ownerId = 'target-claim-owner'
    const base = { ownerId, ownerPid: process.pid, expiresAt: reshapeFixtureEpoch(0, 0, 1), operationId: 'original-operation' }
    const resume = { ...base, kind: 'resume' as const, agentSessionId: f.original.agentSessionId,
      reservationId: 'original-resume', expectedRun: f.original.run }
    await f.store.reserveLifecycle(resume)
    const claim = { ownerId, ownerPid: process.pid, now: reshapeFixtureEpoch(0, 0, 2), expiresAt: reshapeFixtureEpoch(0, 0, 3) }
    expect(await f.store.claimStaleLifecycles(claim, { agentSessionId: f.original.agentSessionId, expectedRun: f.original.run })).toEqual([])
    await f.store.releaseLifecycle(resume)
    const stop = { ...base, kind: 'stop' as const, agentSessionId: f.original.agentSessionId,
      reservationId: 'original-stop', expectedRun: f.original.run,
      stopOperation: { daemonInstance: 'original-daemon', operationKey: base.operationId, runId: f.original.run.runId } }
    await f.store.reserveLifecycle(stop)
    expect(await f.store.claimStaleLifecycles(claim, { agentSessionId: f.original.agentSessionId, expectedRun: { runId: 'wrong-run' } })).toEqual([])
    await f.store.compareAndSwap(null, { ...f.original, agentSessionId: 'unrelated-agent', run: { runId: 'unrelated-run' },
      nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'unrelated-native' } })
    const unrelated = { ...base, kind: 'resume' as const, agentSessionId: 'unrelated-agent', reservationId: 'unrelated-resume', expectedRun: { runId: 'unrelated-run' } }
    await f.store.reserveLifecycle(unrelated)
    expect(await f.store.claimStaleLifecycles(claim, { agentSessionId: f.original.agentSessionId, expectedRun: f.original.run })).toEqual([{ ...stop, expiresAt: reshapeFixtureEpoch(0, 0, 3) }])
    expect(await f.store.claimStaleLifecycles({ ...claim, expiresAt: reshapeFixtureEpoch(0, 0, 4) })).toEqual(expect.arrayContaining([{ ...unrelated, expiresAt: reshapeFixtureEpoch(0, 0, 4) }]))
  })
  it('a lost applied retirement ACK cannot let a late reader unbind the reopened Agent', async () => {
    const f = await fixture('file')
    const observed = await f.internal.kernel.status()
    let release!: () => void
    const barrier = new Promise<void>(done => { release = done })
    f.internal.kernel.stop.mockImplementation(async () => { await barrier })
    f.internal.acp.unbind = vi.fn(async () => {})
    const commit = f.store.commitLifecycle.bind(f.store)
    let lose = true
    f.store.commitLifecycle = async (reservation, next) => {
      await commit(reservation, next)
      if (lose && reservation.kind === 'stop') { lose = false; throw new Error('Applied retirement ACK lost') }
    }
    const first = f.client.stopAgent(f.original.agentSessionId, f.original.run).then(() => null, error => error.code)
    await vi.waitFor(() => expect(f.internal.kernel.stop).toHaveBeenCalledTimes(1))
    f.internal.kernel.status.mockResolvedValue({ ...observed, state: { type: 'exited', code: 0, signal: null }, pid: null })
    try {
      await expect(f.client.stopAgent(f.original.agentSessionId, f.original.run)).rejects.toThrow('Agent stopped but Agent Session cleanup failed.')
      const retired = (await f.store.loadRetiredAgentSessions())[0]!
      let reservation = await f.internal.registry.reserveReopen(f.original.agentSessionId, retired.observedAt, 'reopen-after-lost-ack', 'explicit-reopen')
      const prepared = { ...f.original, capabilityHash: 'c'.repeat(64) }
      reservation = await f.internal.registry.prepareReopen(reservation, prepared)
      await f.internal.registry.commitLifecycle(reservation, { ...prepared, run: { runId: 'reopened-run' }, retiredRuns: [f.original.run],
        reopenedFrom: { run: f.original.run, source: 'user', observedAt: retired.observedAt } })
    } finally { release() }
    expect(await first).toBe('STALE_AGENT_SESSION')
    expect(f.internal.acp.unbind).toHaveBeenCalledTimes(1)
    expect(f.internal.registry.get(f.original.agentSessionId).run).toEqual({ runId: 'reopened-run' })
    expect((await f.store.readMetadata(f.original.agentSessionId))?.run).toEqual({ runId: 'reopened-run' })
  })
  it('refuses another Run and another live owner without changing the original reservation or Session', async () => {
    const f = await fixture('file')
    const reservation = { kind: 'stop' as const, agentSessionId: f.original.agentSessionId, reservationId: 'foreign-reservation',
      ownerId: 'another-live-owner', ownerPid: process.pid, operationId: 'original-foreign-stop', expiresAt: reshapeFixtureEpoch(0, 0, 1),
      expectedRun: f.original.run, stopOperation: { runId: f.original.run.runId, daemonInstance: 'original-daemon', operationKey: 'original-foreign-stop' } }
    await f.store.reserveLifecycle(reservation)
    await expect(f.client.stopAgent(f.original.agentSessionId, { runId: 'another-run' })).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
    await expect(f.client.stopAgent(f.original.agentSessionId, f.original.run)).rejects.toMatchObject({ code: 'AGENT_SESSION_BUSY' })
    expect(f.internal.kernel.stop).not.toHaveBeenCalled()
    expect(await f.store.readMetadata(f.original.agentSessionId)).toEqual(f.original)
    expect(await f.store.claimStaleLifecycles({ ownerId: reservation.ownerId, ownerPid: process.pid, now: reshapeFixtureEpoch(0, 0, 2), expiresAt: reshapeFixtureEpoch(0, 0, 3) })).toEqual([{ ...reservation, expiresAt: reshapeFixtureEpoch(0, 0, 3) }])
  })
  it.each(['memory', 'file'] as const)('refuses a Store decorator that drops the exact target instead of stopping another Agent in %s', async kind => {
    const f = await fixture(kind)
    const other = { ...f.original, agentSessionId: 'another-agent', run: { runId: 'another-run' },
      nativeHandle: { kind: 'provider' as const, providerId: 'claude', sessionId: 'another-native' } }
    await f.store.compareAndSwap(null, other)
    const stop = { kind: 'stop' as const, agentSessionId: other.agentSessionId, expectedRun: other.run,
      reservationId: 'other-stop', ownerId: f.internal.registry.lifecycleOwnerId, ownerPid: process.pid,
      operationId: 'other-operation', expiresAt: reshapeFixtureEpoch(0, 0, 1),
      stopOperation: { daemonInstance: 'original-daemon', operationKey: 'other-operation', runId: other.run.runId } }
    await f.store.reserveLifecycle(stop)
    const originalClaim = f.store.claimStaleLifecycles.bind(f.store)
    f.store.claimStaleLifecycles = claim => originalClaim(claim)
    await expect(f.client.stopAgent(f.original.agentSessionId, f.original.run)).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE' })
    expect(f.internal.kernel.prepareStop).not.toHaveBeenCalled()
    expect(f.internal.kernel.stop).not.toHaveBeenCalled()
    expect(await f.store.readMetadata(f.original.agentSessionId)).toEqual(f.original)
    expect(await f.store.readMetadata(other.agentSessionId)).toEqual(other)
    expect(await originalClaim({ ownerId: stop.ownerId, ownerPid: process.pid, now: reshapeFixtureEpoch(0, 0, 2), expiresAt: reshapeFixtureEpoch(0, 0, 3) })).toEqual([{ ...stop, expiresAt: reshapeFixtureEpoch(0, 0, 3) }])
  })
})
