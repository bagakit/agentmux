import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { decodeBase64, encodeBase64 } from './hosted-value.js'
import type { AgentSessionHistoryResourceRequest, AgentSessionHistoryResourceReadOptions, AgentSessionHistoryResourceReadResult, AgentProviderSessionHistoryResourceReadResult } from './types.js'

export const SESSION_HISTORY_IMAGE_MAX_BYTES = 16 * 1024 * 1024
// Bounded raster decode memory, matching the existing Browser screenshot budget.
const MAX_PIXELS = 32 * 1024 * 1024
const MAX_DIMENSION = 16_384
const MAX_REFERENCE_CHARS = Math.ceil(SESSION_HISTORY_IMAGE_MAX_BYTES / 3) * 4 + 128
export type AgentSessionHistoryResourceParams = AgentSessionHistoryResourceRequest & { hostId: string; agentSessionId: string }
export type AgentSessionHistoryResourceResult = AgentSessionHistoryResourceReadResult & { hostId: string }
const requestFields = ['source', 'turnId', 'recordId', 'partIndex', 'expectedReference', 'maxBytes', 'offsetBytes'] as const
function invalid(message: string, code = 'INVALID_AGENT_SESSION_HISTORY_RESOURCE'): never { throw new AgentMuxError(message, code) }
function exactString(value: unknown, name: string, code: string, max = 16_384): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > max || /[\0\r\n]/u.test(value)) invalid(`${name} requires an exact bounded string.`, code)
}
/** Validate caller identity/compare constraints; no caller field grants filesystem scope. */
export function parseSessionHistoryResourceOptions(value: unknown): AgentSessionHistoryResourceReadOptions {
  const code = 'INVALID_AGENT_SESSION_HISTORY_RESOURCE'
  const p = rpcRecord(value, [...requestFields, 'signal', 'commandOverride', 'args', 'env'], code)
  const source = rpcRecord(p.source, ['providerId', 'nativeSessionId'], code)
  exactString(source.providerId, 'Provider', code); exactString(source.nativeSessionId, 'Native Session', code)
  exactString(p.recordId, 'Record', code)
  if (p.turnId !== undefined) exactString(p.turnId, 'Turn', code)
  exactString(p.expectedReference, 'Expected reference', code, MAX_REFERENCE_CHARS)
  if (!Number.isSafeInteger(p.partIndex) || (p.partIndex as number) < 0) invalid('A resource requires its exact content-part index.', code)
  if (p.maxBytes !== undefined && (!Number.isSafeInteger(p.maxBytes) || (p.maxBytes as number) < 1 || (p.maxBytes as number) > SESSION_HISTORY_IMAGE_MAX_BYTES))
    invalid('Image maxBytes may only reduce the fixed 16 MiB budget.', code)
  if (p.offsetBytes !== undefined && (!Number.isSafeInteger(p.offsetBytes) || (p.offsetBytes as number) < 0)) invalid('Content offset must be a nonnegative safe byte position.', code)
  if (p.signal !== undefined && !(p.signal instanceof AbortSignal)) invalid('Resource cancellation requires an AbortSignal.', code)
  if (p.commandOverride !== undefined) exactString(p.commandOverride, 'Executor command', code)
  if (p.args !== undefined && (!Array.isArray(p.args) || p.args.some(arg => typeof arg !== 'string' || arg.includes('\0')))) invalid('Executor args must be strings.', code)
  if (p.env !== undefined) {
    const env = rpcRecord(p.env, undefined, code)
    if (Object.entries(env).some(([key, entry]) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || entry !== undefined && (typeof entry !== 'string' || entry.includes('\0'))))
      invalid('Executor env must contain bounded process values.', code)
  }
  return p as AgentSessionHistoryResourceReadOptions
}
export function parseSessionHistoryResourceParams(value: unknown): AgentSessionHistoryResourceParams {
  const p = rpcRecord(value, ['hostId', 'agentSessionId', ...requestFields])
  exactString(p.hostId, 'Host', 'INVALID_CONTROL_REQUEST'); exactString(p.agentSessionId, 'Agent Session', 'INVALID_CONTROL_REQUEST')
  const { hostId, agentSessionId, ...request } = p
  parseSessionHistoryResourceOptions(request)
  return p as AgentSessionHistoryResourceParams
}

type Read = Extract<AgentSessionHistoryResourceReadResult['result'], { status: 'read' }>
export function unavailable(code: string, message: string): Extract<AgentSessionHistoryResourceReadResult['result'], { status: 'unavailable' }> {
  return { status: 'unavailable', code, message }
}
function imageHeader(bytes: Uint8Array): { mimeType: Read['mimeType']; width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const matches = (offset: number, value: readonly number[]) => value.every((byte, index) => bytes[offset + index] === byte)
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))
  const uint24 = (offset: number) => bytes[offset]! | bytes[offset + 1]! << 8 | bytes[offset + 2]! << 16
  if (bytes.length >= 33 && matches(0, [137, 80, 78, 71, 13, 10, 26, 10]) &&
    view.getUint32(8) === 13 && ascii(12, 16) === 'IHDR')
    return { mimeType: 'image/png', width: view.getUint32(16), height: view.getUint32(20) }
  if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6)))
    return { mimeType: 'image/gif', width: view.getUint16(6, true), height: view.getUint16(8, true) }
  if (bytes[0] === 255 && bytes[1] === 216) {
    for (let offset = 2; offset + 4 <= bytes.length;) {
      if (bytes[offset] !== 255) break
      const marker = bytes[offset + 1]!
      if (marker === 255) { offset++; continue }
      const length = view.getUint16(offset + 2)
      if (length < 2 || offset + 2 + length > bytes.length) break
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 8)
        return { mimeType: 'image/jpeg', height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) }
      offset += length + 2
    }
  }
  if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    const format = ascii(12, 16)
    if (format === 'VP8X') return { mimeType: 'image/webp', width: uint24(24) + 1, height: uint24(27) + 1 }
    if (format === 'VP8 ' && matches(23, [157, 1, 42]))
      return { mimeType: 'image/webp', width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    if (format === 'VP8L' && bytes[20] === 47) {
      const dimensions = view.getUint32(21, true)
      return { mimeType: 'image/webp', width: (dimensions & 0x3fff) + 1, height: ((dimensions >>> 14) & 0x3fff) + 1 }
    }
  }
  return null
}
export function imageBytes(bytes: Uint8Array, maxBytes: number, declaredMime?: string): AgentSessionHistoryResourceReadResult['result'] {
  if (!bytes.length || bytes.length > maxBytes) return unavailable('AGENT_SESSION_HISTORY_RESOURCE_TOO_LARGE', 'The recorded image is empty or exceeds this read’s byte budget. Its reference is kept.')
  const image = imageHeader(bytes)
  if (!image || declaredMime !== undefined && declaredMime !== image.mimeType) return unavailable('AGENT_SESSION_HISTORY_RESOURCE_FORMAT_UNSUPPORTED', 'The recorded bytes are not a supported PNG, JPEG, GIF or WebP image. Its reference is kept.')
  if (image.width < 1 || image.height < 1 || image.width > MAX_DIMENSION || image.height > MAX_DIMENSION || image.width * image.height > MAX_PIXELS)
    return unavailable('AGENT_SESSION_HISTORY_RESOURCE_DECODE_BUDGET', 'The recorded image exceeds the 16384 pixel side or 32 megapixel decode budget. Its reference is kept.')
  return { status: 'read', mimeType: image.mimeType, dataBase64: encodeBase64(bytes), byteLength: bytes.length }
}

/** Validate the Provider's complete exact resource without inventing a Core Session identity. */
export function parseProviderSessionHistoryResourceReadResult(value: unknown,
  expected: AgentSessionHistoryResourceRequest): AgentProviderSessionHistoryResourceReadResult {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const p = rpcRecord(value, ['source', 'turnId', 'recordId', 'partIndex', 'reference', 'label', 'result'], code)
  const source = rpcRecord(p.source, ['providerId', 'nativeSessionId'], code)
  if (source.providerId !== expected.source.providerId ||
    source.nativeSessionId !== expected.source.nativeSessionId || p.turnId !== expected.turnId || p.recordId !== expected.recordId ||
    p.partIndex !== expected.partIndex || p.reference !== expected.expectedReference) invalid('Another recorded resource was returned.', code)
  if (p.label !== undefined && typeof p.label !== 'string') invalid('Resource label must remain text.', code)
  const result = rpcRecord(p.result, undefined, code)
  if (result.status === 'unavailable') {
    rpcRecord(result, ['status', 'code', 'message'], code)
    exactString(result.code, 'Resource failure code', code)
    if (typeof result.message !== 'string') invalid('Resource failure requires its readable reason.', code)
  } else if (result.status === 'read') {
    rpcRecord(result, ['status', 'mimeType', 'dataBase64', 'byteLength'], code)
    if (typeof result.dataBase64 !== 'string' || result.dataBase64.length > Math.ceil((expected.maxBytes ?? SESSION_HISTORY_IMAGE_MAX_BYTES) / 3) * 4 ||
      !Number.isSafeInteger(result.byteLength) || (result.byteLength as number) < 1) invalid('Resource bytes exceed their read budget.', code)
    let bytes: Uint8Array
    try { bytes = decodeBase64(result.dataBase64) }
    catch { invalid('Recorded resource bytes or MIME are invalid.', code) }
    if (bytes.length !== result.byteLength || encodeBase64(bytes) !== result.dataBase64 ||
      imageBytes(bytes, expected.maxBytes ?? SESSION_HISTORY_IMAGE_MAX_BYTES, String(result.mimeType)).status !== 'read') invalid('Recorded resource bytes or MIME are invalid.', code)
  } else if (result.status === 'fragment') {
    rpcRecord(result, ['status', 'encoding', 'dataBase64', 'byteLength', 'offsetBytes', 'totalBytes', 'sha256', 'nextOffsetBytes', 'continuationReference'], code)
    if (result.continuationReference !== undefined) exactString(result.continuationReference, 'Renewed content authority', code, MAX_REFERENCE_CHARS)
    const max = expected.maxBytes ?? 64 * 1024
    if (result.encoding !== 'json-utf8' || max > 128 * 1024 || typeof result.dataBase64 !== 'string' ||
      result.dataBase64.length > Math.ceil(max / 3) * 4 || !Number.isSafeInteger(result.byteLength) || (result.byteLength as number) < 1 ||
      result.offsetBytes !== (expected.offsetBytes ?? 0) || !Number.isSafeInteger(result.totalBytes) ||
      (result.totalBytes as number) < (result.offsetBytes as number) + (result.byteLength as number) ||
      typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(result.sha256)) invalid('Text content fragment exceeds its exact read scope.', code)
    const bytes = decodeBase64(result.dataBase64)
    const after = (result.offsetBytes as number) + bytes.length
    if (bytes.length !== result.byteLength || bytes.length > max || encodeBase64(bytes) !== result.dataBase64 ||
      result.nextOffsetBytes !== (after === result.totalBytes ? null : after)) invalid('Text content fragment has an invalid continuation.', code)
  } else invalid('Resource read has an unknown status.', code)
  return p as AgentProviderSessionHistoryResourceReadResult
}

export function parseSessionHistoryResourceResult(value: unknown, expected: AgentSessionHistoryResourceParams): AgentSessionHistoryResourceResult {
  const p = rpcRecord(value, ['hostId', 'agentSessionId', 'source', 'turnId', 'recordId', 'partIndex', 'reference', 'label', 'result'], 'CONTROL_PROTOCOL_ERROR')
  if (p.hostId !== expected.hostId || p.agentSessionId !== expected.agentSessionId) invalid('Another recorded resource was returned.', 'CONTROL_PROTOCOL_ERROR')
  const { hostId: _hostId, agentSessionId: _agentSessionId, ...resource } = p
  parseProviderSessionHistoryResourceReadResult(resource, expected)
  return p as AgentSessionHistoryResourceResult
}

/** Hosted SDK replies carry no transport Host field; validate their complete exact shape before adaptation. */
export function parseSessionHistoryResourceReadResult(value: unknown, agentSessionId: string, expected: AgentSessionHistoryResourceReadOptions): AgentSessionHistoryResourceReadResult {
  const record = rpcRecord(value, ['agentSessionId', 'source', 'turnId', 'recordId', 'partIndex', 'reference', 'label', 'result'], 'CONTROL_PROTOCOL_ERROR')
  if (record.agentSessionId !== agentSessionId) invalid('Another recorded resource was returned.', 'CONTROL_PROTOCOL_ERROR')
  const { agentSessionId: _agentSessionId, ...resource } = record
  parseProviderSessionHistoryResourceReadResult(resource, expected)
  return record as AgentSessionHistoryResourceReadResult
}
