import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ContinuousProgressLoopStore } from '../src/main/continuous-progress-loop-store.js'
import { ContinuousProgressLoopManager } from '../src/main/continuous-progress-loop-manager.js'

describe('ContinuousProgressLoopManager', () => {
  it('claims a completed turn once without screen readiness, including after restart', async () => {
    const dir = await mkdtemp(join('/tmp', 'agentmux-completion-'))
    const store = new ContinuousProgressLoopStore(join(dir, 'loops.json'))
    let now = 0, completedAt = 1, calls = 0
    const observe = async (_loop: unknown, tickId: string) => ({
      session: { agentSessionId: 'a', hostId: 'local', providerId: 'codex', workspacePath: '/w',
        run: { runId: 'r' }, semanticStatus: { state: 'done' as const, source: 'native-hook' as const, observedAt: completedAt } },
      tickId, now
    })
    const send = async () => {
      expect((await store.load())[0]?.pendingCompletion?.id).toBe(JSON.stringify(['r', completedAt]))
      calls++
      return 'sent' as const
    }
    const manager = new ContinuousProgressLoopManager(store, send, () => now, observe)
    const restarted = new ContinuousProgressLoopManager(store, send, () => now, observe)
    try {
      await store.save([{ loopId: 'l', agentSessionId: 'a', intervalMs: 10, prompt: 'next', nextCheckAt: 0, status: 'active' }])
      await manager.start(); await manager.check()
      expect(calls).toBe(1)
      now = 10; await manager.check(); expect(calls).toBe(1)
      await manager.stop(); await restarted.start()
      now = 20; await restarted.check(); expect(calls).toBe(1)
      completedAt = 2; now = 30; await restarted.check(); expect(calls).toBe(2)
    } finally {
      await manager.stop(); await restarted.stop(); await rm(dir, { recursive: true, force: true })
    }
  })
  it('loads durable loops and never retries an unknown tick', async () => {
    const dir = await mkdtemp(join('/tmp', 'agentmux-manager-')); const store = new ContinuousProgressLoopStore(join(dir, 'loops.json'))
    let now = 0; let calls = 0
    const seed = new ContinuousProgressLoopManager(store, async () => 'unknown', () => now)
    // seed through the public scheduler-independent store contract
    await store.save([{ loopId: 'l', agentSessionId: 'a', intervalMs: 10, prompt: 'x', nextCheckAt: 0, status: 'active' }])
    const manager = new ContinuousProgressLoopManager(store, async () => { calls++; return 'unknown' }, () => now)
    await manager.start(); await manager.check(now); await manager.check(now)
    expect(calls).toBe(1); await manager.stop(); await seed.stop(); await rm(dir, { recursive: true, force: true })
  })
})

  it('persists the claim before a slow handler and pauses unknown outcomes', async () => {
    const dir = await mkdtemp(join('/tmp', 'agentmux-manager-')); const store = new ContinuousProgressLoopStore(join(dir, 'loops.json'))
    let now = 0; let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve })
    let didEnter!: () => void; const entered = new Promise<void>((resolve) => { didEnter = resolve })
    const manager = new ContinuousProgressLoopManager(store, async () => { didEnter(); await gate; return 'unknown' }, () => now)
    await store.save([{ loopId: 'l', agentSessionId: 'a', intervalMs: 10, prompt: 'x', nextCheckAt: 0, status: 'active' }])
    await manager.start(); const pending = manager.check(now)
    await entered
    const persisted = await store.load(); expect(persisted[0]?.lastTickId).toBeTruthy(); expect(persisted[0]?.nextCheckAt).toBe(10)
    now = 100; const concurrent = manager.check(now); expect(concurrent).toBeInstanceOf(Promise); release(); await pending; await concurrent
    expect(manager.list()[0]?.status).toBe('paused'); expect(manager.list()[0]?.lastOutcome).toBe('unknown')
    await manager.stop(); await rm(dir, { recursive: true, force: true })
  })

const observedDone = async (_loop: unknown, tickId: string) => ({
  session: { agentSessionId: 'a', hostId: 'local', providerId: 'codex', workspacePath: '/w',
    run: { runId: 'r' }, semanticStatus: { state: 'done' as const, source: 'native-hook' as const, observedAt: 1 } },
  tickId, now: 0
})
it('restores an interrupted claim as unknown and resumes using the original operation identity', async () => {
  const dir = await mkdtemp(join('/tmp', 'agentmux-interrupted-loop-'))
  const store = new ContinuousProgressLoopStore(join(dir, 'loops.json'))
  const operations: string[] = []
  let now = 0
  const manager = new ContinuousProgressLoopManager(store, async (_loop, operationId) => {
    operations.push(operationId)
    if (operations.length === 1) throw new Error('connection unavailable before confirmation')
    return 'sent'
  }, () => now, observedDone)
  try {
    await store.save([{ loopId: 'l', agentSessionId: 'a', intervalMs: 10, prompt: 'next', nextCheckAt: 0,
      status: 'active', pendingCompletion: { id: '["r",1]', operationId: 'original-operation' } }])
    await manager.start(); await manager.check()
    expect(manager.list()[0]).toMatchObject({ status: 'paused', lastOutcome: 'unknown' })
    expect(operations).toEqual([])
    await manager.resume('l'); now = 10; await manager.check()
    expect(manager.list()[0]).toMatchObject({ status: 'paused', lastOutcome: 'unknown' })
    await manager.resume('l'); now = 20; await manager.check()
    expect(operations).toEqual(['original-operation', 'original-operation'])
    expect(manager.list()[0]).toMatchObject({ status: 'active', lastOutcome: 'sent', lastCompletionId: '["r",1]' })
    expect(manager.list()[0]?.pendingCompletion).toBeUndefined()
    now = 30; await manager.check(); expect(operations).toHaveLength(2)
  } finally { await manager.stop(); await rm(dir, { recursive: true, force: true }) }
})
it.each(['pause', 'stopLoop'] as const)('does not send after %s while observation is pending', async (action) => {
  const dir = await mkdtemp(join('/tmp', 'agentmux-pause-loop-'))
  const store = new ContinuousProgressLoopStore(join(dir, 'loops.json'))
  let release!: () => void, enter!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const entered = new Promise<void>((resolve) => { enter = resolve })
  let calls = 0
  const manager = new ContinuousProgressLoopManager(store, async () => { calls++; return 'sent' }, () => 0,
    async (loop, tickId) => { enter(); await gate; return observedDone(loop, tickId) })
  try {
    await store.save([{ loopId: 'l', agentSessionId: 'a', intervalMs: 10, prompt: 'next', nextCheckAt: 0, status: 'active' }])
    await manager.start(); const checking = manager.check(); await entered
    await manager[action]('l'); release(); await checking
    expect(calls).toBe(0)
    expect(manager.list()[0]?.status).toBe(action === 'pause' ? 'paused' : 'stopped')
  } finally { release(); await manager.stop(); await rm(dir, { recursive: true, force: true }) }
})

it('propagates pause cancellation to an already queued Core submission', async () => {
  const dir = await mkdtemp(join('/tmp', 'agentmux-abort-loop-')); const store = new ContinuousProgressLoopStore(join(dir, 'loops.json'))
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((r) => { enter = r }); const gate = new Promise<void>((r) => { release = r })
  let bytes = 0
  const manager = new ContinuousProgressLoopManager(store, async (_loop, _id, _current, signal) => {
    enter(); await gate
    if (!signal.aborted) bytes++
    return 'skipped'
  }, () => 0, observedDone)
  try {
    await store.save([{ loopId: 'l', agentSessionId: 'a', intervalMs: 10, prompt: 'next', nextCheckAt: 0, status: 'active' }])
    await manager.start(); const checking = manager.check(); await entered
    await manager.pause('l'); release(); await checking
    expect(bytes).toBe(0)
  } finally { release(); await manager.stop(); await rm(dir, { recursive: true, force: true }) }
})
