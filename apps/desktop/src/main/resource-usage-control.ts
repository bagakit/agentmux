import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  parseMetricsRendererResult, type AgentMuxMetricsPort, type MetricsObservation,
  type MetricsWindow, type MetricsSource, type MetricsRenderer
} from '@agentmux/core/control'
import { AgentMuxError } from '@agentmux/core'
import type { DesktopControlIpcBridge } from './control-ipc-bridge.js'
import type { ProcessResourceSampler, ResourceSample } from './process-resource-sampler.js'

function source<T>(data: T | null, observedAt: number | null, reason: string | null): MetricsSource<T> {
  return { data, observedAt, lastSuccessAt: observedAt, reason,
    state: reason ? (data === null || observedAt === null ? 'unavailable' : 'stale') : data === null ? 'pending' : 'available' }
}

/** This composes the original sampler; it owns neither a polling clock nor resource facts. */
export function createResourceMetricsPort(args: {
  sampler: ProcessResourceSampler; currentWindow(): MetricsWindow | null; now?: () => number
}): AgentMuxMetricsPort & { dispose(): void } {
  const consumers = new Set<() => void>()
  let disposed = false
  return {
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
      for (const close of [...consumers]) close()
    }
  }
}

export async function observeRendererResources(
  bridge: DesktopControlIpcBridge, currentWindow: () => MetricsWindow | null, signal: AbortSignal, currentProcessId: () => number | null
) {
  const window = currentWindow(), processId = currentProcessId()
  if (!window || processId === null || processId <= 0) throw new AgentMuxError('Current Renderer is not connected.', 'CONTROL_UNAVAILABLE')
  const result = parseMetricsRendererResult(await bridge.execute({ operation: 'metrics.renderer', requestId: randomUUID(), window }, signal))
  const current = currentWindow()
  if (signal.aborted || !current || currentProcessId() !== processId || result.process.pid !== processId || [current, result.window].some(value =>
    value.windowId !== window.windowId || value.webContentsId !== window.webContentsId || value.generation !== window.generation)) {
    throw new AgentMuxError('Renderer observation belongs to an ended generation.', 'CONTROL_OWNER_LOST')
  }
  return { observedAt: result.observedAt, data: { window: result.window, process: result.process, memory: result.memory, counts: result.counts, performance: result.performance } }
}
