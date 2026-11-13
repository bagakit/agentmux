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
  expect(receipt).toMatchObject({ admission: 'superseded-resume', operationId: 'stop-sealed',
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
  expect(receipt).toMatchObject({ admission: 'superseded-resume',
    supersededResume: { fence: 'retained', retainedRun: { runId: orphan.runId }, retainedStop: expect.stringMatching(/^(graceful|forced)$/) } })
  await vi.waitFor(async () => expect((await f.inner.kernel.status(orphan.runId)).state.type).not.toBe('running'))
  expect((await f.store.loadRetiredRuns()).map(run => run.runId)).toEqual(expect.arrayContaining([f.previous.run.runId, orphan.runId]))
  expect(f.start).toHaveBeenCalledTimes(1)
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
  // The refusal is not sticky: the same Stop still works once the original resume is settled.
  expect((await f.store.readMetadata(f.previous.agentSessionId))?.run).toEqual(f.previous.run)
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
