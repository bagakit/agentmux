import { AgentMuxError } from './errors.js'
import { settingsResourceRecord } from './settings-resource-json.js'

/** Performance's own finite failure record; these are not Runtime capabilities. */
export const TOOLKIT_PERFORMANCE_FAILURE_STAGES = ['launch', 'admission', 'run-port', 'create', 'attach', 'run-event',
  'run-output-order', 'run-output-decode', 'run-output-lf', 'toolkit-json', 'toolkit-envelope',
  'metrics-payload', 'toolkit-document', 'metrics-scope', 'process-exit', 'cli-spawn', 'cli-stderr',
  'cli-rpc-json', 'cli-rpc-opening', 'cli-rpc-notification', 'cli-metrics-payload', 'cli-document',
  'cli-output', 'cli-eof'] as const
export type ToolkitPerformanceFailureStage = typeof TOOLKIT_PERFORMANCE_FAILURE_STAGES[number]
export type ToolkitFailureBytes = {
  source: 'toolkit-output' | 'metrics-rpc-stdout' | 'metrics-rpc-stderr'
  startByte: number; endByte: number; prefixBase64: string; suffixBase64: string; omittedBytes: number
}
export type ToolkitPerformanceFailureDetails = {
  stage: ToolkitPerformanceFailureStage
  /** Original event identity only; no inferred attach/process-exit cause. */
  eventOrigin?: { source: import('./types.js').AgentMuxEvidenceSource; observedAt: number; run: { runId: string } | null }
  error: { message: string | null; code: string | null; stack: string | null; messageTruncated: boolean; stackTruncated: boolean }
  bytes: ToolkitFailureBytes | null
  exit: { code: number | null; signal: string | null } | null
}
export type ToolkitPerformanceFailure = {
  schema: 'agentmux.performance.failure.v1'; executionId: string
  run: { hostId: string; runId: string } | null; recordedAt: number
  details: ToolkitPerformanceFailureDetails
}
export type ToolkitPerformanceIssue = {
  operation: 'read-failure' | 'write-failure' | 'open-run-port' | 'stop' | 'release' | 'remove' | 'clear-admission'
  message: string | null; code: string | null; phase: 'before-replace' | 'after-replace' | null
}
export type ToolkitPerformanceDiagnostics = {
  captureEnabled: boolean; failureEvidence: 'none' | 'retained' | 'included'; droppedWrites: number; lastFailure: ToolkitPerformanceFailure | null
  persistence: 'not-requested' | 'pending' | 'confirmed' | 'unconfirmed' | 'observed-on-disk'
  issue: ToolkitPerformanceIssue | null; cleanupIssue: ToolkitPerformanceIssue | null
}
// Worst legal JSON escaping: 6*(4096 message +8192 stack +128 code +128 signal)
// + two 5464-byte base64 fragments + identities/keys/numeric ranges stays below96KiB.
export const TOOLKIT_PERFORMANCE_FAILURE_MAX_BYTES = 96 * 1024
const FRAGMENT_BYTES = 4096
const fail = (): never => { throw new AgentMuxError('Performance failure evidence is invalid or exceeds its budget.', 'CONTROL_PROTOCOL_ERROR') }
const text = (v: unknown, max: number) => { if (typeof v !== 'string' || Buffer.byteLength(v) > max) fail() }
const count = (v: unknown) => { if (!Number.isSafeInteger(v) || (v as number) < 0) fail() }
const record = (v: unknown, keys: string[]) => {
  const r = settingsResourceRecord(v, 'CONTROL_PROTOCOL_ERROR')
  if (Object.keys(r).length !== keys.length || keys.some(key => !Object.hasOwn(r, key))) fail()
  return r
}
export function parseToolkitPerformanceFailureDetails(value: unknown): ToolkitPerformanceFailureDetails {
  const r = settingsResourceRecord(value, 'CONTROL_PROTOCOL_ERROR')
  if (Object.keys(r).some(key => !['stage', 'error', 'bytes', 'exit', 'eventOrigin'].includes(key)) ||
      ['stage', 'error', 'bytes', 'exit'].some(key => !Object.hasOwn(r, key))) fail()
  if (r.eventOrigin !== undefined) {
    if (r.stage !== 'run-event') fail()
    const origin = record(r.eventOrigin, ['source', 'observedAt', 'run'])
    if (!['terminal-output', 'run-process', 'native-hook', 'native-transcript', 'acp', 'user', 'agentmux'].includes(origin.source as string)) fail()
    if (typeof origin.observedAt !== 'number' || !Number.isFinite(origin.observedAt) || origin.observedAt < 0) fail()
    if (origin.run !== null) { const run = record(origin.run, ['runId']); text(run.runId, 128) }
  }
  if (!(TOOLKIT_PERFORMANCE_FAILURE_STAGES as readonly unknown[]).includes(r.stage)) fail()
  const error = record(r.error, ['message', 'code', 'stack', 'messageTruncated', 'stackTruncated'])
  if (typeof error.messageTruncated !== 'boolean' || typeof error.stackTruncated !== 'boolean') fail()
  if (error.message !== null) text(error.message, 4096); if (error.code !== null) text(error.code, 128); if (error.stack !== null) text(error.stack, 8192)
  if (r.bytes !== null) {
    const bytes = record(r.bytes, ['source', 'startByte', 'endByte', 'prefixBase64', 'suffixBase64', 'omittedBytes'])
    if (!['toolkit-output', 'metrics-rpc-stdout', 'metrics-rpc-stderr'].includes(bytes.source as string)) fail()
    count(bytes.startByte); count(bytes.endByte); count(bytes.omittedBytes)
    const lengths = ['prefixBase64', 'suffixBase64'].map(key => {
      text(bytes[key], 5464)
      const encoded = bytes[key] as string, raw = Buffer.from(encoded, 'base64')
      if (raw.length > FRAGMENT_BYTES || raw.toString('base64') !== encoded) fail()
      return raw.length
    })
    const total = (bytes.endByte as number) - (bytes.startByte as number)
    if (total < 0 || lengths[0]! !== Math.min(total, FRAGMENT_BYTES) ||
      lengths[1]! !== Math.min(Math.max(total - FRAGMENT_BYTES, 0), FRAGMENT_BYTES) ||
      total !== lengths[0]! + lengths[1]! + (bytes.omittedBytes as number)) fail()
  }
  if (r.exit !== null) {
    const exit = record(r.exit, ['code', 'signal'])
    if (exit.code !== null && !Number.isSafeInteger(exit.code)) fail()
    if (exit.signal !== null) text(exit.signal, 128)
  }
  return r as ToolkitPerformanceFailureDetails
}
export function parseToolkitPerformanceFailure(value: unknown): ToolkitPerformanceFailure {
  const r = record(value, ['schema', 'executionId', 'run', 'recordedAt', 'details'])
  if (r.schema !== 'agentmux.performance.failure.v1') fail()
  text(r.executionId, 128); if (!(r.executionId as string).trim() || /[\x00-\x1f\x7f]/u.test(r.executionId as string)) fail()
  if (typeof r.recordedAt !== 'number' || !Number.isFinite(r.recordedAt) || r.recordedAt < 0) fail()
  if (r.run !== null) {
    const run = record(r.run, ['hostId', 'runId'])
    for (const key of ['hostId', 'runId']) {
      text(run[key], 128); if (!(run[key] as string).trim() || /[\x00-\x1f\x7f]/u.test(run[key] as string)) fail()
    }
  }
  parseToolkitPerformanceFailureDetails(r.details)
  if (Buffer.byteLength(JSON.stringify(r)) > TOOLKIT_PERFORMANCE_FAILURE_MAX_BYTES) fail()
  return r as ToolkitPerformanceFailure
}
export function parseToolkitPerformanceDiagnostics(value: unknown): ToolkitPerformanceDiagnostics {
  const r = record(value, ['captureEnabled', 'failureEvidence', 'droppedWrites', 'lastFailure', 'persistence', 'issue', 'cleanupIssue'])
  if (typeof r.captureEnabled !== 'boolean' || !['not-requested', 'pending', 'confirmed', 'unconfirmed', 'observed-on-disk'].includes(r.persistence as string)) fail()
  count(r.droppedWrites)
  if (!['none', 'retained', 'included'].includes(r.failureEvidence as string)) fail()
  const failure = r.lastFailure === null ? null : parseToolkitPerformanceFailure(r.lastFailure)
  const raw = failure !== null && (failure.details.bytes !== null || failure.details.error.stack !== null || failure.details.error.message !== null) ||
    [r.issue, r.cleanupIssue].some(value => value !== null && settingsResourceRecord(value, 'CONTROL_PROTOCOL_ERROR').message !== null)
  if (raw !== (r.failureEvidence === 'included') || (failure === null && r.issue === null && r.cleanupIssue === null && r.failureEvidence !== 'none')) fail()
  if (r.lastFailure === null && ['pending', 'confirmed', 'observed-on-disk'].includes(r.persistence as string)) fail()
  for (const key of ['issue', 'cleanupIssue']) if (r[key] !== null) {
    const issue = record(r[key], ['operation', 'message', 'code', 'phase'])
    if (!['read-failure', 'write-failure', 'open-run-port', 'stop', 'release', 'remove', 'clear-admission'].includes(issue.operation as string) ||
        ![null, 'before-replace', 'after-replace'].includes(issue.phase as null | string)) fail()
    if (issue.message !== null) text(issue.message, 4096); if (issue.code !== null) text(issue.code, 128)
  }
  return r as ToolkitPerformanceDiagnostics
}
/** Copies at most 8KiB, never retains a caller's unbounded input buffer. */
export class ToolkitFailureCapture {
  private prefix = Buffer.alloc(0)
  private suffix = Buffer.alloc(0)
  private length = 0
  constructor(private readonly source: ToolkitFailureBytes['source'], private readonly startByte: number) {}
  append(bytes: Uint8Array): void {
    const missing = Math.max(0, FRAGMENT_BYTES - this.prefix.length)
    if (missing) this.prefix = Buffer.concat([this.prefix, bytes.subarray(0, missing)])
    const remainder = bytes.subarray(Math.min(missing, bytes.length))
    if (remainder.length) this.suffix = Buffer.concat([this.suffix, remainder.subarray(Math.max(0, remainder.length - FRAGMENT_BYTES))]).subarray(-FRAGMENT_BYTES)
    this.length += bytes.length
  }
  get value(): ToolkitFailureBytes {
    return { source: this.source, startByte: this.startByte, endByte: this.startByte + this.length,
      prefixBase64: this.prefix.toString('base64'), suffixBase64: this.suffix.toString('base64'),
      omittedBytes: this.length - this.prefix.length - this.suffix.length }
  }
}
export function toolkitFailureError(error: unknown, includeStack = false): ToolkitPerformanceFailureDetails['error'] & { message: string } {
  const clip = (value: string, limit: number) => {
    const bytes = Buffer.from(value)
    // Avoid a replacement character expanding the byte limit at a split UTF-8 scalar.
    return bytes.subarray(0, limit).toString('utf8').replace(/\uFFFD$/u, '')
  }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null
  const message = error instanceof Error ? error.message : String(error)
  return { message: clip(message, 4096), messageTruncated: Buffer.byteLength(message) > 4096,
    stackTruncated: includeStack && error instanceof Error && typeof error.stack === 'string' && Buffer.byteLength(error.stack) > 8192,
    code: typeof code === 'string' ? clip(code, 128) : null,
    stack: includeStack && error instanceof Error && typeof error.stack === 'string' ? clip(error.stack, 8192) : null }
}
