import { fixturePath } from './helpers/fixture-values.js'
import { describe, expect, it, vi } from 'vitest'
import { ContinuousProgressScheduler } from '../src/continuous-progress-scheduler.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


describe('ContinuousProgressScheduler', () => {
  it('creates, claims once per interval, and advances the next check', () => {
    let now = 1000
    const s = new ContinuousProgressScheduler({ now: () => now, id: (() => { let n = 0; return () => `id-${++n}` })() })
    const loop = s.create({ hostId: 'local', agentSessionId: 'a', providerId: 'codex', workspacePath: fixturePath("w"), intervalMs: 100, prompt: 'Continue' })
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
    const loop = a.create({ hostId: 'local', agentSessionId: 'a', providerId: 'codex', workspacePath: fixturePath("w"), intervalMs: 10, prompt: 'x' })
    const b = new ContinuousProgressScheduler({ now: () => now, id: () => 'tick' }); b.restore(a.list())
    expect(b.pause(loop.loopId).status).toBe('paused')
    now = 100
    expect(b.due()).toEqual([])
    expect(b.resume(loop.loopId).nextCheckAt).toBe(110)
    expect(b.stop(loop.loopId).status).toBe('stopped')
  })
  it('recovers one overdue tick without replaying missed periods', () => {
    let now = 0
    const s = new ContinuousProgressScheduler({ now: () => now, id: (() => { let n = 0; return () => `id-${++n}` })() })
    s.create({ hostId: 'local', agentSessionId: 'a', providerId: 'codex', workspacePath: fixturePath("w"), intervalMs: 10, prompt: 'x' })
    now = 1000
    expect(s.recover()).toHaveLength(1)
    expect(s.recover()).toHaveLength(0)
    now = 1010
    expect(s.recover()).toHaveLength(1)
  })

  it.each([1, 100, 1000])('does not copy %i unrelated loop bodies while checking the clock', (count) => {
    const s = new ContinuousProgressScheduler({ id: () => 'tick' })
    const base = { hostId: 'local', agentSessionId: 'a', providerId: 'codex', workspacePath: fixturePath('w'), intervalMs: 10,
      prompt: 'Retained prompt '.repeat(128), nextCheckAt: _historyFixtureEpoch(0, 1, 0) }
    s.restore(Array.from({ length: count }, (_, n) => ({ ...base, loopId: `history-${n}`,
      status: (['paused', 'stopped', 'active'] as const)[n % 3]! })))
    const clone = vi.spyOn(globalThis, 'structuredClone')
    try {
      expect(s.due(100)).toEqual([])
      expect(s.recover(100)).toEqual([])
      expect(clone).not.toHaveBeenCalled()
      // A real due body still leaves the owner as an isolated snapshot.
      s.restore([...s.list(), { ...base, loopId: 'due', status: 'active', nextCheckAt: _historyFixtureEpoch(0, 0, 100),
        taskSource: { kind: 'goal', goalId: 'original-goal', alignmentRevision: 1 } }])
      clone.mockClear()
      const due = s.due(100)
      expect(clone).toHaveBeenCalledTimes(1)
      expect(due.map(loop => loop.loopId)).toEqual(['due'])
      if (due[0]!.taskSource?.kind === 'goal') due[0]!.taskSource.goalId = 'changed-consumer-copy'
      expect(s.due(100)[0]!.taskSource).toMatchObject({ goalId: 'original-goal' })
      clone.mockClear()
      expect(s.recover(100)).toMatchObject([{ loop: { loopId: 'due' }, tickId: 'tick' }])
      expect(s.recover(100)).toEqual([])
      expect(clone).not.toHaveBeenCalled()
    } finally { clone.mockRestore() }
  })
})
