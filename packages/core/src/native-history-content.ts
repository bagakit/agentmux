import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { AgentMuxError } from './errors.js'
import type { AgentProviderSessionHistoryContext, AgentSessionHistoryContentPart, AgentSessionHistoryItem,
  AgentSessionHistoryResourceReadOptions, AgentSessionHistoryResourceReadResult } from './types.js'
import { NativeText, nativeJsonStringify, type NativeHistoryItem, type NativeTextSegment } from './native-history-value.js'
import { nativeRangeBytes, nativeStringChunks, nativeStringRange, type NativeContentRange } from './native-history-source.js'

type SourceBlock = NativeContentRange & { rawSha256: string }
type Segment = { literal: string; sourceBlocks?: SourceBlock[] } | (SourceBlock & { escapeDepth: number; byteLength: number; base64?: { skip: number; length: number } })
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

async function verifiedBlockBytes(block: SourceBlock, signal: AbortSignal): Promise<Buffer> {
  const raw = await nativeRangeBytes(block, 0, block.end - block.start, signal)
  if (digest(raw) !== block.rawSha256) return failure('The original native content block changed.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
  return raw
}
async function segmentBytes(segment: Exclude<Segment, { literal: string }>, signal: AbortSignal): Promise<Buffer> {
  const raw = await verifiedBlockBytes(segment, signal)
  if (segment.base64) {
    const text = JSON.parse('"' + raw.toString('utf8') + '"') as string
    return Buffer.from(Buffer.from(text, 'utf8').subarray(segment.base64.skip, segment.base64.skip + segment.base64.length).toString('base64'))
  }
  const decoded = JSON.parse('"' + raw.toString('utf8') + '"') as string
  return escapeBytes(Buffer.from(JSON.stringify(decoded).slice(1, -1)), segment.escapeDepth - 1)
}

/** Compile only Provider-selected semantics, with bounded source blocks for transformed values. */
async function contentSegments(value: NativeText, signal: AbortSignal): Promise<Segment[]> {
  const segments: Segment[] = []
  for (const valueSegment of value.segments) {
    if ('literal' in valueSegment) { segments.push(valueSegment); continue }
    const segment = valueSegment as Exclude<NativeTextSegment, { literal: string }>
    const range = await nativeStringRange(segment.source, segment.start, segment.end, segment.metadata.length, signal)
    if (range.start === range.end) continue
    if (!segment.base64) {
      if (!segment.escapeDepth) return failure('A semantic string was not JSON encoded.')
      // Canonical JSON formatting follows decoded values, including alternate native
      // escapes. Each signed physical block is independently verified at later offsets.
      for await (const chunk of nativeStringChunks(range, signal))
        segments.push({ ...chunk.range, escapeDepth: segment.escapeDepth, byteLength: 0, rawSha256: digest(Buffer.from(chunk.raw)) })
      continue
    }
    let carry = Buffer.alloc(0), carryBlocks: SourceBlock[] = []
    for await (const chunk of nativeStringChunks(range, signal)) {
      const bytes = Buffer.from(chunk.text, 'utf8'), block = { ...chunk.range, rawSha256: digest(Buffer.from(chunk.raw)) }
      let consumed = 0
      if (carry.length) {
        const take = Math.min(3 - carry.length, bytes.length), combined = Buffer.concat([carry, bytes.subarray(0, take)])
        if (combined.length < 3) { carry = combined; carryBlocks.push(block); continue }
        segments.push({ literal: combined.toString('base64'), sourceBlocks: [...carryBlocks, block] })
        carry = Buffer.alloc(0); consumed = take
      }
      const available = bytes.length - consumed, length = available - available % 3
      if (length) segments.push({ ...chunk.range, escapeDepth: 0, byteLength: length / 3 * 4,
        rawSha256: digest(Buffer.from(chunk.raw)), base64: { skip: consumed, length } })
      carry = bytes.subarray(consumed + length); carryBlocks = carry.length ? [block] : []
    }
    if (carry.length) segments.push({ literal: carry.toString('base64'), sourceBlocks: carryBlocks })
  }
  return segments
}

export async function materializeNativeContent(
  context: AgentProviderSessionHistoryContext, item: NativeHistoryItem
): Promise<AgentSessionHistoryItem> {
  const contentParts: AgentSessionHistoryContentPart[] = []
  for (const part of item.contentParts) {
    const json = nativeJsonStringify(part)
    if (typeof json === 'string') { contentParts.push(part as AgentSessionHistoryContentPart); continue }
    const segments = await contentSegments(json, context.signal)
    if (segments.every(segment => 'literal' in segment)) {
      contentParts.push(JSON.parse(segments.map(segment => 'literal' in segment ? segment.literal : '').join('')) as AgentSessionHistoryContentPart)
      continue
    }
    const hash = createHash('sha256')
    for (const segment of segments) {
      if ('literal' in segment) {
        for (const block of segment.sourceBlocks ?? []) await verifiedBlockBytes(block, context.signal)
        hash.update(segment.literal); continue
      }
      const bytes = await segmentBytes(segment, context.signal)
      hash.update(bytes); segment.byteLength = bytes.length
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
    if ('literal' in segment) {
      for (const block of segment.sourceBlocks ?? []) await verifiedBlockBytes(block, context.signal)
      chunks.push(Buffer.from(segment.literal).subarray(skip, skip + take))
    }
    else {
      const bytes = await segmentBytes(segment, context.signal)
      chunks.push(bytes.subarray(skip, skip + take))
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
  const sourceFacts = (block: SourceBlock) => ({ path: block.path, dev: block.dev, ino: block.ino,
    start: block.start, end: block.end, rawSha256: block.rawSha256 })
  const facts = ({ authority: _authority, segments, ...rest }: Reference) => ({ ...rest, segments: segments.map(segment =>
    'literal' in segment ? { literal: segment.literal, ...(segment.sourceBlocks ? { sourceBlocks: segment.sourceBlocks.map(sourceFacts) } : {}) }
      : { ...sourceFacts(segment), escapeDepth: segment.escapeDepth, byteLength: segment.byteLength,
        ...(segment.base64 ? { base64: segment.base64 } : {}) }) })
  if (JSON.stringify(facts(old)) !== JSON.stringify(facts(current))) failure('The original Provider record or content changed.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
}
