import { constants } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { AgentMuxError } from './errors.js'
import { SESSION_HISTORY_MAX_PAGE_BYTES, SESSION_HISTORY_TIMEOUT_MS } from './session-history.js'
import type { AgentProviderSessionHistoryContext } from './types.js'

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

/** Synchronous reservation and bounded physical byte reading shared across all page readers. */
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
  if (budget.bytesRead + length > SESSION_HISTORY_MAX_PAGE_BYTES) {
    failure('TOO_LARGE', 'Reading this native history page exceeds its byte budget.')
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
  readonly continuation: string | undefined

  private constructor(
    private readonly context: AgentProviderSessionHistoryContext,
    private readonly file: FileHandle,
    { dev, ino }: { dev: number; ino: number },
    size: number,
    cursor: Cursor | undefined,
    budget: NativeHistoryReadBudget
  ) {
    this.budget = budget
    this.identity = { dev, ino }
    this.cut = cursor?.cut ?? size
    this.position = cursor?.before ?? size
    this.continuation = cursor?.continuation
    this.head = cursor?.head ?? ''
    this.tail = cursor?.tail ?? ''
  }

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

  private parse(data: Buffer, partialTail = false): Record<string, unknown> | null {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let text: string
    try {
      // Stream decoding rejects malformed UTF-8 immediately; only flush can reveal an unfinished suffix.
      text = decoder.decode(data, { stream: true })
    } catch {
      return failure('INVALID_TRANSCRIPT', 'Native transcript contains malformed UTF-8.')
    }
    try { text += decoder.decode() } catch {
      if (partialTail) return null
      return failure('INVALID_TRANSCRIPT', 'Native transcript contains unfinished UTF-8 in a complete line.')
    }
    let value: unknown
    try { value = JSON.parse(text) } catch {
      if (partialTail) return null
      return failure('INVALID_TRANSCRIPT', 'Native transcript contains an invalid complete JSON record.')
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return failure('INVALID_TRANSCRIPT', 'Native transcript contains a complete non-object record.')
    }
    return value as Record<string, unknown>
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
      const chunks: Buffer[] = []
      let start = 0
      while (true) {
        const newline = block.lastIndexOf(10)
        if (newline >= 0) {
          start = this.cacheStart + newline + 1
          chunks.unshift(block.subarray(newline + 1))
          break
        }
        chunks.unshift(block)
        at = this.cacheStart
        if (at === 0) break
        block = await this.blockEndingAt(at)
      }
      this.position = start
      const data = Buffer.concat(chunks)
      if (data.length === 0) continue
      const value = this.parse(data, !terminated && end === this.cut && this.head === '')
      if (value === null) {
        this.cut = start
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
    const chunks: Buffer[] = []
    let position = 0
    while (position < this.cut) {
      const block = await this.read(position, Math.min(64 * 1024, this.cut - position))
      const newline = block.indexOf(10)
      chunks.push(newline < 0 ? block : block.subarray(0, newline))
      if (newline >= 0) return this.parse(Buffer.concat(chunks))
      position += block.length
    }
    return chunks.length ? this.parse(Buffer.concat(chunks)) : null
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
