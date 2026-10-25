import { webFrame } from 'electron'
import { AgentMuxError, RENDERER_CACHE_CATEGORIES, parseRendererCacheInput, parseRendererCacheResult, parseRendererCacheSnapshot,
  type RendererCacheInput, type RendererCacheAction, type RendererCacheResult, type RendererCacheSnapshot } from '@agentmux/core/control'

/** Explicit synchronous native operation in the original sandboxed preload. No lifecycle or polling. */
export function executeRendererCache(raw: RendererCacheInput, action: RendererCacheAction): RendererCacheResult {
  const input = { target: { ...parseRendererCacheInput(raw).target } }
  if (action !== 'inspect' && action !== 'reclaim') throw new AgentMuxError('Unknown Renderer cache action.', 'INVALID_CONTROL_REQUEST')
  const verify = () => {
    if (process.pid !== input.target.pid || process.getCreationTime() !== input.target.creationTime)
      throw new AgentMuxError('The original Renderer process is no longer this cache target. Existing work is retained.', 'CONTROL_OWNER_LOST')
  }
  verify()
  const result: RendererCacheResult = { ...input, schema: 'agentmux.renderer-cache.v1', scope: 'renderer-process-platform-cache', units: 'bytes',
    action, status: 'failed', timing: { requestedAt: Date.now(), finishedAt: Date.now() }, sourceVerified: { before: true, after: false },
    clear: { requested: false, completed: false }, before: null, after: null, issues: [] }
  const issue = (stage: string, error: unknown) => {
    const cause = error instanceof Error ? error as Error & { code?: string } : null, message = cause?.message ?? String(error)
    result.issues.push({ stage, code: cause?.code ?? 'CONTROL_FAILED', message: message.slice(0, 2048), messageTruncated: message.length > 2048 })
  }
  const read = (stage: string): RendererCacheSnapshot | null => {
    try {
      const original = webFrame.getResourceUsage(), sampledAt = Date.now()
      const usage = Object.fromEntries(RENDERER_CACHE_CATEGORIES.map(category => {
        const value = original[category]
        return [category, value ? { count: value.count ?? null, sizeBytes: value.size ?? null, decodedBytes: value.liveSize ?? null } : null]
      }))
      return parseRendererCacheSnapshot({ sampledAt, usage })
    } catch (error) { issue(stage, error); return null }
  }
  result.before = read('before-counters')
  if (action === 'reclaim') {
    // Counter availability is not permission to remove the user's existing cleanup capability.
    result.clear.requested = true
    try { verify(); webFrame.clearCache(); result.clear.completed = true; result.status = 'completed' }
    catch (error) { result.status = 'unknown'; issue('clear', error) }
    result.after = read('after-counters')
  } else result.status = result.before ? 'completed' : 'failed'
  try { verify(); result.sourceVerified.after = true }
  catch (error) { result.status = 'unknown'; issue('source', error) }
  result.timing.finishedAt = Date.now()
  return parseRendererCacheResult(result, input, action)
}
