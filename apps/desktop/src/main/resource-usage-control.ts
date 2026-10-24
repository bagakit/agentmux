import { mintObjectId } from '@agentmux/core/object-id'
import { readSceneResources, type PerformanceSceneOwner } from './performance-scene.js'
import type { RendererHeapSnapshotOwner, RendererHeapSnapshotDependencies } from './renderer-heap-snapshot.js'
import type { RendererV8ProfileTarget, RendererSceneLoaded } from '@agentmux/core/control'
import { hostname } from 'node:os'

import {
  AgentMuxError, parseMetricsRendererResult, type AgentMuxMetricsPort, type MetricsObservation,
  type MetricsWindow, type MetricsSource, type MetricsRenderer
} from '@agentmux/core/control'
import type { DesktopControlIpcBridge } from './control-ipc-bridge.js'
import type { ProcessResourceSampler, ResourceSample } from './process-resource-sampler.js'
import type { AppMemoryEvidenceOwner } from './app-memory-evidence.js'

function source<T>(data: T | null, observedAt: number | null, reason: string | null): MetricsSource<T> {
  return { data, observedAt, lastSuccessAt: observedAt, reason,
    state: reason ? (data === null || observedAt === null ? 'unavailable' : 'stale') : data === null ? 'pending' : 'available' }
}

/** This composes the original sampler; it owns neither a polling clock nor resource facts. */
export function createResourceMetricsPort(args: {
  sampler: ProcessResourceSampler; currentWindow(): MetricsWindow | null; now?: () => number
  appMemory?: AppMemoryEvidenceOwner
  allocations?: { capture: NonNullable<AgentMuxMetricsPort['captureAllocations']>; dispose(): void }
  scene?: { owner: PerformanceSceneOwner; currentTarget(): RendererV8ProfileTarget | null; loaded(): RendererSceneLoaded }
  heap?: { owner: RendererHeapSnapshotOwner; dependencies: RendererHeapSnapshotDependencies }
  profiler?: { capture: NonNullable<AgentMuxMetricsPort['captureProfile']>; dispose(): void }
  memory?: { inspect: NonNullable<AgentMuxMetricsPort['inspectMemory']>; dispose(): void }
  animations?: { inspect: NonNullable<AgentMuxMetricsPort['inspectAnimations']>; dispose(): void }
  tracer?: { capture: NonNullable<AgentMuxMetricsPort['captureTrace']>; dispose(): void }
}): AgentMuxMetricsPort & { dispose(): void } {
  const consumers = new Set<() => void>()
  let disposed = false
  const port: AgentMuxMetricsPort & { dispose(): void } = {
    ...(args.appMemory ? { inspectAppMemory: async () => {
      if (disposed) throw new AgentMuxError('Metrics Main owner was disposed.', 'CONTROL_UNAVAILABLE')
      return args.appMemory!.inspect()
    } } : {}),
    ...(args.heap ? {
      captureHeapSnapshot: async (input, signal) => {
        if (disposed) throw new AgentMuxError('Metrics Main owner was disposed.', 'CONTROL_UNAVAILABLE')
        return args.heap!.owner.capture(input, args.heap!.dependencies, signal)
      },
      inspectHeapSnapshot: (input, signal) => args.heap!.owner.inspect(input, signal)
    } : {}),
    ...(args.scene ? {
      inspectScene: (input, signal) => args.scene!.owner.inspect(input, signal),
      captureScene: async (input, signal) => {
        if (disposed || !port.captureProfile || !port.captureTrace || !port.captureAllocations || !port.inspectMemory) throw new AgentMuxError('Original Window scene dependencies are unavailable.', 'METRICS_UNSUPPORTED')
        args.heap?.owner.assertDebuggerAvailable()
        return args.scene!.owner.capture(input, { currentTarget: args.scene!.currentTarget, loaded: args.scene!.loaded,
          resources: signal => readSceneResources(port, signal), captureProfile: port.captureProfile, captureAllocations: port.captureAllocations, captureTrace: port.captureTrace, inspectMemory: port.inspectMemory }, signal)
      }
    } : {}),
    ...(args.allocations ? { captureAllocations: (async (input, signal) => {
      if (disposed) throw new AgentMuxError('Metrics Main owner was disposed.', 'CONTROL_UNAVAILABLE')
      args.heap?.owner.assertDebuggerAvailable()
      return args.allocations!.capture(input, signal)
    }) satisfies NonNullable<AgentMuxMetricsPort['captureAllocations']> } : {}),
    ...(args.memory ? { inspectMemory: (async (input, signal) => {
      if (disposed) throw new AgentMuxError('Metrics Main owner was disposed.', 'CONTROL_UNAVAILABLE')
      args.heap?.owner.assertDebuggerAvailable()
      return args.memory!.inspect(input, signal)
    }) satisfies NonNullable<AgentMuxMetricsPort['inspectMemory']> } : {}),
    ...(args.animations ? { inspectAnimations: (async (input, signal) => {
      if (disposed) throw new AgentMuxError('Metrics Main owner was disposed.', 'CONTROL_UNAVAILABLE')
      return args.animations!.inspect(input, signal)
    }) satisfies NonNullable<AgentMuxMetricsPort['inspectAnimations']> } : {}),
    ...(args.tracer ? { captureTrace: (async (input, signal) => {
      if (disposed) throw new AgentMuxError('Metrics Main owner was disposed.', 'CONTROL_UNAVAILABLE')
      args.heap?.owner.assertDebuggerAvailable()
      return args.tracer!.capture(input, signal)
    }) satisfies NonNullable<AgentMuxMetricsPort['captureTrace']> } : {}),
    ...(args.profiler ? { captureProfile: (async (input, signal) => {
      if (disposed) throw new AgentMuxError('Metrics Main owner was disposed.', 'CONTROL_UNAVAILABLE')
      args.heap?.owner.assertDebuggerAvailable()
      return args.profiler!.capture(input, signal)
    }) satisfies NonNullable<AgentMuxMetricsPort['captureProfile']> } : {}),
    async subscribe(onSnapshot, onEnd, signal) {
      if (disposed) throw new AgentMuxError('Metrics Main owner was disposed.', 'CONTROL_UNAVAILABLE')
      let released = false
      let unsubscribe: (() => void) | undefined
      const release = () => {
        if (released) return
        released = true; signal.removeEventListener('abort', release); consumers.delete(close)
        unsubscribe?.()
      }
      const close = () => { release(); onEnd() }
      consumers.add(close)
      signal.addEventListener('abort', release, { once: true })
      if (signal.aborted) { release(); return { dispose: release } }
      const project = (sample: ResourceSample): MetricsObservation => {
        const window = args.currentWindow()
        const renderer = sample.renderer
        const matchesWindow = (candidate: MetricsWindow | null) => candidate !== null && window !== null &&
          candidate.windowId === window.windowId && candidate.webContentsId === window.webContentsId && candidate.generation === window.generation
        const sameWindow = matchesWindow(renderer.data?.window ?? null)
        const rendererFailure = matchesWindow(renderer.unavailableWindow) ? renderer.unavailable : null
        return {
          schema: 'agentmux.metrics.v1', observedAt: (args.now ?? Date.now)(),
          scope: { kind: 'unix-host', hostId: 'local', hostname: hostname(), mainPid: process.pid }, window,
          units: { cpu: 'percent', cpuBasis: 'one-logical-core', rss: 'KiB', storage: 'bytes', cpuAggregate: '10s-reading-peak', rssAggregate: 'latest' },
          process: source(sample.processObservedAt === null ? null : sample.runs, sample.processObservedAt, sample.unavailable),
          runTotals: sample.processObservedAt === null ? null : sample.runTotals,
          app: source(sample.appObservedAt === null ? null : sample.app, sample.appObservedAt, sample.app?.unavailable ?? null),
          runtime: source(sample.runtime, sample.runtimeObservedAt, sample.runtimeUnavailable),
          diagnostics: source(sample.diagnostics.data, sample.diagnostics.observedAt, sample.diagnostics.unavailable),
          main: source(sample.mainOwners, sample.mainObservedAt,
            sample.mainUnavailable ?? (sample.mainOwners === null ? 'Main resource owners unavailable' : null)),
          renderer: sameWindow ? source(renderer.data, renderer.observedAt, rendererFailure)
            : source<MetricsRenderer>(null, null, window === null ? 'Current Renderer window is unavailable' : rendererFailure)
        }
      }
      try {
        unsubscribe = args.sampler.subscribe(sample => { if (!released) onSnapshot(project(sample)) })
        if (released) unsubscribe()
      } catch (error) { release(); throw error }
      return { dispose: release }
    },
    dispose() {
      if (disposed) return
      disposed = true
      args.allocations?.dispose()
      args.profiler?.dispose()
      args.memory?.dispose()
      args.animations?.dispose()
      args.tracer?.dispose()
      for (const close of [...consumers]) close()
    }
  }
  return port
}

export async function observeRendererResources(
  bridge: DesktopControlIpcBridge, currentWindow: () => MetricsWindow | null, signal: AbortSignal, currentProcessId: () => number | null
) {
  const window = currentWindow(), processId = currentProcessId()
  if (!window || processId === null || processId <= 0) throw new AgentMuxError('Current Renderer is not connected.', 'CONTROL_UNAVAILABLE')
  const result = parseMetricsRendererResult(await bridge.execute({ operation: 'metrics.renderer', requestId: mintObjectId(), window }, signal))
  const current = currentWindow()
  if (signal.aborted || !current || currentProcessId() !== processId || result.process.pid !== processId || [current, result.window].some(value =>
    value.windowId !== window.windowId || value.webContentsId !== window.webContentsId || value.generation !== window.generation)) {
    throw new AgentMuxError('Renderer observation belongs to an ended generation.', 'CONTROL_OWNER_LOST')
  }
  return { observedAt: result.observedAt, data: { window: result.window, process: result.process, memory: result.memory, counts: result.counts, performance: result.performance } }
}
