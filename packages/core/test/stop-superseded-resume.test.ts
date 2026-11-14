import { isDeepStrictEqual } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { core, fixture } from './helpers/prepared-resume-fixture.js'

// A prepared resume froze its Session before Start, then its Start became unknown. The Session is
// held by that reservation; a Stop of the same Run must take it over only with the Runtime's witness
// for the resume's creation key, and must never delete the reservation without one.

async function heldByUnknownStart(f: Awaited<ReturnType<typeof fixture>>, applied: boolean) {
  f.start.mockImplementationOnce(async (...args: any[]) => {
    if (applied) await f.nativeStart(...args)
    throw new core.AgentMuxError('Original Start unknown', 'CONTROL_UNAVAILABLE')
  })
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  const held = await f.correlation()
  expect(held).toMatchObject({ kind: 'resume', preparedSession: expect.any(Object) })
  return held!
}

function dropDispatch(f: Awaited<ReturnType<typeof fixture>>) {
  const db = new DatabaseSync(f.store.path)
  try { db.prepare("UPDATE reservations SET json=json_remove(json, '$.preparedDispatch') WHERE id=?").run(f.previous.agentSessionId) } finally { db.close() }
}

// Each test starts its own real ctxmux daemon and Run; under a loaded machine that alone can take seconds.
const REAL_RUNTIME_MS = 20_000

function rows(f: Awaited<ReturnType<typeof fixture>>) {
  const db = new DatabaseSync(f.store.path, { readOnly: true })
  try {
    return ['sessions', 'reservations', 'retired_sessions', 'retired_runs', 'run_bindings'].map(table =>
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
  } finally { db.close() }
}

it('seals a never-started prepared resume and retires the Session with that witness', async () => {
  const f = await fixture()
  const held = await heldByUnknownStart(f, false)
  const receipt = await f.client.stopAgent(f.previous.agentSessionId, f.previous.run, { operationId: 'stop-sealed' })
  expect(receipt).toMatchObject({ admission: 'new', operationId: 'stop-sealed',
    supersededResume: { lifecycleOperationId: held.operationId, resumeOperationId: f.request.operationId, fence: 'retired' } })
  expect(receipt.supersededResume?.retainedRun).toBeUndefined()
  // The key is sealed: the original resume can never start a Run afterwards.
  await expect(f.inner.kernel.observePreparedStartRetirement(held.operationId, held.preparedDispatch!.runtime)).resolves.toMatchObject({ outcome: 'retired' })
  expect(await f.store.readLifecycleReservation(f.previous.agentSessionId)).toBeNull()
  expect((await f.store.readRetiredAgentSession(f.previous.agentSessionId))?.stop?.supersededResume).toEqual(receipt.supersededResume)
  expect(f.start).toHaveBeenCalledTimes(1)
  expect(f.inputCount()).toBe(0)
}, REAL_RUNTIME_MS)

it('stops the one Run a prepared resume left under its key, then retires both Runs', async () => {
  const f = await fixture()
  const held = await heldByUnknownStart(f, true)
  const [orphan] = (await f.nativeList()).filter((run: any) => run.lifecycleOperationId === held.operationId)
  expect(orphan?.state.type).toBe('running')
  const receipt = await f.client.stopAgent(f.previous.agentSessionId, f.previous.run)
  expect(receipt).toMatchObject({ admission: 'new',
    supersededResume: { fence: 'retained', retainedRun: { runId: orphan.runId }, retainedStop: expect.stringMatching(/^(graceful|forced)$/) } })
  expect(receipt.stages.map(stage => [stage.stage, stage.outcome])).toEqual([
    ['admission', 'ok'], ['runtime-observe', 'ok'], ['runtime-stop', 'skipped'], ['retained-run-stop', 'ok'], ['retire-commit', 'ok']])
  await vi.waitFor(async () => expect((await f.inner.kernel.status(orphan.runId)).state.type).not.toBe('running'))
  expect((await f.store.loadRetiredRuns()).map(run => run.runId)).toEqual(expect.arrayContaining([f.previous.run.runId, orphan.runId]))
  // This client knows the retained Run retired at once, without reloading: it is neither listed nor removable as a terminal.
  expect((await f.client.listRuns()).map(run => run.runId)).not.toContain(orphan.runId)
  await expect(f.client.removeTerminal({ runId: orphan.runId })).rejects.toMatchObject({ code: 'RUN_KIND_MISMATCH' })
  expect(f.start).toHaveBeenCalledTimes(1)
  expect(f.inputCount()).toBe(0)
}, REAL_RUNTIME_MS)

it('an original queued takeover retirement protects its retained Run without waiting for an unrelated Run', async () => {
  const f = await fixture(), held = await heldByUnknownStart(f, true)
  const [orphan] = (await f.nativeList()).filter((run: any) => run.lifecycleOperationId === held.operationId)
  const other = await f.client.createTerminal({ command: process.execPath, args: ['-e', 'process.stdin.resume()'], workspacePath: f.root, createOperationId: 'independent-takeover-terminal' })
  const originalCommit = f.store.commitLifecycle.bind(f.store)
  const observations: Array<{ unrelated: boolean; before?: boolean; after?: boolean }> = []
  vi.spyOn(f.store, 'commitLifecycle').mockImplementationOnce(async (reservation: any, next: any, record: any) => {
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>(yes => { entered = yes }), hold = new Promise<void>(yes => { release = yes })
    const blocker = (f.store as any).enqueue(async () => { entered(); await hold }, undefined, 'unrelated-writer')
    await ready
    const writing = originalCommit(reservation, next, record)
    let observed: boolean | undefined
    const exact = f.store.hasAgentRun({ runId: orphan.runId }).then((value: boolean) => { observed = value; return value })
    try {
      observations.push({ unrelated: await f.store.hasAgentRun({ runId: other.runId }), before: observed })
    } finally { release(); await blocker }
    const result = await writing
    observations[0]!.after = await exact
    return result
  })
  const receipt = await f.client.stopAgent(f.previous.agentSessionId, f.previous.run, { operationId: 'queued-original-takeover' })
  expect(receipt.supersededResume?.retainedRun).toEqual({ runId: orphan.runId })
  expect(observations).toEqual([{ unrelated: false, before: undefined, after: true }])
  expect((await f.inner.kernel.status(other.runId)).state.type).toBe('running')
  expect(f.inputCount()).toBe(0)
}, REAL_RUNTIME_MS)

it.each([
  { owner: 'memory' as const, edit: 'omit' }, { owner: 'memory' as const, edit: 'forge' },
  { owner: 'file' as const, edit: 'omit' }, { owner: 'file' as const, edit: 'forge' }
])('refuses an edited takeover commit and continues from the same original row ($owner/$edit)', async ({ owner, edit }) => {
  const f = await fixture('positional-argv', false, owner), held = await heldByUnknownStart(f, true)
  const [orphan] = (await f.nativeList()).filter((run: any) => run.lifecycleOperationId === held.operationId)
  const originalCommit = f.store.commitLifecycle.bind(f.store)
  const observations: any[] = []
  vi.spyOn(f.store, 'commitLifecycle').mockImplementationOnce(async (reservation: any, next: any, record: any) => {
    const original = await f.store.readLifecycleReservation(f.previous.agentSessionId)
    const session = await f.store.readMetadata(f.previous.agentSessionId)
    const edited = structuredClone(reservation)
    if (edit === 'omit') delete edited.supersededResume
    else edited.supersededResume.retainedRun = { runId: 'another-unowned-run' }
    const attempt = await originalCommit(edited, next, record).then((value: unknown) => ({ kind: 'accepted', value }), (error: any) => ({ kind: 'rejected', code: error.code }))
    observations.push({ attempt, originalRetained: isDeepStrictEqual(await f.store.readLifecycleReservation(f.previous.agentSessionId), original),
      sessionRetained: isDeepStrictEqual(await f.store.readMetadata(f.previous.agentSessionId), session),
      retirement: await f.store.readRetiredAgentSession(f.previous.agentSessionId), forgedOwned: await f.store.hasAgentRun({ runId: 'another-unowned-run' }) })
    if (attempt.kind === 'accepted') return attempt.value
    return await originalCommit((await f.store.readLifecycleReservation(f.previous.agentSessionId))!, next, record)
  })
  const receipt = await f.client.stopAgent(f.previous.agentSessionId, f.previous.run, { operationId: 'same-original-takeover' })
  expect(receipt.operationId).toBe('same-original-takeover')
  expect(observations).toEqual([{ attempt: { kind: 'rejected', code: 'STALE_AGENT_SESSION' }, originalRetained: true, sessionRetained: true, retirement: null, forgedOwned: false }])
  expect(receipt.supersededResume?.retainedRun).toEqual({ runId: orphan.runId })
  expect(await f.store.hasAgentRun({ runId: orphan.runId })).toBe(true)
  expect(f.stop).toHaveBeenCalledTimes(1)
  expect(f.inputCount()).toBe(0)
}, REAL_RUNTIME_MS)

it('an older resume without its dispatch is taken over only through a retained Run', async () => {
  const f = await fixture()
  const held = await heldByUnknownStart(f, true)
  dropDispatch(f)
  const [orphan] = (await f.nativeList()).filter((run: any) => run.lifecycleOperationId === held.operationId)
  const receipt = await f.client.stopAgent(f.previous.agentSessionId, f.previous.run)
  expect(receipt.supersededResume).toMatchObject({ fence: 'retained', retainedRun: { runId: orphan.runId } })
  await vi.waitFor(async () => expect((await f.inner.kernel.status(orphan.runId)).state.type).not.toBe('running'))
  expect(await f.store.readLifecycleReservation(f.previous.agentSessionId)).toBeNull()
}, REAL_RUNTIME_MS)

it('refuses, names the original resume and changes nothing when no witness can exist', async () => {
  const f = await fixture()
  const held = await heldByUnknownStart(f, false)
  dropDispatch(f)
  const before = rows(f)
  const refusal = await f.client.stopAgent(f.previous.agentSessionId, f.previous.run).then(() => null, error => error)
  expect(refusal).toMatchObject({ code: 'AGENT_STOP_BLOCKED_BY_UNCONFIRMED_RESUME' })
  expect(refusal.message).toContain(held.operationId)
  expect(refusal.message).toContain(f.request.operationId)
  expect(rows(f)).toEqual(before)
  expect(f.stop).not.toHaveBeenCalled()
  expect(await f.client.inspectAgentStop({ agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run }))
    .toMatchObject({ phase: 'unconfirmed', canRetry: false, holder: { kind: 'resume', operationId: held.operationId } })
  expect((await f.store.readMetadata(f.previous.agentSessionId))?.run).toEqual(f.previous.run)
}, REAL_RUNTIME_MS)

it('a takeover Stop interrupted before retirement finishes on the next start with its witness', async () => {
  const f = await fixture()
  const held = await heldByUnknownStart(f, true)
  const [orphan] = (await f.nativeList()).filter((run: any) => run.lifecycleOperationId === held.operationId)
  // The retained Run's stop fails once, so the takeover Stop stays open with its witness on the reservation.
  const stop = f.inner.kernel.stop.bind(f.inner.kernel)
  vi.spyOn(f.inner.kernel, 'stop').mockImplementationOnce(async () => { throw new core.AgentMuxError('Runtime stop unconfirmed', 'CONTROL_UNAVAILABLE') })
    .mockImplementation(stop)
  await expect(f.client.stopAgent(f.previous.agentSessionId, f.previous.run, { operationId: 'interrupted-takeover' })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  const open = await f.store.readLifecycleReservation(f.previous.agentSessionId)
  expect(open).toMatchObject({ kind: 'stop', supersededResume: { fence: 'retained', retainedRun: { runId: orphan.runId } },
    progress: { failure: { stage: 'retained-run-stop', code: 'CONTROL_UNAVAILABLE' } } })
  await f.client.dispose()
  // Model the app restart: the process that owned the open Stop is gone.
  const db = new DatabaseSync(f.store.path)
  try { db.prepare("UPDATE reservations SET json=json_set(json, '$.ownerPid', 999999999) WHERE id=?").run(f.previous.agentSessionId) } finally { db.close() }
  const next = await f.reader()
  expect(await next.store.readLifecycleReservation(f.previous.agentSessionId)).toBeNull()
  await vi.waitFor(async () => expect((await next.inner.kernel.status(orphan.runId)).state.type).not.toBe('running'))
  expect((await next.store.readRetiredAgentSession(f.previous.agentSessionId))?.stop?.supersededResume)
    .toMatchObject({ lifecycleOperationId: held.operationId, fence: 'retained', retainedRun: { runId: orphan.runId } })
}, REAL_RUNTIME_MS)

it('a resume still owned by another live process is neither fenced nor taken over', async () => {
  const f = await fixture()
  const held = await heldByUnknownStart(f, false)
  // Another Core process, alive and holding this resume between its preparation and its Start.
  const db = new DatabaseSync(f.store.path)
  try { db.prepare("UPDATE reservations SET json=json_set(json, '$.ownerId', 'another-live-owner', '$.ownerPid', ?) WHERE id=?").run(process.ppid, f.previous.agentSessionId) } finally { db.close() }
  const before = rows(f)
  await expect(f.client.stopAgent(f.previous.agentSessionId, f.previous.run)).rejects.toMatchObject({ code: 'AGENT_SESSION_BUSY' })
  // The creation key was not sealed, so that owner can still start its Run; nothing in the Store moved.
  await expect(f.inner.kernel.observePreparedStartRetirement(held.operationId, held.preparedDispatch!.runtime)).resolves.toMatchObject({ outcome: 'not_retired' })
  expect(rows(f)).toEqual(before)
}, REAL_RUNTIME_MS)

it('a Stop of another Run never takes over the prepared resume', async () => {
  const f = await fixture()
  await heldByUnknownStart(f, false)
  const before = rows(f)
  await expect(f.client.stopAgent(f.previous.agentSessionId, { runId: 'another-run' })).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect(rows(f)).toEqual(before)
}, REAL_RUNTIME_MS)

it('the Store refuses a takeover without a witness for that exact key', async () => {
  const f = await fixture()
  const held = await heldByUnknownStart(f, false)
  const operation = await f.inner.kernel.prepareStop(f.previous.run.runId, 'forged-stop')
  const reserve = (witness?: object) => f.inner.registry.reserveExisting('stop', f.previous.agentSessionId, f.previous.run, 'forged-stop', operation,
    witness ? { supersededResume: witness } : {})
  await expect(reserve()).rejects.toMatchObject({ code: 'AGENT_SESSION_BUSY' })
  await expect(reserve({ lifecycleOperationId: 'another-key', fence: 'retired', runtimeId: 'r' })).rejects.toMatchObject({ code: 'AGENT_SESSION_BUSY' })
  expect(await f.correlation()).toEqual(held)
}, REAL_RUNTIME_MS)
