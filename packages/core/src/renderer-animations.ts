import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseRendererV8Target, sameRendererV8ProfileTarget, type RendererV8ProfileTarget,
  type RendererV8ProfileIssue } from './renderer-v8-profile.js'

export const RENDERER_ANIMATIONS_MAX_ITEMS = 128
export const RENDERER_ANIMATIONS_MAX_ANCESTORS = 3
export const RENDERER_ANIMATIONS_MAX_CLASSES = 8
export const RENDERER_ANIMATIONS_MAX_STRING_CHARS = 128

export type RendererAnimationsInput = { target: RendererV8ProfileTarget }
/** Presentation observations only; labels and play state do not establish CPU ownership. */
export type RendererAnimationEntry = {
  kind: 'css-animation' | 'css-transition' | 'web-animation'
  name: string | null
  playState: 'idle' | 'running' | 'paused' | 'finished'
  pending: boolean
  /** Original numeric time in milliseconds; unsupported native time values remain null. */
  currentTime: number | null
  /** Milliseconds, preserving the native auto and positive infinity tokens. */
  duration: number | 'infinite' | 'auto' | null
  iterations: number | 'infinite' | null
  /** Nearest element first; labels contain only tag and class names. */
  ancestry: string[] | null
  stringsTruncated: boolean
  targetTruncated: boolean
}
export type RendererAnimationsResult = RendererAnimationsInput & {
  schema: 'agentmux.renderer-animations.v1'
  scope: 'renderer-document'
  status: 'completed' | 'failed' | 'unknown'
  timing: { requestedAt: number; sampledAt: number | null; finishedAt: number }
  sourceVerified: { before: boolean; after: boolean }
  evaluation: { requested: boolean; settled: boolean }
  snapshot: { totalAnimations: number; omittedAnimations: number; animations: RendererAnimationEntry[] } | null
  issues: RendererV8ProfileIssue[]
}

function invalid(code: string): never { throw new AgentMuxError('Renderer animation observation is invalid.', code) }
const nonnegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const count = (v: unknown): v is number => nonnegative(v) && Number.isSafeInteger(v)
function fields(value: unknown, keys: string[], code: string): Record<string, unknown> {
  const r = rpcRecord(value, keys, code)
  if (Object.keys(r).length !== keys.length) invalid(code)
  return r
}
function array(value: unknown, max: number, parse: (item: unknown) => void, code: string): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1) invalid(code)
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i))
    if (!d?.enumerable || !('value' in d)) invalid(code)
    parse(d.value)
  }
}
export function parseRendererAnimationsInput(value: unknown, code = 'INVALID_CONTROL_REQUEST'): RendererAnimationsInput {
  const r = fields(value, ['target'], code)
  parseRendererV8Target(r.target, code)
  return r as RendererAnimationsInput
}
export function parseRendererAnimationsResult(value: unknown, input?: RendererAnimationsInput): RendererAnimationsResult {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const r = fields(value, ['target', 'schema', 'scope', 'status', 'timing', 'sourceVerified', 'evaluation', 'snapshot', 'issues'], code)
  const target = parseRendererV8Target(r.target, code)
  if (input && !sameRendererV8ProfileTarget(target, input.target) || r.schema !== 'agentmux.renderer-animations.v1' ||
    r.scope !== 'renderer-document' || typeof r.status !== 'string' || !['completed', 'failed', 'unknown'].includes(r.status)) invalid(code)
  const timing = fields(r.timing, ['requestedAt', 'sampledAt', 'finishedAt'], code)
  if (!nonnegative(timing.requestedAt) || !nonnegative(timing.finishedAt) || timing.finishedAt < timing.requestedAt ||
    timing.sampledAt !== null && (!nonnegative(timing.sampledAt) || timing.sampledAt < timing.requestedAt || timing.sampledAt > timing.finishedAt)) invalid(code)
  const source = fields(r.sourceVerified, ['before', 'after'], code)
  const evaluation = fields(r.evaluation, ['requested', 'settled'], code)
  if (typeof source.before !== 'boolean' || typeof source.after !== 'boolean' || typeof evaluation.requested !== 'boolean' ||
    typeof evaluation.settled !== 'boolean' || evaluation.settled && !evaluation.requested ||
    timing.sampledAt !== null && !evaluation.settled) invalid(code)
  if (r.snapshot !== null) {
    const snapshot = fields(r.snapshot, ['totalAnimations', 'omittedAnimations', 'animations'], code)
    if (!evaluation.settled || !count(snapshot.totalAnimations) || !count(snapshot.omittedAnimations)) invalid(code)
    array(snapshot.animations, RENDERER_ANIMATIONS_MAX_ITEMS, item => {
      const a = fields(item, ['kind', 'name', 'playState', 'pending', 'currentTime', 'duration', 'iterations', 'ancestry', 'stringsTruncated', 'targetTruncated'], code)
      if (typeof a.kind !== 'string' || !['css-animation', 'css-transition', 'web-animation'].includes(a.kind) ||
        a.name !== null && (typeof a.name !== 'string' || a.name.length > RENDERER_ANIMATIONS_MAX_STRING_CHARS) ||
        typeof a.playState !== 'string' || !['idle', 'running', 'paused', 'finished'].includes(a.playState) || typeof a.pending !== 'boolean' ||
        a.currentTime !== null && (typeof a.currentTime !== 'number' || !Number.isFinite(a.currentTime)) ||
        a.duration !== null && a.duration !== 'infinite' && a.duration !== 'auto' && !nonnegative(a.duration) ||
        a.iterations !== null && a.iterations !== 'infinite' && !nonnegative(a.iterations) ||
        typeof a.stringsTruncated !== 'boolean' || typeof a.targetTruncated !== 'boolean') invalid(code)
      if (a.ancestry !== null) array(a.ancestry, RENDERER_ANIMATIONS_MAX_ANCESTORS, label => {
        if (typeof label !== 'string' || !label.length || label.length > RENDERER_ANIMATIONS_MAX_STRING_CHARS) invalid(code)
      }, code)
    }, code)
    if (snapshot.totalAnimations !== snapshot.animations.length + snapshot.omittedAnimations) invalid(code)
  }
  array(r.issues, 8, value => {
    const issue = fields(value, ['stage', 'code', 'message', 'messageTruncated'], code)
    if (typeof issue.stage !== 'string' || issue.stage.length > 80 || typeof issue.code !== 'string' || issue.code.length > 128 ||
      typeof issue.message !== 'string' || issue.message.length > 2048 || typeof issue.messageTruncated !== 'boolean') invalid(code)
  }, code)
  if (r.status === 'completed' && (!source.before || !source.after || !evaluation.requested || !evaluation.settled ||
    timing.sampledAt === null || r.snapshot === null || r.issues.length)) invalid(code)
  if (r.status !== 'completed' && !r.issues.length) invalid(code)
  return r as RendererAnimationsResult
}
