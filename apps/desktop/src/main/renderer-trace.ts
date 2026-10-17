import type { WebContents } from 'electron'
import { AgentMuxError } from '@agentmux/core'
import { scanRendererTraceBytes } from '@agentmux/core/renderer-trace-bytes'
import { agentMuxControlTimeoutMs, parseRendererTraceInput, parseRendererTraceResult,
  sameRendererV8ProfileTarget, RENDERER_TRACE_MAX_GZIP_BYTES, RENDERER_TRACE_CATEGORIES,
  type RendererTraceInput, type RendererTraceResult, type RendererV8ProfileTarget } from '@agentmux/core/control'

const READ_BYTES = 64 * 1024
const CLEANUP_MS = 500
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
    const result: RendererTraceResult = { ...input, schema: 'agentmux.renderer-trace.v2', scope: 'chromium-target-related-timeline', status: 'failed',
      transferMode: 'ReturnAsStream', streamFormat: 'json', streamCompression: 'gzip', traceTimeUnit: 'microseconds', requestedCategories: [...RENDERER_TRACE_CATEGORIES],
      timing: { requestedAt: Date.now(), startedAt: null, endAcknowledgedAt: null, completedAt: null, finishedAt: Date.now(),
        startMonotonicMs: null, endMonotonicMs: null, completeMonotonicMs: null },
      sourceVerified: { before: true, after: false }, lifecycle: { startRequested: false, startAcknowledged: false,
        endRequested: false, endAcknowledged: false, tracingComplete: false, dataLossOccurred: null, detached: 'not-attached' },
      stream: { handleReceived: false, eof: false, closeRequested: false, closeAcknowledged: false },
      bufferUsage: { observations: 0, maxFraction: null, fullObserved: false }, receivedEvents: 0,
      receivedTraceBytes: 0, receivedGzipBytes: 0, trace: null, traceBytes: null, sha256: null, issues: [] }
    let owned = false, detaching = false, finished = false, completionSeen = false, handle: string | null = null, protocolFailure: unknown
    let stage = 'attach', durationTimer: ReturnType<typeof setTimeout> | undefined
    const issue = (at: string, error: unknown) => {
      if (result.issues.length >= 8) return
      const source = error instanceof Error ? error as Error & { code?: string } : null, message = source?.message ?? String(error)
      result.issues.push({ stage: at, code: typeof source?.code === 'string' && source.code.length <= 128 ? source.code : controller.signal.aborted && !protocolFailure ? 'CONTROL_CANCELLED' : 'CONTROL_FAILED',
        message: message.slice(0, 2048), messageTruncated: message.length > 2048 })
    }
    const invalid = (message: string): never => { throw new AgentMuxError(message, 'CONTROL_PROTOCOL_ERROR') }
    const abort = () => controller.abort(signal?.reason ?? new AgentMuxError('Renderer trace request was cancelled.', 'CONTROL_CANCELLED'))
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
    const cancelled = new Promise<never>((_resolve, reject) => {
      if (controller.signal.aborted) reject(controller.signal.reason)
      else controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
    })
    void cancelled.catch(() => {})
    const wait = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, cancelled])
    const canCommand = () => owned && !contents.isDestroyed() && !contents.isDevToolsOpened() && debuggerClient.isAttached()
    const current = () => { controller.signal.throwIfAborted(); verify(); if (!canCommand()) throw new AgentMuxError('The original trace debugger is no longer owned.', 'CONTROL_OWNER_LOST') }
    let complete!: () => void
    const flushed = new Promise<void>(resolve => { complete = resolve })
    const receive = (_event: unknown, method: string, params: any, sessionId: string) => {
      if (finished || sessionId || !result.lifecycle.startAcknowledged || !owned) return
      try {
        if (method === 'Tracing.bufferUsage') {
          const fraction = params?.percentFull ?? params?.value
          if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) invalid('Native trace buffer usage is invalid.')
          result.bufferUsage.observations++
          result.bufferUsage.maxFraction = Math.max(result.bufferUsage.maxFraction ?? 0, fraction)
          result.bufferUsage.fullObserved = result.bufferUsage.maxFraction === 1
        } else if (method === 'Tracing.tracingComplete' && result.lifecycle.endRequested && !completionSeen) {
          completionSeen = true
          // Keep the original handle for cleanup even when other completion fields are malformed.
          if (typeof params?.stream === 'string' && params.stream) { handle = params.stream; result.stream.handleReceived = true }
          if (typeof params?.dataLossOccurred !== 'boolean') invalid('Native trace completion did not state data loss.')
          if (handle === null) invalid('Native trace completion did not provide its stream handle.')
          if (params.traceFormat !== 'json' || params.streamCompression !== 'gzip') invalid('Native trace stream did not confirm json/gzip; no alternate transfer was attempted.')
          result.lifecycle.tracingComplete = true; result.lifecycle.dataLossOccurred = params.dataLossOccurred
          result.timing.completedAt = Date.now(); result.timing.completeMonotonicMs = performance.now(); complete()
        }
      } catch (error) { protocolFailure = error; controller.abort(error) }
    }
    const lost = () => { owned = false; if (!detaching) controller.abort(new AgentMuxError('The Renderer trace debugger owner ended.', 'CONTROL_OWNER_LOST')) }
    const changed = () => { try { verify() } catch (error) { controller.abort(error) } }
    const command = (method: string, params?: unknown) => {
      current()
      if (method === 'Tracing.start') result.lifecycle.startRequested = true
      if (method === 'Tracing.end') result.lifecycle.endRequested = true
      return wait(debuggerClient.sendCommand(method, params))
    }
    // Cleanup is independent of the cancelled observation, but remains bounded and owner-bound.
    const cleanupWait = async (operation: Promise<unknown>) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AgentMuxError('Original trace cleanup acknowledgement is unconfirmed.', 'CONTROL_TIMEOUT')), CLEANUP_MS) })]) }
      finally { clearTimeout(timer) }
    }
    let closing: Promise<unknown> | undefined
    const closeStream = async (observe: (operation: Promise<unknown>) => Promise<unknown>) => {
      if (handle === null || result.stream.closeAcknowledged || !canCommand()) return
      if (!result.stream.closeRequested) {
        result.stream.closeRequested = true
        try { closing = debuggerClient.sendCommand('IO.close', { handle }) }
        catch (error) { closing = Promise.reject(error) }
      }
      await observe(closing!)
      if (!canCommand()) throw new AgentMuxError('Original trace owner changed before stream close acknowledgement.', 'CONTROL_OWNER_LOST')
      result.stream.closeAcknowledged = true
    }
    const deadline = setTimeout(() => controller.abort(new AgentMuxError('Renderer trace exceeded its request observation budget; native completion is unconfirmed.', 'CONTROL_TIMEOUT')),
      agentMuxControlTimeoutMs('metrics.trace.capture'))
    try {
      debuggerClient.attach(); owned = true
      debuggerClient.on('detach', lost); debuggerClient.on('message', receive)
      contents.on('destroyed', changed); contents.on('render-process-gone', changed); contents.on('did-start-navigation', changed)
      verify(); stage = 'start'
      await command('Tracing.start', { transferMode: 'ReturnAsStream', streamFormat: 'json', streamCompression: 'gzip', bufferUsageReportingInterval: 250,
        traceConfig: { recordMode: 'recordUntilFull', includedCategories: [...RENDERER_TRACE_CATEGORIES],
          excludedCategories: ['disabled-by-default-devtools.screenshot', 'disabled-by-default-memory-infra', 'disabled-by-default-v8.cpu_profiler'] } })
      result.lifecycle.startAcknowledged = true; result.timing.startedAt = Date.now(); result.timing.startMonotonicMs = performance.now()
      stage = 'recording'; await wait(new Promise<void>(resolve => { durationTimer = setTimeout(resolve, input.durationMs) }))
      stage = 'end'; await command('Tracing.end'); result.lifecycle.endAcknowledged = true
      result.timing.endAcknowledgedAt = Date.now(); result.timing.endMonotonicMs = performance.now()
      stage = 'flush'; await wait(flushed); current()
      stage = 'read'
      const chunks: Buffer[] = []
      async function* bytes(): AsyncGenerator<Uint8Array> {
        while (!result.stream.eof) {
          const reply = await command('IO.read', { handle, size: READ_BYTES }); current()
          if (!reply || typeof reply !== 'object') invalid('Native trace stream read is invalid.')
          const r = reply as { data?: unknown; eof?: unknown; base64Encoded?: unknown }
          if (typeof r.data !== 'string' || typeof r.eof !== 'boolean' || r.base64Encoded !== undefined && typeof r.base64Encoded !== 'boolean') invalid('Native trace stream read has invalid byte or EOF facts.')
          result.stream.eof = r.eof as boolean
          const data = r.data as string, chunk = Buffer.from(data, r.base64Encoded ? 'base64' : 'utf8')
          if (chunk.toString(r.base64Encoded ? 'base64' : 'utf8') !== data) invalid('Native trace stream bytes cannot be represented exactly.')
          result.receivedGzipBytes += chunk.length
          if (chunk.length > READ_BYTES || result.receivedGzipBytes > RENDERER_TRACE_MAX_GZIP_BYTES) invalid('Original gzip trace exceeds its bounded read or encoded-result budget; it was not truncated.')
          chunks.push(chunk)
          // The EOF reply can contain the final bytes. Empty non-EOF replies never imply completion.
          yield chunk
        }
      }
      const scanned = await scanRendererTraceBytes(bytes(), { signal: controller.signal,
        onProgress: facts => { result.receivedTraceBytes = facts.rawBytes; result.receivedEvents = facts.events } })
      current(); stage = 'close'; await closeStream(wait); current()
      stage = 'source'; result.sourceVerified.after = true
      result.traceBytes = scanned.rawBytes; result.sha256 = scanned.rawSha256
      result.trace = { encoding: 'base64', data: Buffer.concat(chunks).toString('base64'), bytes: scanned.gzipBytes, sha256: scanned.gzipSha256 }
      result.status = result.issues.length ? 'failed' : 'completed'
    } catch (error) {
      issue(stage, protocolFailure ?? error); result.status = protocolFailure ? 'failed' : controller.signal.aborted ? 'unknown' : 'failed'
    } finally {
      clearTimeout(deadline); clearTimeout(durationTimer)
      signal?.removeEventListener('abort', abort)
      contents.removeListener('destroyed', changed); contents.removeListener('render-process-gone', changed); contents.removeListener('did-start-navigation', changed)
      if (canCommand()) {
        if (result.lifecycle.startAcknowledged && !result.lifecycle.endRequested) {
          result.lifecycle.endRequested = true
          try {
            await cleanupWait(debuggerClient.sendCommand('Tracing.end'))
            if (canCommand()) { result.lifecycle.endAcknowledged = true; result.timing.endAcknowledgedAt = Date.now(); result.timing.endMonotonicMs = performance.now() }
          } catch (error) { issue('end', error) }
        }
        // A late original completion may supply its handle during cleanup; never close a foreign handle.
        if (result.lifecycle.endRequested && !completionSeen && handle === null) {
          try { await cleanupWait(flushed) } catch (error) { issue('flush-cleanup', error) }
        }
        try { await closeStream(cleanupWait) } catch (error) { issue('close', error) }
        if (canCommand()) {
          detaching = true
          try { debuggerClient.detach(); result.lifecycle.detached = debuggerClient.isAttached() ? 'unconfirmed' : 'confirmed' }
          catch (error) { result.lifecycle.detached = 'unconfirmed'; issue('detach', error) }
        } else result.lifecycle.detached = 'owner-lost'
      } else if (owned || result.lifecycle.startRequested) result.lifecycle.detached = 'owner-lost'
      finished = true
      debuggerClient.removeListener('message', receive); debuggerClient.removeListener('detach', lost)
      // Consume the last native buffer fact, including any event delivered while IO.close was pending.
      if (result.lifecycle.dataLossOccurred || result.bufferUsage.fullObserved) {
        issue('data-loss', new AgentMuxError('The native trace reported data loss or a full buffer; coverage is incomplete.', 'CONTROL_PROTOCOL_ERROR'))
        if (result.status === 'completed') result.status = 'failed'
      }
      if (result.status === 'completed' && (result.lifecycle.detached !== 'confirmed' || !result.stream.closeAcknowledged || result.issues.length)) result.status = 'unknown'
      result.timing.finishedAt = Date.now(); this.active = null
    }
    return parseRendererTraceResult(result, input)
  }
}
