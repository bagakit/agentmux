import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { link, mkdir, open, opendir, unlink, type FileHandle } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { unavailableDiagnosticEvidence } from '@agentmux/diagnostic-evidence'
import { durableWriteFile, DurableWriteError } from './durable-write.js'
import { mintObjectId } from './object-id.js'
import { AgentMuxError } from './errors.js'
import { diagnosticCauseCode } from './delivery-evidence-reader.js'
import { parseStartupDiagnosticRecord, parseStartupDiagnosticTarget, parseStartupDiagnosticCoverage, startupDiagnosticCode,
  type AgentStartupDiagnosticOwner, type AgentStartupDiagnosticTarget, type AgentStartupDiagnosticRead,
  type AgentStartupDiagnosticRecord, type AgentStartupDiagnosticCoverage, type AgentStartupDiagnosticPage } from './startup-diagnostic.js'
import type { AgentTerminalFrontendObservation } from './agent-terminal-frontend.js'
import type { AgentMuxStoredAgentSession } from './types.js'

// One journal has at most 128 records / 512 KiB payload and 32 pending observations. These
// are diagnostic retention limits, never a limit on Sessions, initialization or input.
const MAX_RECORDS = 128, MAX_BYTES = 512 * 1024, MAX_PENDING = 32, MAX_RECORD_BYTES = 24 * 1024
const MAX_INDEX_BYTES = MAX_BYTES + MAX_RECORDS * 256 + 8192, MAX_PUBLICATION_BYTES = 2 * MAX_RECORD_BYTES + 8192
const MAX_DIRECTORY_ENTRIES = MAX_RECORDS + 12
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type Row = { serial: number; key: string; signature: string; bytes: number;
  observation: Omit<AgentStartupDiagnosticRecord, 'original'>; persistence: 'confirmed' | 'observed' | 'unconfirmed' }
type Draft = { key: string; signature: string; record: AgentStartupDiagnosticRecord }
type Publication = { record: AgentStartupDiagnosticRecord; row: Row; removed: string[] }
class StartupDiagnosticConflict extends Error {
  constructor(readonly logId: string) { super('Startup diagnostic log ID conflict') }
}
function prefix(value: string, maximum: number): string {
  if (Buffer.byteLength(value) <= maximum) return value
  let result = '', used = 0
  for (const char of value) { const count = Buffer.byteLength(char); if (used + count > maximum) break; result += char; used += count }
  return result
}

/** Only accepted observations enter this bounded diagnostic journal. It never reads
 * a Provider or SessionStore, grants recovery, or waits in a business operation. */
export class CoreStartupDiagnosticJournal {
  private rows: Row[] = []
  private readonly memory = new Map<string, AgentStartupDiagnosticRecord>()
  private readonly pending: Draft[] = []
  private readonly reads = new Map<string, Promise<AgentStartupDiagnosticRecord | null>>()
  private serial = 0
  private writing = false
  private drainTask: Promise<void> | undefined
  private closed = false
  private readonly lifetime = new AbortController()
  private persistable = true
  private issueCode: string | null = null
  private opening: Promise<void> | undefined
  private writer: FileHandle | undefined
  private writerBusy = false
  private archiveLoaded = false
  private closing: Promise<void> | undefined
  private readonly coverage: AgentStartupDiagnosticCoverage = { startup: 'loading', history: 'accepted-observations-only',
    retainedRecords: 0, retainedBytes: 0, pendingWrites: 0, dropped: 0, duplicates: 0, evicted: 0, corrupt: 0,
    writeFailures: 0, indexFailures: 0, cleanupFailures: 0, examinedEntries: 0, directoryLimitReached: false, observationGaps: 'unknown', persistenceGap: false }

  constructor(private readonly owner: AgentStartupDiagnosticOwner, readonly directory?: string) {
    void this.refresh()
  }
  private refresh(): Promise<void> {
    if (this.opening) return this.opening
    if (this.closed || this.archiveLoaded) return Promise.resolve()
    const operation = this.openWriter().catch(error => {
      this.persistable = false; this.archiveLoaded = true; this.coverage.startup = 'unavailable'; this.coverage.indexFailures++
      if (error instanceof DurableWriteError && error.cleanupIncomplete) this.coverage.cleanupFailures++
      if (error instanceof StartupDiagnosticConflict) this.preserveOriginal(error.logId)
      this.coverage.persistenceGap = true; this.issueCode = diagnosticCauseCode((error as { code?: unknown }).code)
    })
    this.opening = operation
    void operation.finally(() => { if (this.opening === operation) this.opening = undefined }).catch(() => {})
    return operation
  }
  private async openWriter(): Promise<void> {
    if (!this.directory) { this.archiveLoaded = true; this.coverage.startup = 'ready'; return }
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const handle = await open(join(this.directory, 'writer.lock'), 'a+', 0o600)
    try {
      const native = createRequire(import.meta.url)('fs-native-extensions') as { tryLock(fd: number): boolean }
      if (this.closed || !native.tryLock(handle.fd)) {
        await handle.close(); this.writerBusy = !this.closed; this.coverage.startup = 'unavailable'; return
      }
      this.writer = handle; this.writerBusy = false
      // Bounded inspection of this diagnostic namespace only. Failed durable-write
      // cleanup/crashes can leave unknown temporary names; never delete or grow an
      // unbounded orphan set, and never scan Sessions or workspaces to recover it.
      const directory = await opendir(this.directory)
      for await (const _entry of directory) {
        this.coverage.examinedEntries++
        if (this.coverage.examinedEntries > MAX_DIRECTORY_ENTRIES) {
          this.coverage.directoryLimitReached = true
          throw new Error('Startup diagnostic directory requires cleanup before further persistence')
        }
      }
      await this.load(); this.archiveLoaded = true
    } catch (error) {
      if (this.writer !== handle) await handle.close().catch(() => {})
      throw error
    }
  }
  /** Capture finite facts immediately; no credentials survive this synchronous boundary. */
  observe(session: AgentMuxStoredAgentSession, observation: AgentTerminalFrontendObservation): void {
    if (this.closed) return
    try {
      const init = observation.initialization, actor = session.nativeActor
      if (!init || !actor || actor.lifecycleOperationId !== init.lifecycleOperationId) return
      if (!['unknown', 'failed', 'ready'].includes(init.phase)) return
      if (this.pending.length + Number(this.writing) >= MAX_PENDING) { this.coverage.dropped++; this.coverage.persistenceGap = true; return }
      const knownCredentials = [actor.token, session.hookToken].filter((value): value is string => Boolean(value))
      let redacted = false
      const redact = (value: string): string => {
        let result = value
        for (const secret of knownCredentials) if (result.includes(secret)) { result = result.split(secret).join('[redacted]'); redacted = true }
        return result
      }
      const originalBytes = init.failure ? bytes({ message: init.failure.message, code: init.failure.code ?? null }) : 0
      const message = init.failure ? redact(init.failure.message) : ''
      const code = typeof init.failure?.code === 'string' ? redact(init.failure.code) : init.failure?.code ?? null
      const original = init.failure ? { message: prefix(message, 4096), code: typeof code === 'string' ? prefix(code, 2048) : code } : null
      // Escaping can expand an otherwise short string sixfold in JSON. Keep the
      // actual retained representation bounded without dropping safe failure facts.
      if (original) {
        while (bytes(original) > 8192 && original.message) original.message = prefix(original.message, Math.max(0, Buffer.byteLength(original.message) - 256))
        while (bytes(original) > 8192 && typeof original.code === 'string' && original.code) original.code = prefix(original.code, Math.max(0, Buffer.byteLength(original.code) - 256))
      }
      const truncated = original !== null && (original.message !== message || original.code !== code)
      const continuity = session.continuity
      const recovery = continuity?.initializationRecovery
      const continuityMatches = recovery && recovery.run.runId === session.run.runId && recovery.actorId === actor.actorId && recovery.lifecycleOperationId === init.lifecycleOperationId ||
        continuity?.launchInput?.lifecycleOperationId === init.lifecycleOperationId && continuity.launchInput.key?.expectedRun.runId === session.run.runId
      const record: AgentStartupDiagnosticRecord = {
        kind: 'agent-startup', logId: mintObjectId(), authority: { ...this.owner.authority }, ownerInstanceId: this.owner.ownerInstanceId,
        receivedAt: Date.now(), observedAt: observation.observedAt, hostId: session.hostId, agentSessionId: session.agentSessionId,
        runId: session.run.runId, actorId: actor.actorId, frontendId: observation.frontendId, lifecycleOperationId: init.lifecycleOperationId,
        continuityOperationId: continuityMatches ? continuity!.operationId : null,
        source: observation.source, event: init.phase === 'unknown' ? 'unconfirmed' : init.phase === 'failed' ? 'failed' : 'recovered',
        phase: init.phase, frontendState: observation.state, backendState: observation.backendState, native: { ...init.native },
        failure: init.failure ? { step: init.failure.step, code: startupDiagnosticCode(init.failure.code) } : null,
        previousLogId: null, output: { agentSessionId: session.agentSessionId, runId: session.run.runId, coverage: 'not-captured' },
        material: { retention: original ? 'retained' : 'not-retained', originalBytes, retainedBytes: original ? bytes(original) : 0, truncated, redacted }, original,
      }
      const key = digest([record.agentSessionId, record.runId, record.actorId, record.frontendId, record.lifecycleOperationId])
      // Time/reprojection alone is not a new transition. Private material contributes
      // only a digest to this index; raw content never enters discovery metadata.
      const signature = digest([record.phase, record.frontendState, record.backendState, record.native, record.failure, original])
      this.pending.push({ key, signature, record })
      if (!this.writing) this.drainTask = this.drain()
    } catch { this.coverage.dropped++; this.coverage.persistenceGap = true }
  }
  /** Stop only this recorder. Actual IO retains this diagnostic writer lock until
   * settlement; the semantic owner must not await it to release business ownership. */
  dispose(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true; this.lifetime.abort()
    this.coverage.dropped += this.pending.length
    if (this.pending.length) this.coverage.persistenceGap = true
    this.pending.length = 0
    return this.closing = (async () => {
      await Promise.allSettled([...(this.opening ? [this.opening] : []), ...(this.drainTask ? [this.drainTask] : [])])
      await this.writer?.close().catch(() => { this.coverage.cleanupFailures++ }); this.writer = undefined
    })()
  }
  private snapshot(): AgentStartupDiagnosticCoverage {
    return { ...this.coverage, retainedRecords: this.rows.length, retainedBytes: this.rows.reduce((sum, row) => sum + row.bytes, 0),
      pendingWrites: this.pending.length + Number(this.writing) }
  }
  private async load(): Promise<void> {
    if (!this.directory) { this.coverage.startup = 'ready'; return }
    let raw: string | undefined
    try { raw = await this.readFile(join(this.directory, 'index.json'), MAX_INDEX_BYTES) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (raw !== undefined) {
    const p = JSON.parse(raw) as { schema: unknown; authority: unknown; serial: unknown; rows: unknown; coverage: unknown }
    if (p.schema !== 'agentmux.startup-diagnostics.v1' || !isDeepStrictEqual(p.authority, this.owner.authority) ||
      !Number.isSafeInteger(p.serial) || (p.serial as number) < 0 || !Array.isArray(p.rows) || p.rows.length > MAX_RECORDS) throw new Error('Invalid startup diagnostic index')
    const seen = new Set<string>()
    const rows = p.rows.map((value: unknown): Row => {
      const row = value as Row, record = parseStartupDiagnosticRecord({ ...row.observation, original: null }, false)
      if (!Number.isSafeInteger(row.serial) || row.serial < 1 || row.serial > (p.serial as number) ||
        typeof row.key !== 'string' || !/^[a-f0-9]{64}$/u.test(row.key) || typeof row.signature !== 'string' || !/^[a-f0-9]{64}$/u.test(row.signature) ||
        !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > MAX_RECORD_BYTES || seen.has(record.logId) ||
        !isDeepStrictEqual(record.authority, this.owner.authority)) throw new Error('Invalid startup diagnostic index entry')
      seen.add(record.logId)
      return { ...row, persistence: row.persistence === 'unconfirmed' ? 'unconfirmed' : 'observed' }
    })
    if (rows.reduce((sum, row) => sum + row.bytes, 0) > MAX_BYTES || rows.some((row, index) => index > 0 && row.serial <= rows[index - 1]!.serial)) throw new Error('Invalid startup diagnostic index bounds')
    const coverage = parseStartupDiagnosticCoverage(p.coverage)
    this.rows = rows; this.serial = p.serial as number
    Object.assign(this.coverage, coverage, { startup: 'ready', pendingWrites: 0, examinedEntries: this.coverage.examinedEntries })
    }
    // Exactly one original diagnostic publication may be unfinished. Its bounded
    // receipt survives an index failure; never discover history by scanning Runs
    // or an unbounded directory, and never allocate another orphan per restart.
    let pending: Publication | undefined
    try {
      const value = JSON.parse(await this.readFile(join(this.directory, 'pending.json'), MAX_PUBLICATION_BYTES)) as Publication
      const record = parseStartupDiagnosticRecord(value.record, true), row = value.row
      if (!isDeepStrictEqual(record.authority, this.owner.authority) || !Array.isArray(value.removed) || value.removed.length > MAX_RECORDS ||
        value.removed.some(id => typeof id !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{12}$/u.test(id)) ||
        !row || !Number.isSafeInteger(row.serial) || row.serial < 1 || row.bytes !== bytes(record) || row.bytes > MAX_RECORD_BYTES ||
        typeof row.key !== 'string' || !/^[a-f0-9]{64}$/u.test(row.key) || typeof row.signature !== 'string' || !/^[a-f0-9]{64}$/u.test(row.signature) ||
        !isDeepStrictEqual(row.observation, (({ original: _original, ...rest }) => rest)(record))) throw new Error('Invalid original startup publication receipt')
      pending = { ...value, record, row: { ...row, persistence: 'unconfirmed' } }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (pending) {
      this.coverage.persistenceGap = true
      this.rows = this.rows.filter(row => row.observation.logId !== pending!.record.logId && !pending!.removed.includes(row.observation.logId))
      this.rows.push(pending.row); this.rows.sort((a, b) => a.serial - b.serial)
      this.serial = Math.max(this.serial, pending.row.serial); this.memory.set(pending.record.logId, pending.record)
      if (this.rows.length > MAX_RECORDS || this.rows.reduce((sum, row) => sum + row.bytes, 0) > MAX_BYTES) throw new Error('Startup publication exceeds retained bounds')
      if (!this.closed) await this.completePublication(pending)
    }
    this.coverage.startup = 'ready'
  }
  private async readFile(path: string, limit: number): Promise<string> {
    const file = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(limit + 1)
      let offset = 0
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      if (offset > limit) throw new Error('Startup diagnostic file exceeds its bound')
      return buffer.toString('utf8', 0, offset)
    }
    finally { await file.close() }
  }
  private async drain(): Promise<void> {
    if (this.writing) return
    this.writing = true
    try {
      await this.refresh()
      if (!this.archiveLoaded || this.closed) return
      while (!this.closed && this.pending.length) {
        const draft = this.pending.shift()!, prior = [...this.rows].reverse().find(row => row.key === draft.key)
        if (prior?.signature === draft.signature) { this.coverage.duplicates++; continue }
        if (draft.record.phase === 'ready' && (!prior || prior.observation.phase === 'ready')) continue
        if (this.memory.has(draft.record.logId) || this.rows.some(row => row.observation.logId === draft.record.logId)) {
          this.coverage.dropped++; this.coverage.persistenceGap = true; continue
        }
        draft.record.previousLogId = prior?.observation.logId ?? null
        const record = draft.record, { original: _original, ...observation } = record
        const row: Row = { serial: ++this.serial, key: draft.key, signature: draft.signature, bytes: bytes(record), observation, persistence: 'unconfirmed' }
        if (row.bytes > MAX_RECORD_BYTES) { this.coverage.dropped++; this.coverage.persistenceGap = true; continue }
        this.rows.push(row); this.memory.set(record.logId, record)
        const removed: Row[] = []
        while (this.rows.length > MAX_RECORDS || this.rows.reduce((sum, item) => sum + item.bytes, 0) > MAX_BYTES) {
          const old = this.rows.shift()!; removed.push(old); this.memory.delete(old.observation.logId); this.coverage.evicted++
        }
        if (!this.directory) continue
        if (!this.persistable) { this.coverage.dropped++; this.coverage.persistenceGap = true; continue }
        try {
          await mkdir(this.directory, { recursive: true, mode: 0o700 })
          const publication: Publication = { record, row, removed: removed.map(old => old.observation.logId) }
          await durableWriteFile(join(this.directory, 'pending.json'), JSON.stringify(publication) + '\n', { requireDirectorySync: true, signal: this.lifetime.signal })
          await this.completePublication(publication)
        } catch (error) {
          this.coverage.writeFailures++; this.coverage.persistenceGap = true
          if (error instanceof DurableWriteError && error.cleanupIncomplete) this.coverage.cleanupFailures++
          if (error instanceof StartupDiagnosticConflict) this.preserveOriginal(error.logId)
          this.issueCode = diagnosticCauseCode((error as { code?: unknown }).code)
          this.persistable = false
        }
      }
    } catch { this.coverage.writeFailures++; this.coverage.persistenceGap = true }
    finally { this.writing = false }
  }
  private preserveOriginal(logId: string): void {
    // The immutable original remains readable even when its index was absent.
    // Do not project the rejected new observation under that original identity.
    this.rows = this.rows.filter(row => row.observation.logId !== logId)
    this.memory.delete(logId)
  }
  private async completePublication(publication: Publication): Promise<void> {
    this.lifetime.signal.throwIfAborted()
    // Clean only known diagnostic records. Failed cleanup prevents new disk growth.
    for (const logId of publication.removed) await unlink(join(this.directory!, `${logId}.json`)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.coverage.cleanupFailures++; throw error }
    })
    await this.publish(publication.record)
    this.lifetime.signal.throwIfAborted()
    publication.row.persistence = 'confirmed'
    try {
      await durableWriteFile(join(this.directory!, 'index.json'), JSON.stringify({ schema: 'agentmux.startup-diagnostics.v1',
        authority: this.owner.authority, serial: this.serial, rows: this.rows, coverage: this.snapshot() }) + '\n', { requireDirectorySync: true, signal: this.lifetime.signal })
    } catch (error) { this.coverage.indexFailures++; throw error }
    await unlink(join(this.directory!, 'pending.json')).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.coverage.cleanupFailures++; throw error }
    })
  }
  private async publish(record: AgentStartupDiagnosticRecord): Promise<void> {
    const target = join(this.directory!, `${record.logId}.json`), candidate = join(this.directory!, `${record.logId}.candidate`)
    try {
      await durableWriteFile(candidate, JSON.stringify(record) + '\n', { requireDirectorySync: true, signal: this.lifetime.signal })
      this.lifetime.signal.throwIfAborted()
      try { await link(candidate, target) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const original = parseStartupDiagnosticRecord(JSON.parse(await this.readFile(target, MAX_RECORD_BYTES)), true)
        if (!isDeepStrictEqual(original, record)) {
          this.preserveOriginal(original.logId)
          throw new StartupDiagnosticConflict(original.logId)
        }
      }
      for (const path of [target, this.directory!]) {
        const handle = await open(path, 'r')
        try { await handle.sync() } catch (error) { throw new DurableWriteError(target, 'after-replace', error) }
        finally { await handle.close() }
      }
    } finally {
      await unlink(candidate).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.coverage.cleanupFailures++; this.persistable = false; throw error } })
    }
  }
  private async disk(logId: string): Promise<AgentStartupDiagnosticRecord | null> {
    if (!this.directory) return null
    try { return parseStartupDiagnosticRecord(JSON.parse(await this.readFile(join(this.directory, `${logId}.json`), MAX_RECORD_BYTES)), true) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  private async finite<T>(operation: Promise<T>, fallback: () => T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([operation, new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback()), 250) })]) }
    finally { clearTimeout(timer) }
  }
  async read(input: AgentStartupDiagnosticTarget, includeRaw = false): Promise<AgentStartupDiagnosticRead> {
    const target = parseStartupDiagnosticTarget(input)
    const missing = (code: Parameters<typeof unavailableDiagnosticEvidence>[1]): AgentStartupDiagnosticRead => ({
      ...unavailableDiagnosticEvidence(target, code), scope: 'logId' in target ? 'record' : 'interval-observation',
      readAuthority: { ...this.owner.authority }, authorityStatus: 'verified' })
    if (target.hostId !== 'local') return missing('DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE')
    if ('authority' in target && target.authority && (target.authority.kind !== this.owner.authority.kind || target.authority.id !== this.owner.authority.id))
      return missing('DIAGNOSTIC_EVIDENCE_AUTHORITY_MISMATCH')
    await this.finite(this.refresh(), () => undefined)
    if (this.archiveLoaded && this.pending.length && !this.writing && !this.closed) this.drainTask = this.drain()
    if ('recent' in target) return this.recent(target)
    let record = this.memory.get(target.logId), pending = this.reads.get(target.logId)
    if (!record) {
      if (!pending) {
        if (this.reads.size >= 4) return missing('DIAGNOSTIC_EVIDENCE_SOURCE_BUSY')
        pending = this.disk(target.logId); this.reads.set(target.logId, pending)
        void pending.finally(() => { if (this.reads.get(target.logId) === pending) this.reads.delete(target.logId) }).catch(() => {})
      }
      try {
        const value = await this.finite(pending, () => undefined)
        if (value === undefined) return missing('DIAGNOSTIC_EVIDENCE_SOURCE_BUSY')
        record = value ?? undefined
      } catch (error) {
        this.coverage.corrupt++; this.issueCode = diagnosticCauseCode((error as { code?: unknown }).code)
        return { ...missing('DIAGNOSTIC_EVIDENCE_SOURCE_CORRUPT'), availability: 'corrupt' }
      }
    }
    if (!record) return { ...missing('DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE'), availability: 'not-found', issue: null }
    if (record.logId !== target.logId) return missing('DIAGNOSTIC_EVIDENCE_SOURCE_CORRUPT')
    if (target.authority && (record.authority.kind !== target.authority.kind || record.authority.id !== target.authority.id)) return missing('DIAGNOSTIC_EVIDENCE_AUTHORITY_MISMATCH')
    const row = this.rows.find(row => row.observation.logId === target.logId)
    const data = { ...structuredClone(record), original: includeRaw ? structuredClone(record.original) : null }
    return { target, recordRef: { domain: 'agent.startup', logId: record.logId, authority: { ...record.authority }, routeHostId: target.hostId },
      readAuthority: { ...this.owner.authority }, authorityStatus: 'verified', availability: 'found', data,
      persistence: row?.persistence ?? 'observed', scope: 'record', observedAt: record.observedAt, readAt: Date.now(),
      completeness: record.material.truncated || row?.persistence === 'unconfirmed' ? 'partial' : 'complete',
      raw: { retention: record.material.retention, returned: data.original ? 'included' : 'withheld', truncated: record.material.truncated },
      issue: row?.persistence === 'unconfirmed' && this.coverage.writeFailures ? { code: 'DIAGNOSTIC_EVIDENCE_SOURCE_READ_FAILED', stage: 'read', causeCode: this.issueCode } : null }
  }
  private recent(target: Extract<AgentStartupDiagnosticTarget, { recent: unknown }>): AgentStartupDiagnosticRead {
    const q = target.recent, { cursor, limit: _limit, ...filter } = q
    const filterId = digest({ hostId: target.hostId, ...Object.fromEntries(Object.entries(filter).sort(([a], [b]) => a.localeCompare(b))) })
    let before = this.serial + 1
    if (cursor) {
      try {
        const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
        if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== this.owner.authority.id || parsed[1] !== filterId || !Number.isSafeInteger(parsed[2]) || parsed[2] < 1 || parsed[2] > this.serial + 1) throw Error()
        before = parsed[2]
      } catch { throw new AgentMuxError('Startup cursor belongs to another original authority or query.', 'INVALID_CONTROL_REQUEST') }
    }
    const page: AgentStartupDiagnosticPage = { kind: 'agent-startup-page', items: [], nextCursor: null, coverage: this.snapshot() }
    for (let index = this.rows.length - 1; index >= 0; index--) {
      const row = this.rows[index]!, r = row.observation
      if (row.serial >= before || q.agentSessionId && q.agentSessionId !== r.agentSessionId || q.runId && q.runId !== r.runId || q.since !== undefined && r.observedAt < q.since || q.until !== undefined && r.observedAt > q.until) continue
      if (page.items.length >= (q.limit ?? 32)) { page.nextCursor = Buffer.from(JSON.stringify([this.owner.authority.id, filterId, row.serial + 1])).toString('base64url'); break }
      page.items.push({ recordRef: { domain: 'agent.startup', logId: r.logId, authority: { ...r.authority }, routeHostId: target.hostId }, observation: structuredClone(r), persistence: row.persistence })
    }
    return { target, recordRef: null, readAuthority: { ...this.owner.authority }, authorityStatus: 'verified', availability: 'found', data: page,
      persistence: null, scope: 'interval-observation', observedAt: null, readAt: Date.now(), completeness: 'partial',
      raw: { retention: 'not-retained', returned: 'withheld', truncated: false },
      issue: this.coverage.startup === 'unavailable' ? { code: this.writerBusy ? 'DIAGNOSTIC_EVIDENCE_SOURCE_BUSY' : 'DIAGNOSTIC_EVIDENCE_SOURCE_READ_FAILED', stage: 'read', causeCode: this.issueCode } : null }
  }
}
