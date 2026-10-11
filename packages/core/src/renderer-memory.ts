import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseRendererV8Target, sameRendererV8ProfileTarget, type RendererV8ProfileTarget,
  type RendererV8ProfileIssue } from './renderer-v8-profile.js'

export type RendererMemoryInput = { target: RendererV8ProfileTarget }
/** Original Runtime.getHeapUsage fields in bytes. These are not an exclusive RSS breakdown. */
export type RendererHeapUsage = {
  usedSize: number; totalSize: number
  embedderHeapUsedSize: number | null
  /** Native external/backing accounting includes ArrayBuffers and external strings. */
  backingStorageSize: number | null
}
export type RendererMemoryResult = RendererMemoryInput & {
  schema: 'agentmux.renderer-memory.v1'; scope: 'renderer-v8-isolate'; units: 'bytes'
  status: 'completed' | 'failed' | 'unknown'
  timing: { requestedAt: number; sampledAt: number | null; finishedAt: number }
  sourceVerified: { before: boolean; after: boolean }
  usage: RendererHeapUsage | null
  cleanup: { detached: 'not-attached' | 'confirmed' | 'unconfirmed' | 'owner-lost' }
  issues: RendererV8ProfileIssue[]
}
function invalid(code: string): never { throw new AgentMuxError('Renderer memory observation is invalid.', code) }
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
function fields(v: unknown, keys: string[], code: string) {
  const r = rpcRecord(v, keys, code)
  if (Object.keys(r).length !== keys.length) invalid(code)
  return r
}
export function parseRendererMemoryInput(value: unknown, code = 'INVALID_CONTROL_REQUEST'): RendererMemoryInput {
  const r = fields(value, ['target'], code)
  parseRendererV8Target(r.target, code)
  return r as RendererMemoryInput
}
export function parseRendererHeapUsage(value: unknown): RendererHeapUsage {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const r = fields(value, ['usedSize', 'totalSize', 'embedderHeapUsedSize', 'backingStorageSize'], code)
  if (!number(r.usedSize) || !number(r.totalSize) || r.usedSize > r.totalSize) invalid(code)
  for (const key of ['embedderHeapUsedSize', 'backingStorageSize']) if (r[key] !== null && !number(r[key])) invalid(code)
  return r as RendererHeapUsage
}
export function parseRendererMemoryResult(value: unknown, input?: RendererMemoryInput): RendererMemoryResult {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const r = fields(value, ['target', 'schema', 'scope', 'units', 'status', 'timing', 'sourceVerified', 'usage', 'cleanup', 'issues'], code)
  const target = parseRendererV8Target(r.target, code)
  if (input && !sameRendererV8ProfileTarget(target, input.target) || r.schema !== 'agentmux.renderer-memory.v1' ||
    r.scope !== 'renderer-v8-isolate' || r.units !== 'bytes' || !['completed', 'failed', 'unknown'].includes(String(r.status))) invalid(code)
  const timing = fields(r.timing, ['requestedAt', 'sampledAt', 'finishedAt'], code)
  if (!number(timing.requestedAt) || !number(timing.finishedAt) || timing.sampledAt !== null && !number(timing.sampledAt)) invalid(code)
  const source = fields(r.sourceVerified, ['before', 'after'], code)
  const cleanup = fields(r.cleanup, ['detached'], code)
  if (typeof source.before !== 'boolean' || typeof source.after !== 'boolean' ||
    !['not-attached', 'confirmed', 'unconfirmed', 'owner-lost'].includes(String(cleanup.detached))) invalid(code)
  if (r.usage !== null) parseRendererHeapUsage(r.usage)
  if (!Array.isArray(r.issues) || r.issues.length > 8 || Object.getPrototypeOf(r.issues) !== Array.prototype ||
    Reflect.ownKeys(r.issues).length !== r.issues.length + 1) invalid(code)
  for (let n = 0; n < r.issues.length; n++) {
    const descriptor = Object.getOwnPropertyDescriptor(r.issues, String(n))
    if (!descriptor?.enumerable || !('value' in descriptor)) invalid(code)
    const issue = fields(descriptor.value, ['stage', 'code', 'message', 'messageTruncated'], code)
    if (typeof issue.stage !== 'string' || issue.stage.length > 80 || typeof issue.code !== 'string' || issue.code.length > 128 ||
      typeof issue.message !== 'string' || issue.message.length > 2048 || typeof issue.messageTruncated !== 'boolean') invalid(code)
  }
  if (r.status === 'completed' && (!source.before || !source.after || !r.usage || timing.sampledAt === null ||
    cleanup.detached !== 'confirmed' || r.issues.length)) invalid(code)
  if (r.status !== 'completed' && !r.issues.length) invalid(code)
  return r as RendererMemoryResult
}
