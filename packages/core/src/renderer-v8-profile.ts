import { v8ProfileJSON, type V8Profile } from './v8-profile.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { MetricsWindow } from './metrics.js'

export const RENDERER_V8_PROFILE_METADATA_BYTES = 64 * 1024
export type RendererV8ProfileTarget = MetricsWindow & { pid: number; creationTime: number }
export type RendererV8ProfileInput = { target: RendererV8ProfileTarget; durationMs: number }
export type RendererV8Profile = V8Profile
export type RendererV8ProfileIssue = { stage: string; code: string; message: string; messageTruncated: boolean }
export type RendererV8ProfileResult = RendererV8ProfileInput & {
  schema: 'agentmux.renderer-v8-profile.v1'
  scope: 'renderer-main-thread-v8'
  status: 'completed' | 'failed' | 'unknown'
  timing: { requestedAt: number; startedAt: number | null; stoppedAt: number | null; finishedAt: number
    startMonotonicMs: number | null; stopMonotonicMs: number | null }
  profilerTimeUnit: 'microseconds'
  sourceVerified: { before: boolean; after: boolean }
  cleanup: { stopRequested: boolean; stopAcknowledged: boolean; disableAcknowledged: boolean
    detached: 'not-attached' | 'confirmed' | 'unconfirmed' | 'owner-lost' }
  profile: RendererV8Profile | null
  profileBytes: number | null
  sha256: string | null
  issues: RendererV8ProfileIssue[]
}

function invalid(code: string): never { throw new AgentMuxError('Renderer V8 profile contract is invalid.', code) }
const numeric = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const count = (v: unknown): v is number => numeric(v) && Number.isSafeInteger(v)
const positive = (v: unknown): v is number => count(v) && v > 0
const fields = (v: unknown, keys: string[], code: string) => {
  const r = rpcRecord(v, keys, code)
  if (Object.keys(r).length !== keys.length) invalid(code)
  return r
}
function array(v: unknown, code: string): unknown[] {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype || Reflect.ownKeys(v).length !== v.length + 1) invalid(code)
  for (let i = 0; i < v.length; i++) {
    const d = Object.getOwnPropertyDescriptor(v, String(i))
    if (!d?.enumerable || !('value' in d)) invalid(code)
  }
  return v
}

export function sameRendererV8ProfileTarget(a: RendererV8ProfileTarget, b: RendererV8ProfileTarget): boolean {
  return a.windowId === b.windowId && a.webContentsId === b.webContentsId && a.generation === b.generation &&
    a.pid === b.pid && a.creationTime === b.creationTime
}
export function parseRendererV8Target(value: unknown, code = 'INVALID_CONTROL_REQUEST'): RendererV8ProfileTarget {
  const t = fields(value, ['windowId', 'webContentsId', 'generation', 'pid', 'creationTime'], code)
  if (!positive(t.windowId) || !positive(t.webContentsId) || !count(t.generation) || !positive(t.pid) ||
    !numeric(t.creationTime) || t.creationTime <= 0) invalid(code)
  return t as RendererV8ProfileTarget
}
export function parseRendererV8ProfileInput(value: unknown, code = 'INVALID_CONTROL_REQUEST'): RendererV8ProfileInput {
  const r = fields(value, ['target', 'durationMs'], code)
  parseRendererV8Target(r.target, code)
  if (!count(r.durationMs) || r.durationMs < 1000 || r.durationMs > 5000) invalid(code)
  return r as unknown as RendererV8ProfileInput
}

export function parseRendererV8ProfileResult(value: unknown, input?: RendererV8ProfileInput): RendererV8ProfileResult {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const r = fields(value, ['target', 'durationMs', 'schema', 'scope', 'status', 'timing', 'profilerTimeUnit',
    'sourceVerified', 'cleanup', 'profile', 'profileBytes', 'sha256', 'issues'], code)
  const actual = parseRendererV8ProfileInput({ target: r.target, durationMs: r.durationMs }, code)
  if (input && (!sameRendererV8ProfileTarget(actual.target, input.target) || input.durationMs !== actual.durationMs)) invalid(code)
  if (r.schema !== 'agentmux.renderer-v8-profile.v1' || r.scope !== 'renderer-main-thread-v8' ||
    !['completed', 'failed', 'unknown'].includes(String(r.status)) || r.profilerTimeUnit !== 'microseconds') invalid(code)
  const timing = fields(r.timing, ['requestedAt', 'startedAt', 'stoppedAt', 'finishedAt', 'startMonotonicMs', 'stopMonotonicMs'], code)
  for (const key of ['requestedAt', 'finishedAt']) if (!numeric(timing[key])) invalid(code)
  for (const key of ['startedAt', 'stoppedAt', 'startMonotonicMs', 'stopMonotonicMs']) if (timing[key] !== null && !numeric(timing[key])) invalid(code)
  if (timing.stopMonotonicMs !== null && (timing.startMonotonicMs === null || Number(timing.stopMonotonicMs) < Number(timing.startMonotonicMs))) invalid(code)
  const source = fields(r.sourceVerified, ['before', 'after'], code)
  const cleanup = fields(r.cleanup, ['stopRequested', 'stopAcknowledged', 'disableAcknowledged', 'detached'], code)
  if (typeof source.before !== 'boolean' || typeof source.after !== 'boolean' ||
    ['stopRequested', 'stopAcknowledged', 'disableAcknowledged'].some(key => typeof cleanup[key] !== 'boolean') ||
    !['not-attached', 'confirmed', 'unconfirmed', 'owner-lost'].includes(String(cleanup.detached)) || cleanup.stopAcknowledged && !cleanup.stopRequested) invalid(code)
  const issues = array(r.issues, code)
  if (issues.length > 8) invalid(code)
  for (const issue of issues) {
    const i = fields(issue, ['stage', 'code', 'message', 'messageTruncated'], code)
    if (typeof i.stage !== 'string' || i.stage.length > 80 || typeof i.code !== 'string' || i.code.length > 128 ||
      typeof i.message !== 'string' || i.message.length > 2048 || typeof i.messageTruncated !== 'boolean') invalid(code)
  }
  if (r.profileBytes !== null && !count(r.profileBytes)) invalid(code)
  if (r.profile === null) { if (r.sha256 !== null) invalid(code) }
  else {
    const text = v8ProfileJSON(r.profile as RendererV8Profile)
    if (r.profileBytes !== new TextEncoder().encode(text).byteLength || typeof r.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.sha256)) invalid(code)
  }
  if (r.status === 'completed' && (r.profile === null || !source.before || !source.after || !cleanup.stopAcknowledged ||
    !cleanup.disableAcknowledged || cleanup.detached !== 'confirmed' || issues.length || timing.startedAt === null || timing.stoppedAt === null || timing.startMonotonicMs === null || timing.stopMonotonicMs === null)) invalid(code)
  if (new TextEncoder().encode(JSON.stringify({ ...r, profile: null })).byteLength > RENDERER_V8_PROFILE_METADATA_BYTES) invalid(code)
  return r as unknown as RendererV8ProfileResult
}
