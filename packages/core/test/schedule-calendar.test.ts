import { fixtureEpoch as _batchFixtureEpoch } from "../../../test/fixture-values.mjs"
import { describe, expect, it } from 'vitest'
import { projectScheduleOccurrences, type ScheduleOccurrenceWindow } from '../src/schedule-calendar.js'
import type { ContinuousProgressLoop } from '../src/continuous-progress-scheduler.js'
import type { AgentScheduleCalendar } from '../src/agent-schedule.js'

const at = (text: string) => Date.parse(text)
const calendar = (fields: Partial<AgentScheduleCalendar> = {}): AgentScheduleCalendar => ({ kind: 'daily', timezone: 'UTC', time: (new Date(_batchFixtureEpoch(0, 34200)).toISOString().slice(11, 16)), policies: { gap: 'skip', fold: 'earlier', monthEnd: 'clamp', overdue: 'latest' }, ...fields })
const saved = (fields: Partial<ContinuousProgressLoop> = {}): ContinuousProgressLoop => ({ loopId: 'original', hostId: 'private-host', agentSessionId: 'original-session', providerId: 'generic', workspacePath: new URL('private/original', new URL('/', import.meta.url)).pathname,
  revision: 3, creationOperationId: 'original-create', futureIntentId: 'original-intent', prompt: 'original work', status: 'active', intervalMs: 1000, calendar: calendar(), nextCheckAt: at(((new Date(_batchFixtureEpoch(21915, 0, 34200000)).toISOString().slice(0, 19) + 'Z'))), ...fields })

describe('read-only schedule occurrences', () => {
  it('projects only the finite future window and keeps the original due, revision and records', () => {
    const record = saved(), before = structuredClone(record)
    Object.freeze(record.calendar!.policies); Object.freeze(record.calendar); Object.freeze(record)
    const records = Object.freeze([record]), window = Object.freeze({ from: at(((new Date(_batchFixtureEpoch(21915, 0, 0)).toISOString().slice(0, 19) + 'Z'))), to: at(((new Date(_batchFixtureEpoch(21918, 0, 34200000)).toISOString().slice(0, 19) + 'Z'))) })
    const result = projectScheduleOccurrences(records, window, at(((new Date(_batchFixtureEpoch(21915, 0, 0)).toISOString().slice(0, 19) + 'Z'))))
    expect(result).toEqual([
      { scheduleId: 'original', revision: 3, at: at(((new Date(_batchFixtureEpoch(21915, 0, 34200000)).toISOString().slice(0, 19) + 'Z'))), kind: 'next-due' },
      { scheduleId: 'original', revision: 3, at: at(((new Date(_batchFixtureEpoch(21916, 0, 34200000)).toISOString().slice(0, 19) + 'Z'))), kind: 'projected' },
      { scheduleId: 'original', revision: 3, at: at(((new Date(_batchFixtureEpoch(21917, 0, 34200000)).toISOString().slice(0, 19) + 'Z'))), kind: 'projected' }
    ])
    expect(record).toEqual(before)
    expect(projectScheduleOccurrences(records, { from: at(((new Date(_batchFixtureEpoch(21916, 0, 34200000)).toISOString().slice(0, 19) + 'Z'))), to: window.to }, at(((new Date(_batchFixtureEpoch(21915, 0, 0)).toISOString().slice(0, 19) + 'Z'))))).toEqual(result.slice(1))
  })

  it.each(['paused', 'stopped', 'unknown', 'pending'] as const)('does not predict future occurrences for %s', state => {
    const record = saved({ ...(state === 'paused' || state === 'stopped' ? { status: state } : state === 'unknown' ? { lastOutcome: 'unknown' } : { pendingCompletion: { id: 'original-tick', operationId: 'original-input' } }) })
    const result = projectScheduleOccurrences([record], { from: at(((new Date(_batchFixtureEpoch(21915, 0, 0)).toISOString().slice(0, 19) + 'Z'))), to: at(((new Date(_batchFixtureEpoch(21946, 0, 0)).toISOString().slice(0, 19) + 'Z'))) }, at(((new Date(_batchFixtureEpoch(21915, 0, 0)).toISOString().slice(0, 19) + 'Z'))))
    expect(result).toEqual([{ scheduleId: 'original', revision: 3, at: record.nextCheckAt, kind: 'next-due' }])
  })

  it('shows countdown and once deadlines once, and never projects ordinary interval loops', () => {
    const { calendar: _timerRule, ...timerBase } = saved({ loopId: 'timer' })
    const timer = { ...timerBase, afterMs: 90000 }
    const once = saved({ loopId: 'once', calendar: calendar({ kind: 'once', date: ((new Date(_batchFixtureEpoch(21915, 0, 0)).toISOString().slice(0, 10))) }) })
    const { calendar: _intervalRule, ...interval } = saved({ loopId: 'interval' })
    const result = projectScheduleOccurrences([timer, once, interval], { from: at(((new Date(_batchFixtureEpoch(21915, 0, 0)).toISOString().slice(0, 19) + 'Z'))), to: at(((new Date(_batchFixtureEpoch(21946, 0, 0)).toISOString().slice(0, 19) + 'Z'))) }, at(((new Date(_batchFixtureEpoch(21915, 0, 0)).toISOString().slice(0, 19) + 'Z'))))
    expect(result.map(item => [item.scheduleId, item.kind])).toEqual([['once', 'next-due'], ['timer', 'next-due']])
  })

  it('keeps only the last Host-accepted plan time and does not fabricate historical deliveries', () => {
    const record = saved({ nextCheckAt: at(((new Date(_batchFixtureEpoch(21915, 0, 34200000)).toISOString().slice(0, 19) + 'Z'))), lastOccurrenceAt: at(((new Date(_batchFixtureEpoch(21914, 0, 34200000)).toISOString().slice(0, 19) + 'Z'))) })
    const window = { from: at(((new Date(_batchFixtureEpoch(21884, 0, 0)).toISOString().slice(0, 19) + 'Z'))), to: at(((new Date(_batchFixtureEpoch(21919, 0, 0)).toISOString().slice(0, 19) + 'Z'))) }
    const result = projectScheduleOccurrences([record], window, at(((new Date(_batchFixtureEpoch(21917, 0, 43200000)).toISOString().slice(0, 19) + 'Z'))))
    expect(result.map(item => [new Date(item.at).toISOString(), item.kind])).toEqual([
      [((new Date(_batchFixtureEpoch(21914, 0, 34200000)).toISOString())), 'last-accepted'], [((new Date(_batchFixtureEpoch(21915, 0, 34200000)).toISOString())), 'next-due'], [((new Date(_batchFixtureEpoch(21918, 0, 34200000)).toISOString())), 'projected']
    ])
    const ended = saved({ status: 'stopped', lastOutcome: 'sent', lastOccurrenceAt: record.nextCheckAt })
    expect(projectScheduleOccurrences([ended], window, at(((new Date(_batchFixtureEpoch(21917, 0, 43200000)).toISOString().slice(0, 19) + 'Z'))))).toEqual([{ scheduleId: 'original', revision: 3, at: ended.nextCheckAt, kind: 'last-accepted' }])
  })

  it('reuses civil DST gap/fold and short-month rules for projected occurrences', () => {
    const gap = saved({ calendar: calendar({ timezone: 'America/New_York', time: (new Date(_batchFixtureEpoch(0, 9000)).toISOString().slice(11, 16)) }), nextCheckAt: at(((new Date(_batchFixtureEpoch(21982, 0, 27000000)).toISOString().slice(0, 19) + 'Z'))) })
    expect(projectScheduleOccurrences([gap], { from: at(((new Date(_batchFixtureEpoch(21982, 0, 0)).toISOString().slice(0, 19) + 'Z'))), to: at(((new Date(_batchFixtureEpoch(21985, 0, 0)).toISOString().slice(0, 19) + 'Z'))) }, at(((new Date(_batchFixtureEpoch(21982, 0, 0)).toISOString().slice(0, 19) + 'Z')))).map(item => item.at)).toEqual([at(((new Date(_batchFixtureEpoch(21982, 0, 27000000)).toISOString().slice(0, 19) + 'Z'))), at(((new Date(_batchFixtureEpoch(21984, 0, 23400000)).toISOString().slice(0, 19) + 'Z')))])
    for (const fold of ['earlier', 'later'] as const) {
      const rule = calendar({ timezone: 'America/New_York', time: (new Date(_batchFixtureEpoch(0, 5400)).toISOString().slice(11, 16)), policies: { gap: 'skip', fold, monthEnd: 'clamp', overdue: 'latest' } })
      const record = saved({ calendar: rule, nextCheckAt: at(((new Date(_batchFixtureEpoch(22220, 0, 19800000)).toISOString().slice(0, 19) + 'Z'))) })
      expect(projectScheduleOccurrences([record], { from: at(((new Date(_batchFixtureEpoch(22221, 0, 0)).toISOString().slice(0, 19) + 'Z'))), to: at(((new Date(_batchFixtureEpoch(22222, 0, 0)).toISOString().slice(0, 19) + 'Z'))) }, at(((new Date(_batchFixtureEpoch(22220, 0, 0)).toISOString().slice(0, 19) + 'Z'))))[0]?.at).toBe(at(fold === 'earlier' ? ((new Date(_batchFixtureEpoch(22221, 0, 19800000)).toISOString().slice(0, 19) + 'Z')) : ((new Date(_batchFixtureEpoch(22221, 0, 23400000)).toISOString().slice(0, 19) + 'Z'))))
    }
    const month = saved({ calendar: calendar({ kind: 'monthly', day: 31 }), nextCheckAt: at(((new Date(_batchFixtureEpoch(21945, 0, 34200000)).toISOString().slice(0, 19) + 'Z'))) })
    expect(projectScheduleOccurrences([month], { from: at(((new Date(_batchFixtureEpoch(21946, 0, 0)).toISOString().slice(0, 19) + 'Z'))), to: at(((new Date(_batchFixtureEpoch(21974, 0, 0)).toISOString().slice(0, 19) + 'Z'))) }, at(((new Date(_batchFixtureEpoch(21946, 0, 0)).toISOString().slice(0, 19) + 'Z'))))[0]?.at).toBe(at(((new Date(_batchFixtureEpoch(21973, 0, 34200000)).toISOString().slice(0, 19) + 'Z'))))
  })

  it('allows an empty window and rejects only invalid projection bounds without changing source records', () => {
    const records = [saved()], original = structuredClone(records)
    expect(projectScheduleOccurrences(records, { from: 0, to: 0 }, 0)).toEqual([])
    for (const window of [{ from: 1, to: 0 }, { from: NaN, to: 1 }, { from: 0, to: Infinity }, { from: 0, to: Number.MAX_SAFE_INTEGER }] as ScheduleOccurrenceWindow[]) {
      expect(() => projectScheduleOccurrences(records, window, 0)).toThrow(RangeError)
    }
    expect(() => projectScheduleOccurrences(records, { from: 0, to: 1 }, NaN)).toThrow(RangeError)
    expect(records).toEqual(original)
  })
})

it('bounds minute schedule projection and marks the omitted exact time range', () => {
  const start = _batchFixtureEpoch(1)
  const loop = { loopId: 'minute', hostId: 'local', agentSessionId: 'original', providerId: 'generic', workspacePath: '/private', intervalMs: 1000, everyMs: 60_000, prompt: 'check', nextCheckAt: start, status: 'active' as const }
  const result = projectScheduleOccurrences([loop], { from: start, to: start + 31 * 86_400_000 }, start)
  expect(result).toEqual([{ scheduleId: 'minute', at: start, kind: 'next-due', omittedRepeat: { from: start + 60_000, to: start + 31 * 86_400_000 } }])
})
