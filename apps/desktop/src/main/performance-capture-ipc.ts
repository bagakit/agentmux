import { parseRendererAllocationsInput, parseRendererAllocationsResult, parseRendererSceneCaptureInput, parseRendererSceneCaptureResult, parseRendererSceneInspectInput, parseRendererSceneInspection } from '@agentmux/core/control'
import type { IpcMainInvokeEvent } from 'electron'
import { AgentMuxError } from '@agentmux/core'
import { parseRendererV8ProfileInput, parseRendererV8ProfileResult, parseRendererTraceInput, parseRendererTraceResult,
  type AgentMuxMetricsPort } from '@agentmux/core/control'

/** Desktop is another consumer of the original public metrics capture owner. */
export function registerPerformanceCaptureIpc(metrics: AgentMuxMetricsPort,
  handle: (channel: string, listener: (event: IpcMainInvokeEvent, input: unknown) => unknown) => void): void {
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
