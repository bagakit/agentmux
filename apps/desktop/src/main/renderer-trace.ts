import type { WebContents } from 'electron'
import { createHash } from 'node:crypto'
import { AgentMuxError } from '@agentmux/core'
import { agentMuxControlTimeoutMs, parseRendererTraceInput, parseRendererTraceEvents, parseRendererTraceResult,
  rendererTraceJSON, sameRendererV8ProfileTarget, RENDERER_TRACE_MAX_BYTES, RENDERER_TRACE_CATEGORIES,
  type RendererTraceInput, type RendererTraceResult, type RendererTraceEvent, type RendererV8ProfileTarget } from '@agentmux/core/control'

/** One explicit page-session trace. Native start ACK, not attach, grants this recording. */
export class RendererTimelineTracer {
  private active: AbortController | null = null
  private disposed = false
  constructor(private readonly contents: WebContents, private readonly currentTarget: () => RendererV8ProfileTarget | null) {}
  dispose(): void {
    this.disposed = true
    this.active?.abort(new AgentMuxError('Renderer trace owner ended.', 'CONTROL_OWNER_LOST'))
  }
  async capture(raw: RendererTraceInput, signal?: AbortSignal): Promise<RendererTraceResult> {
    const parsed = parseRendererTraceInput(raw), input = { target: { ...parsed.target }, durationMs: parsed.durationMs }
    const verify = () => {
      const current = this.currentTarget()
      if (!current || !sameRendererV8ProfileTarget(current, input.target)) {
        throw new AgentMuxError('The exact Renderer trace target is no longer current. Existing work remains available.', 'CONTROL_OWNER_LOST')
      }
    }
    signal?.throwIfAborted()
    if (this.disposed) throw new AgentMuxError('Renderer trace owner is unavailable.', 'CONTROL_UNAVAILABLE')
    verify()
    const contents = this.contents, debuggerClient = contents.debugger
    if (this.active || contents.isDevToolsOpened() || debuggerClient.isAttached()) {
      throw new AgentMuxError('This Renderer debugger is already owned. Only this trace request was refused; the original owner remains available.', 'CONTROL_UNAVAILABLE')
    }
    const controller = new AbortController(); this.active = controller
    const result: RendererTraceResult = { ...input, schema: 'agentmux.renderer-trace.v1', scope: 'chromium-target-related-timeline', status: 'failed',
      transferMode: 'ReportEvents', traceTimeUnit: 'microseconds', requestedCategories: [...RENDERER_TRACE_CATEGORIES],
      timing: { requestedAt: Date.now(), startedAt: null, endAcknowledgedAt: null, completedAt: null, finishedAt: Date.now(),
        startMonotonicMs: null, endMonotonicMs: null, completeMonotonicMs: null },
      sourceVerified: { before: true, after: false }, lifecycle: { startRequested: false, startAcknowledged: false,
        endRequested: false, endAcknowledged: false, tracingComplete: false, dataLossOccurred: null, detached: 'not-attached' },
      bufferUsage: { observations: 0, maxFraction: null, fullObserved: false }, receivedEvents: 0,
      receivedTraceBytes: Buffer.byteLength('{"traceEvents":[]}'), trace: null, traceBytes: null, sha256: null, issues: [] }
    let owned = false, detaching = false, finished = false, protocolFailure: unknown, protocolFailureStage = 'collect'
    let stage = 'attach', durationTimer: ReturnType<typeof setTimeout> | undefined
    const events: RendererTraceEvent[] = []
    const issue = (at: string, error: unknown) => {
      if (result.issues.length >= 8) return
      const source = error instanceof Error ? error as Error & { code?: string } : null, message = source?.message ?? String(error)
      result.issues.push({ stage: at, code: typeof source?.code === 'string' && source.code.length <= 128 ? source.code : controller.signal.aborted && !protocolFailure ? 'CONTROL_CANCELLED' : 'CONTROL_FAILED',
        message: message.slice(0, 2048), messageTruncated: message.length > 2048 })
    }
    const abort = () => controller.abort(signal?.reason ?? new AgentMuxError('Renderer trace request was cancelled.', 'CONTROL_CANCELLED'))
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
    const cancelled = new Promise<never>((_resolve, reject) => {
      if (controller.signal.aborted) reject(controller.signal.reason)
      else controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
    })
    void cancelled.catch(() => {})
    const wait = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, cancelled])
    let complete!: () => void
    const flushed = new Promise<void>(resolve => { complete = resolve })
    const receive = (_event: unknown, method: string, params: any, sessionId: string) => {
      if (finished || sessionId || !result.lifecycle.startAcknowledged) return
      try {
        if (method === 'Tracing.dataCollected') {
          const batch = parseRendererTraceEvents(params?.value), bytes = Buffer.byteLength(JSON.stringify(batch)) - 2
          result.receivedTraceBytes += bytes + (result.receivedEvents && batch.length ? 1 : 0)
          result.receivedEvents += batch.length
          if (result.receivedTraceBytes > RENDERER_TRACE_MAX_BYTES) {
            throw new AgentMuxError('Original Renderer trace exceeds the 8 MiB result transport budget; no truncated trace was returned.', 'CONTROL_PROTOCOL_ERROR')
          }
          for (const event of batch) events.push(event)
        } else if (method === 'Tracing.bufferUsage') {
          const fraction = params?.percentFull ?? params?.value
          if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) throw new AgentMuxError('Native trace buffer usage is invalid.', 'CONTROL_PROTOCOL_ERROR')
          result.bufferUsage.observations++
          result.bufferUsage.maxFraction = Math.max(result.bufferUsage.maxFraction ?? 0, fraction)
          result.bufferUsage.fullObserved = result.bufferUsage.maxFraction === 1
        } else if (method === 'Tracing.tracingComplete') {
          if (typeof params?.dataLossOccurred !== 'boolean') throw new AgentMuxError('Native trace completion did not state data loss.', 'CONTROL_PROTOCOL_ERROR')
          result.lifecycle.tracingComplete = true; result.lifecycle.dataLossOccurred = params.dataLossOccurred
          result.timing.completedAt = Date.now(); result.timing.completeMonotonicMs = performance.now(); complete()
        }
      } catch (error) { protocolFailure = error; protocolFailureStage = method === 'Tracing.tracingComplete' ? 'flush' : 'collect'; controller.abort(error) }
    }
    const lost = () => { owned = false; if (!detaching) controller.abort(new AgentMuxError('The Renderer trace debugger owner ended.', 'CONTROL_OWNER_LOST')) }
    const changed = () => { try { verify() } catch (error) { controller.abort(error) } }
    const command = (method: string, params?: unknown) => {
      controller.signal.throwIfAborted()
      if (!owned) throw new AgentMuxError('The original trace debugger is no longer owned.', 'CONTROL_OWNER_LOST')
      if (method === 'Tracing.start') result.lifecycle.startRequested = true
      if (method === 'Tracing.end') result.lifecycle.endRequested = true
      return wait(debuggerClient.sendCommand(method, params))
    }
    const deadline = setTimeout(() => controller.abort(new AgentMuxError('Renderer trace exceeded its request observation budget; native completion is unconfirmed.', 'CONTROL_TIMEOUT')),
      agentMuxControlTimeoutMs('metrics.trace.capture'))
    try {
      debuggerClient.attach(); owned = true
      debuggerClient.on('detach', lost); debuggerClient.on('message', receive)
      contents.on('destroyed', changed); contents.on('render-process-gone', changed); contents.on('did-start-navigation', changed)
      verify(); stage = 'start'
      await command('Tracing.start', { transferMode: 'ReportEvents', bufferUsageReportingInterval: 250,
        traceConfig: { recordMode: 'recordUntilFull', includedCategories: [...RENDERER_TRACE_CATEGORIES],
          excludedCategories: ['disabled-by-default-devtools.screenshot', 'disabled-by-default-memory-infra', 'disabled-by-default-v8.cpu_profiler'] } })
      result.lifecycle.startAcknowledged = true; result.timing.startedAt = Date.now(); result.timing.startMonotonicMs = performance.now()
      stage = 'recording'; await wait(new Promise<void>(resolve => { durationTimer = setTimeout(resolve, input.durationMs) }))
      verify(); stage = 'end'
      await command('Tracing.end'); result.lifecycle.endAcknowledged = true
      result.timing.endAcknowledgedAt = Date.now(); result.timing.endMonotonicMs = performance.now()
      stage = 'flush'; await wait(flushed)
      if (result.lifecycle.dataLossOccurred || result.bufferUsage.fullObserved) {
        issue('data-loss', new AgentMuxError('The native trace reported data loss or a full buffer; coverage is incomplete.', 'CONTROL_PROTOCOL_ERROR'))
      }
      stage = 'source'; verify(); controller.signal.throwIfAborted(); result.sourceVerified.after = true
      const trace = { traceEvents: events }, text = rendererTraceJSON(trace)
      result.trace = trace; result.traceBytes = Buffer.byteLength(text); result.sha256 = createHash('sha256').update(text).digest('hex')
      result.status = result.issues.length ? 'failed' : 'completed'
    } catch (error) {
      issue(protocolFailure ? protocolFailureStage : stage, error); result.status = protocolFailure ? 'failed' : controller.signal.aborted ? 'unknown' : 'failed'
    } finally {
      finished = true; clearTimeout(deadline); clearTimeout(durationTimer)
      signal?.removeEventListener('abort', abort)
      contents.removeListener('destroyed', changed); contents.removeListener('render-process-gone', changed); contents.removeListener('did-start-navigation', changed)
      debuggerClient.removeListener('message', receive)
      if (owned && !contents.isDestroyed() && !contents.isDevToolsOpened() && debuggerClient.isAttached()) {
        // A sent or rejected start is not ownership. Never end a foreign recording.
        if (result.lifecycle.startAcknowledged && !result.lifecycle.endRequested) {
          result.lifecycle.endRequested = true
          try { void debuggerClient.sendCommand('Tracing.end').catch(() => {}) } catch (error) { issue('end', error) }
        }
        detaching = true
        try { debuggerClient.detach(); result.lifecycle.detached = debuggerClient.isAttached() ? 'unconfirmed' : 'confirmed' }
        catch (error) { result.lifecycle.detached = 'unconfirmed'; issue('detach', error) }
      } else if (owned || result.lifecycle.startRequested) result.lifecycle.detached = 'owner-lost'
      debuggerClient.removeListener('detach', lost)
      if (result.status === 'completed' && result.lifecycle.detached !== 'confirmed') result.status = 'unknown'
      result.timing.finishedAt = Date.now(); this.active = null
    }
    return parseRendererTraceResult(result, input)
  }
}
