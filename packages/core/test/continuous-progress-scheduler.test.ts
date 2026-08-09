import { describe, expect, it } from 'vitest'
import { ContinuousProgressScheduler } from '../src/continuous-progress-scheduler.js'

describe('ContinuousProgressScheduler', () => {
  it('creates, claims once per interval, and advances the next check', () => {
    let now = 1000
    const s = new ContinuousProgressScheduler({ now: () => now, id: (() => { let n = 0; return () => `id-${++n}` })() })
    const loop = s.create({ agentSessionId: 'a', intervalMs: 100, prompt: 'Continue' })
    expect(s.due()).toEqual([])
    now = 1100
    const claim = s.claimTick(loop.loopId)
    expect(claim?.tickId).toBe('id-2')
    expect(s.claimTick(loop.loopId)).toBeNull()
    now = 1200
    expect(s.claimTick(loop.loopId)?.tickId).toBe('id-3')
  })
  it('persists lifecycle through restore and pause/resume/stop', () => {
    let now = 0
    const a = new ContinuousProgressScheduler({ now: () => now, id: () => 'loop' })
    const loop = a.create({ agentSessionId: 'a', intervalMs: 10, prompt: 'x' })
    const b = new ContinuousProgressScheduler({ now: () => now, id: () => 'tick' }); b.restore(a.list())
    expect(b.pause(loop.loopId).status).toBe('paused')
    now = 100
    expect(b.due()).toEqual([])
    expect(b.resume(loop.loopId).nextCheckAt).toBe(110)
    expect(b.stop(loop.loopId).status).toBe('stopped')
  })
})
