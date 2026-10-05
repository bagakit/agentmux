import type { MetricsObservation, RendererMemorySnapshot } from '../../src/metrics.js'
import type { ToolkitMetricsSnapshot } from '../../src/toolkit.js'
import { performanceFixture } from './renderer-performance.js'

export function rendererMemoryFixture(pid = 1): RendererMemorySnapshot {
  return { process: { pid, creationTime: 1 }, memory: { sampledAt: 1000, scope: 'renderer-v8-isolate',
    heap: { usedHeapKib: 64, totalHeapKib: 128, physicalHeapKib: 96, heapLimitKib: 4096 }, unavailable: null } }
}

/** Same public shape as live available observations, with synthetic identities. */
export function deepMetricsSnapshot(): ToolkitMetricsSnapshot {
  const timing = () => ({ count: 1, totalMs: 2, maxMs: 2 })
  const window = { windowId: 1, webContentsId: 2, generation: 3 }
  const pending = { state: 'pending', data: null, observedAt: null, lastSuccessAt: null, reason: null } as const
  const performance = performanceFixture()
  performance.observedAt = 1000
  performance.terminals = [{ sessionId: 'session', runId: 'run', regionId: 'region', visible: true,
    visibleSinceAt: 1, readySinceAt: 1, revealed: true, liveReady: true, acceptsInput: true,
    replaying: false, inFlightWrites: 0, queuedItems: 0, queuedBytes: 0, pendingItems: 0, pendingBytes: 0,
    cols: 80, rows: 24, normalLines: 100, alternateLines: 24,
    interaction: { observedSinceAt: 1, keydown: { count: 1, unknownDelayCount: 0, delay: timing() },
      wheel: { count: 1, unknownDelayCount: 0, delay: timing() },
      writeRequests: { started: 1, completed: 1, failed: 0, pending: 0, wall: timing(), lastStartedAt: 1, lastSettledAt: 2 },
      lastEvent: { kind: 'keydown', observedAt: 1000, delayMs: 2, visible: true, liveReady: true,
        acceptsInput: true, readOnly: false, buffer: 'normal', mouseTrackingMode: 'none' } } }]
  performance.tabSwitches = [{ id: 1, target: { displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab', regionId: 'region', presentationId: 'presentation' },
    elapsedMs: 1, pendingStage: null,
    handlerAt: 1, inputDelayMs: 2, selectedMs: 1, placedMs: 1, terminalMs: 1, inputReadyMs: 1, frameMs: 1,
    state: 'observed', mode: 'terminal', terminal: { sessionId: 'session', runId: 'run', readySinceAt: 1,
      visible: true, revealed: true, liveReady: true, acceptsInput: true, readOnly: false, replaying: false } }]
  const observation: MetricsObservation = { schema: 'agentmux.metrics.v1', observedAt: 1000,
    scope: { kind: 'unix-host', hostId: 'local', hostname: 'test-host', mainPid: 1 }, window: { ...window },
    units: { cpu: 'percent', cpuBasis: 'one-logical-core', rss: 'KiB', storage: 'bytes', cpuAggregate: '10s-reading-peak', rssAggregate: 'latest' },
    diagnostics: pending, process: pending, runTotals: null, app: pending, runtime: pending, main: pending,
    renderer: { state: 'available', observedAt: 1000, lastSuccessAt: 1000, reason: null, data: { window, ...rendererMemoryFixture(),
      counts: { monacoEditors: 0, monacoModels: 0, documents: 0, runtimeSubscriptions: 1, terminalViews: 1, terminalAddons: 1, terminalListeners: 1 }, performance } } }
  return { schema: 'agentmux.toolkit.v1', kind: 'metrics', toolId: 'performance', executionId: 'execution',
    run: { hostId: 'local', runId: 'observer-run' }, state: 'observing', reason: null, startedAt: 1,
    observedAt: 1000, observation, document: null, manual: false, consumerCount: 1, sequence: 1,
    trend: [{ observedAt: 1000, appCpuPercent: null, appRssKib: null }] }
}
