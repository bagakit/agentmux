import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseRendererV8Target, sameRendererV8ProfileTarget, type RendererV8ProfileTarget,
  type RendererV8ProfileIssue } from './renderer-v8-profile.js'

export type RendererCacheInput = { target: RendererV8ProfileTarget }
export type RendererCacheAction = 'inspect' | 'reclaim'
export const RENDERER_CACHE_CATEGORIES = ['images', 'scripts', 'cssStyleSheets', 'xslStyleSheets', 'fonts', 'other'] as const
/** Resource-accounted bytes, not process RSS or a prediction of reclaimable memory. */
export type RendererCacheUsage = Record<typeof RENDERER_CACHE_CATEGORIES[number], {
  count: number | null
  sizeBytes: number | null
  /** Electron's native liveSize field is Blink decoded_size, not live/unused memory. */
  decodedBytes: number | null
} | null>
export type RendererCacheSnapshot = { sampledAt: number; usage: RendererCacheUsage }
export type RendererCacheResult = RendererCacheInput & {
  schema: 'agentmux.renderer-cache.v1'
  scope: 'renderer-process-platform-cache'
  units: 'bytes'
  action: RendererCacheAction
  status: 'completed' | 'failed' | 'unknown'
  timing: { requestedAt: number; finishedAt: number }
  sourceVerified: { before: boolean; after: boolean }
  /** requested is the explicit request, not proof of execution; completed is a native return. */
  clear: { requested: boolean; completed: boolean }
  before: RendererCacheSnapshot | null
  after: RendererCacheSnapshot | null
  issues: RendererV8ProfileIssue[]
}
function invalid(code: string): never { throw new AgentMuxError('Renderer cache receipt is invalid.', code) }
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
function fields(value: unknown, keys: readonly string[], code: string) {
  const r = rpcRecord(value, [...keys], code)
  if (Object.keys(r).length !== keys.length) invalid(code)
  return r
}
export function parseRendererCacheInput(value: unknown, code = 'INVALID_CONTROL_REQUEST'): RendererCacheInput {
  const r = fields(value, ['target'], code)
  parseRendererV8Target(r.target, code)
  return r as RendererCacheInput
}
export function parseRendererCacheSnapshot(value: unknown): RendererCacheSnapshot {
  const code = 'CONTROL_PROTOCOL_ERROR', r = fields(value, ['sampledAt', 'usage'], code)
  if (!number(r.sampledAt)) invalid(code)
  const usage = fields(r.usage, RENDERER_CACHE_CATEGORIES, code)
  for (const category of RENDERER_CACHE_CATEGORIES) {
    if (usage[category] === null) continue
    const item = fields(usage[category], ['count', 'sizeBytes', 'decodedBytes'], code)
    for (const key of ['count', 'sizeBytes', 'decodedBytes']) if (item[key] !== null && (!number(item[key]) || !Number.isSafeInteger(item[key]))) invalid(code)
  }
  return r as RendererCacheSnapshot
}
export function parseRendererCacheResult(value: unknown, input?: RendererCacheInput, action?: RendererCacheAction): RendererCacheResult {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const r = fields(value, ['target', 'schema', 'scope', 'units', 'action', 'status', 'timing', 'sourceVerified', 'clear', 'before', 'after', 'issues'], code)
  const target = parseRendererV8Target(r.target, code)
  if (input && !sameRendererV8ProfileTarget(target, input.target) || r.schema !== 'agentmux.renderer-cache.v1' ||
    r.scope !== 'renderer-process-platform-cache' || r.units !== 'bytes' || (r.action !== 'inspect' && r.action !== 'reclaim') ||
    action !== undefined && r.action !== action || (r.status !== 'completed' && r.status !== 'failed' && r.status !== 'unknown')) invalid(code)
  const timing = fields(r.timing, ['requestedAt', 'finishedAt'], code)
  if (!number(timing.requestedAt) || !number(timing.finishedAt)) invalid(code)
  const source = fields(r.sourceVerified, ['before', 'after'], code), clear = fields(r.clear, ['requested', 'completed'], code)
  if (typeof source.before !== 'boolean' || typeof source.after !== 'boolean' || typeof clear.requested !== 'boolean' ||
    typeof clear.completed !== 'boolean' || clear.completed && !clear.requested) invalid(code)
  for (const key of ['before', 'after']) if (r[key] !== null) parseRendererCacheSnapshot(r[key])
  if (r.action === 'inspect' && (clear.requested || clear.completed || r.after !== null)) invalid(code)
  if (!Array.isArray(r.issues) || Object.getPrototypeOf(r.issues) !== Array.prototype || r.issues.length > 8 ||
    Reflect.ownKeys(r.issues).length !== r.issues.length + 1) invalid(code)
  for (let n = 0; n < r.issues.length; n++) {
    const d = Object.getOwnPropertyDescriptor(r.issues, String(n))
    if (!d?.enumerable || !('value' in d)) invalid(code)
    const issue = fields(d.value, ['stage', 'code', 'message', 'messageTruncated'], code)
    if (typeof issue.stage !== 'string' || issue.stage.length > 80 || typeof issue.code !== 'string' || issue.code.length > 128 ||
      typeof issue.message !== 'string' || issue.message.length > 2048 || typeof issue.messageTruncated !== 'boolean') invalid(code)
  }
  if (r.status === 'completed' && (!source.before || !source.after || (r.action === 'inspect' ? r.before === null : !clear.completed))) invalid(code)
  if (r.status !== 'completed' && !r.issues.length) invalid(code)
  return r as RendererCacheResult
}
