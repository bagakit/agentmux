import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ContinuousProgressLoopStore } from '../src/main/continuous-progress-loop-store.js'
import { ContinuousProgressLoopManager } from '../src/main/continuous-progress-loop-manager.js'

describe('ContinuousProgressLoopManager', () => {
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
