import { createInputPerformanceRecorder } from '../../src/performance-diagnostics.js'
import type { RendererPerformanceSnapshot, RendererTerminalWriteContext } from '../../src/metrics.js'
export function performanceFixture(): RendererPerformanceSnapshot {
  const timing = () => ({ count: 0, totalMs: 0, maxMs: 0 })
  const kinds = ['session-event', 'terminal-write', 'long-task', 'input-delay', 'terminal-interaction'] as const
  const kindCounts = () => Object.fromEntries(kinds.map(kind => [kind, 0])) as Record<typeof kinds[number], number>
  const kindTiming = () => Object.fromEntries(kinds.map(kind => [kind, timing()])) as Record<typeof kinds[number], ReturnType<typeof timing>>
  const consumer = () => ({ checks: 0, changes: 0, commits: 0 })
  const visibility = () => ({ visible: consumer(), hidden: consumer() })
  return { startedAt: 1, observedAt: 2, recording: 'bounded-lifetime', selectorTiming: 'counts-only', writeTiming: 'parser-callback-wall',
    consumers: { composer: visibility(), sessionPane: visibility() }, sessionEvents: timing(),
    inputRequestDetails: createInputPerformanceRecorder().snapshot(),
    inputRequests: { user: { started: 0, completed: 0, failed: 0, pending: 0, wall: timing() }, protocol: { started: 0, completed: 0, failed: 0, pending: 0, wall: timing() }, paste: { started: 0, completed: 0, failed: 0, pending: 0, wall: timing() } },
    overlay: { triggers: { initial: 0, demand: 0, mutation: 0, resize: 0, scroll: 0, toggle: 0, font: 0, collect: 0 }, scheduled: 0, coalesced: 0, candidates: 0, geometryReads: 0, nativeDemandCount: null, latestCandidates: null, latestGeometryReads: null, collect: timing() },
    terminalWrites: { visible: timing(), hidden: timing(), bytes: 0, stringCodeUnits: 0 },
    inputDelay: { state: 'unsupported', reason: 'unsupported in fixture', durationThresholdMs: 16, timing: timing() },
    longTasks: { state: 'unsupported', reason: 'unsupported in fixture', timing: timing() }, terminals: [], omittedTerminals: 0, unavailableTerminals: 0, tabSwitches: [], tabSwitchesOmitted: 0, slowEvents: [], slowEventsOmitted: kindCounts(),
    timingEpochs: { durationMs: 10000, basis: 'monotonic-occurrence-start', recordingSinceMonoMs: 0, observedMonoMs: 0,
      current: { startMonoMs: 0, endMonoMs: 10000, timings: kindTiming() }, previous: null, late: kindCounts(), unknown: kindCounts() },
    observerCost: { snapshots: timing(), performanceCallbacks: timing() } }
}

export function terminalWriteContextFixture(): RendererTerminalWriteContext {
  return { hostId: 'local', sessionId: 'fixture-session', runId: 'fixture-run', regionId: 'fixture-region', instanceId: 1, cause: 'history' }
}
