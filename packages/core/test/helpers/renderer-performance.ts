import type { RendererPerformanceSnapshot } from '../../src/metrics.js'
export function performanceFixture(): RendererPerformanceSnapshot {
  const timing = () => ({ count: 0, totalMs: 0, maxMs: 0 })
  const consumer = () => ({ checks: 0, changes: 0, commits: 0 })
  const visibility = () => ({ visible: consumer(), hidden: consumer() })
  return { startedAt: 1, observedAt: 2, recording: 'bounded-lifetime', selectorTiming: 'counts-only', writeTiming: 'parser-callback-wall',
    consumers: { composer: visibility(), sessionPane: visibility() }, sessionEvents: timing(),
    inputRequests: { user: { started: 0, completed: 0, failed: 0, pending: 0, wall: timing() }, protocol: { started: 0, completed: 0, failed: 0, pending: 0, wall: timing() }, paste: { started: 0, completed: 0, failed: 0, pending: 0, wall: timing() } },
    overlay: { triggers: { initial: 0, demand: 0, mutation: 0, resize: 0, scroll: 0, toggle: 0, font: 0, collect: 0 }, scheduled: 0, coalesced: 0, candidates: 0, geometryReads: 0, nativeDemandCount: null, latestCandidates: null, latestGeometryReads: null, collect: timing() },
    terminalWrites: { visible: timing(), hidden: timing(), bytes: 0, stringCodeUnits: 0 },
    inputDelay: { state: 'unsupported', reason: 'unsupported in fixture', durationThresholdMs: 16, timing: timing() },
    longTasks: { state: 'unsupported', reason: 'unsupported in fixture', timing: timing() }, terminals: [], omittedTerminals: 0, unavailableTerminals: 0, tabSwitches: [], tabSwitchesOmitted: 0, slowEvents: [],
    observerCost: { snapshots: timing(), performanceCallbacks: timing() } }
}
