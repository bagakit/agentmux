import type { WebContents } from 'electron'
import { createHash } from 'node:crypto'
import { AgentMuxError } from '@agentmux/core'
import { agentMuxControlTimeoutMs, parseRendererV8ProfileInput, parseRendererV8ProfileResult,
  v8ProfileJSON, sameRendererV8ProfileTarget,
  type RendererV8ProfileInput, type RendererV8ProfileResult, type RendererV8ProfileTarget } from '@agentmux/core/control'

/** A single explicit capture on this App Renderer; never borrows another debugger owner. */
export class RendererV8Profiler {
  private active: AbortController | null = null
  private disposed = false
  constructor(private readonly contents: WebContents, private readonly currentTarget: () => RendererV8ProfileTarget | null) {}

  dispose(): void {
    this.disposed = true
    this.active?.abort(new AgentMuxError('Renderer profile owner ended.', 'CONTROL_OWNER_LOST'))
  }

  async capture(raw: RendererV8ProfileInput, signal?: AbortSignal): Promise<RendererV8ProfileResult> {
    const parsed = parseRendererV8ProfileInput(raw)
    const input = { target: { ...parsed.target }, durationMs: parsed.durationMs }
    const verify = () => {
      const current = this.currentTarget()
      if (!current || !sameRendererV8ProfileTarget(current, input.target)) {
        throw new AgentMuxError('The exact Renderer profile target is no longer current. Existing work remains available.', 'CONTROL_OWNER_LOST')
      }
    }
    signal?.throwIfAborted()
    if (this.disposed) throw new AgentMuxError('Renderer profile owner is unavailable.', 'CONTROL_UNAVAILABLE')
    verify()
    const contents = this.contents, debuggerClient = contents.debugger
    if (this.active || contents.isDevToolsOpened() || debuggerClient.isAttached()) {
      throw new AgentMuxError('This Renderer debugger is already owned. Only this profile request was refused; the original owner remains available.', 'CONTROL_UNAVAILABLE')
    }
    const controller = new AbortController()
    this.active = controller
    const result: RendererV8ProfileResult = {
      ...input, schema: 'agentmux.renderer-v8-profile.v1', scope: 'renderer-main-thread-v8', status: 'failed',
      timing: { requestedAt: Date.now(), startedAt: null, stoppedAt: null, finishedAt: Date.now(), startMonotonicMs: null, stopMonotonicMs: null },
      profilerTimeUnit: 'microseconds', sourceVerified: { before: true, after: false },
      cleanup: { stopRequested: false, stopAcknowledged: false, disableAcknowledged: false, detached: 'not-attached' },
      profile: null, profileBytes: null, sha256: null, issues: []
    }
    let owned = false, detaching = false, enableSent = false, startSent = false, disableSent = false
    let stage = 'attach', durationTimer: ReturnType<typeof setTimeout> | undefined
    const issue = (at: string, error: unknown) => {
      const source = error instanceof Error ? error as Error & { code?: string } : null
      const message = source?.message ?? String(error)
      result.issues.push({ stage: at, code: typeof source?.code === 'string' && source.code.length <= 128 ? source.code : controller.signal.aborted ? 'CONTROL_CANCELLED' : 'CONTROL_FAILED', message: message.slice(0, 2048), messageTruncated: message.length > 2048 })
    }
    const abort = () => controller.abort(signal?.reason ?? new AgentMuxError('Renderer profile request was cancelled.', 'CONTROL_CANCELLED'))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const cancelled = new Promise<never>((_resolve, reject) => {
      if (controller.signal.aborted) reject(controller.signal.reason)
      else controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
    })
    void cancelled.catch(() => {})
    const wait = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, cancelled])
    const lost = () => {
      owned = false
      if (!detaching) controller.abort(new AgentMuxError('The Renderer debugger owner ended during this profile.', 'CONTROL_OWNER_LOST'))
    }
    const changed = () => {
      try { verify() } catch (error) { controller.abort(error) }
    }
    const command = (method: string) => {
      controller.signal.throwIfAborted()
      if (!owned) throw new AgentMuxError('The original profile debugger is no longer owned.', 'CONTROL_OWNER_LOST')
      return wait(debuggerClient.sendCommand(method))
    }
    const deadline = setTimeout(() => controller.abort(new AgentMuxError('Renderer profile reply exceeded its request observation budget; native completion is unconfirmed.', 'CONTROL_TIMEOUT')),
      agentMuxControlTimeoutMs('metrics.profile.capture'))
    try {
      // attach is synchronous; no asynchronous gap may acquire another owner's debugger.
      debuggerClient.attach()
      owned = true
      debuggerClient.on('detach', lost)
      contents.on('destroyed', changed)
      contents.on('render-process-gone', changed)
      contents.on('did-start-navigation', changed)
      verify()
      stage = 'enable'; enableSent = true; await command('Profiler.enable')
      stage = 'start'; startSent = true; await command('Profiler.start')
      result.timing.startedAt = Date.now(); result.timing.startMonotonicMs = performance.now()
      stage = 'recording'
      await wait(new Promise<void>(resolve => { durationTimer = setTimeout(resolve, input.durationMs) }))
      verify()
      stage = 'stop'; result.cleanup.stopRequested = true
      const stopped = await command('Profiler.stop')
      result.cleanup.stopAcknowledged = true
      result.timing.stoppedAt = Date.now(); result.timing.stopMonotonicMs = performance.now()
      stage = 'profile'
      result.profileBytes = Buffer.byteLength(JSON.stringify(stopped.profile))
      const text = v8ProfileJSON(stopped.profile)
      result.profile = stopped.profile; result.sha256 = createHash('sha256').update(text).digest('hex')
      stage = 'disable'; disableSent = true; await command('Profiler.disable')
      result.cleanup.disableAcknowledged = true
      stage = 'source'; verify(); controller.signal.throwIfAborted(); result.sourceVerified.after = true
      result.status = 'completed'
    } catch (error) {
      issue(stage, error)
      result.status = controller.signal.aborted || stage === 'source' ? 'unknown' : 'failed'
    } finally {
      clearTimeout(deadline); clearTimeout(durationTimer)
      signal?.removeEventListener('abort', abort)
      contents.removeListener('destroyed', changed)
      contents.removeListener('render-process-gone', changed)
      contents.removeListener('did-start-navigation', changed)
      // An aborted command has no cancellation ACK. Request cleanup once, then detach our
      // own session without waiting on that command; late replies never mutate this result.
      if (owned && !contents.isDestroyed() && !contents.isDevToolsOpened() && debuggerClient.isAttached()) {
        if (startSent && !result.cleanup.stopRequested) {
          result.cleanup.stopRequested = true
          try { void debuggerClient.sendCommand('Profiler.stop').catch(() => {}) } catch (error) { issue('stop', error) }
        }
        if (enableSent && !disableSent) {
          try { void debuggerClient.sendCommand('Profiler.disable').catch(() => {}) } catch (error) { issue('disable', error) }
        }
        detaching = true
        try {
          debuggerClient.detach()
          result.cleanup.detached = debuggerClient.isAttached() ? 'unconfirmed' : 'confirmed'
        } catch (error) { result.cleanup.detached = 'unconfirmed'; issue('detach', error) }
      } else if (owned || startSent) result.cleanup.detached = 'owner-lost'
      debuggerClient.removeListener('detach', lost)
      if (result.status === 'completed' && result.cleanup.detached !== 'confirmed') {
        result.status = 'unknown'
        issue('detach', new AgentMuxError('Profile data was returned, but release of the original debugger is unconfirmed.', 'CONTROL_UNAVAILABLE'))
      }
      result.timing.finishedAt = Date.now()
      this.active = null
    }
    return parseRendererV8ProfileResult(result, input)
  }
}
