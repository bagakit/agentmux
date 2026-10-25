import { mintObjectId } from '@agentmux/core/object-id'
import { AgentMuxError, AGENTMUX_CONTROL_SCHEMA_VERSION, parseRendererCacheInput, parseRendererCacheResult, sameRendererV8ProfileTarget,
  type RendererCacheAction, type RendererCacheInput, type RendererCacheResult, type RendererV8ProfileTarget } from '@agentmux/core/control'
import type { DesktopControlIpcBridge } from './control-ipc-bridge.js'

/** The original metrics owner routes one explicit request to its exact Renderer process. */
export class RendererCacheController {
  private disposed = false
  constructor(private readonly bridge: DesktopControlIpcBridge, private readonly currentTarget: () => RendererV8ProfileTarget | null) {}
  dispose(): void { this.disposed = true }
  inspect = (input: RendererCacheInput, signal?: AbortSignal) => this.execute(input, 'inspect', signal)
  reclaim = (input: RendererCacheInput, signal?: AbortSignal) => this.execute(input, 'reclaim', signal)
  private async execute(raw: RendererCacheInput, action: RendererCacheAction, signal?: AbortSignal): Promise<RendererCacheResult> {
    const input = { target: { ...parseRendererCacheInput(raw).target } }
    const verify = () => {
      const current = this.currentTarget()
      if (this.disposed || !current || !sameRendererV8ProfileTarget(current, input.target))
        throw new AgentMuxError('The exact Renderer cache target is no longer current. Existing work remains available.', 'CONTROL_OWNER_LOST')
    }
    signal?.throwIfAborted(); verify()
    let result: RendererCacheResult = { ...input, schema: 'agentmux.renderer-cache.v1', scope: 'renderer-process-platform-cache', units: 'bytes',
      action, status: 'unknown', timing: { requestedAt: Date.now(), finishedAt: Date.now() }, sourceVerified: { before: true, after: false },
      clear: { requested: action === 'reclaim', completed: false }, before: null, after: null, issues: [] }
    try {
      const operation = action === 'inspect' ? 'metrics.cache.inspect' : 'metrics.cache.reclaim'
      const response = await this.bridge.execute({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, operation, requestId: mintObjectId(), ...input }, signal)
      if (response.operation !== operation) throw new AgentMuxError('The Renderer cache reply belongs to a different operation.', 'CONTROL_PROTOCOL_ERROR')
      result = structuredClone(parseRendererCacheResult(response.observation, input, action))
      verify(); signal?.throwIfAborted()
    } catch (error) {
      const cause = error instanceof Error ? error as Error & { code?: string } : null, message = cause?.message ?? String(error)
      result.status = 'unknown'; result.sourceVerified.after = false
      result.issues.push({ stage: 'dispatch-or-source', code: cause?.code ?? 'CONTROL_UNAVAILABLE', message: message.slice(0, 2048), messageTruncated: message.length > 2048 })
    }
    result.timing.finishedAt = Date.now()
    return parseRendererCacheResult(result, input, action)
  }
}
