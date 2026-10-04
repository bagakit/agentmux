import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { AgentSessionHistoryResourceRequest, AgentSessionHistoryResourceReadOptions, AgentSessionHistoryResourceReadResult } from './types.js'

export const SESSION_HISTORY_IMAGE_MAX_BYTES = 16 * 1024 * 1024
// Bounded raster decode memory, matching the existing Browser screenshot budget.
const MAX_PIXELS = 32 * 1024 * 1024
const MAX_DIMENSION = 16_384
const MAX_REFERENCE_CHARS = Math.ceil(SESSION_HISTORY_IMAGE_MAX_BYTES / 3) * 4 + 128
export type AgentSessionHistoryResourceParams = AgentSessionHistoryResourceRequest & { hostId: string; agentSessionId: string }
export type AgentSessionHistoryResourceResult = AgentSessionHistoryResourceReadResult & { hostId: string }
const requestFields = ['source', 'turnId', 'recordId', 'partIndex', 'expectedReference', 'maxBytes'] as const
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
function unavailable(code: string, message: string): Extract<AgentSessionHistoryResourceReadResult['result'], { status: 'unavailable' }> {
  return { status: 'unavailable', code, message }
}
function imageHeader(bytes: Buffer): { mimeType: Read['mimeType']; width: number; height: number } | null {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR')
    return { mimeType: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)))
    return { mimeType: 'image/gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
  if (bytes[0] === 255 && bytes[1] === 216) {
    for (let offset = 2; offset + 4 <= bytes.length;) {
      if (bytes[offset] !== 255) break
      const marker = bytes[offset + 1]!
      if (marker === 255) { offset++; continue }
      const length = bytes.readUInt16BE(offset + 2)
      if (length < 2 || offset + 2 + length > bytes.length) break
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 8)
        return { mimeType: 'image/jpeg', height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) }
      offset += length + 2
    }
  }
  if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const format = bytes.toString('ascii', 12, 16)
    if (format === 'VP8X') return { mimeType: 'image/webp', width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 }
    if (format === 'VP8 ' && bytes.subarray(23, 26).equals(Buffer.from([157, 1, 42])))
      return { mimeType: 'image/webp', width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
    if (format === 'VP8L' && bytes[20] === 47) {
      const dimensions = bytes.readUInt32LE(21)
      return { mimeType: 'image/webp', width: (dimensions & 0x3fff) + 1, height: ((dimensions >>> 14) & 0x3fff) + 1 }
    }
  }
  return null
}
function imageBytes(bytes: Buffer, maxBytes: number, declaredMime?: string): AgentSessionHistoryResourceReadResult['result'] {
  if (!bytes.length || bytes.length > maxBytes) return unavailable('AGENT_SESSION_HISTORY_RESOURCE_TOO_LARGE', 'The recorded image is empty or exceeds this read’s byte budget. Its reference is kept.')
  const image = imageHeader(bytes)
  if (!image || declaredMime !== undefined && declaredMime !== image.mimeType) return unavailable('AGENT_SESSION_HISTORY_RESOURCE_FORMAT_UNSUPPORTED', 'The recorded bytes are not a supported PNG, JPEG, GIF or WebP image. Its reference is kept.')
  if (image.width < 1 || image.height < 1 || image.width > MAX_DIMENSION || image.height > MAX_DIMENSION || image.width * image.height > MAX_PIXELS)
    return unavailable('AGENT_SESSION_HISTORY_RESOURCE_DECODE_BUDGET', 'The recorded image exceeds the 16384 pixel side or 32 megapixel decode budget. Its reference is kept.')
  return { status: 'read', mimeType: image.mimeType, dataBase64: bytes.toString('base64'), byteLength: bytes.length }
}

/** Only the newly located true part supplies reference. No arbitrary caller path reaches this read. */
export async function readRecordedImage(reference: string, maxBytes: number, signal: AbortSignal): Promise<AgentSessionHistoryResourceReadResult['result']> {
  signal.throwIfAborted()
  if (reference.startsWith('data:')) {
    // Bound encoded length before allocation; accept canonical raster base64 only.
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/u.exec(reference)
    if (!match) return unavailable('AGENT_SESSION_HISTORY_RESOURCE_FORMAT_UNSUPPORTED', 'This recorded inline image is not canonical raster base64. Its reference is kept.')
    const encoded = match[2]!
    if (encoded.length > Math.ceil(maxBytes / 3) * 4) return unavailable('AGENT_SESSION_HISTORY_RESOURCE_TOO_LARGE', 'The recorded inline image exceeds this read’s byte budget. Its reference is kept.')
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.toString('base64') !== encoded) return unavailable('AGENT_SESSION_HISTORY_RESOURCE_FORMAT_UNSUPPORTED', 'This recorded inline image has invalid base64. Its reference is kept.')
    return imageBytes(bytes, maxBytes, match[1])
  }
  if (!isAbsolute(reference)) return unavailable('AGENT_SESSION_HISTORY_RESOURCE_REFERENCE_UNSUPPORTED', 'This opaque or remote image reference has no local byte source. No network request was made; its reference is kept.')
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    // Nonblocking open lets us reject FIFO/device targets before reading; /var symlinks remain valid.
    file = await open(reference, constants.O_RDONLY | constants.O_NONBLOCK)
    const before = await file.stat({ bigint: true })
    if (!before.isFile()) return unavailable('AGENT_SESSION_HISTORY_RESOURCE_NOT_FILE', 'The recorded image path is not a regular file. Its reference is kept.')
    if (before.size < 1n || before.size > BigInt(maxBytes)) return unavailable('AGENT_SESSION_HISTORY_RESOURCE_TOO_LARGE', 'The recorded image is empty or exceeds this read’s byte budget. Its reference is kept.')
    const bytes = Buffer.alloc(Number(before.size))
    let offset = 0
    while (offset < bytes.length) {
      signal.throwIfAborted()
      const read = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) break
      offset += read.bytesRead
    }
    signal.throwIfAborted()
    const after = await file.stat({ bigint: true }), named = await stat(reference, { bigint: true })
    if (offset !== bytes.length || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after]) ||
      named.dev !== after.dev || named.ino !== after.ino)
      return unavailable('AGENT_SESSION_HISTORY_RESOURCE_CHANGED', 'The exact recorded file changed during reading. Retry this resource; its reference is kept.')
    return imageBytes(bytes, maxBytes)
  } catch (error) {
    signal.throwIfAborted()
    return unavailable('AGENT_SESSION_HISTORY_RESOURCE_UNAVAILABLE', error instanceof Error ? error.message : String(error))
  } finally { await file?.close() }
}

export function parseSessionHistoryResourceResult(value: unknown, expected: AgentSessionHistoryResourceParams): AgentSessionHistoryResourceResult {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const p = rpcRecord(value, ['hostId', 'agentSessionId', 'source', 'turnId', 'recordId', 'partIndex', 'reference', 'label', 'result'], code)
  const source = rpcRecord(p.source, ['providerId', 'nativeSessionId'], code)
  if (p.hostId !== expected.hostId || p.agentSessionId !== expected.agentSessionId || source.providerId !== expected.source.providerId ||
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
    const bytes = Buffer.from(result.dataBase64, 'base64')
    if (bytes.length !== result.byteLength || bytes.toString('base64') !== result.dataBase64 ||
      imageBytes(bytes, expected.maxBytes ?? SESSION_HISTORY_IMAGE_MAX_BYTES, String(result.mimeType)).status !== 'read') invalid('Recorded resource bytes or MIME are invalid.', code)
  } else invalid('Resource read has an unknown status.', code)
  return p as AgentSessionHistoryResourceResult
}

/** Hosted SDK replies carry no transport Host field; validate their complete exact shape before adaptation. */
export function parseSessionHistoryResourceReadResult(value: unknown, agentSessionId: string, expected: AgentSessionHistoryResourceReadOptions): AgentSessionHistoryResourceReadResult {
  const record = rpcRecord(value, ['agentSessionId', 'source', 'turnId', 'recordId', 'partIndex', 'reference', 'label', 'result'], 'CONTROL_PROTOCOL_ERROR')
  const { hostId: _hostId, ...result } = parseSessionHistoryResourceResult({ ...record, hostId: 'local' },
    { ...expected, hostId: 'local', agentSessionId })
  return result
}
