import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseRendererV8ProfileInput, sameRendererV8ProfileTarget, type RendererV8ProfileInput } from './renderer-v8-profile.js'

export type RendererTraceInput = RendererV8ProfileInput
export type RendererTraceEvent = Record<string, unknown>
export type RendererTrace = { traceEvents: RendererTraceEvent[] }
export const RENDERER_TRACE_MAX_BYTES = 8 * 1024 * 1024
export const RENDERER_TRACE_METADATA_BYTES = 64 * 1024
export const RENDERER_TRACE_CATEGORIES = ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline',
  'blink', 'blink.user_timing', 'cc', 'gpu', 'viz', 'input', 'latencyInfo'] as const
export type RendererTraceResult = RendererTraceInput & {
  schema: 'agentmux.renderer-trace.v1'; scope: 'chromium-target-related-timeline'; status: 'completed' | 'failed' | 'unknown'
  /** Requested filters, not proof of native support. Observed PID/category facts remain in the original events. */
  transferMode: 'ReportEvents'; traceTimeUnit: 'microseconds'; requestedCategories: string[]
  /** Main receive times: startedAt/startMonotonicMs mark start ACK, not the native trace's earliest event. */
  timing: { requestedAt: number; startedAt: number | null; endAcknowledgedAt: number | null; completedAt: number | null
    finishedAt: number; startMonotonicMs: number | null; endMonotonicMs: number | null; completeMonotonicMs: number | null }
  sourceVerified: { before: boolean; after: boolean }
  lifecycle: { startRequested: boolean; startAcknowledged: boolean; endRequested: boolean; endAcknowledged: boolean
    tracingComplete: boolean; dataLossOccurred: boolean | null; detached: 'not-attached' | 'confirmed' | 'unconfirmed' | 'owner-lost' }
  bufferUsage: { observations: number; maxFraction: number | null; fullObserved: boolean }
  /** Compact JSON document bytes from chunks observed so far, including the empty document envelope. */
  receivedEvents: number; receivedTraceBytes: number
  trace: RendererTrace | null; traceBytes: number | null; sha256: string | null
  issues: Array<{ stage: string; code: string; message: string; messageTruncated: boolean }>
}
function invalid(code = 'CONTROL_PROTOCOL_ERROR'): never { throw new AgentMuxError('Renderer trace contract is invalid.', code) }
const numeric = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const count = (v: unknown): v is number => numeric(v) && Number.isSafeInteger(v)
function fields(value: unknown, keys: string[]) {
  const result = rpcRecord(value, keys, 'CONTROL_PROTOCOL_ERROR')
  if (Object.keys(result).length !== keys.length) invalid()
  return result
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) invalid()
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i))
    if (!descriptor?.enumerable || !('value' in descriptor)) invalid()
  }
  return value
}
export function parseRendererTraceInput(value: unknown, code = 'INVALID_CONTROL_REQUEST'): RendererTraceInput {
  try { return parseRendererV8ProfileInput(value, code) } catch { return invalid(code) }
}
/** Keep every JSON field and event in its original order; no event-name projection. */
export function parseRendererTraceEvents(value: unknown): RendererTraceEvent[] {
  for (const event of array(value)) rpcRecord(event, undefined, 'CONTROL_PROTOCOL_ERROR')
  const pending: unknown[] = [value], seen = new WeakSet<object>()
  while (pending.length) {
    const item = pending.pop()
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) continue
    if (!item || typeof item !== 'object') invalid()
    if (seen.has(item)) continue
    seen.add(item)
    if (Array.isArray(item)) {
      for (const value of array(item)) pending.push(value)
    } else {
      const object = rpcRecord(item, undefined, 'CONTROL_PROTOCOL_ERROR')
      for (const key of Object.keys(object)) pending.push(Object.getOwnPropertyDescriptor(object, key)!.value)
    }
  }
  try { JSON.stringify(value) } catch { invalid() }
  return value as RendererTraceEvent[]
}
export function rendererTraceJSON(trace: RendererTrace): string {
  const data = fields(trace, ['traceEvents'])
  parseRendererTraceEvents(data.traceEvents)
  const text = JSON.stringify(trace)
  if (new TextEncoder().encode(text).byteLength > RENDERER_TRACE_MAX_BYTES) {
    throw new AgentMuxError('Original Renderer trace exceeds the 8 MiB result transport budget; it was not truncated.', 'CONTROL_PROTOCOL_ERROR')
  }
  return text
}
export function parseRendererTraceResult(value: unknown, input?: RendererTraceInput): RendererTraceResult {
  const r = fields(value, ['target', 'durationMs', 'schema', 'scope', 'status', 'transferMode', 'traceTimeUnit', 'requestedCategories',
    'timing', 'sourceVerified', 'lifecycle', 'bufferUsage', 'receivedEvents', 'receivedTraceBytes', 'trace', 'traceBytes', 'sha256', 'issues'])
  const actual = parseRendererTraceInput({ target: r.target, durationMs: r.durationMs }, 'CONTROL_PROTOCOL_ERROR')
  if (input && (!sameRendererV8ProfileTarget(actual.target, input.target) || actual.durationMs !== input.durationMs)) invalid()
  if (r.schema !== 'agentmux.renderer-trace.v1' || r.scope !== 'chromium-target-related-timeline' ||
    !['completed', 'failed', 'unknown'].includes(String(r.status)) || r.transferMode !== 'ReportEvents' || r.traceTimeUnit !== 'microseconds' ||
    array(r.requestedCategories).length !== RENDERER_TRACE_CATEGORIES.length || (r.requestedCategories as unknown[]).some((category, index) => category !== RENDERER_TRACE_CATEGORIES[index])) invalid()
  const timing = fields(r.timing, ['requestedAt', 'startedAt', 'endAcknowledgedAt', 'completedAt', 'finishedAt', 'startMonotonicMs', 'endMonotonicMs', 'completeMonotonicMs'])
  for (const key of ['requestedAt', 'finishedAt']) if (!numeric(timing[key])) invalid()
  for (const key of ['startedAt', 'endAcknowledgedAt', 'completedAt', 'startMonotonicMs', 'endMonotonicMs', 'completeMonotonicMs']) if (timing[key] !== null && !numeric(timing[key])) invalid()
  for (const key of ['endMonotonicMs', 'completeMonotonicMs']) if (timing[key] !== null && (timing.startMonotonicMs === null || Number(timing[key]) < Number(timing.startMonotonicMs))) invalid()
  const source = fields(r.sourceVerified, ['before', 'after'])
  if (typeof source.before !== 'boolean' || typeof source.after !== 'boolean') invalid()
  const life = fields(r.lifecycle, ['startRequested', 'startAcknowledged', 'endRequested', 'endAcknowledged', 'tracingComplete', 'dataLossOccurred', 'detached'])
  for (const key of ['startRequested', 'startAcknowledged', 'endRequested', 'endAcknowledged', 'tracingComplete']) if (typeof life[key] !== 'boolean') invalid()
  if (life.dataLossOccurred !== null && typeof life.dataLossOccurred !== 'boolean' || !['not-attached', 'confirmed', 'unconfirmed', 'owner-lost'].includes(String(life.detached)) ||
    life.startAcknowledged && !life.startRequested || life.endAcknowledged && !life.endRequested || life.endRequested && !life.startAcknowledged ||
    life.tracingComplete !== (typeof life.dataLossOccurred === 'boolean')) invalid()
  const usage = fields(r.bufferUsage, ['observations', 'maxFraction', 'fullObserved'])
  if (!count(usage.observations) || usage.maxFraction !== null && (!numeric(usage.maxFraction) || usage.maxFraction > 1) ||
    typeof usage.fullObserved !== 'boolean' || usage.fullObserved !== (usage.maxFraction === 1)) invalid()
  if (!count(r.receivedEvents) || !count(r.receivedTraceBytes) || r.traceBytes !== null && !count(r.traceBytes)) invalid()
  if (r.trace === null) { if (r.sha256 !== null || r.traceBytes !== null) invalid() }
  else {
    const text = rendererTraceJSON(r.trace as RendererTrace)
    if (r.traceBytes !== new TextEncoder().encode(text).byteLength || r.receivedTraceBytes !== r.traceBytes ||
      (r.trace as RendererTrace).traceEvents.length !== r.receivedEvents || typeof r.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.sha256)) invalid()
  }
  const issues = array(r.issues)
  if (issues.length > 8) invalid()
  for (const issue of issues) {
    const i = fields(issue, ['stage', 'code', 'message', 'messageTruncated'])
    if (typeof i.stage !== 'string' || i.stage.length > 80 || typeof i.code !== 'string' || i.code.length > 128 ||
      typeof i.message !== 'string' || i.message.length > 2048 || typeof i.messageTruncated !== 'boolean') invalid()
  }
  if (r.status === 'completed' && (r.trace === null || !source.before || !source.after || !life.startAcknowledged || !life.endAcknowledged ||
    !life.tracingComplete || life.dataLossOccurred !== false || life.detached !== 'confirmed' || usage.fullObserved || issues.length ||
    ['startedAt', 'endAcknowledgedAt', 'completedAt', 'startMonotonicMs', 'endMonotonicMs', 'completeMonotonicMs'].some(key => timing[key] === null))) invalid()
  if (new TextEncoder().encode(JSON.stringify({ ...r, trace: null })).byteLength > RENDERER_TRACE_METADATA_BYTES) invalid()
  return r as unknown as RendererTraceResult
}
