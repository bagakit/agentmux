import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'
import { AgentMuxError } from './errors.js'
import { NativeText, nativeStringMetadata, appendNativeStringMetadata, type NativeTextValue } from './native-history-value.js'

export type NativeContentExtent = { path: string; dev: number; ino: number; cut: number; head: string; tail: string }
export type NativeContentRange = NativeContentExtent & { start: number; end: number }
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function changed(message: string): never { throw new AgentMuxError(message, 'AGENT_SESSION_HISTORY_SOURCE_CHANGED') }

async function exactFile(range: NativeContentRange, signal: AbortSignal): Promise<FileHandle> {
  signal.throwIfAborted()
  const file = await open(range.path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const current = await file.stat(), named = await stat(range.path)
    if (!current.isFile() || current.dev !== range.dev || current.ino !== range.ino || current.size < range.cut ||
      named.dev !== current.dev || named.ino !== current.ino) changed('The original native content file was replaced or truncated.')
    const length = Math.min(128, range.cut), head = Buffer.alloc(length), tail = Buffer.alloc(length)
    const first = await file.read(head, 0, length, 0), last = await file.read(tail, 0, length, range.cut - length)
    signal.throwIfAborted()
    if (first.bytesRead !== length || last.bytesRead !== length || digest(head) !== range.head || digest(tail) !== range.tail)
      changed('The original native content boundary changed.')
    return file
  } catch (error) { await file.close(); throw error }
}
export async function nativeRangeBytes(range: NativeContentRange, offset: number, length: number, signal: AbortSignal): Promise<Buffer> {
  const file = await exactFile(range, signal)
  try {
    const data = Buffer.alloc(length), read = await file.read(data, 0, length, range.start + offset)
    signal.throwIfAborted()
    if (read.bytesRead !== length) changed('The original native content changed during reading.')
    const after = await file.stat(), named = await stat(range.path)
    if (after.dev !== range.dev || after.ino !== range.ino || after.size < range.cut || named.dev !== after.dev || named.ino !== after.ino)
      changed('The original native content changed during reading.')
    return data
  } finally { await file.close() }
}

/** Decode bounded, complete string lexemes using JSON.parse; retain at most one split escape. */
export async function* nativeStringChunks(range: NativeContentRange, signal: AbortSignal): AsyncGenerator<{ range: NativeContentRange; raw: string; text: string }> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = '', start = range.start
  for (let offset = 0; offset < range.end - range.start; offset += 64 * 1024) {
    const length = Math.min(64 * 1024, range.end - range.start - offset)
    const last = offset + length === range.end - range.start
    let raw = pending + decoder.decode(await nativeRangeBytes(range, offset, length, signal), { stream: !last })
    let end = raw.length
    const slash = raw.lastIndexOf('\\')
    if (!last && slash !== -1) {
      let run = 1
      while (raw[slash - run] === '\\') run++
      if (run % 2 && (slash === raw.length - 1 || raw[slash + 1] === 'u' && raw.length - slash < 6)) end = slash
    }
    // Keep an escaped high surrogate with the following code unit. JSON formatting
    // and UTF-8/Base64 encoding then see the same pair as JSON.parse of the full value.
    const high = raw.slice(0, end).match(/\\u[dD][89aAbB][a-fA-F0-9]{2}$/u)
    if (!last && high) {
      let slashes = 1
      while (raw[end - 6 - slashes] === '\\') slashes++
      if (slashes % 2) end -= 6
    }
    pending = raw.slice(end); raw = raw.slice(0, end)
    if (!raw) continue
    const bytes = Buffer.byteLength(raw)
    let text: string
    try { text = JSON.parse('"' + raw + '"') as string }
    catch { changed('The original native string changed during reading.') }
    yield { range: { ...range, start, end: start + bytes }, raw, text: text! }
    start += bytes
  }
  if (pending || start !== range.end) changed('The original native string has an incomplete extent.')
}

function rawIndex(raw: string, decodedIndex: number): number {
  let at = 0, decoded = 0
  while (decoded < decodedIndex && at < raw.length) {
    at += raw[at] === '\\' ? raw[at + 1] === 'u' ? 6 : 2 : 1
    decoded++
  }
  return at
}

/** Resolve a Provider-selected UTF-16 interval to its exact physical JSON string body. */
export async function nativeStringRange(source: NativeContentRange, start: number, end: number, total: number, signal: AbortSignal): Promise<NativeContentRange> {
  const body = { ...source, start: source.start + 1, end: source.end - 1 }
  if (start === 0 && end === total) return body
  let position = 0, from: number | undefined, to: number | undefined
  for await (const chunk of nativeStringChunks(body, signal)) {
    if (from === undefined && start <= position + chunk.text.length)
      from = chunk.range.start + Buffer.byteLength(chunk.raw.slice(0, rawIndex(chunk.raw, start - position)))
    if (end <= position + chunk.text.length) {
      to = chunk.range.start + Buffer.byteLength(chunk.raw.slice(0, rawIndex(chunk.raw, end - position))); break
    }
    position += chunk.text.length
  }
  if (from === undefined || to === undefined || from > to) changed('The native string selection is invalid.')
  return { ...body, start: from!, end: to! }
}

/** Provider supplies delimiters; physical reading knows no vendor protocol. */
export async function nativeTextBetween(value: NativeTextValue, opening: string, closing: string, signal: AbortSignal): Promise<NativeTextValue> {
  if (typeof value === 'string') {
    const found = value.indexOf(opening), start = found === -1 ? 0 : found + opening.length
    const end = found === -1 ? -1 : value.indexOf(closing, start)
    return end === -1 ? value.slice(start) : value.slice(start, end)
  }
  const segment = value.segments[0]
  if (value.segments.length !== 1 || !segment || 'literal' in segment || segment.start || segment.end !== segment.metadata.length)
    throw new TypeError('Delimited selection requires an original native string.')
  let overlap = '', position = 0, start: number | undefined, end: number | undefined
  for await (const chunk of nativeStringChunks({ ...segment.source, start: segment.source.start + 1, end: segment.source.end - 1 }, signal)) {
    const combined = overlap + chunk.text, origin = position - overlap.length
    if (start === undefined) {
      const found = combined.indexOf(opening)
      if (found !== -1) start = origin + found + opening.length
    }
    if (start !== undefined) {
      const found = combined.indexOf(closing, Math.max(0, start - origin))
      if (found !== -1) { end = origin + found; break }
    }
    position += chunk.text.length
    overlap = combined.slice(-Math.max(opening.length, closing.length))
  }
  if (start === undefined) return value
  const from = start, to = end ?? segment.metadata.length
  const range = await nativeStringRange(segment.source, from, to, segment.metadata.length, signal)
  const metadata = nativeStringMetadata()
  for await (const chunk of nativeStringChunks(range, signal)) appendNativeStringMetadata(metadata, chunk.text)
  // Keep the original full-string extent and express the selected interval in its units.
  return new NativeText([{ ...segment, start: from, end: to, metadata: { ...segment.metadata,
    trimmedStart: from + metadata.trimmedStart, trimmedEnd: from + metadata.trimmedEnd } }])
}
