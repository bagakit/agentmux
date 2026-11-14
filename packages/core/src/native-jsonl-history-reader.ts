import { DatabaseSync } from 'node:sqlite'
import { join, dirname } from 'node:path'
import { chmod } from 'node:fs/promises'
import { decodeNativeSnapshotCursor, encodeNativeSnapshotCursor, liveNativeCut, nativeSnapshotStore, type NativeSnapshotCursor } from './native-snapshot-cursor.js'
import type { NativeSnapshotLease } from './native-source-snapshot.js'
import type { ProviderConversationChangesContext, ProviderConversationChangesPage } from './session-history-changes.js'
import { constants } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { AgentMuxError } from './errors.js'
import { reportSessionHistoryProgress, SESSION_HISTORY_MAX_PAGE_BYTES, SESSION_HISTORY_TIMEOUT_MS } from './session-history.js'
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

/** Physical source boundaries; end includes the original newline when present. */
export type NativeJsonlHistoryRecord = { value: Record<string, unknown>; start: number; end: number }

/** startedAt is the page's last progress: each completed physical read moves it, so the deadline measures a stall. */
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
  budget.startedAt = Date.now()
  reportSessionHistoryProgress(signal)
  return data
}

/** Bounded, read-only physical JSONL paging. Provider readers own every record's meaning. */
export class NativeJsonlHistoryReader {
  private recoveryIndex: DatabaseSync | undefined
  private snapshotCursor: NativeSnapshotCursor | undefined
  private snapshotLease: NativeSnapshotLease | undefined
  private readonly budget: NativeHistoryReadBudget
  private readonly identity: { dev: number; ino: number }
  private position: number
  private cut: number
  private lastRecordEnd: number | undefined
  private forwardPosition = 0
  private lastForwardStart: number | undefined
  private readonly birth: number
  private cache: Buffer = Buffer.alloc(0)
  private cacheStart = 0
  private forwardCache: Buffer = Buffer.alloc(0)
  private forwardCacheStart = 0
  private head = ''
  private tail = ''
  private readonly stringSources = new WeakMap<object, Map<string, { value: string | NativeText; start: number; end: number; text?: NativeText }>>()
  private readonly permitsPartialTail: boolean
  readonly continuation: string | undefined
  materializeItem(item: NativeHistoryItem): Promise<AgentSessionHistoryItem> {
    return materializeNativeContent(this.context, item)
  }

  /** Exact original string backing, retained only while its parsed holder is reachable. */
  sourceText(holder: Record<string, unknown> | unknown[], key: string): NativeText | undefined {
    const slot = this.stringSources.get(holder)?.get(key)
    if (!slot || Reflect.get(holder, key) !== slot.value) return undefined
    if (typeof slot.value !== 'string') return slot.value
    if (!slot.text) {
      const metadata = nativeStringMetadata()
      appendNativeStringMetadata(metadata, slot.value)
      slot.text = nativeSourceText({ path: this.actualPath, ...(this.snapshotLease && this.snapshotCursor ? { snapshot: this.snapshotCursor.reference } : {}), ...this.identity, cut: this.cut,
        head: this.head, tail: this.tail, start: slot.start, end: slot.end }, metadata)
    }
    return slot.text
  }

  private constructor(
    private readonly context: AgentProviderSessionHistoryContext,
    private readonly file: FileHandle,
    { dev, ino, birthtimeMs }: { dev: number; ino: number; birthtimeMs: number },
    size: number,
    cursor: Cursor | undefined,
    budget: NativeHistoryReadBudget,
    private readonly actualPath = context.transcriptPath!
  ) {
    this.budget = budget
    this.permitsPartialTail = cursor === undefined
    this.identity = { dev, ino }
    this.birth = birthtimeMs
    this.cut = cursor?.cut ?? size
    this.position = cursor?.before ?? size
    this.continuation = cursor?.continuation
    this.head = cursor?.head ?? ''
    this.tail = cursor?.tail ?? ''
  }

  /** Physical byte extent of this snapshot, excluding any unfinished append encountered at EOF. */
  get sourceSizeBytes(): number { return this.cut }

  /** The opened descriptor's identity; a preceding path stat cannot identify this reader. */
  get sourceIdentity(): Readonly<{ dev: number; ino: number }> { return { ...this.identity } }

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
    const changes = context as ProviderConversationChangesContext
    const retained = decodeNativeSnapshotCursor(context, changes.after ?? context.nativeSnapshotCursor)
    let lease: NativeSnapshotLease | undefined
    let physicalPath = path
    let captured: NativeSnapshotCursor | undefined
    let exactFrozenRecord = false
    if (retained?.kind === 'scope' && typeof Reflect.get(context, 'recordId') === 'string') {
      try {
        const manifest = await nativeSnapshotStore(context).metadata(retained.reference)
        const cut = JSON.parse(Buffer.from(retained.cursor, 'base64url').toString('utf8')) as { offset: number }
        exactFrozenRecord = Number.isSafeInteger(cut.offset) && cut.offset <= manifest.end
      } catch { /* A missing optional image cannot remove current exact-record reading; its version still has to match. */ }
    }
    if (retained?.kind === 'range' || exactFrozenRecord || context.nativeSnapshotReference) { lease = await nativeSnapshotStore(context).open(context.nativeSnapshotReference ?? retained!.reference); physicalPath = lease.path; captured = retained ?? { version: 1, kind: 'range', reference: context.nativeSnapshotReference!, cursor: '', origin: lease.manifest.origin } }
    let originalFile = lease?.file ?? await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      if (changes.snapshot || changes.recover && retained?.kind !== 'range') {
        const store = nativeSnapshotStore(context)
        if (changes.recover) { const failure = await store.recoveryFailure(originalFile, changes.recover); if (failure) throw failure }
        const receipt = await store.capture(originalFile, changes.snapshot ?? 'range', context.signal, async (file, size) => {
          let end = size
          while (end) {
            const start = Math.max(0, end - 64 * 1024), bytes = await readNativeHistoryBytes(file, start, end - start, context.signal, activeBudget), newline = bytes.lastIndexOf(10)
            if (newline >= 0) { end = start + newline + 1; break }; end = start
          }
          return { start: changes.tail ? end : 0, end }
        })
        await originalFile.close()
        lease = await store.open(receipt.reference)
        physicalPath = lease.path; originalFile = lease.file
        captured = { version: 1, kind: changes.snapshot ?? 'range', reference: receipt.reference, cursor: '', origin: lease.manifest.origin }
      }
      const file = originalFile
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
      const reader = new NativeJsonlHistoryReader(context, file, current, current.size, cursor, activeBudget, physicalPath)
      reader.snapshotCursor = captured ?? retained; reader.snapshotLease = lease
      if (lease) { reader.cut = lease.manifest.end; reader.position = reader.cut }
      if (cursor) await reader.verifyUnchanged()
      return reader
    } catch (error) {
      if (lease) await lease.close(); else await originalFile.close()
      throw error
    }
  }

  async prepareRecovery(convert: (row: Record<string, unknown>, start: number) => NativeHistoryItem | null | Promise<NativeHistoryItem | null>,
    stable: ((row: Record<string, unknown>) => boolean) | undefined, original: string): Promise<void> {
    if (this.snapshotCursor?.recovery) { await this.openRecoveryIndex(); return }
    if (!this.snapshotLease || !this.snapshotCursor || !stable) return failure('SOURCE_REPAIR_REQUIRED', 'This original source lacks qualified stable recovery identities.')
    const store = nativeSnapshotStore(this.context), scope = decodeNativeSnapshotCursor(this.context, original)
    const sourceOrigin = this.snapshotCursor.origin
    if (BigInt(sourceOrigin.birth) <= 0n) return failure('SOURCE_REPAIR_REQUIRED', 'The original filesystem has no qualified birth identity for automatic recovery.')
    const expectedBirth = Number(BigInt(sourceOrigin.birth) / 1_000_000_000n) * 1000 + Number(BigInt(sourceOrigin.birth) % 1_000_000_000n) / 1e6
    let retainedOffset = 0
    for (const token of [original, (this.context as ProviderConversationChangesContext).after]) {
      if (!token) return failure('SOURCE_CHANGED', 'Recovery requires both original source and sharing cuts.')
      const wrapped = decodeNativeSnapshotCursor(this.context, token)
      let cut: { version?: number; providerId?: string; nativeSessionId?: string; ino?: number; birth?: number; offset?: number }
      try { cut = JSON.parse(Buffer.from(wrapped?.cursor ?? token, 'base64url').toString('utf8')) as typeof cut } catch { return failure('INVALID_CURSOR', 'The original source cut is malformed.') }
      if (token === (this.context as ProviderConversationChangesContext).after && Number.isSafeInteger(cut.offset)) retainedOffset = Number(cut.offset)
      if (cut.version !== 1 || cut.providerId !== this.context.source.providerId || cut.nativeSessionId !== this.context.source.nativeSessionId || cut.ino !== Number(sourceOrigin.ino) || cut.birth !== expectedBirth)
        return failure('SOURCE_CHANGED', 'The original native file identity changed; a matching prefix cannot authorize a replacement source.')
    }
    let start: number
    if (scope) {
      const before = await store.open(scope.reference)
      try {
        if (before.manifest.origin.ino !== sourceOrigin.ino || before.manifest.origin.birth !== sourceOrigin.birth) return failure('SOURCE_CHANGED', 'The original scope snapshot belongs to another physical native source.')
        start = scope.scopeStart ?? before.manifest.start
        if (start > before.manifest.end) return failure('INVALID_CURSOR', 'The original scope cut exceeds its immutable observation.')
        if (start > this.cut) return failure('SOURCE_REPAIR_REQUIRED', 'The original sharing prefix is missing from this frozen source.')
        for (let at = 0; at < start; at += 64 * 1024) {
          const length = Math.min(64 * 1024, start - at)
          const expected = await readNativeHistoryBytes(before.file, at, length, this.context.signal, this.budget)
          if (!expected.equals(await this.read(at, length))) return failure('SOURCE_REPAIR_REQUIRED', 'The original complete sharing prefix changed; an exact original-owner range review is required.')
        }
      } finally { await before.close() }
    } else {
      let saved: { offset: number; head: string; tail: string }
      try { saved = JSON.parse(Buffer.from(original, 'base64url').toString('utf8')) as typeof saved } catch { return failure('INVALID_CURSOR', 'The original scope cut is malformed.') }
      // Only these old cuts authenticate their *entire* prefix. Larger sampled cuts
      // cannot retrospectively authorize the omitted bytes.
      if (!Number.isSafeInteger(saved.offset) || saved.offset < 0 || saved.offset > 256 || saved.offset > this.cut) return failure('SOURCE_REPAIR_REQUIRED', 'The old sharing cut has no retained complete-prefix evidence.')
      const fingerprints = await this.prefixFingerprints(saved.offset)
      if (saved.head !== fingerprints.head || saved.tail !== fingerprints.tail) return failure('SOURCE_REPAIR_REQUIRED', 'The complete old sharing prefix is no longer available.')
      start = saved.offset
    }
    if (start > retainedOffset) return failure('INVALID_CURSOR', 'The original sharing start is later than its retained source cut.')
    if (start && (await this.read(start - 1, 1))[0] !== 10) return failure('SOURCE_REPAIR_REQUIRED', 'The original scope is not a complete record boundary.')
    const path = join(dirname(this.actualPath), 'identities.sqlite')
    const created = await open(path, 'wx', 0o600); await created.close()
    const index = new DatabaseSync(path)
    try {
      index.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; CREATE TABLE identity(id TEXT PRIMARY KEY, digest TEXT NOT NULL, position INTEGER NOT NULL, excluded INTEGER NOT NULL)')
      const find = index.prepare('SELECT digest,excluded FROM identity WHERE id=?'), insert = index.prepare('INSERT INTO identity VALUES(?,?,?,?)')
      this.forwardPosition = 0
      for (;;) {
        const entry = await this.readNext(); if (!entry) break
        const item = await convert(entry.value, entry.start); if (!item) continue
        // A positional ID or open semantic relation cannot be silently reinterpreted
        // after a rewrite. This does not block ordinary source reads or input.
        const publicCandidate = ['assistant-message', 'user-message'].includes(item.kind) && item.contentParts.some(part => part.contentEligibility === 'public') || !!item.questionRequest || !!item.questionAnswers || item.turnOutcome?.status === 'failed' || item.contentParts.some(part => part.kind === 'resource' && part.contentEligibility === 'public')
        const crossRecord = item.conversation && Object.keys(item.conversation).some(key => key !== 'nativeInvocationScope')
        if (entry.start >= start && publicCandidate && (!stable(entry.value) || crossRecord || item.questionRequest || item.questionAnswers)) return failure('SOURCE_REPAIR_REQUIRED', 'The frozen range contains an identity or semantic relation needing original-owner qualification.')
        const digest = await this.recordDigest(entry), previous = find.get(item.id)
        if (previous && previous.digest !== digest) return failure('SOURCE_REPAIR_REQUIRED', 'The frozen range contains conflicting versions of one native identity.')
        if (!previous) insert.run(item.id, digest, entry.start, entry.start < start ? 1 : 0)
      }
    } finally { index.close() }
    await chmod(path, 0o600)
    const fd = await open(path, 'r'); try { await fd.sync() } finally { await fd.close() }
    const state = await stat(path)
    this.snapshotCursor.recovery = { start, index: { ino: state.ino, size: state.size, mtimeMs: state.mtimeMs, ctimeMs: state.ctimeMs } }
    // This source was just proven to retain the original sharing prefix, so its
    // retained range now carries exactly that original start, never the current end.
    await store.setRangeStart(this.snapshotLease, start)
    this.forwardPosition = start
    await this.openRecoveryIndex()
  }
  private async openRecoveryIndex(): Promise<void> {
    if (this.recoveryIndex || !this.snapshotCursor?.recovery) return
    const path = join(dirname(this.actualPath), 'identities.sqlite'), current = await stat(path), expected = this.snapshotCursor.recovery.index
    if (Object.entries(expected).some(([key, value]) => Reflect.get(current, key) !== value)) return failure('SOURCE_REPAIR_REQUIRED', 'The validated original identity inventory changed.')
    this.recoveryIndex = new DatabaseSync(path, { readOnly: true })
  }
  async recoveredItemAccepted(id: string, position: number): Promise<boolean> {
    if (!this.snapshotCursor?.recovery) return true
    await this.openRecoveryIndex()
    const row = this.recoveryIndex!.prepare('SELECT position,excluded FROM identity WHERE id=?').get(id)
    if (!row) return failure('SOURCE_REPAIR_REQUIRED', 'The original range identity inventory is incomplete.')
    return row.excluded === 0 && row.position === position
  }
  async rememberRecoveryFailure(scope: string, error: unknown): Promise<void> {
    if (this.snapshotCursor) await nativeSnapshotStore(this.context).rememberRecoveryFailure(this.snapshotCursor.origin, this.snapshotLease?.manifest.dataGeneration, scope, error).catch(() => undefined)
  }
  async recoveryRange(): Promise<{ from: string; through: string } | undefined> {
    if (!this.snapshotCursor || !this.snapshotLease || this.snapshotCursor.kind !== 'range' && !this.snapshotCursor.recovery) return undefined
    const at = async (offset: number) => encodeNativeSnapshotCursor(this.context, { ...this.snapshotCursor!, kind: 'range', cursor: Buffer.from(JSON.stringify({ version: 1, ...this.context.source, ...this.identity, birth: this.birth, offset, ...await this.prefixFingerprints(offset) })).toString('base64url') })
    return { from: await at(this.snapshotCursor.recovery?.start ?? this.snapshotLease.manifest.start), through: await at(this.snapshotLease.manifest.end) }
  }
  get recovered(): boolean { return !!this.snapshotCursor?.recovery }

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

  /** Reuse delimiter bytes within this open snapshot; parsing and integrity checks read the original file. */
  private async blockStartingAt(start: number): Promise<Buffer> {
    this.check()
    if (start < this.forwardCacheStart || start >= this.forwardCacheStart + this.forwardCache.length) {
      this.forwardCache = await this.read(start, Math.min(64 * 1024, this.cut - start))
      this.forwardCacheStart = start
    }
    return this.forwardCache.subarray(start - this.forwardCacheStart, Math.min(this.forwardCache.length, this.cut - this.forwardCacheStart))
  }

  /** Streaming tokens retain small metadata while large strings stay at their exact physical extent. */
  private async parseRange(start: number, end: number, partialTail = false): Promise<Record<string, unknown> | null> {
    let deferred: NativeText | undefined
    let stringRange: { start: number; end: number } | undefined
    const sources = this.stringSources
    // The public reviver inserts the physical value at exactly this string's slot. No
    // placeholder text can enter Provider interpretation, concatenation or encoding.
    const assembler = new Assembler<unknown>({ reviver: function (this: object, key, value) {
      const result = deferred ?? value
      if (stringRange && this && typeof this === 'object') {
        let slots = sources.get(this)
        if (!slots) { slots = new Map(); sources.set(this, slots) }
        slots.set(String(key), { value: result, ...stringRange })
      }
      deferred = undefined; stringRange = undefined
      return result
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
          stringRange = currentRange
          if (big || currentRange && currentRange.end - currentRange.start > SESSION_HISTORY_MAX_PAGE_BYTES / 2) {
            if (!currentRange || currentRange.end <= currentRange.start) return failure('INVALID_TRANSCRIPT', 'A native string extent is incomplete.')
            deferred = nativeSourceText({ path: this.actualPath, ...(this.snapshotLease && this.snapshotCursor ? { snapshot: this.snapshotCursor.reference } : {}), ...this.identity, cut: this.cut,
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
      return { value, start, end }
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
      const block = await this.blockStartingAt(position)
      const newline = block.indexOf(10)
      if (newline >= 0) return await this.parseRange(0, position + newline)
      position += block.length
    }
    return position ? await this.parseRange(0, position) : null
  }

  /** Read one Provider-issued byte identity without traversing unrelated history. */
  async readAt(start: number): Promise<NativeJsonlHistoryRecord | null> {
    if (!Number.isSafeInteger(start) || start < 0 || start >= this.cut ||
        start > 0 && (await this.read(start - 1, 1))[0] !== 10) return null
    const original = this.forwardPosition, originalLastStart = this.lastForwardStart
    this.forwardPosition = start
    try {
      const record = await this.readNext()
      return record?.start === start ? record : null
    } finally { this.forwardPosition = original; this.lastForwardStart = originalLastStart }
  }

  /** Inspect the original record immediately before the validated changes cut.
   * Provider lineage checks must not move either paging direction. */
  async readBeforeChanges(): Promise<NativeJsonlHistoryRecord | null> {
    return this.readBefore(this.forwardPosition)
  }

  /** Read the preceding complete record in this same source without moving either cursor. */
  async readBefore(start: number): Promise<NativeJsonlHistoryRecord | null> {
    if (!Number.isSafeInteger(start) || start < 0 || start > this.cut ||
        start > 0 && (await this.read(start - 1, 1))[0] !== 10) {
      return failure('INVALID_CURSOR', 'Native predecessor requires an original complete record boundary.')
    }
    const original = this.position, originalEnd = this.lastRecordEnd
    this.position = start
    try { return await this.readPrevious() }
    finally { this.position = original; this.lastRecordEnd = originalEnd }
  }

  /** Forward metadata reads reuse the same bounded parser; large message text stays unmaterialized. */
  async readNext(): Promise<NativeJsonlHistoryRecord | null> {
    while (this.forwardPosition < this.cut) {
      const start = this.forwardPosition
      let position = start
      while (position < this.cut) {
        const block = await this.blockStartingAt(position)
        const newline = block.indexOf(10)
        if (newline >= 0) {
          const end = position + newline
          this.forwardPosition = end + 1
          if (end === start) break
          const value = await this.parseRange(start, end)
          if (value) { this.lastForwardStart = start; return { value, start, end: this.forwardPosition } }
          break
        }
        position += block.length
      }
      if (position === this.cut) return null
    }
    return null
  }

  /** Reuse the physical source boundary for durable append reads, independently of UI page cursors. */
  async seekChanges(after?: string, tail = false): Promise<void> {
    if (after !== undefined) {
      const saved = this.savedChangesCut(decodeNativeSnapshotCursor(this.context, after)?.cursor ?? after), bound = Math.min(saved.offset, this.cut)
      const fingerprints = await this.prefixFingerprints(bound)
      if (saved.head !== fingerprints.head) return failure('SOURCE_CHANGED', 'The original conversation source was replaced.')
      // Same file and beginning, but the bytes before the cut are gone or differ:
      // the Provider rewrote an earlier suffix of this same source in place.
      if (saved.offset > this.cut || saved.tail !== fingerprints.tail) return failure('REWRITTEN', 'The original conversation was rewritten before the saved reading position.')
      if (saved.offset && (await this.read(saved.offset - 1, 1))[0] !== 10) return failure('INVALID_CURSOR', 'Conversation checkpoint is not a complete record boundary.')
      this.forwardPosition = saved.offset
    } else if (tail) {
      // A JSONL record becomes eligible only when its delimiter has been durably recorded.
      let end = this.cut
      while (end) {
        const start = Math.max(0, end - 64 * 1024), block = await this.read(start, end - start), newline = block.lastIndexOf(10)
        if (newline !== -1) { this.forwardPosition = start + newline + 1; return }
        end = start
      }
      this.forwardPosition = 0
    }
    await this.verifyUnchanged()
  }

  /** Decode a durable changes cut issued for this same physical source. A
   * different Provider, Session, inode or creation time is a different source. */
  private savedChangesCut(after: string): { offset: number; head: string; tail: string } {
    let saved: { version: number; providerId: string; nativeSessionId: string; dev: number; ino: number; birth: number; offset: number; head: string; tail: string }
    try { saved = JSON.parse(Buffer.from(after, 'base64url').toString('utf8')) as typeof saved }
    catch { return failure('INVALID_CURSOR', 'Conversation checkpoint is malformed.') }
    // Device numbers belong to one mount lifetime. Durable cuts retain the
    // original file and boundary; verifyUnchanged still checks this open's device.
    if (!saved || typeof saved !== 'object' || saved.version !== 1 || saved.providerId !== this.context.source.providerId || saved.nativeSessionId !== this.context.source.nativeSessionId ||
        saved.ino !== this.identity.ino || saved.birth !== this.birth || !Number.isSafeInteger(saved.offset) || saved.offset < 0 ||
        typeof saved.head !== 'string' || typeof saved.tail !== 'string') {
      return failure('SOURCE_CHANGED', 'The original conversation source was replaced, truncated or changed.')
    }
    return saved
  }

  /** sha256 of one record's exact physical bytes, excluding its newline: stable across reads.
   * Hashed in bounded reads, because one record can exceed a single physical read. */
  async recordDigest(record: Pick<NativeJsonlHistoryRecord, 'start' | 'end'>): Promise<string> {
    const hash = createHash('sha256')
    let end = record.end
    if (end > record.start && (await this.read(end - 1, 1))[0] === 10) end--
    for (let at = record.start; at < end; at += RECORD_DIGEST_READ_BYTES) hash.update(await this.read(at, Math.min(RECORD_DIGEST_READ_BYTES, end - at)))
    return hash.digest('hex')
  }

  /** Apply a second opaque cut at this same original physical owner. */
  async limitChanges(through: string): Promise<void> {
    const lower = this.forwardPosition
    await this.seekChanges(through)
    const upper = this.forwardPosition
    if (lower > upper) return failure('INVALID_CURSOR', 'The original upper cut precedes the lower cut.')
    this.cut = upper; this.position = Math.min(this.position, upper); this.forwardPosition = lower
    this.head = ''; this.tail = ''; this.cache = Buffer.alloc(0); this.forwardCache = Buffer.alloc(0)
    await this.verifyUnchanged()
  }

  repeatNext(): void {
    if (this.lastForwardStart === undefined) return failure('INVALID_CURSOR', 'Read an original record before repeating it.')
    this.forwardPosition = this.lastForwardStart
  }

  async hasMoreChanges(): Promise<boolean> {
    for (let start = this.forwardPosition; start < this.cut; start += 64 * 1024) {
      const block = await this.read(start, Math.min(64 * 1024, this.cut - start))
      if (block.includes(10)) return true
    }
    return false
  }

  private async prefixFingerprints(offset: number): Promise<{ head: string; tail: string }> {
    const length = Math.min(128, offset), hash = (data: Buffer) => createHash('sha256').update(data).digest('hex')
    return { head: hash(await this.read(0, length)), tail: hash(await this.read(offset - length, length)) }
  }

  async changesCursor(): Promise<string> {
    await this.verifyUnchanged()
    let cursor = Buffer.from(JSON.stringify({ version: 1, ...this.context.source, ...this.identity, birth: this.birth,
      offset: this.forwardPosition, ...await this.prefixFingerprints(this.forwardPosition) })).toString('base64url')
    if (this.snapshotCursor) {
      if (this.snapshotLease) await nativeSnapshotStore(this.context).retain(this.snapshotLease)
      const completed = !(this.context as ProviderConversationChangesContext).head && !(this.context as ProviderConversationChangesContext).tail && this.snapshotCursor.kind === 'range' && this.snapshotLease && this.forwardPosition >= this.snapshotLease.manifest.end
      if ((this.snapshotCursor.kind === 'scope' || completed) && this.snapshotLease) cursor = liveNativeCut(cursor, this.snapshotCursor.origin)
      if (completed) this.snapshotCursor = { ...this.snapshotCursor, kind: 'scope', scopeStart: this.snapshotCursor.recovery?.start ?? this.snapshotLease!.manifest.end }; if (completed) delete this.snapshotCursor.recovery
      cursor = encodeNativeSnapshotCursor(this.context, { ...this.snapshotCursor, cursor })
    }
    return cursor
  }

  /** The changes cut of this same physical history snapshot, including when its
   * history cursor reads older pages. No second file open or inferred cursor conversion. */
  async historyChangesCursor(): Promise<string> {
    await this.seekChanges(undefined, true)
    return await this.changesCursor()
  }

  private async fingerprints(): Promise<{ head: string; tail: string }> {
    const length = Math.min(128, this.cut)
    const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex')
    return { head: hash(await this.read(0, length)), tail: hash(await this.read(this.cut - length, length)) }
  }

  async verifyUnchanged(): Promise<void> {
    this.check()
    const current = await stat(this.actualPath)
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

  /** Re-read the same original page from its opening position and accepted cut. */
  async historyReplayCursor(): Promise<string> {
    await this.verifyUnchanged()
    const before = Math.min(this.context.cursor ? decodeCursor(this.context.cursor).before : this.cut, this.cut)
    return Buffer.from(JSON.stringify({ version: 1, ...this.context.source, path: this.actualPath,
      ...this.identity, cut: this.cut, before, head: this.head, tail: this.tail,
      ...(this.continuation === undefined ? {} : { continuation: this.continuation }) })).toString('base64url')
  }

  async nextCursor(continuation?: string): Promise<string | null> {
    await this.verifyUnchanged()
    if (this.position === 0) return null
    const cursor: Cursor = { version: 1, ...this.context.source, path: this.actualPath,
      ...this.identity, cut: this.cut, before: this.position, head: this.head, tail: this.tail,
      ...(continuation === undefined ? {} : { continuation }) }
    return Buffer.from(JSON.stringify(cursor)).toString('base64url')
  }

  async close(): Promise<void> { this.recoveryIndex?.close(); if (this.snapshotLease) await this.snapshotLease.close(); else await this.file.close() }
}

export const NATIVE_CONVERSATION_CHANGES_PAGE_RESERVE_BYTES = 64 * 1024
/** One digest read; a record larger than this is hashed across several reads. */
const RECORD_DIGEST_READ_BYTES = 1024 * 1024

/** Physical append iteration is shared; the original Provider alone interprets each row. */
export async function readNativeConversationChanges(reader: NativeJsonlHistoryReader, context: ProviderConversationChangesContext,
  convert: (row: Record<string, unknown>, start: number) => NativeHistoryItem | null | Promise<NativeHistoryItem | null>,
  /** The Provider supplies record identity so returned original bytes can carry digests. */
  identify?: (row: Record<string, unknown>, start: number) => string | null,
  stable?: (row: Record<string, unknown>) => boolean): Promise<ProviderConversationChangesPage> {
  if (context.head && (context.after !== undefined || context.tail)) return failure('INVALID_CURSOR', 'A beginning checkpoint cannot include another source position.')
  if (context.recover && !decodeNativeSnapshotCursor(context, context.after)?.recovery) {
    try { await reader.prepareRecovery(convert, stable, context.recover) }
    catch (error) { await reader.rememberRecoveryFailure(context.recover, error); throw error }
  }
  else await reader.seekChanges(context.after, context.tail === true)
  if (context.through !== undefined) await reader.limitChanges(context.through)
  const items: AgentSessionHistoryItem[] = [], digests: Record<string, string> = {}, identities: Record<string, 'protocol' | 'position'> = {}
  let bytes = 0
  if (!context.tail && !context.head) for (let scanned = 0; scanned < context.limit; scanned++) {
    const entry = await reader.readNext()
    if (!entry) break
    const original = await convert(entry.value, entry.start)
    if (!original) continue
    if (!await reader.recoveredItemAccepted(original.id, entry.start)) continue
    const item = await reader.materializeItem(original), size = Buffer.byteLength(JSON.stringify(item))
    if (bytes + size > SESSION_HISTORY_MAX_PAGE_BYTES - NATIVE_CONVERSATION_CHANGES_PAGE_RESERVE_BYTES) {
      if (!items.length) throw new AgentMuxError('The original change cannot fit its materialized page.', 'AGENT_SESSION_HISTORY_TOO_LARGE')
      reader.repeatNext(); break
    }
    // Versions of one native identity must remain separate accepted pages.
    if (items.some(previous => previous.id === item.id)) { reader.repeatNext(); break }
    items.push(item); bytes += size
    if (stable) identities[item.id] = stable(entry.value) ? 'protocol' : 'position'
    if (identify) digests[item.id] = await reader.recordDigest(entry)
  }
  const recoveryRange = await reader.recoveryRange()
  return { source: context.source, items, ...(recoveryRange ? { recoveryRange } : {}), ...(identify ? { digests } : {}), ...(stable ? { identities } : {}), cursor: await reader.changesCursor(), more: context.tail || context.head ? false : await reader.hasMoreChanges() }
}
