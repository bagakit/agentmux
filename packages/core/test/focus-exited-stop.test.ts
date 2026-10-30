import { afterEach, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { retiredReopenFixture } from './fixtures/retired-reopen.js'
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '../src/agent-session-recovery/continuity-contract.js'
const fixtures: Awaited<ReturnType<typeof retiredReopenFixture>>[] = []
afterEach(async () => { for (const f of fixtures.splice(0).reverse()) await f.close(); vi.restoreAllMocks() })

it.each(['codex', 'claude'] as const)('Stop retires an exited %s Session with idle-window-expired continuity and reopens the same history explicitly', async provider => {
  const f = await retiredReopenFixture(provider); fixtures.push(f)
  const opened = await f.client.reopenAgent(f.input)
  const observedAt = Date.now()
  const continuity = { kind: 'pending', reason: 'idle-window-expired', operationId: 'private-idle-expired',
    agentSessionId: opened.agentSessionId, previousRun: opened.run, trigger: 'startup', policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY },
    admittedAt: observedAt, observedAt, rechecks: 0, evidence: { kind: 'run-ended', state: 'exited', observedAt } }
  await (f.inner.registry as any).update(opened.agentSessionId, opened.run, (current: any) => ({ ...current, updatedAt: observedAt,
    continuity, continuityOperations: { ...current.continuityOperations, [continuity.operationId]: continuity } }))
  f.inner.kernel.status.mockImplementation(async (id: string) => ({ ...f.run(id, false),
    lifecycleOperationId: id === opened.run.runId ? f.starts[0]?.operationKey ?? null : null }))
  const startsBefore = f.starts.length
  await f.client.stopAgent(opened.agentSessionId, opened.run)
  expect(f.stops).toEqual([]) // The exact Run is already exited: retirement needs no new Runtime Stop.
  expect(f.starts).toHaveLength(startsBefore)
  expect(await f.store.loadMetadata()).toEqual([])
  const retired = (await f.store.loadRetiredAgentSessions())[0]!
  expect(retired).toMatchObject({ agentSessionId: f.old.agentSessionId, run: opened.run,
    history: { nativeHandle: f.old.nativeHandle } })
  const continued = await f.client.reopenAgent({ agentSessionId: opened.agentSessionId,
    expectedRetiredAt: retired.observedAt, operationId: 'private-explicit-after-exited-stop' })
  expect(continued).toMatchObject({ agentSessionId: f.old.agentSessionId, nativeHandle: f.old.nativeHandle,
    run: { runId: 'new-run-2' }, reopenedFrom: { run: opened.run, source: 'user' } })
  expect(f.starts).toHaveLength(startsBefore + 1)
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect(await f.store.loadTimeline(f.old.agentSessionId)).toEqual(f.timelineBefore)
  expect(await readFile(f.path)).toEqual(f.nativeBefore)
})
