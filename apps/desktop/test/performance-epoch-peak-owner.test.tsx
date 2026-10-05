// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { createRendererPerformance } from '../src/renderer/src/lib/renderer-performance'
import { parseRendererPerformanceSnapshot } from '../../../packages/core/src/metrics'
import { terminalWriteContextFixture } from '../../../packages/core/test/helpers/renderer-performance'

it('retains a displaced current maximum, the first tied event, and deduplicates latest membership', () => {
  let mono = 0
  const recorder = createRendererPerformance(() => mono, () => 0)
  mono = 1900; recorder.terminalWrite(false, '秘密', 83.3, terminalWriteContextFixture())
  mono = 2000; recorder.terminalWrite(true, new Uint8Array(3), 183.3, { ...terminalWriteContextFixture(), cause: 'live' })
  for (let i = 0; i < 8; i++) { mono += 100; recorder.terminalWrite(false, new Uint8Array(4), mono - 80, terminalWriteContextFixture()) }
  const snapshot = parseRendererPerformanceSnapshot(recorder.snapshot()), events = snapshot.slowEvents
  expect(events).toHaveLength(5)
  expect(events.map(event => event.id)).toEqual([1, 7, 8, 9, 10])
  expect(events[0]).toMatchObject({ durationMs: 1816.7, retainedAs: ['current-peak'], terminal: { cause: 'history', payload: { unit: 'string-code-units', length: 2 } } })
  expect(events.slice(1).every(event => event.retainedAs.join() === 'latest')).toBe(true)
  expect(snapshot.slowEventsOmitted['terminal-write']).toBe(5)
  expect(snapshot.timingEpochs.current.timings['terminal-write'].maxMs).toBe(1816.7)
  expect(JSON.stringify(snapshot)).not.toContain('秘密')
})

it('keeps two distinct epoch maxima plus latest four, rotates idle peaks, and recomputes omissions', () => {
  let mono = 0
  const recorder = createRendererPerformance(() => mono)
  mono = 1500; recorder.sessionEvent('body', 500)
  mono = 11500; recorder.sessionEvent('body', 10000)
  for (let i = 0; i < 8; i++) { mono += 100; recorder.sessionEvent('body', mono - 70) }
  const snapshot = recorder.snapshot()
  expect(snapshot.slowEvents).toHaveLength(6)
  expect(snapshot.slowEvents[0]!.retainedAs).toEqual(['previous-peak'])
  expect(snapshot.slowEvents[1]!.retainedAs).toEqual(['current-peak'])
  expect(snapshot.slowEventsOmitted['session-event']).toBe(4)
  mono = 20000
  expect(recorder.snapshot().slowEvents.find(event => event.id === 2)!.retainedAs).toEqual(['previous-peak'])
  expect(recorder.snapshot().slowEventsOmitted['session-event']).toBe(5)
  mono = 21000; recorder.sessionEvent('body', 20000)
  for (let i = 0; i < 4; i++) { mono += 100; recorder.sessionEvent('body', mono - 70) }
  expect(recorder.snapshot().slowEvents.find(event => event.id === 11)!.retainedAs).toEqual(['current-peak'])
  mono = 50000
  const idle = recorder.snapshot()
  expect(idle.slowEvents).toHaveLength(4)
  expect(idle.slowEvents.every(event => event.retainedAs.join() === 'latest')).toBe(true)
  expect(idle.slowEventsOmitted['session-event']).toBe(11)
  expect(idle.timingEpochs.previous!.timings['session-event'].count).toBe(0)
})

it('snapshots detach retention flags, exact context and payload; terminal serials survive terminal unregister', () => {
  let mono = 0
  const recorder = createRendererPerformance(() => mono)
  const first = recorder.allocateTerminalInstance(), second = recorder.allocateTerminalInstance()
  expect(second).toBe(first + 1)
  const context = { ...terminalWriteContextFixture(), instanceId: first }
  mono = 80; recorder.terminalWrite(false, new Uint8Array(7), 0, context)
  context.runId = 'changed-after-delivery'
  const snapshot = recorder.snapshot(), event = snapshot.slowEvents[0]!
  expect(snapshot.slowEvents).toHaveLength(1)
  expect(event.retainedAs).toEqual(['latest', 'current-peak'])
  event.retainedAs.length = 0; event.terminal!.payload.length = 999; event.terminal!.runId = 'tampered'
  expect(recorder.snapshot().slowEvents[0]).toMatchObject({ retainedAs: ['latest', 'current-peak'], terminal: { runId: 'fixture-run', payload: { length: 7 } } })
  expect(recorder.allocateTerminalInstance()).toBe(second + 1)
})

it('rejects wrong or unbounded retention/context at the public strict owner without reading accessor payloads', () => {
  let mono = 0
  const recorder = createRendererPerformance(() => mono)
  mono = 80; recorder.terminalWrite(false, 'x', 0, terminalWriteContextFixture())
  const snapshot = recorder.snapshot(), event = snapshot.slowEvents[0]!
  let invoked = 0
  const getter = { ...event.terminal! }; Object.defineProperty(getter, 'runId', { get: () => { invoked++; return 'private' }, enumerable: true })
  const badEvents = [
    { ...event, retainedAs: [] }, { ...event, retainedAs: ['latest', 'latest'] }, { ...event, retainedAs: ['guessed'] },
    { ...event, terminal: null }, { ...event, terminal: getter },
    { ...event, terminal: { ...event.terminal, cause: 'guessed' } },
    { ...event, terminal: { ...event.terminal, hostId: 'x'.repeat(4097) } },
    { ...event, terminal: { ...event.terminal, payload: { unit: 'text', length: 1 } } },
    { ...event, terminal: { ...event.terminal, payload: { unit: 'bytes', length: -1 } } },
    { ...event, terminal: { ...event.terminal, payload: { unit: 'bytes', length: 1, body: 'private' } } },
    { ...event, kind: 'long-task' }
  ]
  for (const invalid of badEvents) expect(() => parseRendererPerformanceSnapshot({ ...snapshot, slowEvents: [invalid] })).toThrow()
  expect(() => parseRendererPerformanceSnapshot({ ...snapshot, slowEvents: [event, event] })).toThrow()
  expect(() => parseRendererPerformanceSnapshot({ ...snapshot, slowEvents: Array.from({length: 5}, (_, id) => ({ ...event, id, retainedAs: ['latest'] })) })).toThrow()
  expect(() => parseRendererPerformanceSnapshot({ ...snapshot, slowEvents: [event, {...event, id: 2, retainedAs: ['current-peak']}] })).toThrow()
  expect(invoked).toBe(0)
})
