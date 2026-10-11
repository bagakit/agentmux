import type { WebContents } from 'electron'
import { AgentMuxError, agentMuxControlTimeoutMs, parseRendererMemoryInput, parseRendererMemoryResult, parseRendererHeapUsage,
  sameRendererV8ProfileTarget, type RendererMemoryInput, type RendererMemoryResult,
  type RendererV8ProfileTarget } from '@agentmux/core/control'

/** One explicit counter read; no Runtime.enable, evaluation, object enumeration or GC command. */
export class RendererMemoryInspector {
  private active: AbortController | null = null
  private disposed = false
  constructor(private readonly contents: WebContents, private readonly currentTarget: () => RendererV8ProfileTarget | null) {}
  dispose(): void {
    this.disposed = true
    this.active?.abort(new AgentMuxError('Renderer memory owner ended.', 'CONTROL_OWNER_LOST'))
  }
  async inspect(raw: RendererMemoryInput, signal?: AbortSignal): Promise<RendererMemoryResult> {
    const input = { target: { ...parseRendererMemoryInput(raw).target } }
    const verify = () => {
      const current = this.currentTarget()
      if (!current || !sameRendererV8ProfileTarget(current, input.target))
        throw new AgentMuxError('The exact Renderer memory target is no longer current. Existing work remains available.', 'CONTROL_OWNER_LOST')
    }
    signal?.throwIfAborted()
    if (this.disposed) throw new AgentMuxError('Renderer memory owner is unavailable.', 'CONTROL_UNAVAILABLE')
    verify()
    const contents = this.contents, client = contents.debugger
    if (this.active || contents.isDevToolsOpened() || client.isAttached())
      throw new AgentMuxError('This Renderer debugger is already owned. Only this memory query was refused; the original owner remains available.', 'CONTROL_UNAVAILABLE')
    const controller = new AbortController()
    this.active = controller
    const result: RendererMemoryResult = { ...input, schema: 'agentmux.renderer-memory.v1', scope: 'renderer-v8-isolate', units: 'bytes',
      status: 'failed', timing: { requestedAt: Date.now(), sampledAt: null, finishedAt: Date.now() },
      sourceVerified: { before: true, after: false }, usage: null, cleanup: { detached: 'not-attached' }, issues: [] }
    let owned = false, detaching = false, stage = 'attach'
    const issue = (at: string, error: unknown) => {
      const cause = error instanceof Error ? error as Error & { code?: string } : null
      const message = cause?.message ?? String(error)
      result.issues.push({ stage: at, code: typeof cause?.code === 'string' && cause.code.length <= 128 ? cause.code :
        controller.signal.aborted ? 'CONTROL_CANCELLED' : 'CONTROL_FAILED', message: message.slice(0, 2048), messageTruncated: message.length > 2048 })
    }
    const abort = () => controller.abort(signal?.reason ?? new AgentMuxError('Renderer memory query was cancelled.', 'CONTROL_CANCELLED'))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const cancelled = new Promise<never>((_resolve, reject) => {
      if (controller.signal.aborted) reject(controller.signal.reason)
      else controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
    })
    void cancelled.catch(() => {})
    const lost = () => {
      owned = false
      if (!detaching) controller.abort(new AgentMuxError('The original memory debugger owner ended.', 'CONTROL_OWNER_LOST'))
    }
    const changed = () => { try { verify() } catch (error) { controller.abort(error) } }
    const deadline = setTimeout(() => controller.abort(new AgentMuxError('Renderer memory reply exceeded its observation budget; native completion is unconfirmed.', 'CONTROL_TIMEOUT')),
      agentMuxControlTimeoutMs('metrics.memory.inspect'))
    try {
      client.attach(); owned = true
      client.on('detach', lost)
      contents.on('destroyed', changed); contents.on('render-process-gone', changed); contents.on('did-start-navigation', changed)
      verify(); controller.signal.throwIfAborted()
      stage = 'read'
      const usage = await Promise.race([client.sendCommand('Runtime.getHeapUsage'), cancelled])
      result.timing.sampledAt = Date.now()
      stage = 'decode'
      result.usage = parseRendererHeapUsage({ usedSize: usage.usedSize, totalSize: usage.totalSize,
        embedderHeapUsedSize: usage.embedderHeapUsedSize ?? null, backingStorageSize: usage.backingStorageSize ?? null })
      stage = 'source'; verify(); controller.signal.throwIfAborted()
      result.sourceVerified.after = true; result.status = 'completed'
    } catch (error) {
      issue(stage, error)
      result.status = controller.signal.aborted || stage === 'source' ? 'unknown' : 'failed'
    } finally {
      clearTimeout(deadline)
      signal?.removeEventListener('abort', abort)
      contents.removeListener('destroyed', changed); contents.removeListener('render-process-gone', changed); contents.removeListener('did-start-navigation', changed)
      if (owned && !contents.isDestroyed() && !contents.isDevToolsOpened() && client.isAttached()) {
        detaching = true
        try { client.detach(); result.cleanup.detached = client.isAttached() ? 'unconfirmed' : 'confirmed' }
        catch (error) { result.cleanup.detached = 'unconfirmed'; issue('detach', error) }
      } else if (owned || controller.signal.aborted) result.cleanup.detached = 'owner-lost'
      client.removeListener('detach', lost)
      if (result.status === 'completed' && result.cleanup.detached !== 'confirmed') {
        result.status = 'unknown'
        issue('detach', new AgentMuxError('Memory data was returned, but release of the original debugger is unconfirmed.', 'CONTROL_UNAVAILABLE'))
      }
      result.timing.finishedAt = Date.now(); this.active = null
    }
    return parseRendererMemoryResult(result, input)
  }
}
