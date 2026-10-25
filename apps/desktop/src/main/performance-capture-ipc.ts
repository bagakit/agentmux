import { parseRendererAllocationsInput, parseRendererAllocationsResult, parseRendererSceneCaptureInput, parseRendererSceneCaptureResult, parseRendererSceneInspectInput, parseRendererSceneInspection } from '@agentmux/core/control'
import { parseRendererCacheInput, parseRendererCacheResult } from '@agentmux/core/control'
import type { IpcMainInvokeEvent } from 'electron'
import { parseRendererAnimationsInput, parseRendererAnimationsResult } from '@agentmux/core/control'
import { parseRendererHeapSnapshotInput, parseRendererHeapSnapshotResult, parseRendererHeapSnapshotInspectInput, parseRendererHeapSnapshotInspection } from '@agentmux/core/control'
import { AgentMuxError } from '@agentmux/core'
import { parseRendererV8ProfileInput, parseRendererV8ProfileResult, parseRendererTraceInput, parseRendererTraceResult,
  type AgentMuxMetricsPort } from '@agentmux/core/control'

/** Desktop is another consumer of the original public metrics capture owner. */
export function registerPerformanceCaptureIpc(metrics: AgentMuxMetricsPort,
  handle: (channel: string, listener: (event: IpcMainInvokeEvent, input: unknown) => unknown) => void): void {
  for (const action of ['inspect', 'reclaim'] as const) handle(action === 'inspect' ? 'metrics:inspectCache' : 'metrics:reclaimCache', async (_event, raw) => {
    const input = parseRendererCacheInput(raw), call = action === 'inspect' ? metrics.inspectCache : metrics.reclaimCache
    if (!call) throw new AgentMuxError('Renderer platform cache operation is unavailable.', 'METRICS_UNSUPPORTED')
    return parseRendererCacheResult(await call.call(metrics, input), input, action)
  })
  handle('metrics:captureHeapSnapshot', async (_event, raw) => {
    const input = parseRendererHeapSnapshotInput(raw)
    if (!metrics.captureHeapSnapshot) throw new AgentMuxError('Native heap capture is unavailable.', 'METRICS_UNSUPPORTED')
    return parseRendererHeapSnapshotResult(await metrics.captureHeapSnapshot(input), input)
  })
  handle('metrics:inspectHeapSnapshot', async (_event, raw) => {
    const input = parseRendererHeapSnapshotInspectInput(raw)
    if (!metrics.inspectHeapSnapshot) throw new AgentMuxError('Native heap inspection is unavailable.', 'METRICS_UNSUPPORTED')
    return parseRendererHeapSnapshotInspection(await metrics.inspectHeapSnapshot(input), input)
  })
  handle('metrics:inspectAnimations', async (_event, raw) => {
    const input = parseRendererAnimationsInput(raw)
    if (!metrics.inspectAnimations) throw new AgentMuxError('Renderer animation observation is unavailable.', 'METRICS_UNSUPPORTED')
    return parseRendererAnimationsResult(await metrics.inspectAnimations(input), input)
  })
  handle('metrics:captureAllocations', async (_event, raw) => {
    const input = parseRendererAllocationsInput(raw)
    if (!metrics.captureAllocations) throw new AgentMuxError('Allocation sampling is unavailable.', 'METRICS_UNSUPPORTED')
    return parseRendererAllocationsResult(await metrics.captureAllocations(input), input)
  })
  handle('metrics:captureScene', async (_event, raw) => {
    const input = parseRendererSceneCaptureInput(raw)
    if (!metrics.captureScene) throw new AgentMuxError('Scene capture is unavailable.', 'METRICS_UNSUPPORTED')
    return parseRendererSceneCaptureResult(await metrics.captureScene(input), input)
  })
  handle('metrics:inspectScene', async (_event, raw) => {
    const input = parseRendererSceneInspectInput(raw)
    if (!metrics.inspectScene) throw new AgentMuxError('Scene inspection is unavailable.', 'METRICS_UNSUPPORTED')
    return parseRendererSceneInspection(await metrics.inspectScene(input), input)
  })
  handle('metrics:captureProfile', async (_event, raw) => {
    const input = parseRendererV8ProfileInput(raw)
    if (!metrics.captureProfile) throw new AgentMuxError('Renderer profiling is unavailable.', 'METRICS_UNSUPPORTED')
    return parseRendererV8ProfileResult(await metrics.captureProfile(input), input)
  })
  handle('metrics:captureTrace', async (_event, raw) => {
    const input = parseRendererTraceInput(raw)
    if (!metrics.captureTrace) throw new AgentMuxError('Renderer tracing is unavailable.', 'METRICS_UNSUPPORTED')
    return parseRendererTraceResult(await metrics.captureTrace(input), input)
  })
}
