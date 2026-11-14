import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore, AgentMuxSessionDurabilityError, type AgentMuxAgentSessionStore } from '../src/agent-session-store.js';
import { agentLifecycleOperationIdentity } from "../src/agent-session-identity.js";
import { trigger, syncFault } from './fixtures/hook-transaction/faults.js'
import { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import type { AgentMuxStoredAgentSession, AgentTimelineMutation } from '../src/types.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
function tool(id: string, itemId = 'original-tool'): AgentTimelineMutation {
  return { type: 'append', agentSessionId: id, item: { id: itemId, agentSessionId: id, kind: 'tool_call',
    source: 'native-hook', status: 'streaming', createdAt: 2, updatedAt: 2, title: 'Original Tool',
    toolName: 'Bash', toolInput: '{"command":"original"}' } }
}
async function owner(kind: 'file' | 'memory' = 'file', warm = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hook-transaction-store-'))), path = join(root, 'sessions.sqlite')
  const store = kind === 'file' ? new AgentMuxFileAgentSessionStore(path) : new AgentMuxMemoryAgentSessionStore()
  const original: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-session', providerId: 'codex', executorId: 'codex',
    hostId: 'local', workspacePath: root, run: { runId: 'original-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1,
    hookBindingId: 'b'.repeat(43), hookToken: 't'.repeat(43),
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-native' } }
  const next: AgentMuxStoredAgentSession = { ...original, updatedAt: 2, hookReceipt: { id: 'original-receipt',
    providerId: 'codex', agentSessionId: original.agentSessionId, run: original.run, eventName: 'PreToolUse',
    lifecycleEvent: 'tool-use-start', observedAt: 2 }, promptCompletionAdmission: {
      submissionId: 'original-input', operationId: 'original-payload', startByte: 0, endByte: 8, acknowledged: true,
      intent: { run: original.run, ownerInstanceId: 'original-owner', prompt: 'original', plan: { kind: 'single-phase', data: 'original\r' } }
    } }
  await store.compareAndSwap(null, original)
  if (warm) await store.applyTimelineMutation(tool(original.agentSessionId, 'seed'))
  cleanup.push(async () => {
    // Retire only this test's exact still-owned cleanup; never unlink a live lock as recovery.
    if (kind === 'file') { const pending = Reflect.get(store, 'pendingLockRelease'); if (pending) await pending() }
    await rm(root, { recursive: true, force: true })
  })
  return { root, path, store, original, next, mutation: tool(original.agentSessionId) }
}
const write = (f: Awaited<ReturnType<typeof owner>>, signal?: AbortSignal) =>
  f.store.compareAndSwapMetadataWithTimeline(f.original, f.next, f.mutation, signal)
function belongs(db: DatabaseSync, path: string) {
  return db.prepare('PRAGMA database_list').all().some(row => row.file === path)
}
function rollbackToFault(path: string, wholeRollbackFails = false) {
  const execute = DatabaseSync.prototype.exec, savepointFailure = new Error('Controlled rollback-to failure'), outerFailure = new Error('Controlled outer rollback failure')
  let target: DatabaseSync | undefined, outer = 0
  const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function(this: DatabaseSync, sql: string) {
    if (sql === 'ROLLBACK TO hook_history' && belongs(this, path)) { target = this; throw savepointFailure }
    if (sql === 'ROLLBACK' && this === target) { outer++; if (wholeRollbackFails) throw outerFailure }
    return execute.call(this, sql)
  })
  return { spy, savepointFailure, outerFailure, outer: () => outer, target: () => target }
}

it.each(['file', 'memory'] as const)('%s commits exact metadata, prompt admission and one original history result', async kind => {
  const f = await owner(kind), before = await f.store.readCapturedHistory(f.original.agentSessionId)
  const result = await write(f)
  expect(result).toMatchObject({ timeline: { changed: true, position: { id: 'original-tool', firstSequence: 2, sequence: 2 } } })
  expect(await f.store.readMetadata(f.original.agentSessionId)).toEqual(f.next)
  expect((await f.store.readPromptAdmission(f.original.agentSessionId, f.original.run, 'original-input'))?.admission).toEqual(f.next.promptCompletionAdmission)
  const after = await f.store.readCapturedHistory(f.original.agentSessionId)
  expect(after.stream.epoch).toBe(before.stream.epoch); expect(after.records.map(row => row.item.id)).toContain('original-tool')
})

it.each(['file', 'memory'] as const)('%s invalid and oversized optional history still accepts only the exact valid metadata', async kind => {
  for (const invalid of [true, false]) {
    const f = await owner(kind), before = await f.store.readCapturedHistory(f.original.agentSessionId)
    const mutation = invalid ? { ...f.mutation, item: { ...(f.mutation as Extract<AgentTimelineMutation, {type:'append'}>).item, kind: 'invalid' } }
      : { ...f.mutation, item: { ...(f.mutation as Extract<AgentTimelineMutation, {type:'append'}>).item, toolInput: 'x'.repeat(128 * 1024) } }
    const result = await f.store.compareAndSwapMetadataWithTimeline(f.original, f.next, mutation as AgentTimelineMutation)
    expect(result).toMatchObject({ timelineFailure: { code: invalid ? 'INVALID_AGENT_TIMELINE' : 'AGENT_TIMELINE_TOO_LARGE' } })
    expect(await f.store.readMetadata(f.original.agentSessionId)).toEqual(f.next)
    expect(await f.store.readCapturedHistory(f.original.agentSessionId)).toEqual(before)
  }
})

it.each(['file', 'memory'] as const)('%s metadata rejection and original cancellation change no metadata, prompt record or history', async kind => {
  const f = await owner(kind), history = await f.store.readCapturedHistory(f.original.agentSessionId)
  await expect(f.store.compareAndSwapMetadataWithTimeline({ ...f.original, updatedAt: 7 }, f.next, f.mutation)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  const controller = new AbortController(), reason = new Error('original cancellation'); controller.abort(reason)
  await expect(write(f, controller.signal)).rejects.toBe(reason)
  expect(await f.store.readMetadata(f.original.agentSessionId)).toEqual(f.original)
  expect(await f.store.readPromptAdmission(f.original.agentSessionId, f.original.run, 'original-input')).toBeNull()
  expect(await f.store.readCapturedHistory(f.original.agentSessionId)).toEqual(history)
})

it('Memory stages clone, prompt records and history without an intermediate await', async () => {
  const f = await owner('memory'), observations: unknown[] = []
  queueMicrotask(() => observations.push({ session: Reflect.get(f.store, 'sessions').get(f.original.agentSessionId),
    history: Reflect.get(f.store, 'timelines').get(f.original.agentSessionId).heads.has('original-tool'),
    promptRecords: Reflect.get(f.store, 'promptAdmissions').size }))
  const pending = write(f); await pending
  expect(observations).toEqual([{ session: f.next, history: true, promptRecords: 1 }])
  const prior = await f.store.readMetadata(f.original.agentSessionId), history = await f.store.readCapturedHistory(f.original.agentSessionId)
  const controller = new AbortController(), reason = new Error('cancel while staging')
  const item = { ...(f.mutation as Extract<AgentTimelineMutation, {type:'append'}>).item, id: 'cancelled-tool',
    get title() { controller.abort(reason); return 'original title' } }
  await expect(f.store.compareAndSwapMetadataWithTimeline(prior!, { ...f.next, updatedAt: 3 }, { type: 'append', agentSessionId: f.original.agentSessionId, item }, controller.signal)).rejects.toBe(reason)
  expect(await f.store.readMetadata(f.original.agentSessionId)).toEqual(prior)
  expect(await f.store.readCapturedHistory(f.original.agentSessionId)).toEqual(history)
})

it('FileStore actual preparation failure preserves valid receipt and original incomplete-history error', async () => {
  const f = await owner('file', false)
  const path = Reflect.get(f.store, 'timelinePath').call(f.store, f.original.agentSessionId) as string
  await mkdir(path, { recursive: true })
  const result = await write(f)
  expect(result).toMatchObject({ timelineFailure: { code: 'INVALID_AGENT_TIMELINE_STORE' } })
  expect(await f.store.readMetadata(f.original.agentSessionId)).toEqual(f.next)
})

it('FileStore real SQL failure rolls back only optional history and preserves its outward error class', async () => {
  const f = await owner(), before = await f.store.readCapturedHistory(f.original.agentSessionId)
  trigger(f.path, 'ABORT')
  const result = await write(f)
  expect('timelineFailure' in result).toBe(true)
  if (!('timelineFailure' in result)) throw new Error('Nonempty failure expected')
  expect(result.timelineFailure).toBeInstanceOf(AgentMuxError)
  expect(result.timelineFailure).toMatchObject({ code: 'AGENT_SESSION_STORE_UNAVAILABLE', cause: { errcode: 1811 } })
  expect(await f.store.readMetadata(f.original.agentSessionId)).toEqual(f.next)
  expect(await f.store.readCapturedHistory(f.original.agentSessionId)).toEqual(before)
})

it.each(['automatic', 'explicit'] as const)('FileStore %s full rollback before COMMIT confirms cleanup before exact metadata-only CAS', async mode => {
  const f = await owner(), before = await f.store.readCapturedHistory(f.original.agentSessionId)
  trigger(f.path, mode === 'automatic' ? 'ROLLBACK' : 'ABORT')
  const fault = mode === 'explicit' ? rollbackToFault(f.path) : undefined
  const fallback = vi.spyOn(f.store, 'compareAndSwapMetadata')
  const result = await write(f)
  expect(result).toMatchObject({ timelineFailure: { code: 'AGENT_SESSION_STORE_UNAVAILABLE' } })
  expect(fallback).toHaveBeenCalledExactlyOnceWith(f.original, f.next, undefined)
  if (fault) expect(fault.outer()).toBe(1)
  expect(await f.store.readMetadata(f.original.agentSessionId)).toEqual(f.next)
  expect(await f.store.readCapturedHistory(f.original.agentSessionId)).toEqual(before)
})

it('failed outer rollback cannot authorize metadata fallback and preserves cleanup evidence', async () => {
  const f = await owner(), before = await f.store.readCapturedHistory(f.original.agentSessionId)
  trigger(f.path, 'ABORT'); const fault = rollbackToFault(f.path, true), fallback = vi.spyOn(f.store, 'compareAndSwapMetadata')
  const failure = await write(f).then(() => undefined, error => error)
  expect(failure).toMatchObject({ code: 'AGENT_SESSION_STORE_UNAVAILABLE', cleanup: expect.arrayContaining([fault.savepointFailure, fault.outerFailure]) })
  expect(fallback).not.toHaveBeenCalled()
  fault.spy.mockRestore()
  expect(await f.store.readMetadata(f.original.agentSessionId)).toEqual(f.original)
  expect(await f.store.readCapturedHistory(f.original.agentSessionId)).toEqual(before)
})

it.each(['native', 'run', 'metadata'] as const)('a real second Store %s change rejects the frozen exact compound CAS', async change => {
  const f = await owner(), second = new AgentMuxFileAgentSessionStore(f.path)
  const other = { ...f.original, updatedAt: 8, ...(change === 'native' ? { nativeHandle: { ...f.original.nativeHandle!, sessionId: 'other-native' } }
    : change === 'run' ? { run: { runId: 'other-run' }, retiredRuns: [f.original.run] } : {}) }
  await second.compareAndSwapMetadata(f.original, other)
  await expect(write(f)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect(await second.readMetadata(f.original.agentSessionId)).toEqual(other)
  expect((await second.readCapturedHistory(f.original.agentSessionId)).records.map(row => row.item.id)).toEqual(['seed'])
})

it('abort after real history SQL but before COMMIT rolls back both original facts', async () => {
  const f = await owner(), controller = new AbortController(), reason = new Error('original pre-COMMIT cancel'), execute = DatabaseSync.prototype.exec
  const before = await f.store.readCapturedHistory(f.original.agentSessionId)
  vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function(this: DatabaseSync, sql: string) {
    const result = execute.call(this, sql)
    if (sql === 'RELEASE hook_history' && belongs(this, f.path)) controller.abort(reason)
    return result
  })
  await expect(write(f, controller.signal)).rejects.toBe(reason)
  expect(await f.store.readMetadata(f.original.agentSessionId)).toEqual(f.original)
  expect(await f.store.readCapturedHistory(f.original.agentSessionId)).toEqual(before)
})

it.each(['compound', 'fallback'] as const)('%s metadata sync loss remains the true Registry durability failure', async mode => {
  const f = await owner()
  if (mode === 'fallback') trigger(f.path, 'ROLLBACK')
  const fault = await syncFault(f.path, db => JSON.parse(String(db.prepare('SELECT json FROM sessions WHERE id=?').get(f.original.agentSessionId)!.json)).hookReceipt?.id === f.next.hookReceipt!.id)
  const notices: unknown[] = [], registry = new AgentMuxAgentSessionRegistry(f.store, (session, error) => notices.push({ session, error }))
  await registry.load('local')
  const failure = await registry.updateWithTimeline(f.original.agentSessionId, f.original.run, () => ({ session: f.next, mutation: f.mutation })).then(() => undefined, error => error)
  expect(fault.hits()).toBe(1); expect(failure).toBeInstanceOf(AgentMuxSessionDurabilityError)
  expect(failure.cause).toBe(fault.failure)
  expect(registry.get(f.original.agentSessionId)).toEqual(f.next); expect(registry.isDurabilityUnconfirmed(f.original.agentSessionId)).toBe(true)
  expect(notices).toContainEqual({ session: f.next, error: failure })
  if (mode === 'fallback') expect(failure.timelineFailure).toMatchObject({ code: 'AGENT_SESSION_STORE_UNAVAILABLE', cause: { errcode: 1811 } })
  fault.spy.mockRestore()
  await registry.confirmDurability(f.original.agentSessionId, f.original.run)
  expect(registry.isDurabilityUnconfirmed(f.original.agentSessionId)).toBe(false)
  expect((await f.store.readCapturedHistory(f.original.agentSessionId)).records.map(row => row.item.id)).toEqual(mode === 'compound' ? ['original-tool', 'seed'] : ['seed'])
})

it('preparation-only sync loss does not masquerade as Registry metadata uncertainty', async () => {
  const f = await owner('file', false), notices: unknown[] = []
  const fault = await syncFault(f.path, db => db.prepare("SELECT 1 FROM captured_streams WHERE session_id=? AND state='preparing'").get(f.original.agentSessionId) !== undefined)
  const registry = new AgentMuxAgentSessionRegistry(f.store, (session, error) => notices.push({ session, error })); await registry.load('local')
  const result = await registry.updateWithTimeline(f.original.agentSessionId, f.original.run, () => ({ session: f.next, mutation: f.mutation }))
    .then(value => ({ value }), error => ({ error }))
  expect(registry.isDurabilityUnconfirmed(f.original.agentSessionId)).toBe(false); expect(notices).toEqual([])
  expect(result).toMatchObject({ value: { timeline: { timelineFailure: { code: 'AGENT_SESSION_STORE_DURABILITY_UNCONFIRMED', cause: fault.failure } } } })
  expect(await f.store.readMetadata(f.original.agentSessionId)).toEqual(f.next)
  const db = new DatabaseSync(f.path, { readOnly: true })
  try { expect(db.prepare('SELECT COUNT(*) AS n FROM captured_record_versions').get()!.n).toBe(0) } finally { db.close() }
})

it.each([false, true])('an actual COMMIT with a lost ACK never retries metadata and retains exact original confirmation (historyFailed=%s)', async historyFailed => {
  const f = await owner(), execute = DatabaseSync.prototype.exec, ackFailure = new Error('Lost original COMMIT ACK')
  if (historyFailed) trigger(f.path, 'ABORT')
  const fallback = vi.spyOn(f.store, 'compareAndSwapMetadata'); let armed = true
  const fault = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function(this: DatabaseSync, sql: string) {
    const target = sql === 'COMMIT' && armed && belongs(this, f.path) &&
      JSON.parse(String(this.prepare('SELECT json FROM sessions WHERE id=?').get(f.original.agentSessionId)!.json)).hookReceipt?.id === f.next.hookReceipt!.id
    const value = execute.call(this, sql)
    if (target) { armed = false; throw ackFailure }
    return value
  })
  const registry = new AgentMuxAgentSessionRegistry(f.store); await registry.load('local')
  const failure = await registry.updateWithTimeline(f.original.agentSessionId, f.original.run, () => ({ session: f.next, mutation: f.mutation })).then(() => undefined, error => error)
  expect(failure).toBeInstanceOf(AgentMuxSessionDurabilityError); expect(failure).toMatchObject({ commitOutcome: 'unknown', cause: ackFailure })
  expect(fallback).not.toHaveBeenCalled(); expect(registry.isDurabilityUnconfirmed(f.original.agentSessionId)).toBe(true)
  fault.mockRestore(); await registry.confirmDurability(f.original.agentSessionId, f.original.run)
  expect(registry.isDurabilityUnconfirmed(f.original.agentSessionId)).toBe(false)
  expect((await f.store.readCapturedHistory(f.original.agentSessionId)).records.map(row => row.item.id)).toEqual(historyFailed ? ['seed'] : ['original-tool', 'seed'])
})

it.each(['once', 'unconfirmed'] as const)('original database close %s is resolved by its owning handle, not a metadata replay guess', async mode => {
  const f = await owner(); trigger(f.path, 'ABORT')
  const rollback = rollbackToFault(f.path), close = DatabaseSync.prototype.close, closeFailure = new Error('Controlled owned database close failure')
  const fallback = vi.spyOn(f.store, 'compareAndSwapMetadata'); let failures = 0, armed = true
  vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function(this: DatabaseSync) {
    if (this === rollback.target() && armed && (mode === 'unconfirmed' || failures === 0)) { failures++; throw closeFailure }
    return close.call(this)
  })
  const result = await write(f).then(value => ({ value }), error => ({ error }))
  if (mode === 'once') {
    expect(result).toMatchObject({ value: { timelineFailure: { cleanup: expect.arrayContaining([closeFailure]) } } })
    expect(fallback).toHaveBeenCalledOnce()
  } else {
    expect(result).toMatchObject({ error: { cleanup: expect.arrayContaining([closeFailure]) } })
    expect(fallback).not.toHaveBeenCalled()
  }
  armed = false; vi.restoreAllMocks()
  // Explicit original writer settles the retained handle; no new identity or timeline re-append.
  const current = await f.store.readMetadata(f.original.agentSessionId)
  await f.store.compareAndSwapMetadata(current, current)
  expect((await f.store.readCapturedHistory(f.original.agentSessionId)).records.map(row => row.item.id)).toEqual(['seed'])
})

it.each(['rolled-back', 'committed', 'history-recovered'] as const)('original flock release keeps its prior ACK contract (%s)', async phase => {
  const f = await owner()
  if (phase !== 'committed') trigger(f.path, phase === 'rolled-back' ? 'ROLLBACK' : 'ABORT')
  const acquire = Reflect.get(f.store, 'acquireLock').bind(f.store)
  const releaseFailure = new Error('Controlled original lease release failure')
  const fallback = vi.spyOn(f.store, 'compareAndSwapMetadata'), warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
  let armed = true
  vi.spyOn(f.store as unknown as { acquireLock(...args: unknown[]): Promise<() => Promise<void>> }, 'acquireLock')
    .mockImplementation(async (...args: unknown[]) => {
      const release = await acquire(...args)
      // Keep the real acquired flock and original release closure. Only its ACK is withheld.
      return async () => { if (armed) throw releaseFailure; await release() }
    })
  const result = await write(f).then(value => ({ value }), error => ({ error }))
  expect(warning).toHaveBeenCalledWith(expect.any(String), { code: 'AGENT_SESSION_STORE_LOCK_RELEASE_FAILED' })
  expect(Reflect.get(f.store, 'pendingLockRelease')).toEqual(expect.any(Function))
  expect(fallback).not.toHaveBeenCalled()
  if (phase === 'rolled-back') {
    expect(result).toMatchObject({ error: { cleanup: expect.arrayContaining([releaseFailure]) } })
    expect(await f.store.readMetadata(f.original.agentSessionId)).toEqual(f.original)
  } else {
    expect(result).toMatchObject({ value: phase === 'committed' ? { timeline: { changed: true } } : { timelineFailure: { code: 'AGENT_SESSION_STORE_UNAVAILABLE' } } })
    expect(await f.store.readMetadata(f.original.agentSessionId)).toEqual(f.next)
  }
  armed = false
  const current = await f.store.readMetadata(f.original.agentSessionId)
  await f.store.compareAndSwapMetadata(current, f.next)
  expect(await f.store.readMetadata(f.original.agentSessionId)).toEqual(f.next)
  expect(Reflect.get(f.store, 'pendingLockRelease')).toBeNull()
})

it('a real second Store restart reservation retains its frozen same-ID receipt fence', async () => {
  const f = await owner(), second = new AgentMuxFileAgentSessionStore(f.path)
  const request = { agentSessionId: f.original.agentSessionId, expectedRun: f.original.run, operationId: 'original-restart' }
  await second.reserveLifecycle({ kind: 'resume', agentSessionId: f.original.agentSessionId, expectedRun: f.original.run,
    reservationId: 'original-reservation', operationId: agentLifecycleOperationIdentity('restart', f.original.agentSessionId, request.operationId),
    ownerId: 'original-owner', ownerPid: process.pid, expiresAt: Date.now() + 60000,
    restart: { requestDigest: 'original-digest', request, nativeTarget: f.original.nativeHandle as Extract<NonNullable<AgentMuxStoredAgentSession['nativeHandle']>, {kind:'provider'}>,
      stopOperation: { daemonInstance: 'original-daemon', operationKey: 'original-stop', runId: f.original.run.runId } } })
  const current = (await second.readMetadata(f.original.agentSessionId))!, { [request.operationId]: original, ...others } = current.continuityOperations!
  const conflicting = { ...current, continuity: { ...original!, requestDigest: 'other-digest' },
    continuityOperations: { ...others, [request.operationId]: { ...original!, requestDigest: 'other-digest' } } }
  await expect(f.store.compareAndSwapMetadataWithTimeline(current, conflicting, f.mutation)).rejects.toMatchObject({ code: 'AGENT_CONTINUITY_SUPERSEDED' })
  expect(await second.readMetadata(f.original.agentSessionId)).toEqual(current)
  expect((await second.readCapturedHistory(f.original.agentSessionId)).records.map(row => row.item.id)).toEqual(['seed'])
})
