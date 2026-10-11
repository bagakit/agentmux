import type { IpcMainInvokeEvent } from 'electron'
import { AgentMuxError } from '@agentmux/core'
import { parseRendererV8ProfileInput, parseRendererV8ProfileResult, parseRendererTraceInput, parseRendererTraceResult,
  type AgentMuxMetricsPort } from '@agentmux/core/control'

/** Desktop is another consumer of the original public metrics capture owner. */
export function registerPerformanceCaptureIpc(metrics: AgentMuxMetricsPort,
  handle: (channel: string, listener: (event: IpcMainInvokeEvent, input: unknown) => unknown) => void): void {
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
