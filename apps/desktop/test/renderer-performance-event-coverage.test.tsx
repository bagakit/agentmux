// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createRendererPerformance, rendererPerformance } from '../src/renderer/src/lib/renderer-performance'
import { useAppStore } from '../src/renderer/src/store'
import { createTerminalInteractionObservation } from '../src/renderer/src/lib/terminal-interaction-observation'
import { parseMetricsRendererResult, parseRendererPerformanceSnapshot } from '../../../packages/core/src/metrics'

declare const __AGENTMUX_RENDERER_STORE_SOURCE__: string
declare const __AGENTMUX_TERMINAL_VIEW_SOURCE__: string
type Costs = ReturnType<typeof createRendererPerformance>
const kinds = ['session-event', 'terminal-write', 'long-task', 'input-delay', 'terminal-interaction'] as const
function observed(costs: Costs) {
  const callbacks = new Map<string, PerformanceObserverCallback>()
  class Observer {
    static supportedEntryTypes = ['longtask', 'event']
    private callback: PerformanceObserverCallback
    constructor(callback: PerformanceObserverCallback) { this.callback = callback }
    observe(options: PerformanceObserverInit) { callbacks.set(options.type!, this.callback) }
    disconnect() {}
  }
  const off = costs.observeMainThread(Observer as unknown as typeof PerformanceObserver)
  const emit = (type: string, entries: Partial<PerformanceEntry & PerformanceEventTiming>[]) => {
    callbacks.get(type)!({ getEntries: () => entries } as unknown as PerformanceObserverEntryList, {} as PerformanceObserver)
  }
  return { off, emit }
}
afterEach(() => { vi.restoreAllMocks() })

it('keeps rare observer categories under an actual hidden-write flood with exact per-kind omissions', () => {
  let mono = 0
  const costs = createRendererPerformance(() => mono, () => 50_000 + mono), observer = observed(costs)
  mono = 120
  observer.emit('longtask', [{ startTime: 1, duration: 80 }])
  observer.emit('event', [{ startTime: 2, processingStart: 72, duration: 90 }])
  for (let i = 0; i < 1000; i++) costs.terminalWrite(false, new Uint8Array(1), 10)
  const snap = parseRendererPerformanceSnapshot(costs.snapshot())
  expect(snap.slowEvents.filter(event => event.kind === 'long-task')).toHaveLength(1)
  expect(snap.slowEvents.filter(event => event.kind === 'input-delay')).toHaveLength(1)
  expect(snap.slowEvents.filter(event => event.kind === 'terminal-write')).toHaveLength(6)
  expect(snap.slowEventsOmitted['terminal-write']).toBe(994)
  expect(snap.slowEventsOmitted['long-task']).toBe(0)
  expect(snap.slowEvents.length).toBe(8)
  expect(snap.timingEpochs.current.timings['terminal-write']).toEqual({ count: 1000, totalMs: 110_000, maxMs: 110 })
  observer.off()
})

it('retains at most six of each of five categories and globally orders ids independently of wall time', () => {
  let mono = 0, wall = 1000
  const costs = createRendererPerformance(() => mono, () => wall), observer = observed(costs)
  mono = 100
  for (let i = 0; i < 12; i++) {
    wall -= 10
    costs.sessionEvent('private prompt body', 1)
    costs.terminalWrite(false, 'private terminal body', 1)
    observer.emit('longtask', [{ startTime: 1, duration: 80 }])
    observer.emit('event', [{ startTime: 1, processingStart: 81, duration: 90 }])
    costs.terminalInteraction('wheel-dispatch', 80, 20)
  }
  const snap = costs.snapshot()
  expect(snap.slowEvents).toHaveLength(30)
  for (const kind of kinds) {
    expect(snap.slowEvents.filter(event => event.kind === kind)).toHaveLength(6)
    expect(snap.slowEventsOmitted[kind]).toBe(6)
  }
  expect(snap.slowEvents.map(event => event.id)).toEqual(Array.from({ length: 30 }, (_, i) => i + 31))
  expect(JSON.stringify(snap)).not.toContain('private')
  observer.off()
})

it('records all five timing categories below the slow threshold without creating slow records', () => {
  let mono = 0
  const costs = createRendererPerformance(() => mono), observer = observed(costs)
  mono = 40
  costs.sessionEvent('status', 35)
  costs.terminalWrite(true, new Uint8Array(1), 34)
  costs.terminalInteraction('keydown-dispatch', 7, 33)
  observer.emit('longtask', [{ startTime: 10, duration: 20 }])
  observer.emit('event', [{ startTime: 10, processingStart: 18, duration: 24 }])
  const snap = costs.snapshot()
  expect(snap.slowEvents).toHaveLength(0)
  for (const kind of kinds) expect(snap.timingEpochs.current.timings[kind].count).toBe(1)
  expect(snap.timingEpochs.current.timings['input-delay'].maxMs).toBe(8)
  observer.off()
})

it('keeps lifetime peaks while fixed epochs expire by monotonic time with a frozen/backwards wall', () => {
  let mono = 0, wall = 90_000
  const costs = createRendererPerformance(() => mono, () => wall)
  mono = 18_000
  costs.sessionEvent('status', 0)
  expect(costs.snapshot().timingEpochs.previous!.timings['session-event'].maxMs).toBe(18_000)
  mono = 30_080; wall = 100
  costs.sessionEvent('status', 30_000)
  const snap = costs.snapshot()
  expect(snap.sessionEvents.maxMs).toBe(18_000)
  expect(snap.timingEpochs.current).toMatchObject({ startMonoMs: 30_000, endMonoMs: 40_000, timings: { 'session-event': { count: 1, totalMs: 80, maxMs: 80 } } })
  expect(snap.timingEpochs.previous).toMatchObject({ startMonoMs: 20_000, endMonoMs: 30_000, timings: { 'session-event': { count: 0, totalMs: 0, maxMs: 0 } } })
})

it('rotates idle epochs without timers and repeated reads do not reset or alias nested facts', () => {
  let mono = 0
  const interval = vi.spyOn(globalThis, 'setInterval'), timeout = vi.spyOn(globalThis, 'setTimeout')
  const costs = createRendererPerformance(() => mono)
  mono = 80; costs.sessionEvent('status', 1)
  const first = costs.snapshot()
  first.timingEpochs.current.timings['session-event'].count = 100
  first.slowEventsOmitted['session-event'] = 100
  expect(first.slowEvents).toHaveLength(1)
  first.slowEvents[0]!.id = 100
  const second = costs.snapshot()
  expect(second.timingEpochs.current.timings['session-event'].count).toBe(1)
  expect(second.slowEventsOmitted['session-event']).toBe(0)
  expect(second.slowEvents[0]?.id).toBe(1)
  mono = 50_000
  const idle = costs.snapshot()
  expect(idle.timingEpochs.current.startMonoMs).toBe(50_000)
  expect(idle.timingEpochs.previous!.startMonoMs).toBe(40_000)
  for (const kind of kinds) expect(idle.timingEpochs.current.timings[kind].count + idle.timingEpochs.previous!.timings[kind].count).toBe(0)
  expect(interval).not.toHaveBeenCalled(); expect(timeout).not.toHaveBeenCalled()
})

it('attributes delayed native entries to occurrence epochs and explicitly counts old or unknown occurrences', () => {
  let mono = 0
  const costs = createRendererPerformance(() => mono), observer = observed(costs)
  mono = 25_000
  observer.emit('longtask', [{ startTime: 12_000, duration: 80 }, { startTime: 1000, duration: 90 }, { startTime: 26_000, duration: 100 }])
  const snap = costs.snapshot()
  expect(snap.longTasks.timing.count).toBe(3)
  expect(snap.timingEpochs.current.timings['long-task'].count).toBe(0)
  expect(snap.timingEpochs.previous!.timings['long-task']).toEqual({ count: 1, totalMs: 80, maxMs: 80 })
  expect(snap.timingEpochs.late['long-task']).toBe(1)
  expect(snap.timingEpochs.unknown['long-task']).toBe(1)
  expect(snap.slowEvents.map(event => [event.occurredAtMonoMs, event.deliveredAtMonoMs])).toEqual([[12_000, 25_000], [1000, 25_000], [null, 25_000]])
  observer.off()
})

it('marks occurrence outside recorder coverage unknown while preserving first partial epoch bounds', () => {
  let mono = 3500
  const costs = createRendererPerformance(() => mono), observer = observed(costs)
  mono = 4000
  observer.emit('longtask', [{ startTime: 3000, duration: 80 }, { startTime: 3600, duration: 80 }])
  const snap = costs.snapshot()
  expect(snap.timingEpochs.recordingSinceMonoMs).toBe(3500)
  expect(snap.timingEpochs.current.startMonoMs).toBe(0)
  expect(snap.timingEpochs.previous).toBeNull()
  expect(snap.timingEpochs.unknown['long-task']).toBe(1)
  expect(snap.timingEpochs.current.timings['long-task'].count).toBe(1)
  observer.off()
})

it('keeps unavailable support and generation fences instead of signing absence as zero latency', () => {
  let mono = 0
  const costs = createRendererPerformance(() => mono), observer = observed(costs)
  mono = 100
  observer.emit('longtask', [{ startTime: 1, duration: 80 }])
  observer.off(); observer.off()
  mono = 200
  observer.emit('longtask', [{ startTime: 110, duration: 80 }])
  expect(costs.snapshot().longTasks).toMatchObject({ state: 'stopped', timing: { count: 1 } })
  expect(costs.snapshot().timingEpochs.current.timings['long-task'].count).toBe(1)
  class Unsupported { static supportedEntryTypes = [] }
  const off = costs.observeMainThread(Unsupported as unknown as typeof PerformanceObserver)
  expect(costs.snapshot().longTasks.state).toBe('unsupported')
  expect(costs.snapshot().inputDelay.state).toBe('unsupported')
  off()
})

it('preserves occurrence start versus delivery for asynchronous writes without interpreting overlap as CPU', () => {
  let mono = 0
  const costs = createRendererPerformance(() => mono)
  mono = 130
  costs.terminalWrite(false, new Uint8Array(1), 10)
  costs.terminalWrite(false, new Uint8Array(1), 20)
  const snap = costs.snapshot()
  expect(snap.terminalWrites.hidden.totalMs).toBe(230)
  expect(snap.slowEvents.map(event => [event.occurredAtMonoMs, event.deliveredAtMonoMs])).toEqual([[10, 130], [20, 130]])
  expect(snap.timingEpochs.current.timings['terminal-write'].totalMs).toBe(230)
  expect(snap.writeTiming).toBe('parser-callback-wall')
})

it('adds no clock calls on selector checks or committed-consumer counters at retained scale', () => {
  const now = vi.fn(() => 1), costs = createRendererPerformance(now)
  const before = now.mock.calls.length
  for (let i = 0; i < 10_000; i++) { costs.check('composer', false, false); costs.commit('sessionPane', false) }
  expect(now.mock.calls.length).toBe(before)
  expect(costs.snapshot().consumers.composer.hidden.checks).toBe(10_000)
})

it('rejects malformed per-category bounds and epoch fields in the actual strict public codec', () => {
  let mono = 0
  const costs = createRendererPerformance(() => mono)
  mono = 100; costs.sessionEvent('status', 1)
  const snap = costs.snapshot()
  expect(() => parseRendererPerformanceSnapshot(snap)).not.toThrow()
  expect(parseRendererPerformanceSnapshot(snap)).toEqual(snap)
  const excess = Array.from({ length: 7 }, (_, id) => ({ ...snap.slowEvents[0], id }))
  for (const bad of [
    { ...snap, slowEvents: excess },
    { ...snap, slowEvents: Array.from({ length: 31 }, (_, id) => ({ ...snap.slowEvents[0], id })) },
    { ...snap, slowEventsOmitted: { ...snap.slowEventsOmitted, 'long-task': -1 } },
    { ...snap, timingEpochs: { ...snap.timingEpochs, durationMs: 9999 } },
    { ...snap, timingEpochs: { ...snap.timingEpochs, current: { ...snap.timingEpochs.current, extra: 0 } } },
    { ...snap, slowEvents: [{ ...snap.slowEvents[0], occurredAtMonoMs: Number.NaN }] },
    { ...snap, timingEpochs: { ...snap.timingEpochs, current: { ...snap.timingEpochs.current, timings: { ...snap.timingEpochs.current.timings, dynamic: { count: 0, totalMs: 0, maxMs: 0 } } } } }
  ]) expect(() => parseRendererPerformanceSnapshot(bad)).toThrow()
})

it('executes the actual Store metrics.renderer callback and strict result parser with nonempty recorder facts', () => {
  expect(typeof useAppStore.getState().initialize).toBe('function')
  const code = typeof __AGENTMUX_RENDERER_STORE_SOURCE__ === 'string' ? __AGENTMUX_RENDERER_STORE_SOURCE__ : readFileSync(resolve('apps/desktop/src/renderer/src/store.ts'), 'utf8')
  const file = ts.createSourceFile('store.ts', code, ts.ScriptTarget.Latest, true)
  let callback: ts.Node | undefined
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'api.control.onRequest') callback = node.arguments[0]
    ts.forEachChild(node, visit)
  }
  visit(file)
  expect(callback).toBeDefined()
  const expression = ts.transpileModule('const invoke = ' + callback!.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const counts = { monacoEditors: null, monacoModels: null, documents: 0, runtimeSubscriptions: 4, terminalViews: 0, terminalAddons: 0, terminalListeners: 0 }
  const invoke = new Function('readContinuousProgressInput', 'get', 'readRendererResourceOwnerCounts', 'rendererPerformance', expression + ';return invoke')(
    () => { throw new Error('wrong branch') }, () => { throw new Error('wrong branch') }, () => counts, rendererPerformance)
  rendererPerformance.sessionEvent('must-not-leak', rendererPerformance.start())
  const request = { operation: 'metrics.renderer', window: { windowId: 1, webContentsId: 1, generation: 1 } }
  let response: unknown
  expect(() => {
    let threw = true
    try { response = invoke(request, new AbortController().signal); threw = false }
    finally {
      if (process.env.AGENTMUX_TERMINAL_INPUT_LOADED) appendFileSync(process.env.AGENTMUX_TERMINAL_INPUT_LOADED + '.coverage', JSON.stringify({
        path: resolve('apps/desktop/src/renderer/src/store.ts'), operation: request.operation, invoked: true, threw,
        sourceSHA256: createHash('sha256').update(code).digest('hex'),
        callbackSHA256: createHash('sha256').update(expression).digest('hex')
      }) + '\n')
    }
  }).not.toThrow()
  expect(() => parseMetricsRendererResult(response)).not.toThrow()
  const result = parseMetricsRendererResult(response)
  expect(result.performance.timingEpochs.current.timings['session-event'].count).toBeGreaterThan(0)
  expect(result.performance.timingEpochs.basis).toBe('monotonic-occurrence-start')
  expect(Object.keys(result.performance.slowEventsOmitted)).toHaveLength(5)
  expect(JSON.stringify(result.performance)).not.toContain('must-not-leak')
})

it('passes original natural-event and request starts through the actual TerminalView adapter across epoch boundaries', async () => {
  let delivered = 0, handlerAt = 0
  const costs = createRendererPerformance(() => delivered)
  const source = typeof __AGENTMUX_TERMINAL_VIEW_SOURCE__ === 'string' ? __AGENTMUX_TERMINAL_VIEW_SOURCE__ : readFileSync(resolve('apps/desktop/src/renderer/src/components/TerminalView.tsx'), 'utf8')
  const file = ts.createSourceFile('TerminalView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const adapters: ts.Expression[] = []
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'createTerminalInteractionObservation' && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
      for (const member of node.arguments[0].properties) if (ts.isPropertyAssignment(member) && member.name.getText(file) === 'slow') adapters.push(member.initializer)
    }
    ts.forEachChild(node, visit)
  }
  visit(file); expect(adapters).toHaveLength(1)
  const expression = ts.transpileModule('const slow = ' + adapters[0]!.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const slow = new Function('rendererPerformance', expression + ';return slow')(costs) as Parameters<typeof createTerminalInteractionObservation>[0]['slow']
  const listeners = new Map<string, EventListenerOrEventListenerObject>()
  const host = {
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) { listeners.set(type, listener) },
    removeEventListener(type: string) { listeners.delete(type) }
  }
  const interaction = createTerminalInteractionObservation({ host, now: () => handlerAt, wall: () => 1000,
    readContext: () => ({ visible: true, liveReady: true, acceptsInput: true, readOnly: false, buffer: 'normal', mouseTrackingMode: 'none' }), slow })
  let resolveRequest!: () => void
  const request = new Promise<void>(resolve => { resolveRequest = resolve })
  interaction.observeWriteRequest(request, 9999.8)
  handlerAt = 10_000.2; delivered = 10_000.7
  ;(listeners.get('wheel') as EventListener)({ type: 'wheel', isTrusted: true, timeStamp: 9999.9 } as Event)
  handlerAt = 10_020.2; delivered = 10_020.7
  resolveRequest(); await Promise.resolve()
  if (process.env.AGENTMUX_TERMINAL_INPUT_LOADED) appendFileSync(process.env.AGENTMUX_TERMINAL_INPUT_LOADED + '.coverage', JSON.stringify({
    path: resolve('apps/desktop/src/renderer/src/components/TerminalView.tsx'), operation: 'terminal-interaction-boundary', invoked: true, threw: false,
    sourceSHA256: createHash('sha256').update(source).digest('hex'), callbackSHA256: createHash('sha256').update(expression).digest('hex')
  }) + '\n')
  const snapshot = costs.snapshot()
  expect(snapshot.timingEpochs.previous!.timings['terminal-interaction'].count).toBe(2)
  expect(snapshot.timingEpochs.current.timings['terminal-interaction'].count).toBe(0)
  expect(snapshot.timingEpochs.unknown['terminal-interaction']).toBe(0)
  expect(interaction.snapshot().writeRequests).toMatchObject({ completed: 1, pending: 0 })
  interaction.dispose(); expect(listeners.size).toBe(0)
})
