import { expect, it, vi } from 'vitest'
import { createRendererPerformance } from '../src/renderer/src/lib/renderer-performance'
import { parseRendererPerformanceSnapshot, RENDERER_SESSION_EVENT_TYPES } from '@agentmux/core/control'

it('keeps exact lifetime type totals bounded, private and detached while retaining the original aggregate', () => {
  let mono = 0
  const costs = createRendererPerformance(() => mono, () => mono)
  for (const [kind, duration] of [['agent-status', 3], ['agent-status', 8], ['agent-session', 0], ['agent-session', 21]] as const) {
    const start = mono; mono += duration; costs.sessionEvent(kind, start)
  }
  for (let i = 0; i < 500; i++) { const start = mono; mono += 1; costs.sessionEvent(`private-body-${i}`, start) }
  costs.sessionEvent('__proto__', mono); costs.sessionEvent('constructor', mono)
  const snapshot = parseRendererPerformanceSnapshot(costs.snapshot()), events = snapshot.sessionEvents
  expect(Object.keys(events.byType)).toEqual(Object.keys(RENDERER_SESSION_EVENT_TYPES))
  expect(Object.keys(events.byType)).toHaveLength(20)
  expect(events.byType['agent-status']).toEqual({ count: 2, totalMs: 11, maxMs: 8 })
  expect(events.byType['agent-session']).toEqual({ count: 2, totalMs: 21, maxMs: 21 })
  expect(events.byType.unknown).toEqual({ count: 502, totalMs: 500, maxMs: 1 })
  expect(events.count).toBe(Object.values(events.byType).reduce((n, cost) => n + cost.count, 0))
  expect(events.totalMs).toBe(Object.values(events.byType).reduce((n, cost) => n + cost.totalMs, 0))
  expect(events.maxMs).toBe(Math.max(...Object.values(events.byType).map(cost => cost.maxMs)))
  expect(JSON.stringify(snapshot)).not.toContain('private-body')
  expect(snapshot.timingEpochs.current.timings['session-event']).toEqual({ count: 506, totalMs: 532, maxMs: 21 })
  events.byType['agent-status'].count = 9000
  delete (events.byType as Partial<typeof events.byType>)['agent-session']
  const next = costs.snapshot()
  expect(next.sessionEvents.byType['agent-status'].count).toBe(2)
  expect(next.sessionEvents.byType['agent-session'].count).toBe(2)
})

it('strict metrics reject missing, extra, accessor and invalid type measurements without fabricating facts', () => {
  const costs = createRendererPerformance(() => 10)
  costs.sessionEvent('agent-status', 1)
  const invalid = (change: (value: any) => void) => {
    const value = costs.snapshot(); change(value.sessionEvents)
    expect(() => parseRendererPerformanceSnapshot(value)).toThrow()
  }
  invalid(value => { delete value.byType })
  invalid(value => { delete value.byType['agent-status'] })
  invalid(value => { value.byType['private-body'] = { count: 1, totalMs: 1, maxMs: 1 } })
  invalid(value => { value.byType['agent-status'].payload = 'private-body' })
  for (const field of ['count', 'totalMs', 'maxMs']) for (const number of [-1, NaN, Infinity]) {
    invalid(value => { value.byType['agent-status'][field] = number })
  }
  invalid(value => { value.byType['agent-status'].count = 1.5 })
  const getter = vi.fn(() => ({ count: 1, totalMs: 1, maxMs: 1 }))
  invalid(value => { Object.defineProperty(value.byType, 'agent-status', { enumerable: true, get: getter }) })
  expect(getter).not.toHaveBeenCalled()
})
