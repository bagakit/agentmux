import { constants } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { AgentMuxError } from './errors.js'
import { SESSION_HISTORY_MAX_PAGE_BYTES, SESSION_HISTORY_TIMEOUT_MS } from './session-history.js'
import parser from 'stream-json/parser.js'
import Assembler from 'stream-json/assembler.js'
import type { Token } from 'stream-json/parser.js'
import { materializeNativeContent } from './native-history-content.js'
import { nativeSourceText, nativeStringMetadata, appendNativeStringMetadata, type NativeHistoryItem, type NativeText } from './native-history-value.js'
import type { AgentProviderSessionHistoryContext, AgentSessionHistoryItem } from './types.js'

type Cursor = {
  version: 1
  providerId: string
  nativeSessionId: string
  path: string
  dev: number
  ino: number
  cut: number
  before: number
  head: string
  tail: string
  continuation?: string
}

export type NativeJsonlHistoryRecord = { value: Record<string, unknown>; start: number }

export type NativeHistoryReadBudget = { bytesRead: number; startedAt: number }

function failure(code: string, message: string): never {
  throw new AgentMuxError(message, `AGENT_SESSION_HISTORY_${code}`)
}

function decodeCursor(text: string): Cursor {
  try {
    const value = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as Cursor
    if (!value || value.version !== 1 || typeof value.providerId !== 'string' ||
      typeof value.nativeSessionId !== 'string' || typeof value.path !== 'string' ||
      ![value.dev, value.ino, value.cut, value.before].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      value.before > value.cut || typeof value.head !== 'string' || typeof value.tail !== 'string' ||
      (value.continuation !== undefined && (typeof value.continuation !== 'string' || value.continuation.length > 1024))) {
      return failure('INVALID_CURSOR', 'Native history cursor is invalid; reopen the newest page.')
    }
    return value
  } catch (error) {
    if (error instanceof AgentMuxError) throw error
    return failure('INVALID_CURSOR', 'Native history cursor is invalid; reopen the newest page.')
  }
}

/** Bounded physical allocations. Total scan IO follows the related source; it is not a lifetime quota. */
export async function readNativeHistoryBytes(
  file: FileHandle,
  position: number,
  length: number,
  signal: AbortSignal,
  budget: NativeHistoryReadBudget
): Promise<Buffer> {
  signal.throwIfAborted()
  if (Date.now() - budget.startedAt > SESSION_HISTORY_TIMEOUT_MS) {
    failure('TIMEOUT', 'Native transcript page timed out.')
  }
  if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 0) {
    failure('INVALID_TRANSCRIPT', 'Native transcript read range is invalid.')
  }
  if (length > SESSION_HISTORY_MAX_PAGE_BYTES) {
    failure('TOO_LARGE', 'A native history physical read exceeds its allocation budget.')
  }
  budget.bytesRead += length
  const data = Buffer.alloc(length)
  const { bytesRead } = await file.read(data, 0, length, position)
  signal.throwIfAborted()
  if (Date.now() - budget.startedAt > SESSION_HISTORY_TIMEOUT_MS) {
    failure('TIMEOUT', 'Native transcript page timed out.')
  }
  if (bytesRead !== length) {
    failure('SOURCE_CHANGED', 'Native transcript was truncated during reading.')
  }
  return data
}

/** Bounded, read-only physical JSONL paging. Provider readers own every record's meaning. */
export class NativeJsonlHistoryReader {
  private readonly budget: NativeHistoryReadBudget
  private readonly identity: { dev: number; ino: number }
  private position: number
  private cut: number
  private lastRecordEnd: number | undefined
  private cache: Buffer = Buffer.alloc(0)
  private cacheStart = 0
  private head = ''
  private tail = ''
  private readonly permitsPartialTail: boolean
  readonly continuation: string | undefined
  materializeItem(item: NativeHistoryItem): Promise<AgentSessionHistoryItem> {
    return materializeNativeContent(this.context, item)
  }

  private constructor(
    private readonly context: AgentProviderSessionHistoryContext,
    private readonly file: FileHandle,
    { dev, ino }: { dev: number; ino: number },
    size: number,
    cursor: Cursor | undefined,
    budget: NativeHistoryReadBudget
  ) {
    this.budget = budget
    this.permitsPartialTail = cursor === undefined
    this.identity = { dev, ino }
    this.cut = cursor?.cut ?? size
    this.position = cursor?.before ?? size
    this.continuation = cursor?.continuation
    this.head = cursor?.head ?? ''
    this.tail = cursor?.tail ?? ''
  }

  /** Physical byte extent of this snapshot, excluding any unfinished append encountered at EOF. */
  get sourceSizeBytes(): number { return this.cut }

  static async open(
    context: AgentProviderSessionHistoryContext,
    budget?: NativeHistoryReadBudget
  ): Promise<NativeJsonlHistoryReader> {
    const activeBudget = budget ?? { bytesRead: 0, startedAt: Date.now() }
    context.signal.throwIfAborted()
    if (Date.now() - activeBudget.startedAt > SESSION_HISTORY_TIMEOUT_MS) {
      return failure('TIMEOUT', 'Native transcript page timed out.')
    }
    const path = context.transcriptPath
    if (!path || !isAbsolute(path)) return failure('LOCATOR_UNAVAILABLE', 'Native transcript path has not been established.')
    const cursor = context.cursor === undefined ? undefined : decodeCursor(context.cursor)
    if (cursor && (cursor.path !== path || cursor.providerId !== context.source.providerId ||
      cursor.nativeSessionId !== context.source.nativeSessionId)) {
      return failure('SOURCE_CHANGED', 'Native history cursor belongs to another source.')
    }
    // Nonblocking open prevents a bad locator naming a FIFO from waiting for a writer.
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      context.signal.throwIfAborted()
      if (Date.now() - activeBudget.startedAt > SESSION_HISTORY_TIMEOUT_MS) {
        return failure('TIMEOUT', 'Native transcript page timed out.')
      }
      const current = await file.stat()
      context.signal.throwIfAborted()
      if (!current.isFile()) return failure('INVALID_TRANSCRIPT', 'Native transcript is not a regular file.')
      if (cursor && (cursor.dev !== current.dev || cursor.ino !== current.ino || cursor.cut > current.size)) {
        return failure('SOURCE_CHANGED', 'Native transcript was replaced or truncated; reopen its newest page.')
      }
      const reader = new NativeJsonlHistoryReader(context, file, current, current.size, cursor, activeBudget)
      if (cursor) await reader.verifyUnchanged()
      return reader
    } catch (error) {
      await file.close()
      throw error
    }
  }

  private check(): void {
    this.context.signal.throwIfAborted()
    if (Date.now() - this.budget.startedAt > SESSION_HISTORY_TIMEOUT_MS) {
      failure('TIMEOUT', 'Native transcript page timed out.')
    }
  }

  private read(position: number, length: number): Promise<Buffer> {
    return readNativeHistoryBytes(this.file, position, length, this.context.signal, this.budget)
  }

  private async blockEndingAt(end: number): Promise<Buffer> {
    if (end > this.cacheStart && end <= this.cacheStart + this.cache.length) {
      return this.cache.subarray(0, end - this.cacheStart)
    }
    this.cacheStart = Math.max(0, end - 64 * 1024)
    this.cache = await this.read(this.cacheStart, end - this.cacheStart)
    return this.cache
  }

  /** Streaming tokens retain small metadata while large strings stay at their exact physical extent. */
  private async parseRange(start: number, end: number, partialTail = false): Promise<Record<string, unknown> | null> {
    let deferred: NativeText | undefined
    // The public reviver inserts the physical value at exactly this string's slot. No
    // placeholder text can enter Provider interpretation, concatenation or encoding.
    const assembler = new Assembler<unknown>({ reviver: (_key, value) => {
      if (!deferred) return value
      const result = deferred; deferred = undefined; return result
    } }), stream = parser.asStream({ packKeys: true, streamKeys: false,
      packStrings: false, streamStrings: true, packNumbers: true, streamNumbers: false })
    const strings: Array<{ start: number; end: number }> = []
    let quoted = false, escaped = false, stringIndex = 0, value = '', valueBytes = 0, big = false, currentRange: { start: number; end: number } | undefined
    let retainedBytes = 0, parserError: unknown
    let metadata = nativeStringMetadata()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    stream.on('error', error => { parserError = error })
    stream.on('data', (token: Token) => {
      try {
        if (token.name === 'keyValue') { stringIndex++; retainedBytes += Buffer.byteLength(token.value); assembler.consume(token) }
        else if (token.name === 'startString') {
          currentRange = strings[stringIndex++]; value = ''; valueBytes = 0; big = false
          metadata = nativeStringMetadata()
        }
        else if (token.name === 'stringChunk') {
          appendNativeStringMetadata(metadata, token.value)
          if (!big) {
            value += token.value
            valueBytes += Buffer.byteLength(token.value)
            if (valueBytes > SESSION_HISTORY_MAX_PAGE_BYTES / 2) { value = ''; big = true }
          }
        } else if (token.name === 'endString') {
          if (big || currentRange && currentRange.end - currentRange.start > SESSION_HISTORY_MAX_PAGE_BYTES / 2) {
            if (!currentRange || currentRange.end <= currentRange.start) return failure('INVALID_TRANSCRIPT', 'A native string extent is incomplete.')
            deferred = nativeSourceText({ path: this.context.transcriptPath!, ...this.identity, cut: this.cut,
              head: this.head, tail: this.tail, start: currentRange.start, end: currentRange.end },
              metadata)
            retainedBytes += 4096 // bounded source metadata, not its unmaterialized body
            value = ''
          }
          retainedBytes += Buffer.byteLength(value)
          assembler.consume({ name: 'stringValue', value })
        } else { retainedBytes += 16; assembler.consume(token) }
        if (retainedBytes > SESSION_HISTORY_MAX_PAGE_BYTES) failure('TOO_LARGE', 'Native history metadata exceeds its materialization budget.')
      } catch (error) { parserError = error; stream.destroy(error as Error) }
    })
    try {
      await this.verifyUnchanged()
      for (let position = start; position < end; position += 64 * 1024) {
        const bytes = await this.read(position, Math.min(64 * 1024, end - position))
        // Locate JSON string lexemes without interpreting JSON or retaining their content.
        for (let index = 0; index < bytes.length; index++) {
          const byte = bytes[index]!
          if (!quoted) {
            if (byte === 34) { quoted = true; escaped = false; strings.push({ start: position + index, end: 0 }) }
          } else if (escaped) escaped = false
          else if (byte === 92) escaped = true
          else if (byte === 34) { quoted = false; strings[strings.length - 1]!.end = position + index + 1 }
        }
        let text: string
        try { text = decoder.decode(bytes, { stream: true }) }
        catch { return failure('INVALID_TRANSCRIPT', 'Native transcript contains malformed UTF-8.') }
        await new Promise<void>((resolve, reject) => stream.write(text, error => error ? reject(error) : resolve()))
        if (parserError) throw parserError
        // Consumed lexeme positions need not grow with a record's ordinary small strings.
        if (stringIndex > 1024) { const consumed = stringIndex - (quoted ? 1 : 0); strings.splice(0, consumed); stringIndex -= consumed }
      }
      const tail = decoder.decode()
      await new Promise<void>((resolve, reject) => { stream.once('finish', resolve); stream.once('error', reject); stream.end(tail) })
      if (parserError) throw parserError
      if (!assembler.done || !assembler.current || typeof assembler.current !== 'object' || Array.isArray(assembler.current))
        return failure('INVALID_TRANSCRIPT', 'Native transcript contains a complete non-object record.')
      return assembler.current as Record<string, unknown>
    } catch (error) {
      this.context.signal.throwIfAborted()
      if (error instanceof AgentMuxError) throw error
      if (partialTail) return null
      return failure('INVALID_TRANSCRIPT', 'Native transcript contains an invalid complete UTF-8 JSON record.')
    } finally { stream.destroy() }
  }

  /** Latest complete record first. A partial append at EOF is excluded from this snapshot. */
  async readPrevious(): Promise<NativeJsonlHistoryRecord | null> {
    while (this.position > 0) {
      this.check()
      const end = this.position
      let at = end
      let block = await this.blockEndingAt(at)
      const terminated = block[block.length - 1] === 10
      if (terminated) { at--; block = block.subarray(0, -1) }
      let start = 0
      while (true) {
        const newline = block.lastIndexOf(10)
        if (newline >= 0) {
          start = this.cacheStart + newline + 1
          break
        }
        at = this.cacheStart
        if (at === 0) break
        block = await this.blockEndingAt(at)
      }
      this.position = start
      const recordEnd = terminated ? end - 1 : end
      if (recordEnd === start) continue
      const value = await this.parseRange(start, recordEnd, !terminated && end === this.cut && this.permitsPartialTail)
      if (value === null) {
        this.cut = start
        this.head = ''; this.tail = ''
        continue
      }
      this.lastRecordEnd = end
      return { value, start }
    }
    return null
  }

  /** Include the last returned complete physical record in the next page. */
  repeatPrevious(): void {
    this.check()
    if (this.lastRecordEnd === undefined) {
      failure('INVALID_CURSOR', 'Read a complete native history record before repeating it.')
    }
    this.position = this.lastRecordEnd
  }

  /** Provider format identity/header check; does not move the backwards page position. */
  async readFirst(): Promise<Record<string, unknown> | null> {
    let position = 0
    while (position < this.cut) {
      const block = await this.read(position, Math.min(64 * 1024, this.cut - position))
      const newline = block.indexOf(10)
      if (newline >= 0) return await this.parseRange(0, position + newline)
      position += block.length
    }
    return position ? await this.parseRange(0, position) : null
  }

  private async fingerprints(): Promise<{ head: string; tail: string }> {
    const length = Math.min(128, this.cut)
    const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex')
    return { head: hash(await this.read(0, length)), tail: hash(await this.read(this.cut - length, length)) }
  }

  async verifyUnchanged(): Promise<void> {
    this.check()
    const current = await stat(this.context.transcriptPath!)
    if (current.dev !== this.identity.dev || current.ino !== this.identity.ino || current.size < this.cut) {
      failure('SOURCE_CHANGED', 'Native transcript was replaced or truncated during reading.')
    }
    const actual = await this.fingerprints()
    if (this.head && (actual.head !== this.head || actual.tail !== this.tail)) {
      failure('SOURCE_CHANGED', 'Native transcript page boundary changed; reopen the newest page.')
    }
    this.head = actual.head
    this.tail = actual.tail
  }

  async nextCursor(continuation?: string): Promise<string | null> {
    await this.verifyUnchanged()
    if (this.position === 0) return null
    const cursor: Cursor = { version: 1, ...this.context.source, path: this.context.transcriptPath!,
      ...this.identity, cut: this.cut, before: this.position, head: this.head, tail: this.tail,
      ...(continuation === undefined ? {} : { continuation }) }
    return Buffer.from(JSON.stringify(cursor)).toString('base64url')
  }

  async close(): Promise<void> { await this.file.close() }
}
