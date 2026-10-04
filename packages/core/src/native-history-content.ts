import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'
import { AgentMuxError } from './errors.js'
import type { AgentProviderSessionHistoryContext, AgentSessionHistoryContentPart, AgentSessionHistoryItem,
  AgentSessionHistoryResourceReadOptions, AgentSessionHistoryResourceReadResult } from './types.js'

export type NativeContentExtent = { path: string; dev: number; ino: number; cut: number; head: string; tail: string }
export type NativeContentRange = NativeContentExtent & { start: number; end: number }
type Segment = { literal: string } | (NativeContentRange & { escapeDepth: number; byteLength: number })
type Reference = { version: 1; authority: string; agentSessionId?: string; providerId: string; nativeSessionId: string; ownerPath: string;
  recordId: string; partIndex: number; turnId?: string; segments: Segment[]; byteLength: number; sha256: string }
const key = randomBytes(32)
const prefix = 'amux-native-content:'
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const failure = (message: string, code = 'AGENT_SESSION_HISTORY_RESOURCE_MISMATCH'): never => {
  throw new AgentMuxError(message, code)
}
export function isNativeContentReference(reference: string): boolean { return reference.startsWith(prefix) }

function signingKey(secret?: string): Buffer { return secret === undefined ? key : createHmac('sha256', secret).update('agentmux/native-history-content/v1').digest() }
function encode(value: Reference, secret?: string): string {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url')
  return prefix + body + '.' + createHmac('sha256', signingKey(secret)).update(body).digest('base64url')
}
function decode(reference: string, secret?: string, verify = true): Reference {
  try {
    const [body, mac, extra] = reference.slice(prefix.length).split('.')
    if (!body || !mac || extra !== undefined) return failure('Native content reference is invalid.')
    const expected = createHmac('sha256', signingKey(secret)).update(body).digest(), supplied = Buffer.from(mac, 'base64url')
    if (expected.length !== supplied.length || supplied.toString('base64url') !== mac ||
      Buffer.from(body, 'base64url').toString('base64url') !== body || verify && !timingSafeEqual(expected, supplied))
      return failure('Native content reference changed.')
    const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Reference
    if (value.version !== 1 || !Array.isArray(value.segments) || !Number.isSafeInteger(value.byteLength) || value.byteLength < 1 ||
      !/^[a-f0-9]{64}$/u.test(value.sha256)) return failure('Native content reference is invalid.')
    return value
  } catch (error) {
    if (error instanceof AgentMuxError) throw error
    return failure('Native content reference is invalid.')
  }
}
async function exactFile(range: NativeContentRange, signal: AbortSignal): Promise<FileHandle> {
  signal.throwIfAborted()
  const file = await open(range.path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const current = await file.stat(), named = await stat(range.path)
    if (!current.isFile() || current.dev !== range.dev || current.ino !== range.ino || current.size < range.cut ||
      named.dev !== current.dev || named.ino !== current.ino) {
      return failure('The original native content file was replaced or truncated.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
    }
    const length = Math.min(128, range.cut), head = Buffer.alloc(length), tail = Buffer.alloc(length)
    const first = await file.read(head, 0, length, 0), last = await file.read(tail, 0, length, range.cut - length)
    signal.throwIfAborted()
    if (first.bytesRead !== length || last.bytesRead !== length || digest(head) !== range.head || digest(tail) !== range.tail) {
      return failure('The original native content boundary changed.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
    }
    return file
  } catch (error) { await file.close(); throw error }
}
async function rangeBytes(range: NativeContentRange, offset: number, length: number, signal: AbortSignal): Promise<Buffer> {
  const file = await exactFile(range, signal)
  try {
    const data = Buffer.alloc(length), read = await file.read(data, 0, length, range.start + offset)
    signal.throwIfAborted()
    if (read.bytesRead !== length) return failure('The original native content changed during reading.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
    const after = await file.stat(), named = await stat(range.path)
    if (after.dev !== range.dev || after.ino !== range.ino || after.size < range.cut || named.dev !== after.dev || named.ino !== after.ino)
      return failure('The original native content changed during reading.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
    return data
  } finally { await file.close() }
}
const lengthOf = (segment: Segment) => 'literal' in segment ? Buffer.byteLength(segment.literal) : segment.byteLength
function escapeBytes(input: Buffer, depth: number): Buffer {
  let bytes = input
  for (let index = 0; index < depth; index++) {
    const extra = bytes.reduce((count, byte) => count + (byte === 34 || byte === 92 ? 1 : 0), 0)
    const escaped = Buffer.alloc(bytes.length + extra)
    let at = 0
    for (const byte of bytes) { if (byte === 34 || byte === 92) escaped[at++] = 92; escaped[at++] = byte }
    bytes = escaped
  }
  return bytes
}

/** Replace only this reader's private markers after the Provider has interpreted role, tools and filtering. */
export async function materializeNativeContent(
  context: AgentProviderSessionHistoryContext, item: AgentSessionHistoryItem,
  ranges: ReadonlyMap<string, NativeContentRange>
): Promise<AgentSessionHistoryItem> {
  if (!ranges.size) return item
  const contentParts: AgentSessionHistoryContentPart[] = []
  for (const part of item.contentParts) {
    const json = JSON.stringify(part)
    const matches = [...ranges].filter(([marker]) => json.includes(marker))
    if (!matches.length) { contentParts.push(part); continue }
    // Splice exact JSON string lexemes into the Provider's semantic part. A JSON-stringified
    // marker has quotes; a marker inside an already formatted string only replaces its body.
    const segments: Segment[] = []
    let position = 0
    const occurrences = matches.flatMap(([marker, range]) => {
      const result: Array<{ at: number; marker: string; range: NativeContentRange }> = []
      let at = json.indexOf(marker)
      while (at !== -1) { result.push({ at, marker, range }); at = json.indexOf(marker, at + marker.length) }
      return result
    }).sort((a, b) => a.at - b.at)
    for (const { at, marker, range } of occurrences) {
      segments.push({ literal: json.slice(position, at) })
      // Inside the serialized semantic string, the native string's original escapes are exact.
      // Dropping its outer quotes preserves the enclosing semantic string and any prefix/suffix.
      let slashes = 0
      if (json[at - 1] === '"' && json[at + marker.length] === '\\') {
        for (let before = at - 2; before >= 0 && json[before] === '\\'; before--) slashes++
      }
      const depth = Math.log2(slashes + 1)
      segments.push({ ...range, start: range.start + 1, end: range.end - 1,
        escapeDepth: Number.isInteger(depth) ? depth : 0, byteLength: 0 })
      position = at + marker.length
    }
    segments.push({ literal: json.slice(position) })
    const hash = createHash('sha256')
    for (const segment of segments) {
      if ('literal' in segment) { hash.update(segment.literal); continue }
      for (let offset = 0; offset < segment.end - segment.start; offset += 64 * 1024) {
        context.signal.throwIfAborted()
        const bytes = escapeBytes(await rangeBytes(segment, offset, Math.min(64 * 1024, segment.end - segment.start - offset), context.signal), segment.escapeDepth)
        hash.update(bytes); segment.byteLength += bytes.length
      }
    }
    const byteLength = segments.reduce((total, segment) => total + lengthOf(segment), 0), sha256 = hash.digest('hex')
    const reference = encode({ version: 1, authority: digest(signingKey(context.contentSigningSecret)), ...(context.agentSessionId === undefined ? {} : { agentSessionId: context.agentSessionId }),
      ...context.source, ownerPath: context.transcriptPath!, recordId: item.id,
      partIndex: contentParts.length, ...(item.turnId === undefined ? {} : { turnId: item.turnId }), segments, byteLength, sha256 }, context.contentSigningSecret)
    contentParts.push({ kind: 'resource', resourceType: 'text', reference,
      label: `Complete ${part.kind}`, content: { encoding: 'json-utf8', kind: part.kind, byteLength, sha256 } })
  }
  return { ...item, contentParts }
}

/** The signed read extent was issued by the original Provider; caller fields grant no path authority. */
export async function readNativeContentResource(
  context: Omit<AgentProviderSessionHistoryContext, 'cursor' | 'limit'>,
  input: AgentSessionHistoryResourceReadOptions
): Promise<AgentSessionHistoryResourceReadResult['result']> {
  const reference = decode(input.expectedReference, context.contentSigningSecret)
  if (reference.agentSessionId !== context.agentSessionId || reference.providerId !== context.source.providerId || reference.nativeSessionId !== context.source.nativeSessionId ||
    reference.ownerPath !== context.transcriptPath || reference.recordId !== input.recordId || reference.turnId !== input.turnId ||
    reference.partIndex !== input.partIndex) return failure('This content reference belongs to another native record or source.')
  const offsetBytes = input.offsetBytes ?? 0, maxBytes = input.maxBytes ?? 64 * 1024
  if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0 || offsetBytes >= reference.byteLength || maxBytes > 128 * 1024)
    return failure('Native content requires a valid offset and a bounded 1–131072 byte read.', 'INVALID_AGENT_SESSION_HISTORY_RESOURCE')
  const length = Math.min(maxBytes, reference.byteLength - offsetBytes), chunks: Buffer[] = []
  let skip = offsetBytes, remaining = length
  for (const segment of reference.segments) {
    const bytes = lengthOf(segment)
    if (skip >= bytes) { skip -= bytes; continue }
    const take = Math.min(remaining, bytes - skip)
    if ('literal' in segment) chunks.push(Buffer.from(segment.literal).subarray(skip, skip + take))
    else if (!segment.escapeDepth) chunks.push(await rangeBytes(segment, skip, take, context.signal))
    else {
      // Formatted JSON inside a semantic string has another escape layer. Stream it without
      // materializing the value; an explicit offset may require scanning that related value.
      let valueSkip = skip, left = take
      for (let physical = 0; physical < segment.end - segment.start && left; physical += 64 * 1024) {
        const bytes = escapeBytes(await rangeBytes(segment, physical, Math.min(64 * 1024, segment.end - segment.start - physical), context.signal), segment.escapeDepth)
        if (valueSkip >= bytes.length) { valueSkip -= bytes.length; continue }
        const available = Math.min(left, bytes.length - valueSkip)
        chunks.push(bytes.subarray(valueSkip, valueSkip + available)); left -= available; valueSkip = 0
      }
      if (left) return failure('Native content escaped extent is invalid.')
    }
    skip = 0; remaining -= take
    if (!remaining) break
  }
  if (remaining) return failure('Native content reference has an invalid extent.')
  const data = Buffer.concat(chunks), nextOffsetBytes = offsetBytes + length === reference.byteLength ? null : offsetBytes + length
  return { status: 'fragment', encoding: 'json-utf8', dataBase64: data.toString('base64'), byteLength: data.length,
    offsetBytes, totalBytes: reference.byteLength, sha256: reference.sha256, nextOffsetBytes }
}

/** A changed credential is not a changed native source. Unauthenticated fields grant no read scope. */
export function nativeContentNeedsRevalidation(reference: string, secret?: string): boolean {
  return decode(reference, secret, false).authority !== digest(signingKey(secret))
}
/** Only a newly issued reference from the original Provider may authorize an old credential's extent. */
export function revalidateNativeContentReference(original: string, fresh: string, secret?: string): void {
  const old = decode(original, secret, false), current = decode(fresh, secret)
  const facts = ({ authority: _authority, segments, ...rest }: Reference) => ({ ...rest, segments: segments.map(segment =>
    'literal' in segment ? segment : { path: segment.path, dev: segment.dev, ino: segment.ino, start: segment.start,
      end: segment.end, escapeDepth: segment.escapeDepth, byteLength: segment.byteLength }) })
  if (JSON.stringify(facts(old)) !== JSON.stringify(facts(current))) failure('The original Provider record or content changed.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
}
