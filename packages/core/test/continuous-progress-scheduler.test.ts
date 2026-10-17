import { fixturePath } from './helpers/fixture-values.js'
import { describe, expect, it, vi } from 'vitest'
import { ContinuousProgressScheduler, isAgentSchedule } from '../src/continuous-progress-scheduler.js'
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

  it('keeps the absolute relative deadline on claim, restore and resume while interval time advances', () => {
    let now = 1000
    const a = new ContinuousProgressScheduler({ now: () => now, id: () => 'timer' })
    const timer = a.createSchedule({ hostId: 'local', agentSessionId: 'a', providerId: 'codex', workspacePath: fixturePath('w'), afterMs: 90000, nextDue: 91000, prompt: 'once', operationId: 'create' })
    expect(isAgentSchedule(timer)).toBe(true); a.pause(timer.loopId); now = 300000
    const b = new ContinuousProgressScheduler({ now: () => now, id: () => 'tick' }); b.restore(a.list())
    expect(b.resume(timer.loopId).nextCheckAt).toBe(91000)
    expect(b.claimTick(timer.loopId)?.loop.nextCheckAt).toBe(91000)
    const interval = b.create({ ...timer, intervalMs: 10 })
    expect(isAgentSchedule(interval)).toBe(false)
    expect(interval.nextCheckAt).toBe(now + 10)
  })

  it('refuses invalid direct Core timing without creating a schedule or disturbing the original loop', () => {
    const s = new ContinuousProgressScheduler({ now: () => 1000, id: () => 'original' })
    const input = { hostId: 'local', agentSessionId: 'a', providerId: 'codex', workspacePath: fixturePath('w'), prompt: 'once', operationId: 'create', nextDue: 91000 }
    const original = s.createSchedule({ ...input, afterMs: 90000 })
    for (const timing of [{}, { afterMs: 0 }, { afterMs: -1 }, { afterMs: 1.5 }, { afterMs: Infinity }, { afterMs: Number.MAX_SAFE_INTEGER + 1 }, { afterMs: 90000, calendar: {} }, { afterMs: 90000, checkIn: {} }]) {
      expect(() => s.createSchedule({ ...input, ...timing } as Parameters<typeof s.createSchedule>[0])).toThrow()
      expect(s.list()).toEqual([original])
    }
    expect(() => s.createSchedule({ ...input, afterMs: 90000, nextDue: Number.MAX_SAFE_INTEGER + 1 })).toThrow()
    expect(s.list()).toEqual([original])
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
