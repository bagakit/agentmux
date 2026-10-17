import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import parser, { type Token } from 'stream-json/parser.js'
import { AgentMuxError } from './errors.js'
import { RENDERER_TRACE_MAX_GZIP_BYTES } from './renderer-trace.js'

/** A decoded scan bound, not a promise that every requested recording will fit. */
export const RENDERER_TRACE_MAX_RAW_BYTES = 64 * 1024 * 1024
export type RendererTraceByteProgress = { gzipBytes: number; rawBytes: number; events: number }
export type RendererTraceByteScan = RendererTraceByteProgress & { gzipSha256: string; rawSha256: string }
export type RendererTraceByteOptions = {
  signal?: AbortSignal
  onDecodedChunk?: (chunk: Uint8Array) => void | Promise<void>
  onProgress?: (facts: RendererTraceByteProgress) => void
}
const invalid = (message: string): never => { throw new AgentMuxError(message, 'CONTROL_PROTOCOL_ERROR') }

/** Validate one original gzip/UTF8/JSON document without collecting its raw body or events.
 * Only this Node entry imports zlib/stream-json. Its caller retains the original compressed
 * material and owns native handles; cancellation here does not close a CDP stream.
 */
export async function scanRendererTraceBytes(source: AsyncIterable<Uint8Array>, options: RendererTraceByteOptions = {}): Promise<RendererTraceByteScan> {
  options.signal?.throwIfAborted()
  const gzipHash = createHash('sha256'), rawHash = createHash('sha256')
  const progress: RendererTraceByteProgress = { gzipBytes: 0, rawBytes: 0, events: 0 }
  const report = () => options.onProgress?.({ ...progress })
  // Keys and strings stream without aggregation. One number lexeme and the parser's
  // nesting stack are bounded by the raw scan limit, not by the native read size.
  const tokens = parser.asStream({ jsonStreaming: false, packKeys: false, streamKeys: true,
    packStrings: false, streamStrings: true, packNumbers: true, streamNumbers: false })
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  let depth = 0, rootSeen = false, rootClosed = false, hasEvents = false, inEvents = false
  let rootKey = '', rootKeyLength = 0, readingRootKey = false, eventsKey = false, tokenError: unknown
  const token = (t: Token) => {
    if (t.name === 'startKey') { readingRootKey = depth === 1; rootKey = ''; rootKeyLength = 0; return }
    if (t.name === 'stringChunk' && readingRootKey) {
      rootKeyLength += t.value.length
      if (rootKey.length < 11) rootKey += t.value.slice(0, 11 - rootKey.length)
    }
    if (t.name === 'endKey') {
      if (readingRootKey) {
        eventsKey = rootKeyLength === 11 && rootKey === 'traceEvents'
        if (eventsKey && hasEvents) invalid('Original trace has duplicate traceEvents fields.')
      }
      readingRootKey = false; return
    }
    const valueStart = t.name === 'startObject' || t.name === 'startArray' || t.name === 'startString' ||
      t.name === 'startNumber' || t.name === 'numberValue' || t.name === 'trueValue' || t.name === 'falseValue' || t.name === 'nullValue'
    if (valueStart) {
      if (depth === 0) {
        if (t.name !== 'startObject' || rootSeen || rootClosed) invalid('Original trace must be one JSON object.')
        rootSeen = true
      } else if (depth === 1 && eventsKey) {
        if (t.name !== 'startArray') invalid('Original traceEvents must be an array.')
        hasEvents = true; inEvents = true
      } else if (depth === 2 && inEvents && t.name !== 'startObject') invalid('Original trace events must be objects.')
    }
    if (t.name === 'numberValue' && !Number.isFinite(Number(t.value))) invalid('Original trace contains a non-finite number.')
    if (t.name === 'startObject' || t.name === 'startArray') depth++
    if (t.name === 'endObject' || t.name === 'endArray') {
      if (inEvents && depth === 3 && t.name === 'endObject') progress.events++
      if (inEvents && depth === 2 && t.name === 'endArray') { inEvents = false; eventsKey = false }
      depth--
      if (depth === 0) rootClosed = true
    }
  }
  tokens.on('data', (t: Token) => { try { token(t) } catch (error) { tokenError = error; tokens.destroy(error as Error) } })
  tokens.on('error', error => { tokenError ??= error })
  const writeTokens = async (text: string) => {
    if (tokenError) throw tokenError
    await new Promise<void>((resolve, reject) => tokens.write(text, error => error ? reject(error) : resolve()))
    if (tokenError) throw tokenError
  }
  async function* compressed() {
    for await (const chunk of source) {
      options.signal?.throwIfAborted()
      if (!(chunk instanceof Uint8Array)) invalid('Original trace stream returned invalid bytes.')
      progress.gzipBytes += chunk.byteLength; report()
      if (progress.gzipBytes > RENDERER_TRACE_MAX_GZIP_BYTES) invalid('Original gzip trace exceeds its encoded 8 MiB result budget; no truncated material was returned.')
      gzipHash.update(chunk)
      yield chunk
    }
  }
  try {
    await pipeline(Readable.from(compressed(), { objectMode: false, highWaterMark: 64 * 1024 }),
      createGunzip({ chunkSize: 64 * 1024 }), async chunks => {
        for await (const chunk of chunks) {
          options.signal?.throwIfAborted()
          progress.rawBytes += chunk.byteLength; report()
          if (progress.rawBytes > RENDERER_TRACE_MAX_RAW_BYTES) invalid('Original decoded trace exceeds its 64 MiB scan budget; no truncated material was returned.')
          rawHash.update(chunk)
          await writeTokens(decoder.decode(chunk, { stream: true }))
          report()
          await options.onDecodedChunk?.(chunk)
        }
      }, options.signal ? { signal: options.signal } : {})
    await writeTokens(decoder.decode())
    await new Promise<void>((resolve, reject) => { tokens.once('finish', resolve); tokens.once('error', reject); tokens.end() })
    if (tokenError) throw tokenError
    if (!rootSeen || !rootClosed || depth !== 0 || !hasEvents) invalid('Original trace JSON is incomplete or has no traceEvents array.')
    options.signal?.throwIfAborted(); report()
    return { ...progress, gzipSha256: gzipHash.digest('hex'), rawSha256: rawHash.digest('hex') }
  } finally { tokens.destroy() }
}
