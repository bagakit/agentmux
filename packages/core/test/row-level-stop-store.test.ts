import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore, type AgentMuxAgentSessionStore, type AgentMuxLifecycleReservation } from '../src/agent-session-store.js';
import { agentLifecycleOperationIdentity } from "../src/agent-session-identity.js";
import type { AgentMuxStoredAgentSession } from '../src/types.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fileStore() {
  const root = await mkdtemp(join(tmpdir(), 'amux-row-stop-'))
  roots.push(root)
  const path = join(root, 'sessions.json')
  return { store: new AgentMuxFileAgentSessionStore(path), path }
}

function session(id: string, runId: string, retiredRuns: string[] = [], extra: Partial<AgentMuxStoredAgentSession> = {}): AgentMuxStoredAgentSession {
  return {
    kind: 'agent', agentSessionId: id, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/work',
    run: { runId }, retiredRuns: retiredRuns.map(runId => ({ runId })), createdAt: 100, updatedAt: 200,
    hookBindingId: `hook-${id}`, hookToken: `token-${id}`,
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: `native-${id}` }, ...extra
  }
}

function stop(target: AgentMuxStoredAgentSession, owner = 'owner-a'): Extract<AgentMuxLifecycleReservation, { kind: 'stop' }> {
  return {
    reservationId: `stop-${target.agentSessionId}-${owner}`, ownerId: owner, ownerPid: process.pid, kind: 'stop',
    agentSessionId: target.agentSessionId, operationId: `stop-op-${target.agentSessionId}`, expiresAt: Date.now() + 60_000,
    expectedRun: { ...target.run },
    stopOperation: { daemonInstance: 'daemon', operationKey: `stop-op-${target.agentSessionId}`, runId: target.run.runId }
  }
}

function restart(target: AgentMuxStoredAgentSession): Extract<AgentMuxLifecycleReservation, { kind: 'resume' }> {
  return {
    reservationId: `restart-${target.agentSessionId}`, ownerId: 'owner-a', ownerPid: process.pid, kind: 'resume',
    agentSessionId: target.agentSessionId, operationId: agentLifecycleOperationIdentity('restart', target.agentSessionId, `restart-${target.agentSessionId}`),
    expiresAt: Date.now() + 60_000,
    expectedRun: { ...target.run },
    restart: {
      requestDigest: 'digest', request: { agentSessionId: target.agentSessionId, expectedRun: { ...target.run }, operationId: `restart-${target.agentSessionId}` },
      nativeTarget: { kind: 'provider', providerId: 'codex', sessionId: `native-${target.agentSessionId}` },
      stopOperation: { daemonInstance: 'daemon', operationKey: `restart-stop-${target.agentSessionId}`, runId: target.run.runId }
    }
  }
}

/** The binding tables are derived facts: retired Runs bind to nothing, current Runs and native keys bind to their Session. */
function bindings(path: string) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return {
      runs: Object.fromEntries(db.prepare('SELECT run_id, session_id FROM run_bindings ORDER BY run_id').all()
        .map(row => [String(row.run_id), row.session_id === null ? null : String(row.session_id)])),
      natives: Object.fromEntries(db.prepare('SELECT native_key, session_id FROM native_bindings ORDER BY native_key').all()
        .map(row => [String(row.native_key), String(row.session_id)])),
      reservations: db.prepare('SELECT id FROM reservations ORDER BY rowid').all().map(row => String(row.id))
    }
  } finally { db.close() }
}

async function snapshot(store: AgentMuxAgentSessionStore) {
  const retired = await store.loadRetiredAgentSessions()
  return {
    sessions: (await store.loadMetadata()).map(item => item.agentSessionId).sort(),
    retiredRuns: (await store.loadRetiredRuns()).map(run => run.runId),
    retired: retired.map(({ observedAt: _time, ...rest }) => rest)
  }
}

describe('a user Stop retires one Session by its own rows', () => {
  it('retires the exact Session and every one of its Runs, and returns that retirement', async () => {
    for (const store of [new AgentMuxMemoryAgentSessionStore(), (await fileStore()).store]) {
      const target = session('target', 'run-now', ['run-old'])
      await store.compareAndSwap(null, target)
      await store.compareAndSwap(null, session('neighbor', 'run-neighbor'))
      const reservation = stop(target)
      await store.reserveLifecycle(reservation)
      const retired = await store.commitLifecycle(reservation, null)
      expect(retired).toEqual(expect.objectContaining({ agentSessionId: 'target', hostId: 'local', run: { runId: 'run-now' }, source: 'user' }))
      expect(await store.readRetiredAgentSession('target')).toEqual(retired)
      expect((await store.loadMetadata()).map(item => item.agentSessionId)).toEqual(['neighbor'])
      expect((await store.loadRetiredRuns()).map(run => run.runId)).toEqual(['run-old', 'run-now'])
    }
  })

  it('keeps the binding tables exactly equal to the facts they are derived from', async () => {
    const { store, path } = await fileStore()
    const target = session('target', 'run-now', ['run-old'])
    await store.compareAndSwap(null, target)
    await store.compareAndSwap(null, session('neighbor', 'run-neighbor'))
    const reservation = stop(target)
    await store.reserveLifecycle(reservation)
    await store.commitLifecycle(reservation, null)
    expect(bindings(path)).toEqual({
      runs: { 'run-neighbor': 'neighbor', 'run-now': null, 'run-old': null },
      natives: { [JSON.stringify(['provider', 'codex', 'native-neighbor'])]: 'neighbor' },
      reservations: []
    })
  })

  it('refuses a later Session that tries to reuse a retired Run, and frees the retired native identity', async () => {
    const { store } = await fileStore()
    const target = session('target', 'run-now')
    await store.compareAndSwap(null, target)
    const reservation = stop(target)
    await store.reserveLifecycle(reservation)
    await store.commitLifecycle(reservation, null)
    await expect(store.compareAndSwap(null, session('reuser', 'run-now'))).rejects.toThrow('Run conflicts with another current or retired Session')
    await expect(store.compareAndSwap(null, session('heir', 'run-heir', [], {
      nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'native-target' }
    }))).resolves.toBeUndefined()
  })

  it('stops a healthy Session while an unrelated stored row is damaged, and leaves that row untouched', async () => {
    const { store, path } = await fileStore()
    const target = session('target', 'run-now')
    await store.compareAndSwap(null, target)
    await store.compareAndSwap(null, session('damaged', 'run-damaged'))
    // SQLite expression indexes refuse non-JSON rows, so the damaged neighbour is valid JSON that
    // fails the strict Session shape: it cannot be normalized if the Stop ever reads it.
    const damaged = '{"kind":"agent","agentSessionId":"damaged"}'
    const db = new DatabaseSync(path)
    db.prepare('UPDATE sessions SET json=? WHERE id=?').run(damaged, 'damaged')
    db.close()
    const reservation = stop(target)
    await store.reserveLifecycle(reservation)
    await expect(store.commitLifecycle(reservation, null)).resolves.toEqual(expect.objectContaining({ agentSessionId: 'target' }))
    const check = new DatabaseSync(path, { readOnly: true })
    expect(check.prepare('SELECT json FROM sessions WHERE id=?').get('damaged')?.json).toBe(damaged)
    check.close()
  })

  it('supersedes an unprepared restart in place, keeping the original reservation order', async () => {
    const { store, path } = await fileStore()
    const first = session('first', 'run-first'), target = session('target', 'run-target'), last = session('last', 'run-last')
    for (const item of [first, target, last]) await store.compareAndSwap(null, item)
    await store.reserveLifecycle(stop(first))
    await store.reserveLifecycle(restart(target))
    await store.reserveLifecycle(stop(last))
    // A live other owner keeps its restart; the same owner's close supersedes it in place.
    await expect(store.reserveLifecycle(stop(target, 'owner-b'))).rejects.toThrow('already has a lifecycle operation in progress')
    await store.reserveLifecycle(stop(target, 'owner-a'))
    expect(bindings(path).reservations).toEqual(['first', 'target', 'last'])
    expect(await store.readLifecycleReservation('target')).toEqual(expect.objectContaining({ kind: 'stop', reservationId: 'stop-target-owner-a' }))
  })

  it('refuses a Stop whose expected Run is stale or whose reservation was taken over', async () => {
    const { store } = await fileStore()
    const target = session('target', 'run-now')
    await store.compareAndSwap(null, target)
    const stale = stop({ ...target, run: { runId: 'run-other' } })
    await expect(store.reserveLifecycle(stale)).rejects.toThrow('changed before lifecycle reservation')
    const reservation = stop(target)
    await store.reserveLifecycle(reservation)
    await expect(store.commitLifecycle({ ...reservation, reservationId: 'someone-else' }, null)).rejects.toThrow('no longer current')
    expect((await store.loadMetadata()).map(item => item.agentSessionId)).toEqual(['target'])
  })

  it('agrees with the in-memory reference across interleaved creates, Stops and released Runs', async () => {
    const { store: file, path } = await fileStore()
    const memory = new AgentMuxMemoryAgentSessionStore()
    const live = new Map<string, AgentMuxStoredAgentSession>()
    let seed = 7
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let step = 0; step < 60; step++) {
      const roll = next()
      if (roll < 0.45 || live.size === 0) {
        const id = `s${step}`, created = session(id, `r${step}`, next() < 0.4 ? [`r${step}-old`] : [])
        for (const store of [memory, file]) await store.compareAndSwap(null, created)
        live.set(id, created)
      } else if (roll < 0.85) {
        const id = [...live.keys()][Math.floor(next() * live.size)]!, target = live.get(id)!
        for (const store of [memory, file]) {
          const reservation = stop(target)
          await store.reserveLifecycle(reservation)
          await store.commitLifecycle(reservation, null)
        }
        live.delete(id)
      } else {
        const runs = [{ runId: `free-${step}-a` }, { runId: `free-${step}-b` }]
        for (const store of [memory, file]) await store.retireRuns(runs)
      }
      expect(await snapshot(file)).toEqual(await snapshot(memory))
    }
    const facts = await snapshot(file), derived = bindings(path)
    const current = await file.loadMetadata()
    expect(derived.runs).toEqual(Object.fromEntries([
      ...facts.retiredRuns.map(run => [run, null]),
      ...current.flatMap(item => [item.run, ...item.retiredRuns].map(run => [run.runId, item.agentSessionId]))
    ].sort(([a], [b]) => String(a).localeCompare(String(b)))))
  }, 60_000) // 60 steps against two stores; each File step is one fsync-confirmed transaction.
})
