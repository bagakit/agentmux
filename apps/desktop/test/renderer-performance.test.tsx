// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { createRendererPerformance, rendererPerformance } from '../src/renderer/src/lib/renderer-performance'
import { useObservedAppStore, useObservedConsumerCommit } from '../src/renderer/src/lib/use-observed-app-store'
import { useAppStore } from '../src/renderer/src/store'
import { parseMetricsRendererResult, parseRendererPerformanceSnapshot } from '@agentmux/core/control'
import type { RendererTerminalCost } from '@agentmux/core/control'
import { TerminalLiveOutputQueue } from '@agentmux/client-ui/terminal/live-output'

const terminal = (id: number): RendererTerminalCost => ({ sessionId: `session-${id}`, runId: `run-${id}`, regionId: null,
  visible: true, visibleSinceAt: 1, readySinceAt: null, revealed: false, liveReady: false, acceptsInput: false, replaying: true,
  inFlightWrites: 0, queuedItems: 0, queuedBytes: 0, pendingItems: 0, pendingBytes: 0, cols: 80, rows: 24, normalLines: 24, alternateLines: 24,
  interaction: { observedSinceAt: 1,
    keydown: { count: 0, unknownDelayCount: 0, delay: { count: 0, totalMs: 0, maxMs: 0 } },
    wheel: { count: 0, unknownDelayCount: 0, delay: { count: 0, totalMs: 0, maxMs: 0 } },
    writeRequests: { started: 0, completed: 0, failed: 0, pending: 0, wall: { count: 0, totalMs: 0, maxMs: 0 }, lastStartedAt: null, lastSettledAt: null },
    lastEvent: null } })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('retains bounded independent facts, releases terminal readers, and does not inspect excess terminals', () => {
  let time = 0, reads = 0
  const costs = createRendererPerformance(() => time, () => 1000 + time)
  const releases = Array.from({ length: 70 }, (_, id) => costs.registerTerminal(() => { reads++; return terminal(id) }))
  for (let i = 0; i < 1000; i++) {
    const start = costs.start(); time += 60; costs.sessionEvent('status', start)
    costs.check('composer', false, false)
  }
  const releaseBroken = costs.registerTerminal(() => { throw new Error('gone') })
  const snap = parseRendererPerformanceSnapshot(costs.snapshot())
  expect(snap.terminals).toHaveLength(64); expect(reads).toBe(64)
  expect(snap.omittedTerminals).toBe(7); expect(snap.slowEvents).toHaveLength(32)
  expect(snap.sessionEvents).toEqual({ count: 1000, totalMs: 60_000, maxMs: 60 })
  expect(snap.consumers.composer.hidden).toEqual({ checks: 1000, changes: 0, commits: 0 })
  snap.sessionEvents.count = 0; snap.consumers.composer.hidden.checks = 0
  expect(costs.snapshot().sessionEvents.count).toBe(1000)
  expect(costs.snapshot().consumers.composer.hidden.checks).toBe(1000)
  for (const release of releases) { release(); release() }
  expect(costs.snapshot()).toMatchObject({ terminals: [], omittedTerminals: 0, unavailableTerminals: 1 })
  releaseBroken(); expect(costs.snapshot().unavailableTerminals).toBe(0)
  let failedReads = 0
  for (let i = 0; i < 200; i++) costs.registerTerminal(() => { failedReads++; throw new Error('lost') })
  expect(costs.snapshot()).toMatchObject({ terminals: [], unavailableTerminals: 64, omittedTerminals: 136 })
  expect(failedReads).toBe(64)
})

it('observes actual longtask entries with one shared owner, no timer, and disconnects on departure', () => {
  let callback!: PerformanceObserverCallback
  const disconnect = vi.fn(), observe = vi.fn(), interval = vi.spyOn(globalThis, 'setInterval')
  class Observer {
    static supportedEntryTypes = ['longtask']
    constructor(cb: PerformanceObserverCallback) { callback = cb }
    observe = observe; disconnect = disconnect
  }
  const costs = createRendererPerformance()
  const off = costs.observeMainThread(Observer as unknown as typeof PerformanceObserver)
  const second = costs.observeMainThread(Observer as unknown as typeof PerformanceObserver)
  expect(observe).toHaveBeenCalledExactlyOnceWith({ type: 'longtask' }); expect(interval).not.toHaveBeenCalled()
  callback({ getEntries: () => [{ duration: 87 }] } as PerformanceObserverEntryList, {} as PerformanceObserver)
  expect(costs.snapshot().longTasks).toEqual({ state: 'observing', reason: null, timing: { count: 1, totalMs: 87, maxMs: 87 } })
  off(); off(); expect(disconnect).not.toHaveBeenCalled()
  second(); expect(disconnect).toHaveBeenCalledOnce(); expect(costs.snapshot().longTasks.state).toBe('stopped')
  callback({ getEntries: () => [{ duration: 900 }] } as PerformanceObserverEntryList, {} as PerformanceObserver)
  expect(costs.snapshot().longTasks.timing.count).toBe(1)
  class Unsupported { static supportedEntryTypes = [] }
  const stop = costs.observeMainThread(Unsupported as unknown as typeof PerformanceObserver)
  expect(costs.snapshot().longTasks.state).toBe('unsupported'); stop()
  class Broken { static supportedEntryTypes = ['longtask']; constructor() { throw new Error('observation denied') } }
  const end = costs.observeMainThread(Broken as unknown as typeof PerformanceObserver)
  expect(costs.snapshot().longTasks).toMatchObject({ state: 'unavailable', reason: 'Error: observation denied' }); end()
})

it('distinguishes selector checks and changed selections from committed renders without changing store behavior', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const initial = useAppStore.getState(), host = document.createElement('div'), root = createRoot(host)
  let renders = 0
  function Probe({ visible }: { visible: boolean }) {
    const error = useObservedAppStore('composer', visible, { sessionIds: ['own'], navigation: false }, state => state.error)
    useObservedConsumerCommit('composer', visible)
    renders++
    return <output>{error}</output>
  }
  try {
    useAppStore.setState({ error: null })
    await act(async () => root.render(<Probe visible={false} />))
    const before = rendererPerformance.snapshot(), rendered = renders
    await act(async () => useAppStore.setState({ agentNames: { unrelated: 'name' } }))
    const unchanged = rendererPerformance.snapshot()
    expect(unchanged.consumers.composer.hidden.checks).toBe(before.consumers.composer.hidden.checks)
    expect(unchanged.consumers.composer.hidden.changes).toBe(before.consumers.composer.hidden.changes)
    expect(unchanged.consumers.composer.hidden.commits).toBe(before.consumers.composer.hidden.commits)
    expect(renders).toBe(rendered)
    await act(async () => useAppStore.setState({ error: 'changed' }))
    const changed = rendererPerformance.snapshot()
    expect(changed.consumers.composer.hidden.changes).toBeGreaterThan(unchanged.consumers.composer.hidden.changes)
    expect(changed.consumers.composer.hidden.commits).toBeGreaterThan(unchanged.consumers.composer.hidden.commits)
    expect(host.textContent).toBe('changed')
    await act(async () => root.render(<Probe visible />))
    expect(rendererPerformance.snapshot().consumers.composer.visible.commits).toBeGreaterThan(before.consumers.composer.visible.commits)
    const start = rendererPerformance.snapshot().sessionEvents.count
    useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: { type: 'connection-state', state: 'disconnected' } } as any)
    expect(rendererPerformance.snapshot().sessionEvents.count).toBe(start + 1)
  } finally { await act(async () => root.unmount()); useAppStore.setState(initial, true) }
})

it('reports parser callback wall time and queue bytes in constant time, without treating text units as bytes', () => {
  let time = 0
  const costs = createRendererPerformance(() => time)
  const start = costs.start(); time = 75; costs.terminalWrite(false, '中文', start)
  time = 80; costs.terminalWrite(true, new Uint8Array(6), start)
  expect(costs.snapshot().terminalWrites).toEqual({ visible: { count: 1, totalMs: 80, maxMs: 80 }, hidden: { count: 1, totalMs: 75, maxMs: 75 }, stringCodeUnits: 2, bytes: 6 })
  const queue = new TerminalLiveOutputQueue()
  queue.admit({ dataBytes: new Uint8Array(6), startByte: 0, endByte: 6 })
  Object.defineProperty(queue, Symbol.iterator, { value() { throw new Error('must not traverse') } })
  expect(queue.byteLength).toBe(6); queue.take(); expect(queue.byteLength).toBe(0)
})

it('rejects malformed and excessive performance facts in the real Renderer response parser', () => {
  const performance = createRendererPerformance().snapshot()
  const result = { operation: 'metrics.renderer', window: { windowId: 1, webContentsId: 1, generation: 1 }, observedAt: 1,
    counts: { monacoEditors: null, monacoModels: null, documents: 0, runtimeSubscriptions: 1, terminalViews: 0, terminalAddons: 0, terminalListeners: 0 }, performance }
  expect(parseMetricsRendererResult(result).performance.recording).toBe('bounded-lifetime')
  for (const bad of [
    { ...performance, sessionEvents: { count: -1, totalMs: 0, maxMs: 0 } },
    { ...performance, sessionEvents: { count: 1, totalMs: Number.NaN, maxMs: 0 } },
    { ...performance, terminals: Array.from({ length: 65 }, (_, id) => terminal(id)) },
    { ...performance, slowEvents: Array.from({ length: 33 }, () => ({ kind: 'long-task', detail: '', observedAt: 1, durationMs: 60 })) },
    { ...performance, invented: 0 }
  ]) expect(() => parseMetricsRendererResult({ ...result, performance: bad })).toThrow()
})

it('records browser input queue delay separately from long task duration and discards late observer entries', () => {
  const callbacks = new Map<string, PerformanceObserverCallback>()
  let callback!: PerformanceObserverCallback
  class Observer {
    static supportedEntryTypes = ['longtask', 'event']
    constructor(cb: PerformanceObserverCallback) { callback = cb }
    observe(options: PerformanceObserverInit) { callbacks.set(options.type!, callback) }
    disconnect() {}
  }
  const costs = createRendererPerformance()
  const stop = costs.observeMainThread(Observer as unknown as typeof PerformanceObserver)
  callbacks.get('event')!({ getEntries: () => [{ startTime: 10, processingStart: 210, duration: 500 }] } as unknown as PerformanceObserverEntryList, {} as PerformanceObserver)
  expect(costs.snapshot().inputDelay).toMatchObject({ state: 'observing', durationThresholdMs: 16, timing: { count: 1, totalMs: 200, maxMs: 200 } })
  expect(costs.snapshot().longTasks.timing.count).toBe(0)
  stop()
  callbacks.get('event')!({ getEntries: () => [{ startTime: 0, processingStart: 900 }] } as unknown as PerformanceObserverEntryList, {} as PerformanceObserver)
  expect(costs.snapshot().inputDelay.timing.count).toBe(1)
  expect(costs.snapshot().inputDelay.state).toBe('stopped')
})
