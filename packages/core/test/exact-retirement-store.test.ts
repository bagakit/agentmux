import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import * as core from '../dist/index.js'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
it.each(['memory', 'file'] as const)('reads only the exact original strict retirement in the %s Store', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'private-retirement-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'sessions.json'), store = kind === 'memory' ? new core.AgentMuxMemoryAgentSessionStore() : new core.AgentMuxFileAgentSessionStore(path)
  const original: core.AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-retired', providerId: 'codex', executorId: 'codex',
    hostId: 'local', workspacePath: root, run: { runId: 'original-retired-run' }, retiredRuns: [],
    hookBindingId: 'original-hook', hookToken: 'original-token', createdAt: _tailFixtureEpoch(0, 0, 100), updatedAt: _tailFixtureEpoch(0, 0, 100),
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-native' } }
  await store.compareAndSwap(null, original)
  const reservation: core.AgentMuxLifecycleReservation = { kind: 'stop', reservationId: 'original-stop-reservation', agentSessionId: original.agentSessionId,
    ownerId: 'original-owner', ownerPid: process.pid, operationId: 'original-stop', expiresAt: Date.now() + 60_000, expectedRun: original.run,
    stopOperation: { daemonInstance: 'original-native-owner', operationKey: 'original-stop', runId: original.run.runId } }
  await store.reserveLifecycle(reservation); await store.commitLifecycle(reservation, null)
  const load = vi.spyOn(store, 'loadRetiredAgentSessions').mockRejectedValue(new Error('Unrelated retirement catalog is unavailable.'))
  const result = await store.readRetiredAgentSession(original.agentSessionId).then(value => ({ value }), error => ({ error }))
  expect(result, 'an exact retirement cannot wait for or fail with an unrelated catalog').toHaveProperty('value')
  if (!('value' in result)) throw new Error('Exact retirement read is unavailable')
  const retained = result.value
  expect(retained, 'an exact retirement must retain its original authority').toMatchObject({ agentSessionId: original.agentSessionId, hostId: 'local', run: original.run, source: 'user',
    history: { nativeHandle: original.nativeHandle } })
  expect(retained!.observedAt).toBeGreaterThan(0)
  expect(await store.readRetiredAgentSession('absent-original')).toBeNull()
  expect(load, 'an exact retirement cannot depend on the catalog').not.toHaveBeenCalled()
  if (kind === 'file') {
    const db = new DatabaseSync(path)
    try {
      db.prepare('INSERT INTO retired_sessions(id,json) VALUES(?,?)').run('unrelated-corrupt-retirement', '{')
      expect(await store.readRetiredAgentSession(original.agentSessionId), 'a corrupt adjacent retirement cannot poison the exact owner').toEqual(retained)
      db.prepare('UPDATE retired_sessions SET json=? WHERE id=?').run(JSON.stringify({ ...retained, agentSessionId: 'wrong-stored-location' }), original.agentSessionId)
      await expect(store.readRetiredAgentSession(original.agentSessionId)).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE' })
      db.prepare('UPDATE retired_sessions SET json=? WHERE id=?').run(JSON.stringify({ ...retained, observedAt: _tailFixtureEpoch(0, 0, -1) }), original.agentSessionId)
      await expect(store.readRetiredAgentSession(original.agentSessionId)).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE' })
      db.prepare('UPDATE retired_sessions SET json=? WHERE id=?').run(JSON.stringify(retained), original.agentSessionId)
      db.prepare('INSERT INTO sessions(id,json,future_present) VALUES(?,?,0)').run(original.agentSessionId, JSON.stringify(original))
      await expect(store.readRetiredAgentSession(original.agentSessionId), 'conflicting active and retired facts cannot authorize recovery')
        .rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE' })
    } finally { db.close() }
  } else {
    const records = (store as any).retiredAgentSessions as any[]
    records[0].observedAt = -1
    await expect(store.readRetiredAgentSession(original.agentSessionId)).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE' })
    records[0] = retained
    ;(store as any).sessions.set(original.agentSessionId, original)
    await expect(store.readRetiredAgentSession(original.agentSessionId)).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE' })
  }
})
