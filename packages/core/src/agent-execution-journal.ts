import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { AgentMuxError } from './errors.js'
import { durableWriteFile } from './durable-write.js'

export type AgentExecutionOperationKey = {
  bindingId: string
  streamGeneration: string
  /** Preserve JSON-RPC string and numeric identities, including numeric zero. */
  nativeRequestId: string | number
}
export type AgentExecutionOperation = AgentExecutionOperationKey & {
  payloadDigest: string
  payloadBytes: number
  phase: 'prepared' | 'dispatched' | 'completed' | 'unknown'
  revision: number
  /** Dispatched without a retained native response always has an unknown outcome. */
  outcome: 'not-dispatched' | 'unknown' | 'response-recorded'
  resultDigest: string | null
  resultBytes: number | null
}
const applicationId = 0x414d4558
const schema = `
  CREATE TABLE identity (id TEXT PRIMARY KEY);
  CREATE TABLE operations (
    binding_id TEXT NOT NULL, stream_generation TEXT NOT NULL, request_id TEXT NOT NULL,
    payload_digest TEXT NOT NULL, payload_bytes INTEGER NOT NULL,
    phase TEXT NOT NULL, revision INTEGER NOT NULL,
    result_digest TEXT, result_bytes INTEGER, result BLOB,
    PRIMARY KEY(binding_id, stream_generation, request_id)
  ) WITHOUT ROWID;
  PRAGMA application_id = ${applicationId}; PRAGMA user_version = 1;
`
const digest = (bytes: Uint8Array) => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
const fail = (message: string, code = 'AGENT_EXECUTION_OPERATION_CONFLICT') => new AgentMuxError(message, code)
const fields = 'binding_id,stream_generation,request_id,payload_digest,payload_bytes,phase,revision,result_digest,result_bytes'
function key(value: AgentExecutionOperationKey): [string, string, string] {
  if (!value || typeof value.bindingId !== 'string' || !value.bindingId || typeof value.streamGeneration !== 'string' || !value.streamGeneration ||
      !(typeof value.nativeRequestId === 'string' || typeof value.nativeRequestId === 'number' && Number.isSafeInteger(value.nativeRequestId))) {
    throw fail('The original binding, stream generation and native request identity are required.', 'INVALID_EXECUTION_OPERATION')
  }
  return [value.bindingId, value.streamGeneration, JSON.stringify(value.nativeRequestId)]
}
function freezeKey(value: AgentExecutionOperationKey): AgentExecutionOperationKey {
  const [bindingId, streamGeneration, requestId] = key(value)
  return { bindingId, streamGeneration, nativeRequestId: JSON.parse(requestId) as string | number }
}
function bytes(value: string | Uint8Array): Uint8Array {
  if (typeof value === 'string') return Buffer.from(value)
  if (!(value instanceof Uint8Array)) throw fail('Exact native bytes are required.', 'INVALID_EXECUTION_OPERATION')
  return value
}
function originalDigest(value: string): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw fail('The original payload digest is required.', 'INVALID_EXECUTION_OPERATION')
}
function metadata(row: Record<string, unknown>): AgentExecutionOperation {
  const phase = row.phase as AgentExecutionOperation['phase']
  if (!['prepared', 'dispatched', 'completed', 'unknown'].includes(phase)) throw fail('The retained operation phase is unconfirmed.', 'AGENT_EXECUTION_JOURNAL_INVALID')
  return { bindingId: String(row.binding_id), streamGeneration: String(row.stream_generation), nativeRequestId: JSON.parse(String(row.request_id)) as string | number,
    payloadDigest: String(row.payload_digest), payloadBytes: Number(row.payload_bytes), phase, revision: Number(row.revision),
    outcome: phase === 'prepared' ? 'not-dispatched' : phase === 'completed' ? 'response-recorded' : 'unknown',
    resultDigest: row.result_digest === null ? null : String(row.result_digest), resultBytes: row.result_bytes === null ? null : Number(row.result_bytes) }
}

/** A failed persistence acknowledgement never authorizes a native dispatch or replay. */
export class AgentExecutionJournalWriteError extends Error {
  readonly code = 'AGENT_EXECUTION_JOURNAL_WRITE_UNCONFIRMED'
  constructor(readonly transactionOutcome: 'not-committed' | 'committed' | 'unknown', cause: unknown) {
    super('The original tool operation storage acknowledgement is unconfirmed. Inspect the same operation; do not dispatch or replay it.', { cause })
    this.name = 'AgentExecutionJournalWriteError'
  }
}

/**
 * The resource Core's original tool-operation owner. No Session/Run projection,
 * discovery, timers or transport retry lives here. Private native responses are
 * BLOBs in the same transaction as their receipt; public reads omit all bytes.
 */
export class AgentExecutionJournal {
  readonly identity: string
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false
  private readonly read: StatementSync
  private readonly readBytes: StatementSync
  private constructor(private readonly path: string, private readonly db: DatabaseSync, identity: string) {
    this.identity = identity
    this.read = db.prepare(`SELECT ${fields} FROM operations WHERE binding_id=? AND stream_generation=? AND request_id=?`)
    this.readBytes = db.prepare('SELECT payload_digest,phase,result_digest,result_bytes,result FROM operations WHERE binding_id=? AND stream_generation=? AND request_id=?')
  }

  /**
   * Observe one retained operation without acquiring writer authority. Missing,
   * unreadable or replaced storage is unknown, never an empty healthy journal.
   * Only a valid original journal with no matching primary key returns null.
   */
  static async inspectRetained(directory: string, target: AgentExecutionOperationKey, expectedIdentity?: string): Promise<AgentExecutionOperation | null> {
    const location = key(target)
    const path = join(resolve(directory), 'operations.sqlite')
    let db: DatabaseSync | undefined
    try {
      const acknowledged = await readFile(join(resolve(directory), 'operations.identity'), 'utf8')
      if (!acknowledged || expectedIdentity !== undefined && expectedIdentity !== acknowledged) throw new Error('identity mismatch')
      db = new DatabaseSync(path, { readOnly: true })
      // A read transaction keeps schema, identity and the selected row on the
      // same SQLite snapshot. No journal configuration or schema repair runs.
      db.exec('BEGIN')
      if (db.prepare('PRAGMA application_id').get()?.application_id !== applicationId || db.prepare('PRAGMA user_version').get()?.user_version !== 1) throw new Error('schema identity mismatch')
      const identities = db.prepare('SELECT id FROM identity LIMIT 2').all()
      if (identities.length !== 1 || identities[0]?.id !== acknowledged) throw new Error('journal identity mismatch')
      const columns = db.prepare('PRAGMA table_info(operations)').all()
      const names = ['binding_id', 'stream_generation', 'request_id', 'payload_digest', 'payload_bytes', 'phase', 'revision', 'result_digest', 'result_bytes', 'result']
      const types = ['TEXT', 'TEXT', 'TEXT', 'TEXT', 'INTEGER', 'TEXT', 'INTEGER', 'TEXT', 'INTEGER', 'BLOB']
      if (columns.length !== names.length || columns.some((column, index) => column.name !== names[index] || column.type !== types[index] || column.notnull !== (index < 7 ? 1 : 0) || column.pk !== (index < 3 ? index + 1 : 0))) throw new Error('operation key schema mismatch')
      const row = db.prepare(`SELECT ${fields} FROM operations WHERE binding_id=? AND stream_generation=? AND request_id=?`).get(...location)
      if (!row) return null
      const operation = metadata(row)
      if (!/^sha256:[0-9a-f]{64}$/u.test(operation.payloadDigest) || !Number.isSafeInteger(operation.payloadBytes) || operation.payloadBytes < 0 || !Number.isSafeInteger(operation.revision) || operation.revision < 1 ||
          operation.phase === 'completed' && (operation.resultDigest === null || !/^sha256:[0-9a-f]{64}$/u.test(operation.resultDigest) || !Number.isSafeInteger(operation.resultBytes) || operation.resultBytes! < 0) ||
          operation.phase !== 'completed' && (operation.resultDigest !== null || operation.resultBytes !== null)) throw new Error('operation metadata invalid')
      return operation
    } catch {
      throw fail('The original tool operation cannot be confirmed from retained storage. Its outcome remains unknown; no journal or operation was changed.', 'AGENT_EXECUTION_JOURNAL_READ_UNCONFIRMED')
    } finally { db?.close() }
  }

  /** Retain identity in the binding; pass it on rejoin to detect replacement of the whole directory. */
  static async open(directory: string, expectedIdentity?: string): Promise<AgentExecutionJournal> {
    directory = resolve(directory)
    const path = join(directory, 'operations.sqlite'), marker = join(directory, 'operations.identity')
    let acknowledged: string | null = null
    try { acknowledged = await readFile(marker, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    let exists = true
    try { await stat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; exists = false }
    if (!exists && (acknowledged !== null || expectedIdentity !== undefined)) throw fail('The original tool journal is missing; no replacement was created.', 'AGENT_EXECUTION_JOURNAL_MISSING')
    const created = await mkdir(directory, { recursive: true, mode: 0o700 })
    // Confirm newly created directory ancestors before admitting any original effect.
    if (created) for (let parent = directory;; parent = dirname(parent)) {
      const handle = await open(parent, 'r'); try { await handle.sync() } finally { await handle.close() }
      if (parent === dirname(created)) break
    }
    const file = await open(path, 'a', 0o600); await file.close(); await chmod(path, 0o600)
    const db = new DatabaseSync(path)
    try {
      db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA')
      const app = Number(db.prepare('PRAGMA application_id').get()!.application_id)
      if (app === 0 && !acknowledged && expectedIdentity === undefined) {
        db.exec('BEGIN IMMEDIATE')
        // Another creator may have committed while this connection acquired the writer.
        if (Number(db.prepare('PRAGMA application_id').get()!.application_id) === 0) {
          if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' LIMIT 1").get()) throw fail('The selected database is not an execution journal.', 'AGENT_EXECUTION_JOURNAL_INVALID')
          db.exec(schema); db.prepare('INSERT INTO identity VALUES (?)').run(randomUUID())
        }
        db.exec('COMMIT')
      }
      const identity = db.prepare('SELECT id FROM identity').get()?.id
      if (Number(db.prepare('PRAGMA application_id').get()!.application_id) !== applicationId ||
          Number(db.prepare('PRAGMA user_version').get()!.user_version) !== 1 || typeof identity !== 'string' ||
          acknowledged !== null && acknowledged !== identity || expectedIdentity !== undefined && expectedIdentity !== identity) {
        throw fail('The original tool journal identity changed; retained operations were not replaced.', 'AGENT_EXECUTION_JOURNAL_INVALID')
      }
      const journal = new AgentExecutionJournal(path, db, identity)
      await journal.sync()
      if (acknowledged === null) await durableWriteFile(marker, identity, { mode: 0o600, requireDirectorySync: true })
      return journal
    } catch (error) {
      try { if (db.isTransaction) db.exec('ROLLBACK') } finally { db.close() }
      throw error
    }
  }

  private assertOpen(): void {
    if (this.closed) throw fail('This journal reader is closed; the original operations remain retained.', 'AGENT_EXECUTION_JOURNAL_CLOSED')
  }
  private async sync(): Promise<void> {
    for (const path of [this.path, dirname(this.path)]) {
      const handle = await open(path, 'r'); try { await handle.sync() } finally { await handle.close() }
    }
  }
  private lookup(target: AgentExecutionOperationKey): AgentExecutionOperation | null {
    const row = this.read.get(...key(target)); return row ? metadata(row) : null
  }
  private expected(target: AgentExecutionOperationKey, payloadDigest: string): AgentExecutionOperation {
    originalDigest(payloadDigest)
    const row = this.lookup(target)
    if (!row || row.payloadDigest !== payloadDigest) throw fail('The original tool request is absent or has different bytes.')
    return row
  }
  private mutate<T>(change: () => { value: T; changed: boolean }): Promise<T> {
    const work = this.tail.then(async () => {
      this.assertOpen()
      let started = false, committed = false
      try {
        this.db.exec('BEGIN IMMEDIATE'); started = true
        const result = change()
        this.db.exec('COMMIT'); committed = true
        // SQLite EXTRA confirms database/journal writes and journal deletion directory sync.
        // Repeating fsync here adds latency without strengthening the committed receipt.
        return result.value
      } catch (error) {
        if (!started || this.db.isTransaction) {
          if (this.db.isTransaction) {
            try { this.db.exec('ROLLBACK') } catch { throw new AgentExecutionJournalWriteError('unknown', error) }
          }
          // Domain refusals are accurate pre-effect outcomes, not storage failures.
          if (error instanceof AgentMuxError) throw error
          throw new AgentExecutionJournalWriteError('not-committed', error)
        }
        throw new AgentExecutionJournalWriteError(committed ? 'committed' : 'unknown', error)
      }
    })
    this.tail = work.catch(() => {})
    return work
  }

  async inspect(target: AgentExecutionOperationKey): Promise<AgentExecutionOperation | null> {
    target = freezeKey(target); await this.tail; this.assertOpen(); return this.lookup(target)
  }
  async prepare(target: AgentExecutionOperationKey, payload: string | Uint8Array): Promise<AgentExecutionOperation> {
    target = freezeKey(target)
    const location = key(target), body = bytes(payload), payloadDigest = digest(body), payloadBytes = body.byteLength
    return this.mutate(() => {
      const previous = this.lookup(target)
      if (previous) {
        if (previous.payloadDigest !== payloadDigest || previous.payloadBytes !== payloadBytes) throw fail('This original native request already contains different bytes.')
        return { value: previous, changed: false }
      }
      this.db.prepare(`INSERT INTO operations VALUES (?,?,?,?,?,'prepared',1,NULL,NULL,NULL)`).run(...location, payloadDigest, payloadBytes)
      return { value: this.lookup(target)!, changed: true }
    })
  }
  /** Only a durable first transition returns dispatch=true. Never infer it from inspect. */
  async dispatch(target: AgentExecutionOperationKey, payloadDigest: string): Promise<{ dispatch: boolean; operation: AgentExecutionOperation }> {
    target = freezeKey(target); originalDigest(payloadDigest)
    return this.mutate<{ dispatch: boolean; operation: AgentExecutionOperation }>(() => {
      const previous = this.expected(target, payloadDigest)
      if (previous.phase !== 'prepared') return { value: { dispatch: false, operation: previous }, changed: false }
      this.db.prepare("UPDATE operations SET phase='dispatched',revision=revision+1 WHERE binding_id=? AND stream_generation=? AND request_id=?").run(...key(target))
      return { value: { dispatch: true, operation: this.lookup(target)! }, changed: true }
    })
  }
  async markUnknown(target: AgentExecutionOperationKey, payloadDigest: string): Promise<AgentExecutionOperation> {
    target = freezeKey(target); originalDigest(payloadDigest)
    return this.mutate(() => {
      const previous = this.expected(target, payloadDigest)
      if (previous.phase === 'prepared') throw fail('A tool request that was never dispatched cannot be marked as an unknown effect.')
      if (previous.phase !== 'dispatched') return { value: previous, changed: false }
      this.db.prepare("UPDATE operations SET phase='unknown',revision=revision+1 WHERE binding_id=? AND stream_generation=? AND request_id=?").run(...key(target))
      return { value: this.lookup(target)!, changed: true }
    })
  }
  async complete(target: AgentExecutionOperationKey, payloadDigest: string, response: string | Uint8Array): Promise<AgentExecutionOperation> {
    target = freezeKey(target); originalDigest(payloadDigest)
    // Freeze caller-owned bytes before awaiting the writer, including offset views.
    const body = Buffer.from(bytes(response)), resultDigest = digest(body)
    return this.mutate(() => {
      const previous = this.expected(target, payloadDigest)
      if (previous.phase === 'prepared') throw fail('A native response cannot complete an undispatched request.')
      if (previous.phase === 'completed') {
        if (previous.resultDigest !== resultDigest || previous.resultBytes !== body.byteLength) throw fail('The original native response already contains different bytes.')
        return { value: previous, changed: false }
      }
      this.db.prepare("UPDATE operations SET phase='completed',revision=revision+1,result_digest=?,result_bytes=?,result=? WHERE binding_id=? AND stream_generation=? AND request_id=?")
        .run(resultDigest, body.byteLength, body, ...key(target))
      return { value: this.lookup(target)!, changed: true }
    })
  }
  /** Private broker read. A new stream generation can never read another stream's response. */
  async readResult(target: AgentExecutionOperationKey, payloadDigest: string): Promise<Uint8Array | null> {
    target = freezeKey(target); originalDigest(payloadDigest); await this.tail; this.assertOpen()
    this.expected(target, payloadDigest)
    const row = this.readBytes.get(...key(target))!
    if (row.phase !== 'completed') return null
    if (!(row.result instanceof Uint8Array) || row.result.byteLength !== row.result_bytes || digest(row.result) !== row.result_digest) {
      throw fail('The original native response bytes are unconfirmed; no replacement was returned.', 'AGENT_EXECUTION_JOURNAL_INVALID')
    }
    return Uint8Array.from(row.result)
  }
  async close(): Promise<void> { await this.tail; if (!this.closed) { this.closed = true; this.db.close() } }
}
