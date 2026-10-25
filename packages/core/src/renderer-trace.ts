import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseRendererV8ProfileInput, sameRendererV8ProfileTarget, type RendererV8ProfileInput } from './renderer-v8-profile.js'

export type RendererTraceInput = RendererV8ProfileInput
/** Original native gzip bytes, never a reconstructed event array. */
export type RendererTrace = { encoding: 'base64'; data: string; bytes: number; sha256: string }
export const RENDERER_TRACE_MAX_BYTES = 8 * 1024 * 1024
export const RENDERER_TRACE_METADATA_BYTES = 64 * 1024
export const RENDERER_TRACE_MAX_GZIP_BYTES = 3 * Math.floor((RENDERER_TRACE_MAX_BYTES - RENDERER_TRACE_METADATA_BYTES) / 4)
export const RENDERER_TRACE_CATEGORIES = ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.stack',
  'blink', 'blink.user_timing', 'cc', 'gpu', 'viz', 'input', 'latencyInfo'] as const
export type RendererTraceResult = RendererTraceInput & {
  schema: 'agentmux.renderer-trace.v2'; scope: 'chromium-target-related-timeline'; status: 'completed' | 'failed' | 'unknown'
  /** Requested filters, not proof of native support. Observed PID/category facts remain in the original events. */
  transferMode: 'ReturnAsStream'; streamFormat: 'json'; streamCompression: 'gzip'; traceTimeUnit: 'microseconds'; requestedCategories: string[]
  /** Main receive times: startedAt/startMonotonicMs mark start ACK, not the native trace's earliest event. */
  timing: { requestedAt: number; startedAt: number | null; endAcknowledgedAt: number | null; completedAt: number | null
    finishedAt: number; startMonotonicMs: number | null; endMonotonicMs: number | null; completeMonotonicMs: number | null }
  sourceVerified: { before: boolean; after: boolean }
  lifecycle: { startRequested: boolean; startAcknowledged: boolean; endRequested: boolean; endAcknowledged: boolean
    tracingComplete: boolean; dataLossOccurred: boolean | null; detached: 'not-attached' | 'confirmed' | 'unconfirmed' | 'owner-lost' }
  bufferUsage: { observations: number; maxFraction: number | null; fullObserved: boolean }
  /** Observed decoded bytes/events and original gzip bytes; failure counters may include a violating chunk. */
  receivedEvents: number; receivedTraceBytes: number; receivedGzipBytes: number
  stream: { handleReceived: boolean; eof: boolean; closeRequested: boolean; closeAcknowledged: boolean }
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
/** Canonical base64 shape/length only. Byte inflation belongs to explicit Node consumers. */
function parseMaterial(value: unknown): RendererTrace {
  const r = fields(value, ['encoding', 'data', 'bytes', 'sha256'])
  if (r.encoding !== 'base64' || typeof r.data !== 'string' || !count(r.bytes) || r.bytes < 1 ||
    r.bytes > RENDERER_TRACE_MAX_GZIP_BYTES || r.data.length !== 4 * Math.ceil(r.bytes / 3) ||
    typeof r.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.sha256)) invalid()
  const sextet = (code: number) => code >= 65 && code <= 90 ? code - 65 : code >= 97 && code <= 122 ? code - 71 :
    code >= 48 && code <= 57 ? code + 4 : code === 43 ? 62 : code === 47 ? 63 : -1
  const padding = r.bytes % 3 === 0 ? 0 : 3 - r.bytes % 3, end = r.data.length - padding
  for (let i = 0; i < end; i++) if (sextet(r.data.charCodeAt(i)) < 0) invalid()
  for (let i = end; i < r.data.length; i++) if (r.data.charCodeAt(i) !== 61) invalid()
  if (padding && (sextet(r.data.charCodeAt(end - 1)) & (padding === 2 ? 15 : 3)) !== 0) invalid()
  return r as unknown as RendererTrace
}
export function parseRendererTraceResult(value: unknown, input?: RendererTraceInput): RendererTraceResult {
  const envelope = rpcRecord(value, undefined, 'CONTROL_PROTOCOL_ERROR')
  if (envelope.schema !== 'agentmux.renderer-trace.v2') {
    throw new AgentMuxError('Renderer trace version is unsupported; the original stored material was not modified.', 'CONTROL_PROTOCOL_ERROR')
  }
  const r = fields(envelope, ['target', 'durationMs', 'schema', 'scope', 'status', 'transferMode', 'streamFormat', 'streamCompression', 'traceTimeUnit', 'requestedCategories',
    'timing', 'sourceVerified', 'lifecycle', 'bufferUsage', 'receivedEvents', 'receivedTraceBytes', 'receivedGzipBytes', 'stream', 'trace', 'traceBytes', 'sha256', 'issues'])
  const actual = parseRendererTraceInput({ target: r.target, durationMs: r.durationMs }, 'CONTROL_PROTOCOL_ERROR')
  if (input && (!sameRendererV8ProfileTarget(actual.target, input.target) || actual.durationMs !== input.durationMs)) invalid()
  if (r.schema !== 'agentmux.renderer-trace.v2' || r.scope !== 'chromium-target-related-timeline' ||
    !['completed', 'failed', 'unknown'].includes(String(r.status)) || r.transferMode !== 'ReturnAsStream' || r.streamFormat !== 'json' || r.streamCompression !== 'gzip' || r.traceTimeUnit !== 'microseconds' ||
    !array(r.requestedCategories).length || (r.requestedCategories as unknown[]).some(category => typeof category !== 'string' || !category.length)) invalid()
  // These are the original producer's filters, not this reader's current capture policy.
  // The existing metadata byte budget below also bounds this retained array.
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
  const stream = fields(r.stream, ['handleReceived', 'eof', 'closeRequested', 'closeAcknowledged'])
  for (const key of ['handleReceived', 'eof', 'closeRequested', 'closeAcknowledged']) if (typeof stream[key] !== 'boolean') invalid()
  if ((stream.eof || stream.closeRequested) && !stream.handleReceived ||
    stream.closeAcknowledged && !stream.closeRequested) invalid()
  if (!count(r.receivedEvents) || !count(r.receivedTraceBytes) || !count(r.receivedGzipBytes) || r.traceBytes !== null && !count(r.traceBytes)) invalid()
  if (r.trace === null) { if (r.sha256 !== null || r.traceBytes !== null) invalid() }
  else {
    const trace = parseMaterial(r.trace)
    if (!count(r.traceBytes) || r.receivedTraceBytes !== r.traceBytes || trace.bytes !== r.receivedGzipBytes ||
      typeof r.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.sha256) || !stream.eof) invalid()
  }
  const issues = array(r.issues)
  if (issues.length > 8) invalid()
  for (const issue of issues) {
    const i = fields(issue, ['stage', 'code', 'message', 'messageTruncated'])
    if (typeof i.stage !== 'string' || i.stage.length > 80 || typeof i.code !== 'string' || i.code.length > 128 ||
      typeof i.message !== 'string' || i.message.length > 2048 || typeof i.messageTruncated !== 'boolean') invalid()
  }
  if (r.status === 'completed' && (r.trace === null || !source.before || !source.after || !life.startAcknowledged || !life.endAcknowledged ||
    !life.tracingComplete || !stream.handleReceived || !stream.eof || !stream.closeRequested || !stream.closeAcknowledged || life.dataLossOccurred !== false || life.detached !== 'confirmed' || usage.fullObserved || issues.length ||
    ['startedAt', 'endAcknowledgedAt', 'completedAt', 'startMonotonicMs', 'endMonotonicMs', 'completeMonotonicMs'].some(key => timing[key] === null))) invalid()
  const metadata = { ...r, trace: r.trace === null ? null : { ...r.trace as RendererTrace, data: '' } }
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata)).byteLength
  if (metadataBytes > RENDERER_TRACE_METADATA_BYTES || metadataBytes + (r.trace === null ? 0 : (r.trace as RendererTrace).data.length) > RENDERER_TRACE_MAX_BYTES) invalid()
  return r as unknown as RendererTraceResult
}
