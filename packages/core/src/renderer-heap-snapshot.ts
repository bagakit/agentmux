import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseRendererV8Target, sameRendererV8ProfileTarget,
  type RendererV8ProfileTarget, type RendererV8ProfileIssue } from './renderer-v8-profile.js'

export type RendererHeapSnapshotInput = { target: RendererV8ProfileTarget; captureId: string }
export type RendererHeapSnapshotInspectInput = { captureId?: string }
export type RendererHeapSnapshotHost = { kind: 'unix-host'; hostId: 'local'; hostname: string; mainPid: number }
/** A path on the original Host, never a caller-local destination or an authorization token. */
export type RendererHeapSnapshotArtifact = {
  kind: 'renderer-heap-snapshot'; captureId: string; host: RendererHeapSnapshotHost
  format: 'v8-heapsnapshot'; path: string; byteLength: number; sha256: string
}
export type RendererHeapSnapshotCapture = RendererHeapSnapshotInput & {
  schema: 'agentmux.renderer-heap-snapshot.v1'; scope: 'renderer-v8-isolate'
  host: RendererHeapSnapshotHost; status: 'completed' | 'failed' | 'unknown'
  timing: { requestedAt: number; nativeRequestedAt: number | null; nativeSettledAt: number | null; finishedAt: number }
  /** Null preserves missing original native observations after owner recovery. */
  native: { requested: boolean | null; settled: boolean | null; succeeded: boolean | null }
  sourceVerified: { before: boolean; after: boolean }
  artifact: RendererHeapSnapshotArtifact | null
  issues: RendererV8ProfileIssue[]
}
/** Unknown phase:null means this reader did not observe the write phase, not before-replace. */
export type RendererHeapSnapshotResult = {
  capture: RendererHeapSnapshotCapture
  persistence: { status: 'confirmed' | 'failed' | 'unknown'; phase: 'before-replace' | 'after-replace' | null; issue: RendererV8ProfileIssue | null }
}
/** Available reads the original receipt and verifies its file when present; never reconstructs a save ACK. */
export type RendererHeapSnapshotInspection = {
  status: 'available' | 'absent' | 'mismatch' | 'unavailable'
  capture: RendererHeapSnapshotCapture | null
  issue: RendererV8ProfileIssue | null
}

function invalid(code: string): never {
  throw new AgentMuxError('Renderer heap snapshot contract is invalid.', code)
}
function fields(value: unknown, names: string[], code: string) {
  const valueRecord = rpcRecord(value, names, code)
  if (Object.keys(valueRecord).length !== names.length) invalid(code)
  return valueRecord
}
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
function text(value: unknown, max: number, code: string): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\0\r\n]/u.test(value)) invalid(code)
}
function captureId(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) invalid(code)
}
function host(value: unknown, code: string): RendererHeapSnapshotHost {
  const h = fields(value, ['kind', 'hostId', 'hostname', 'mainPid'], code)
  text(h.hostname, 4096, code)
  if (h.kind !== 'unix-host' || h.hostId !== 'local' || !Number.isSafeInteger(h.mainPid) || Number(h.mainPid) <= 0) invalid(code)
  return h as RendererHeapSnapshotHost
}
function sameHost(a: RendererHeapSnapshotHost, b: RendererHeapSnapshotHost): boolean {
  return a.kind === b.kind && a.hostId === b.hostId && a.hostname === b.hostname && a.mainPid === b.mainPid
}
function issue(value: unknown, code: string): void {
  const i = fields(value, ['stage', 'code', 'message', 'messageTruncated'], code)
  text(i.stage, 128, code); text(i.code, 128, code)
  if (typeof i.message !== 'string' || i.message.length > 2048 || typeof i.messageTruncated !== 'boolean') invalid(code)
}

export function parseRendererHeapSnapshotInput(value: unknown, code = 'INVALID_CONTROL_REQUEST'): RendererHeapSnapshotInput {
  const r = fields(value, ['target', 'captureId'], code)
  parseRendererV8Target(r.target, code); captureId(r.captureId, code)
  return r as RendererHeapSnapshotInput
}
export function parseRendererHeapSnapshotInspectInput(value: unknown, code = 'INVALID_CONTROL_REQUEST'): RendererHeapSnapshotInspectInput {
  const r = rpcRecord(value, ['captureId'], code)
  if (r.captureId !== undefined) captureId(r.captureId, code)
  return r as RendererHeapSnapshotInspectInput
}
export function parseRendererHeapSnapshotCapture(value: unknown, input?: RendererHeapSnapshotInput): RendererHeapSnapshotCapture {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const r = fields(value, ['target', 'captureId', 'schema', 'scope', 'host', 'status', 'timing', 'native', 'sourceVerified', 'artifact', 'issues'], code)
  const target = parseRendererV8Target(r.target, code), originalHost = host(r.host, code)
  captureId(r.captureId, code)
  if (r.schema !== 'agentmux.renderer-heap-snapshot.v1' || r.scope !== 'renderer-v8-isolate' ||
    !['completed', 'failed', 'unknown'].includes(r.status as string) || input &&
    (r.captureId !== input.captureId || !sameRendererV8ProfileTarget(target, input.target))) invalid(code)
  const timing = fields(r.timing, ['requestedAt', 'nativeRequestedAt', 'nativeSettledAt', 'finishedAt'], code)
  if (!number(timing.requestedAt) || !number(timing.finishedAt) ||
    timing.nativeRequestedAt !== null && !number(timing.nativeRequestedAt) ||
    timing.nativeSettledAt !== null && !number(timing.nativeSettledAt)) invalid(code)
  const native = fields(r.native, ['requested', 'settled', 'succeeded'], code)
  const source = fields(r.sourceVerified, ['before', 'after'], code)
  if (native.requested !== null && typeof native.requested !== 'boolean' || native.settled !== null && typeof native.settled !== 'boolean' ||
    typeof source.before !== 'boolean' || typeof source.after !== 'boolean' ||
    native.settled === true && native.requested !== true ||
    (native.settled === true ? typeof native.succeeded !== 'boolean' : native.succeeded !== null) ||
    (native.requested === true) !== (timing.nativeRequestedAt !== null) || (native.settled === true) !== (timing.nativeSettledAt !== null)) invalid(code)
  if (r.artifact !== null) {
    const a = fields(r.artifact, ['kind', 'captureId', 'host', 'format', 'path', 'byteLength', 'sha256'], code)
    text(a.path, 16384, code)
    if (a.kind !== 'renderer-heap-snapshot' || a.captureId !== r.captureId || a.format !== 'v8-heapsnapshot' ||
      !sameHost(host(a.host, code), originalHost) || !Number.isSafeInteger(a.byteLength) || Number(a.byteLength) <= 0 ||
      typeof a.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(a.sha256)) invalid(code)
  }
  if (!Array.isArray(r.issues) || Object.getPrototypeOf(r.issues) !== Array.prototype || r.issues.length > 8 ||
    Reflect.ownKeys(r.issues).length !== r.issues.length + 1) invalid(code)
  for (let n = 0; n < r.issues.length; n++) {
    const d = Object.getOwnPropertyDescriptor(r.issues, String(n))
    if (!d?.enumerable || !('value' in d)) invalid(code)
    issue(d.value, code)
  }
  if (r.status === 'completed' ? !source.before || !source.after || native.requested !== true || native.settled !== true || native.succeeded !== true || r.artifact === null || r.issues.length !== 0 : r.issues.length === 0) invalid(code)
  return r as RendererHeapSnapshotCapture
}
export function parseRendererHeapSnapshotResult(value: unknown, input?: RendererHeapSnapshotInput): RendererHeapSnapshotResult {
  const code = 'CONTROL_PROTOCOL_ERROR', r = fields(value, ['capture', 'persistence'], code)
  parseRendererHeapSnapshotCapture(r.capture, input)
  const p = fields(r.persistence, ['status', 'phase', 'issue'], code)
  if (!['confirmed', 'failed', 'unknown'].includes(p.status as string) ||
    ![null, 'before-replace', 'after-replace'].includes(p.phase as string | null)) invalid(code)
  if (p.issue !== null) issue(p.issue, code)
  if (p.status === 'confirmed' ? p.phase !== null || p.issue !== null : p.issue === null ||
    (p.status === 'unknown' ? p.phase !== null && p.phase !== 'after-replace' : p.phase !== 'before-replace')) invalid(code)
  return r as RendererHeapSnapshotResult
}
export function parseRendererHeapSnapshotInspection(value: unknown, input: RendererHeapSnapshotInspectInput = {}): RendererHeapSnapshotInspection {
  const code = 'CONTROL_PROTOCOL_ERROR', r = fields(value, ['status', 'capture', 'issue'], code)
  if (!['available', 'absent', 'mismatch', 'unavailable'].includes(r.status as string)) invalid(code)
  if (r.issue !== null) issue(r.issue, code)
  if (r.capture !== null) parseRendererHeapSnapshotCapture(r.capture)
  if (r.status === 'available' ? r.capture === null || r.issue !== null || input.captureId !== undefined &&
    (r.capture as RendererHeapSnapshotCapture).captureId !== input.captureId :
    r.capture !== null || (r.status === 'absent' ? r.issue !== null : r.issue === null)) invalid(code)
  return r as RendererHeapSnapshotInspection
}
