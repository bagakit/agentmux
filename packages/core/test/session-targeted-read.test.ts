import { fixturePath } from './helpers/fixture-values.js'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore, loadSessionHistorySources } from '../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
function session(n: number): AgentMuxStoredAgentSession {
  return { kind: 'agent', agentSessionId: `target-${n}`, providerId: 'codex', executorId: 'codex', hostId: 'local',
    workspacePath: fixturePath("repo"), run: { runId: `run-${n}` }, retiredRuns: [], hookBindingId: `binding-${n}`,
    hookToken: `token-${n}`, createdAt: 1, updatedAt: 1 }
}

it('reads each original Timeline by exact identity without discovering unrelated Sessions', async () => {
  const root = await mkdtemp(fixturePath("tmp/amux-target-read-")); roots.push(root)
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  for (let n = 0; n < 32; n++) await store.compareAndSwap(null, session(n))
  const reader = new AgentMuxFileAgentSessionStore(store.path)
  const exact = vi.spyOn(reader, 'readHistorySource')
  const catalog = vi.spyOn(reader, 'loadMetadata').mockRejectedValue(new Error('unrelated catalog unavailable'))
  const retired = vi.spyOn(reader, 'loadRetiredAgentSessions').mockRejectedValue(new Error('unrelated retired catalog unavailable'))
  const correlations = vi.spyOn(reader, 'loadReopenCorrelations').mockRejectedValue(new Error('unrelated reservation catalog unavailable'))
  const client = new AgentMuxClient({ store: reader })
  try {
    const pages = await Promise.all(Array.from({ length: 32 }, (_, n) => client.sessionTimeline(`target-${n}`)))
    expect(pages.map(page => page.agentSessionId)).toEqual(Array.from({ length: 32 }, (_, n) => `target-${n}`))
    expect(exact).toHaveBeenCalledTimes(32)
    expect(catalog).not.toHaveBeenCalled(); expect(retired).not.toHaveBeenCalled(); expect(correlations).not.toHaveBeenCalled()
    await expect(client.sessionTimeline('missing')).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
  } finally { await client.dispose() }
})

it('resolves retired history and the exact pending reopen identically to discovery after reopening the Store', async () => {
  const root = await mkdtemp(fixturePath("tmp/amux-retired-target-")); roots.push(root)
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')), original = session(0)
  await store.compareAndSwap(null, original)
  const stop = { kind: 'stop' as const, reservationId: 'stop', ownerId: 'owner', ownerPid: process.pid,
    agentSessionId: original.agentSessionId, expectedRun: original.run, operationId: 'stop-operation', expiresAt: Date.now() + 60_000,
    stopOperation: { daemonInstance: 'private', operationKey: 'stop', runId: original.run.runId } }
  await store.reserveLifecycle(stop); await store.commitLifecycle(stop, null)
  const expectedRetirement = (await store.loadRetiredAgentSessions())[0]!
  await store.reserveLifecycle({ kind: 'reopen', reservationId: 'reopen', ownerId: 'owner', ownerPid: process.pid,
    agentSessionId: original.agentSessionId, expectedRetirement, operationId: 'reopen-operation', expiresAt: Date.now() + 60_000 })
  const fresh = new AgentMuxFileAgentSessionStore(store.path)
  expect(await fresh.readHistorySource(original.agentSessionId)).toEqual((await loadSessionHistorySources(fresh))[0])
  expect(await fresh.readHistorySource(original.agentSessionId)).toMatchObject({ state: 'retired', pendingReopen: {}, history: { providerId: 'codex' } })
  expect(await fresh.readHistorySource('missing')).toBeNull()
})
