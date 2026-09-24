import { constants, type BigIntStats } from 'node:fs'
import { open, readFile, stat, type FileHandle } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { createRequire } from 'node:module'
import * as SQLite from 'wa-sqlite'
import initializeSqlite from 'wa-sqlite/dist/wa-sqlite-async.mjs'
import { Base } from 'wa-sqlite/src/VFS.js'
import { AgentMuxError } from './errors.js'
import { readNativeHistoryBytes, type NativeHistoryReadBudget } from './native-jsonl-history-reader.js'
import { SESSION_HISTORY_MAX_PAGE_BYTES, SESSION_HISTORY_TIMEOUT_MS } from './session-history.js'

type SourceFile = { path: string; file: FileHandle; identity: BigIntStats }
export type NativeSqliteHistoryIdentity = { path: string; dev: string; ino: string }
const snapshotPath = '/history/store.db'
// Immutable library code only. Native records and SQLite instances are page-local.
let wasmBytes: Promise<Buffer> | undefined
// The 1.0.0 Base declaration has a stale {size,value} xRead signature. Its
// shipped JS and the package's SQLiteVFS interface both pass Uint8Array.
const SqliteVfsBase = Base as unknown as new () => SQLiteVFS & {
  handleAsync(callback: () => Promise<number>): number
}

function failure(code: string, message: string, detail?: string): never {
  throw new AgentMuxError(message, `AGENT_SESSION_HISTORY_${code}`, detail)
}

function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
}

async function optionalStat(path: string): Promise<BigIntStats | undefined> {
  try { return await stat(path, { bigint: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * One readonly SQLite page over stable native DB/WAL files. SQLite owns all page,
 * journal and WAL interpretation. Every native byte read uses the existing shared
 * reservation owner; this VFS caches only this page's requested byte ranges.
 */
export class NativeSqliteHistoryReader {
  private readonly sources = new Map<string, SourceFile>()
  private readonly files = new Set<FileHandle>()
  private readonly opened = new Map<number, SourceFile>()
  private readonly cache = new Map<string, Buffer>()
  private sqlite: SQLiteAPI | undefined
  private database: number | undefined
  private readError: unknown
  private closed = false
  private closing = false
  readonly budget: NativeHistoryReadBudget

  private constructor(private readonly path: string, private readonly signal: AbortSignal,
    budget?: NativeHistoryReadBudget) {
    this.budget = budget ?? { bytesRead: 0, startedAt: Date.now() }
  }

  get identity(): NativeSqliteHistoryIdentity {
    const main = this.sources.get(snapshotPath)!
    return { path: this.path, dev: String(main.identity.dev), ino: String(main.identity.ino) }
  }

  private check(): void {
    if (this.closed || this.closing) failure('INVALID_TRANSCRIPT', 'Native SQLite history reader is closed.')
    this.signal.throwIfAborted()
    if (Date.now() - this.budget.startedAt > SESSION_HISTORY_TIMEOUT_MS) {
      failure('TIMEOUT', 'Native SQLite history page timed out.')
    }
  }

  private async addSource(path: string, name: string, optional = false): Promise<void> {
    this.check()
    let file: FileHandle
    try { file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK) } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    this.files.add(file)
    this.check()
    const identity = await file.stat({ bigint: true })
    this.check()
    if (!identity.isFile() || identity.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      failure('INVALID_TRANSCRIPT', 'Native SQLite history source is not a supported regular file.')
    }
    const named = await stat(path, { bigint: true })
    this.check()
    if (!unchanged(identity, named)) failure('SOURCE_CHANGED', 'Native SQLite source changed while opening.')
    this.sources.set(name, { path, file, identity })
  }

  static async open(path: string, signal: AbortSignal, budget?: NativeHistoryReadBudget): Promise<NativeSqliteHistoryReader> {
    const reader = new NativeSqliteHistoryReader(path, signal, budget)
    reader.check()
    if (!isAbsolute(path)) failure('LOCATOR_UNAVAILABLE', 'Native SQLite history requires an absolute source path.')
    try {
      // A nonempty rollback journal cannot be silently discarded or mistaken for WAL.
      const journal = await optionalStat(`${path}-journal`)
      reader.check()
      if (journal && (!journal.isFile() || journal.size > 0n)) {
        failure('INVALID_TRANSCRIPT', 'Native SQLite has a rollback journal; a safe history snapshot cannot be confirmed.')
      }
      await reader.addSource(path, snapshotPath)
      await reader.addSource(`${path}-wal`, `${snapshotPath}-wal`, true)
      await reader.verifyUnchanged()
      reader.check()
      wasmBytes ??= readFile(createRequire(import.meta.url).resolve('wa-sqlite/dist/wa-sqlite-async.wasm'))
      const wasmBinary = await wasmBytes
      reader.check()
      reader.sqlite = SQLite.Factory(await initializeSqlite({ wasmBinary }))
      reader.check()
      reader.sqlite.vfs_register(reader.createVfs(), false)
      reader.database = await reader.sqlite.open_v2(snapshotPath, SQLite.SQLITE_OPEN_READONLY, 'agentmux-history-page')
      reader.sqlite.limit(reader.database, SQLite.SQLITE_LIMIT_LENGTH, SESSION_HISTORY_MAX_PAGE_BYTES)
      reader.sqlite.progress_handler(reader.database, 1000, () => {
        try { reader.check(); return 0 } catch (error) { reader.readError ??= error; return 1 }
      }, null)
      // SQLite builds its own heap WAL index for this isolated, single-connection
      // snapshot. These locks touch only virtual state, never the native writer.
      await reader.get('PRAGMA locking_mode=EXCLUSIVE')
      return reader
    } catch (error) {
      await reader.close()
      if (reader.readError) throw reader.readError
      if (error instanceof AgentMuxError || signal.aborted) throw error
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      return failure(missing ? 'LOCATOR_UNAVAILABLE' : 'INVALID_TRANSCRIPT',
        missing ? 'Native SQLite history source has not been established.' : 'Native SQLite history source cannot be opened.',
        error instanceof Error ? error.message : String(error))
    }
  }

  private createVfs(): SQLiteVFS & { name: string } {
    const reader = this
    return new class extends SqliteVfsBase {
      name = 'agentmux-history-page'
      override mxPathName = 512
      override xOpen(name: string | null, id: number, flags: number, output: DataView): number {
        const source = name === null ? undefined : reader.sources.get(name)
        if (!source) return SQLite.SQLITE_CANTOPEN
        reader.opened.set(id, source)
        output.setInt32(0, (flags & ~(SQLite.SQLITE_OPEN_READWRITE | SQLite.SQLITE_OPEN_CREATE)) | SQLite.SQLITE_OPEN_READONLY, true)
        return SQLite.SQLITE_OK
      }
      override xClose(id: number): number { reader.opened.delete(id); return SQLite.SQLITE_OK }
      override xRead(id: number, output: Uint8Array, offset: number): number {
        return this.handleAsync(async () => {
          try {
            reader.check()
            const source = reader.opened.get(id)!
            const length = Math.min(output.byteLength, Math.max(0, Number(source.identity.size) - offset))
            const key = `${source.path}:${offset}:${length}`
            let bytes = reader.cache.get(key)
            if (!bytes) {
              bytes = await readNativeHistoryBytes(source.file, offset, length, reader.signal, reader.budget)
              reader.cache.set(key, bytes)
            }
            reader.check()
            output.fill(0)
            output.set(bytes)
            return length < output.byteLength ? SQLite.SQLITE_IOERR_SHORT_READ : SQLite.SQLITE_OK
          } catch (error) {
            reader.readError ??= error
            return SQLite.SQLITE_IOERR
          }
        })
      }
      override xFileSize(id: number, output: DataView): number {
        output.setBigInt64(0, reader.opened.get(id)!.identity.size, true)
        return SQLite.SQLITE_OK
      }
      override xAccess(name: string, _flags: number, output: DataView): number {
        output.setInt32(0, reader.sources.has(name) ? 1 : 0, true)
        return SQLite.SQLITE_OK
      }
      override xCheckReservedLock(_id: number, output: DataView): number { output.setInt32(0, 0, true); return SQLite.SQLITE_OK }
      override xLock(): number { return SQLite.SQLITE_OK }
      override xUnlock(): number { return SQLite.SQLITE_OK }
      override xWrite(): number { return SQLite.SQLITE_READONLY }
      override xTruncate(): number { return SQLite.SQLITE_READONLY }
      override xDelete(): number { return SQLite.SQLITE_READONLY }
    }()
  }

  /** Provider-owned, fixed SQL; only one row can be materialized per call. */
  async get(sql: string, parameters: readonly SQLiteCompatibleType[] = []): Promise<readonly SQLiteCompatibleType[] | undefined> {
    this.check()
    let result: readonly SQLiteCompatibleType[] | undefined
    try {
      for await (const statement of this.sqlite!.statements(this.database!, sql)) {
        this.check()
        this.sqlite!.bind_collection(statement, [...parameters])
        while (await this.sqlite!.step(statement) === SQLite.SQLITE_ROW) {
          this.check()
          if (result) failure('INVALID_TRANSCRIPT', 'Native SQLite query returned more than its bounded record.')
          result = this.sqlite!.row(statement).map(value => value instanceof Uint8Array ? value.slice() : value)
        }
      }
      this.check()
      return result
    } catch (error) {
      if (this.readError) throw this.readError
      if (error instanceof AgentMuxError || this.signal.aborted) throw error
      return failure('INVALID_TRANSCRIPT', 'Native SQLite history contains an invalid database or record.')
    }
  }

  async verifyUnchanged(): Promise<void> {
    this.check()
    for (const source of this.sources.values()) {
      const current = await source.file.stat({ bigint: true })
      this.check()
      const named = await optionalStat(source.path)
      this.check()
      if (!named || !unchanged(source.identity, current) || !unchanged(source.identity, named)) {
        failure('SOURCE_CHANGED', 'Native SQLite source changed during reading; reopen its newest page.')
      }
    }
    if (!this.sources.has(`${snapshotPath}-wal`) && await optionalStat(`${this.path}-wal`)) {
      failure('SOURCE_CHANGED', 'Native SQLite WAL appeared during reading; reopen its newest page.')
    }
    const journal = await optionalStat(`${this.path}-journal`)
    this.check()
    if (journal && (!journal.isFile() || journal.size > 0n)) {
      failure('SOURCE_CHANGED', 'Native SQLite rollback journal appeared during reading; reopen its newest page.')
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closing = true
    const errors: unknown[] = []
    try {
      if (this.sqlite && this.database !== undefined) {
        await this.sqlite.close(this.database)
        this.database = undefined
        this.sqlite = undefined
        this.opened.clear()
      }
      // A failed open owns only this page's module; the published SQLite factory
      // does not expose its error handle. Drop every module/VFS reference for GC.
      if (this.database === undefined) { this.sqlite = undefined; this.opened.clear() }
    } catch (error) {
      errors.push(error)
    } finally {
      const files = [...this.files]
      const results = await Promise.allSettled(files.map(file => file.close()))
      for (let index = 0; index < results.length; index++) {
        const result = results[index]!
        if (result.status === 'fulfilled') {
          this.files.delete(files[index]!)
          for (const [name, source] of this.sources) if (source.file === files[index]) this.sources.delete(name)
        }
        else errors.push(result.reason)
      }
      this.cache.clear()
      this.closed = this.files.size === 0 && this.database === undefined
    }
    if (errors.length) throw new AggregateError(errors, 'Native SQLite history resources could not be released; cleanup remains incomplete.')
  }
}
