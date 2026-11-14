import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentMuxFileAgentSessionStore,
  AgentMuxMemoryAgentSessionStore,
  type AgentMuxAgentSessionStore,
  type AgentMuxLifecycleReservation
} from '../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function pair() {
  const root = await mkdtemp(join(tmpdir(), 'amux-row-lifecycle-'))
  roots.push(root)
  const path = join(root, 'sessions.json')
  return { memory: new AgentMuxMemoryAgentSessionStore(), file: new AgentMuxFileAgentSessionStore(path), path }
}

function session(id: string, runId: string, retiredRuns: string[] = [], extra: Partial<AgentMuxStoredAgentSession> = {}): AgentMuxStoredAgentSession {
  return {
    kind: 'agent', agentSessionId: id, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/work',
    run: { runId }, retiredRuns: retiredRuns.map(runId => ({ runId })), createdAt: 100, updatedAt: 200,
    hookBindingId: `hook-${id}`, hookToken: `token-${id}`, capabilityHash: `cap-${id}`,
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: `native-${id}` }, ...extra
  }
}

const owner = { ownerId: 'owner-a', ownerPid: process.pid }
const lease = () => Date.now() + 60_000

function stop(target: AgentMuxStoredAgentSession): Extract<AgentMuxLifecycleReservation, { kind: 'stop' }> {
  return { ...owner, reservationId: `stop-${target.agentSessionId}-${target.run.runId}`, kind: 'stop', agentSessionId: target.agentSessionId,
    operationId: `stop-op-${target.agentSessionId}-${target.run.runId}`, expiresAt: lease(), expectedRun: { ...target.run },
    stopOperation: { daemonInstance: 'daemon', operationKey: `stop-op-${target.agentSessionId}`, runId: target.run.runId } }
}

function resume(target: AgentMuxStoredAgentSession): Extract<AgentMuxLifecycleReservation, { kind: 'resume' }> {
  return { ...owner, reservationId: `resume-${target.agentSessionId}-${target.run.runId}`, kind: 'resume', agentSessionId: target.agentSessionId,
    operationId: `resume-op-${target.agentSessionId}-${target.run.runId}`, expiresAt: lease(), expectedRun: { ...target.run } }
}

function create(id: string): Extract<AgentMuxLifecycleReservation, { kind: 'create' }> {
  return { ...owner, reservationId: `create-${id}`, kind: 'create', agentSessionId: id, operationId: `create-op-${id}`, expiresAt: lease() }
}

/** The binding tables are derived: retired Runs bind to nothing, current Runs and native keys bind to their Session. */
function bindings(path: string) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return {
      runs: Object.fromEntries(db.prepare('SELECT run_id, session_id FROM run_bindings ORDER BY run_id').all()
        .map(row => [String(row.run_id), row.session_id === null ? null : String(row.session_id)])),
      natives: Object.fromEntries(db.prepare('SELECT native_key, session_id FROM native_bindings ORDER BY native_key').all()
        .map(row => [String(row.native_key), String(row.session_id)]))
    }
  } finally { db.close() }
}

function auditBindingWrites(path: string) {
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE binding_writes (binding_table TEXT, operation TEXT, binding_key TEXT)')
    for (const [table, key] of [['run_bindings', 'run_id'], ['native_bindings', 'native_key']] as const) {
      for (const [action, row] of [['INSERT', 'new'], ['UPDATE', 'new'], ['DELETE', 'old']] as const) {
        db.exec(`CREATE TRIGGER audit_${table}_${action} AFTER ${action} ON ${table}
          BEGIN INSERT INTO binding_writes VALUES ('${table}', '${action}', ${row}.${key}); END`)
      }
    }
  } finally { db.close() }
  return () => {
    const reader = new DatabaseSync(path, { readOnly: true })
    try {
      return reader.prepare('SELECT binding_table, operation, binding_key FROM binding_writes ORDER BY binding_table, operation, binding_key')
        .all().map(row => [row.binding_table, row.operation, row.binding_key])
    } finally { reader.close() }
  }
}

function nativeKey(id: string) {
  return JSON.stringify(['provider', 'codex', `native-${id}`])
}

async function facts(store: AgentMuxAgentSessionStore) {
  const sessions = await store.loadMetadata()
  return {
    sessions: sessions.map(item => ({ id: item.agentSessionId, run: item.run.runId, retiredRuns: item.retiredRuns.map(run => run.runId) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    retiredRuns: (await store.loadRetiredRuns()).map(run => run.runId),
    retired: (await store.loadRetiredAgentSessions()).map(({ observedAt: _time, ...rest }) => rest),
    reservations: (await Promise.all(sessions.map(item => store.readLifecycleReservation(item.agentSessionId)))).filter(Boolean)
  }
}

function derived(current: readonly AgentMuxStoredAgentSession[], retiredRuns: readonly string[]) {
  return {
    runs: Object.fromEntries([
      ...retiredRuns.map(run => [run, null]),
      ...current.flatMap(item => [item.run, ...item.retiredRuns].map(run => [run.runId, item.agentSessionId]))
    ].sort(([a], [b]) => String(a).localeCompare(String(b)))),
    natives: Object.fromEntries(current.flatMap(item => item.nativeHandle?.kind === 'provider'
      ? [[JSON.stringify(['provider', item.nativeHandle.providerId, item.nativeHandle.sessionId]), item.agentSessionId]] : [])
      .sort(([a], [b]) => String(a).localeCompare(String(b))))
  }
}

describe('metadata saves reconcile only changed binding rows', () => {
  it('writes no binding rows when the current and historical identities stay the same', async () => {
    const { file, path } = await pair()
    const original = session('target', 'run-target', Array.from({ length: 32 }, (_, index) => `prior-${index}`))
    await file.compareAndSwapMetadata(null, original)
    const current = (await file.readMetadata('target'))!
    const readWrites = auditBindingWrites(path)
    const next = { ...current, updatedAt: current.updatedAt + 1 }

    await file.compareAndSwapMetadata(current, next)

    expect(await file.readMetadata('target')).toEqual(next)
    expect(bindings(path)).toEqual(derived([next], []))
    expect(readWrites()).toEqual([])
  })

  it.each(['replace', 'remove'] as const)('changes only the exact Run and native keys when native identity is set to %s', async nativeChange => {
    const { file, path } = await pair()
    const original = session('target', 'run-target', ['prior-stays', 'prior-leaves'])
    const neighbor = session('neighbor', 'run-neighbor')
    await file.compareAndSwapMetadata(null, original)
    await file.compareAndSwapMetadata(null, neighbor)
    await file.retireRuns([{ runId: 'reserved-by-retirement' }])
    const current = (await file.readMetadata('target'))!
    const readWrites = auditBindingWrites(path)
    const next = { ...current, run: { runId: 'run-new' }, retiredRuns: [{ runId: 'prior-stays' }, current.run] }
    if (nativeChange === 'replace') next.nativeHandle = { kind: 'provider', providerId: 'codex', sessionId: 'native-new' }
    else delete next.nativeHandle

    await file.compareAndSwapMetadata(current, next)

    expect(bindings(path)).toEqual(derived([next, neighbor], ['reserved-by-retirement']))
    expect(readWrites()).toEqual([
      ['native_bindings', 'DELETE', nativeKey('target')],
      ...(nativeChange === 'replace' ? [['native_bindings', 'INSERT', nativeKey('new')]] : []),
      ['run_bindings', 'DELETE', 'prior-leaves'],
      ['run_bindings', 'INSERT', 'run-new']
    ])
  })

  it('repairs missing and stale physical bindings during an unchanged identity save', async () => {
    const { file, path } = await pair()
    await file.compareAndSwapMetadata(null, session('target', 'run-target', ['prior-stays']))
    const current = (await file.readMetadata('target'))!
    const db = new DatabaseSync(path)
    try {
      db.prepare('DELETE FROM run_bindings WHERE run_id=?').run('prior-stays')
      db.prepare('DELETE FROM native_bindings WHERE native_key=?').run(nativeKey('target'))
      db.prepare('INSERT INTO run_bindings VALUES (?, ?)').run('run-stale', 'target')
      db.prepare('INSERT INTO native_bindings VALUES (?, ?)').run(nativeKey('stale'), 'target')
    } finally { db.close() }
    const readWrites = auditBindingWrites(path)

    await file.compareAndSwapMetadata(current, { ...current, updatedAt: current.updatedAt + 1 })

    expect(bindings(path)).toEqual(derived([current], []))
    expect(readWrites()).toEqual([
      ['native_bindings', 'DELETE', nativeKey('stale')],
      ['native_bindings', 'INSERT', nativeKey('target')],
      ['run_bindings', 'DELETE', 'run-stale'],
      ['run_bindings', 'INSERT', 'prior-stays']
    ])
  })

  it.each(['Run', 'native'] as const)('refuses to claim another current Session’s %s binding', async kind => {
    const { file, path } = await pair()
    const neighbor = session('neighbor', 'run-neighbor', ['run-neighbor-prior'])
    await file.compareAndSwapMetadata(null, neighbor)
    await file.compareAndSwapMetadata(null, session('target', 'run-target'))
    const current = (await file.readMetadata('target'))!
    const expected = kind === 'Run' ? 'Run conflicts with another current or retired Session.' : 'Native identity conflicts with another Session.'
    const next = kind === 'Run' ? { ...current, retiredRuns: [...neighbor.retiredRuns] } : { ...current, nativeHandle: neighbor.nativeHandle! }

    await expect(file.compareAndSwapMetadata(current, next)).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE', message: expected })

    expect(bindings(path)).toEqual(derived([current, neighbor], []))
    expect(await file.readMetadata('target')).toEqual(current)
  })
})

describe('every lifecycle commits one Session by its own rows', () => {
  it('agrees with the in-memory reference across creates, resumes, reopens, Stops, releases and retired Runs', async () => {
    const { memory, file, path } = await pair()
    const live = new Map<string, AgentMuxStoredAgentSession>()
    const retired = new Set<string>()
    let seed = 11, run = 0
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!
    const both = async (step: (store: AgentMuxAgentSessionStore) => Promise<unknown>) => { for (const store of [memory, file]) await step(store) }
    for (let step = 0; step < 80; step++) {
      const roll = next()
      if (roll < 0.25 || live.size === 0) {
        const id = `s${step}`, created = session(id, `r${++run}`)
        const reservation = create(id)
        await both(async store => { await store.reserveLifecycle(reservation); await store.commitLifecycle(reservation, created) })
        live.set(id, created)
      } else if (roll < 0.45) {
        const target = live.get(pick([...live.keys()]))!, reservation = resume(target)
        const resumed = { ...target, run: { runId: `r${++run}` }, retiredRuns: [...target.retiredRuns, target.run], updatedAt: target.updatedAt + 1 }
        await both(async store => { await store.reserveLifecycle(reservation); await store.commitLifecycle(reservation, resumed) })
        live.set(target.agentSessionId, resumed)
      } else if (roll < 0.65) {
        const target = live.get(pick([...live.keys()]))!, reservation = stop(target)
        await both(async store => { await store.reserveLifecycle(reservation); await store.commitLifecycle(reservation, null) })
        live.delete(target.agentSessionId); retired.add(target.agentSessionId)
      } else if (roll < 0.8 && retired.size > 0) {
        const id = pick([...retired])
        const retirement = (await memory.readRetiredAgentSession(id))!
        if (retirement.history?.creation) continue
        const reservation: Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }> = { ...owner, reservationId: `reopen-${id}-${step}`, kind: 'reopen',
          agentSessionId: id, operationId: `reopen-op-${id}-${step}`, expiresAt: lease(), expectedRetirement: retirement }
        const reopened = session(id, `r${++run}`, [retirement.run.runId], {
          createdAt: retirement.history!.createdAt, workspacePath: retirement.history!.workspacePath,
          ...(retirement.history!.nativeHandle ? { nativeHandle: retirement.history!.nativeHandle } : {}),
          reopenedFrom: { run: retirement.run, source: retirement.source, observedAt: retirement.observedAt } })
        await both(async store => {
          const own = { ...reservation, expectedRetirement: (await store.readRetiredAgentSession(id))! }
          await store.reserveLifecycle(own)
          await store.commitLifecycle(own, { ...reopened, reopenedFrom: { run: own.expectedRetirement.run, source: own.expectedRetirement.source, observedAt: own.expectedRetirement.observedAt } })
        })
        retired.delete(id); live.set(id, (await memory.readMetadata(id))!)
      } else if (roll < 0.9) {
        const id = `released-${step}`, reservation = create(id), runs = [{ runId: `free-${step}` }]
        await both(async store => { await store.reserveLifecycle(reservation); await store.releaseLifecycle(reservation, runs) })
      } else {
        await both(store => store.retireRuns([{ runId: `loose-${step}` }]))
      }
      const expected = await facts(memory)
      expect(await facts(file), `after step ${step}`).toEqual(expected)
      expect(bindings(path), `bindings after step ${step}`).toEqual(derived(await file.loadMetadata(), expected.retiredRuns))
    }
    expect(retired.size + live.size).toBeGreaterThan(10)
  }, 60_000) // 80 steps against two stores; each File step is one fsync-confirmed transaction.

  it('refuses a commit that would bind a retired Run to another Session', async () => {
    const { file, path } = await pair()
    const first = session('first', 'run-1')
    const reservation = create('first')
    await file.reserveLifecycle(reservation); await file.commitLifecycle(reservation, first)
    const stopFirst = stop(first)
    await file.reserveLifecycle(stopFirst); await file.commitLifecycle(stopFirst, null)
    const thief = create('thief')
    await file.reserveLifecycle(thief)
    await expect(file.commitLifecycle(thief, session('thief', 'run-1'))).rejects.toThrow('Run conflicts with another current or retired Session')
    expect((await file.loadMetadata()).map(item => item.agentSessionId)).toEqual([])
    expect(await file.readLifecycleReservation('thief')).toEqual(expect.objectContaining({ kind: 'create' }))
    expect(bindings(path)).toEqual(derived([], ['run-1']))
  })

  it('keeps one terminal prompt operation on one current Session', async () => {
    const { file } = await pair()
    const submission = { run: { runId: 'run-a' }, submissionId: 'prompt-1', promptDigest: 'digest', outputCursorBytes: 12,
      readinessEvidence: { source: 'native-stop' as const, id: 'ready', outputCursorBytes: 8, readyThroughByte: 12 },
      payload: { operationId: 'payload-1', inputByteRange: { startByte: 5, endByte: 9 }, acknowledged: true },
      submit: { operationId: 'submit-1', inputByteRange: { startByte: 9, endByte: 10 }, acknowledged: true } }
    const a = create('a'), b = create('b')
    await file.reserveLifecycle(a); await file.commitLifecycle(a, session('a', 'run-a', [], { terminalPromptSubmission: submission }))
    await file.reserveLifecycle(b)
    await expect(file.commitLifecycle(b, session('b', 'run-b', [], { terminalPromptSubmission: { ...submission, run: { runId: 'run-b' } } })))
      .rejects.toThrow('duplicate prompt operation')
  })

  it('refuses to retire a Run that a current Session still owns, through either history path', async () => {
    const { memory, file } = await pair()
    for (const store of [memory, file]) {
      const owned = session('owner', 'run-live', ['run-earlier'])
      const made = create('owner')
      await store.reserveLifecycle(made); await store.commitLifecycle(made, owned)
      await expect(store.retireRuns([{ runId: 'run-live' }])).rejects.toThrow('Unbound retired Run conflicts with an Agent Session')
      const release = create('released')
      await store.reserveLifecycle(release)
      await expect(store.releaseLifecycle(release, [{ runId: 'run-earlier' }])).rejects.toThrow('Unbound retired Run conflicts with an Agent Session')
      expect(await store.readLifecycleReservation('released')).toEqual(expect.objectContaining({ kind: 'create' }))
      expect((await store.loadRetiredRuns()).map(run => run.runId)).toEqual([])
    }
  })

  it('claims stale lifecycles and releases a dead owner without reading any Session', async () => {
    const { file, path } = await pair()
    const target = session('target', 'run-t')
    const made = create('target')
    await file.reserveLifecycle(made); await file.commitLifecycle(made, target)
    const dead = { ...stop(target), ownerId: 'dead-owner', ownerPid: 2147483647 }
    await file.reserveLifecycle(dead)
    const db = new DatabaseSync(path)
    db.prepare('INSERT INTO sessions (id, json, future_present) VALUES (?, ?, 0)').run('damaged', '{"kind":"agent","agentSessionId":"damaged"}')
    db.close()
    const claimed = await file.claimStaleLifecycles({ ownerId: 'owner-b', ownerPid: process.pid, now: Date.now(), expiresAt: lease() })
    expect(claimed.map(item => [item.agentSessionId, item.ownerId])).toEqual([['target', 'owner-b']])
    await file.releaseReopenOwner('owner-b')
    expect(await file.readLifecycleReservation('target')).toEqual(expect.objectContaining({ ownerId: 'owner-b' }))
  })
})
