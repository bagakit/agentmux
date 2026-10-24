import { createHash } from 'node:crypto'
import { mintObjectId } from '@agentmux/core/object-id'
import { clientIncidentPriority } from '@agentmux/core/client-incident'
import { link, lstat, mkdir, open, opendir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { durableWriteFile, DurableWriteError, parseClientIncidentRecord, parseClientIncidentReport,
  type AgentMuxClientIncidentRecord, type AgentMuxClientIncidentReport, type AgentMuxClientIncidentProducer,
  type AgentMuxClientIncidentPage, type AgentMuxClientIncidentTarget, parseClientIncidentPage, parseClientIncidentTarget } from '@agentmux/core'
import type { DiagnosticEvidenceRead, DiagnosticEvidenceAuthority, DiagnosticEvidenceIssueCode, DiagnosticEvidenceRef } from '@agentmux/core/diagnostic-evidence'

/** Limits protect the diagnostic owner only. Rejected reports never affect the original operation.
 * The queue retains at most half a MiB while one real disk write is pending; a timed-out caller
 * never releases that IO slot. The manifest bounds discovery; startup only scans a bounded number of owned temporary names.
 */
export const CLIENT_INCIDENT_LIMITS = Object.freeze({ records: 128, bytes: 2 * 1024 * 1024,
  recordBytes: 40 * 1024, queue: 32, queueBytes: 512 * 1024, readers: 4,
  indexBytes: 512 * 1024, retentionMs: 7 * 24 * 60 * 60 * 1000,
  readingQueue: 16, readingQueueBytes: 256 * 1024, readingProducerQueue: 4,
  readingRecords: 64, readingBytes: 1024 * 1024, readingProgressRecords: 16, readingProgressBytes: 512 * 1024 })

type Persistence = 'confirmed' | 'observed' | 'unconfirmed'
type Counters = AgentMuxClientIncidentPage['coverage']
type Summary = AgentMuxClientIncidentPage['items'][number]
type Entry = { summary: Summary; sequence: number; bytes: number; key: string; digest: string }
type Manifest = { schema: 'agentmux.client-incidents.v1'; archiveId: string; revision: number;
  entries: Entry[]; evicted: string[]; counters: Pick<Counters, 'dropped' | 'invalid' | 'duplicates' | 'evicted' | 'corrupt' | 'writeFailures' | 'indexFailures' | 'cleanupFailures'> }
type Pending = { logId: string; report: AgentMuxClientIncidentReport; producer: AgentMuxClientIncidentProducer;
  receivedAt: number; bytes: number; key: string; digest: string }
export type ClientIncidentReceipt = { accepted: boolean; logId?: string }
const ID = /^[A-Za-z0-9_-]{1,128}$/
const emptyCounters = (): Manifest['counters'] => ({ dropped: 0, invalid: 0, duplicates: 0, evicted: 0,
  corrupt: 0, writeFailures: 0, indexFailures: 0, cleanupFailures: 0 })
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const safeInt = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
function readingKey(report: AgentMuxClientIncidentReport, producer: AgentMuxClientIncidentProducer): string | null {
  if (!report.reading) return null
  const scope = report.reading.scope
  return JSON.stringify([producer.appInstanceId, producer.producerInstanceId, scope.owner, scope.ownerInstanceId,
    scope.consumerKind, scope.consumerId, scope.hostId, scope.agentSessionId, scope.runId, scope.sourceHostId, scope.producerBuildId, report.reading.trigger])
}

async function readIncidentFile(path: string, maxBytes: number, beforeRead?: (path: string) => Promise<void>): Promise<string> {
  await beforeRead?.(path)
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    if (length > maxBytes) throw new Error('Diagnostic file exceeds its owner budget.')
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
  } finally { await handle.close() }
}
function parseIncidentManifest(raw: string, hostId: string): Manifest {
  const value = JSON.parse(raw) as Manifest
  if (!value || Object.keys(value).sort().join() !== 'archiveId,counters,entries,evicted,revision,schema' || value.schema !== 'agentmux.client-incidents.v1' || !ID.test(value.archiveId) || !safeInt(value.revision) ||
    !Array.isArray(value.entries) || value.entries.length > CLIENT_INCIDENT_LIMITS.records ||
    !Array.isArray(value.evicted) || value.evicted.length > CLIENT_INCIDENT_LIMITS.records || value.evicted.some(id => typeof id !== 'string' || !ID.test(id)) ||
    !value.counters || Object.keys(emptyCounters()).some(key => !safeInt(value.counters[key as keyof Manifest['counters']]))) throw new Error('Invalid diagnostic index.')
  let bytes = 0
  const ids = new Set<string>()
  for (const entry of value.entries) {
    if (Object.keys(entry).sort().join() !== 'bytes,digest,key,sequence,summary') throw new Error('Invalid diagnostic index entry.')
    const ref = entry?.summary?.recordRef
    if (!ref || !ID.test(ref.logId) || ref.domain !== 'client.incident' || ref.routeHostId !== hostId ||
      ref.authority?.id !== value.archiveId || ref.authority?.kind !== 'client-incident-archive' || ref.authority?.lifetime !== 'durable' ||
      !safeInt(entry.sequence) || entry.sequence > value.revision || !safeInt(entry.bytes) || entry.bytes > CLIENT_INCIDENT_LIMITS.recordBytes || typeof entry.key !== 'string' || entry.key.length > 450 ||
      !/^[a-f0-9]{64}$/.test(entry.digest) || !safeInt(entry.summary.receivedAt) || ids.has(ref.logId)) throw new Error('Invalid diagnostic index entry.')
    ids.add(ref.logId); bytes += entry.bytes
    // Historical bytes were observed, not fsync-confirmed by this process.
    if (entry.summary.persistence === 'confirmed') entry.summary.persistence = 'observed'
  }
  parseClientIncidentPage({ kind: 'client-incident-page', items: value.entries.map(entry => entry.summary).slice(0, 32), nextCursor: null,
    coverage: { startup: 'ready', retainedCount: value.entries.length, retainedBytes: bytes, pendingWrites: 0, ...value.counters } },
    { domain: 'client.incident', hostId: hostId, recent: { limit: 32 } })
  for (let offset = 32; offset < value.entries.length; offset += 32) parseClientIncidentPage({ kind: 'client-incident-page',
    items: value.entries.slice(offset, offset + 32).map(entry => entry.summary), nextCursor: null,
    coverage: { startup: 'ready', retainedCount: value.entries.length, retainedBytes: bytes, pendingWrites: 0, ...value.counters } },
    { domain: 'client.incident', hostId: hostId, recent: { limit: 32 } })
  if (bytes > CLIENT_INCIDENT_LIMITS.bytes) throw new Error('Diagnostic index exceeds its owner budget.')
  return value
}
function manifestAuthority(manifest: Manifest): DiagnosticEvidenceAuthority {
  return { kind: 'client-incident-archive', id: manifest.archiveId, lifetime: 'durable' }
}
/** Original namespace observation only. This never creates, repairs or writes an archive. */
export async function readOriginalIncidentArchiveAuthority(directory: string): Promise<DiagnosticEvidenceAuthority> {
  return manifestAuthority(parseIncidentManifest(await readIncidentFile(join(directory, 'index.json'), CLIENT_INCIDENT_LIMITS.indexBytes), 'local'))
}

/** Host-owned immutable records and a bounded durable index. This owner performs no business calls. */
export class ClientIncidentArchive {
  readonly hostId = 'local'
  readonly appInstanceId = mintObjectId()
  private readonly queue: Pending[] = []
  private queueBytes = 0
  private readonly memory = new Map<string, AgentMuxClientIncidentRecord>()
  private readonly accepted = new Map<string, { logId: string; digest: string }>()
  private manifest: Manifest | null = null
  private startup: Counters['startup'] = 'loading'
  private counters = emptyCounters()
  private draining: Promise<void> | null = null
  private actualReaders = 0
  private cleanupBlocked: string | null = null
  private writeBlocked = false
  private readonly ready: Promise<void>
  constructor(readonly directory: string, private readonly dependencies: {
    write?: typeof durableWriteFile; now?: () => number; beforeRead?: (path: string) => Promise<void>; remove?: typeof unlink
  } = {}) { this.ready = this.initialize().catch(() => { this.startup = 'unavailable' }) }
  private now() { return this.dependencies.now?.() ?? Date.now() }
  private async write(path: string, content: string): Promise<void> {
    if (this.writeBlocked) throw new Error('Diagnostic publication is waiting for original temporary-file cleanup.')
    try { await (this.dependencies.write ?? durableWriteFile)(path, content, { mode: 0o600, requireDirectorySync: true }) }
    catch (error) {
      if (error instanceof DurableWriteError && error.cleanupIncomplete) { this.writeBlocked = true; this.counters.cleanupFailures++ }
      throw error
    }
  }
  get authority(): DiagnosticEvidenceAuthority | null {
    return this.manifest ? manifestAuthority(this.manifest) : null
  }
  /** Original archive route and namespace; admission still does not claim durable publication. */
  reference(logId: string): DiagnosticEvidenceRef | null {
    const authority = this.authority
    return authority && this.startup === 'ready' && (this.queue.some(item => item.logId === logId) ||
      this.manifest?.entries.some(entry => entry.summary.recordRef.logId === logId))
      ? { domain: 'client.incident', logId, authority, routeHostId: this.hostId } : null
  }
  private async readFile(path: string, maxBytes: number): Promise<string> {
    return await readIncidentFile(path, maxBytes, this.dependencies.beforeRead)
  }
  private async initialize(): Promise<void> {
    const earlyCounters = this.counters
    let existing = true
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await this.cleanupTemporaryFiles()
    const path = join(this.directory, 'index.json')
    try { this.manifest = parseIncidentManifest(await this.readFile(path, CLIENT_INCIDENT_LIMITS.indexBytes), this.hostId) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.counters.corrupt++; throw error }
      existing = false
      // A lost index must never silently create another namespace over retained originals.
      const directory = await opendir(this.directory)
      try { if (await directory.read()) throw new Error('Diagnostic index is missing.') }
      finally { await directory.close().catch(() => {}) }
      this.manifest = { schema: 'agentmux.client-incidents.v1', archiveId: mintObjectId(), revision: 0,
        entries: [], evicted: [], counters: emptyCounters() }
      try { await this.saveIndex() } catch (error) { this.manifest = null; throw error }
    }
    this.counters = Object.fromEntries(Object.keys(emptyCounters()).map(key => [key,
      (existing ? this.manifest!.counters[key as keyof Manifest['counters']] : 0) + earlyCounters[key as keyof Manifest['counters']]])) as Manifest['counters']
    for (const entry of this.manifest.entries) this.accepted.set(entry.key, { logId: entry.summary.recordRef.logId, digest: entry.digest })
    for (const entry of this.manifest.entries) if (!await this.cleanupCandidate(entry.summary.recordRef.logId)) break
    this.startup = 'ready'
  }
  private async saveIndex(): Promise<void> {
    const manifest = this.manifest!
    manifest.revision++; manifest.counters = { ...this.counters }
    const content = JSON.stringify(manifest) + '\n'
    if (Buffer.byteLength(content) > CLIENT_INCIDENT_LIMITS.indexBytes) throw new Error('Diagnostic index exceeds its owner budget.')
    try { await this.write(join(this.directory, 'index.json'), content) }
    catch (error) { this.counters.indexFailures++; throw error }
  }
  private omitQueued(index: number): void {
    const omitted = this.queue.splice(index, 1)[0]!
    this.queueBytes -= omitted.bytes; this.accepted.delete(omitted.key); this.counters.dropped++
  }
  /** The receiving Host stamps its own authority. The Renderer cannot supply any archive authority. */
  enqueue(input: AgentMuxClientIncidentReport, producer: AgentMuxClientIncidentProducer): ClientIncidentReceipt {
    let report: AgentMuxClientIncidentReport
    try { report = parseClientIncidentReport(input) } catch { this.counters.invalid++; return { accepted: false } }
    const bytes = Buffer.byteLength(JSON.stringify({ report, producer })) + 1024
    if (bytes > CLIENT_INCIDENT_LIMITS.recordBytes) { this.counters.invalid++; return { accepted: false } }
    const key = JSON.stringify([producer.appInstanceId, producer.producerInstanceId, report.occurrenceId]), fingerprint = digest({ report, producer })
    const previous = this.accepted.get(key)
    if (previous) {
      if (previous.digest !== fingerprint) { this.counters.invalid++; return { accepted: false } }
      this.counters.duplicates++; return { accepted: true, ...(this.startup === 'ready' ? { logId: previous.logId } : {}) }
    }
    // Preserve the same reading identity before considering queue reclamation.
    const logId = report.reading?.logId ?? mintObjectId()
    if (this.memory.has(logId) || this.queue.some(item => item.logId === logId) ||
      this.manifest?.entries.some(entry => entry.summary.recordRef.logId === logId)) { this.counters.dropped++; return { accepted: false } }
    const priority = clientIncidentPriority(report), reading = readingKey(report, producer)
    const same = reading === null ? [] : this.queue.filter((item, index) => index >= (this.draining ? 1 : 0) &&
      readingKey(item.report, item.producer) === reading)
    // The actual writer and the first pending checkpoint remain immutable.
    const replaced = same.length >= 2 ? same.at(-1) : undefined
    const queued = () => this.queue.filter(item => item !== replaced)
    const own = () => queued().filter(item => item.producer.producerInstanceId === producer.producerInstanceId)
    const lower = () => queued().filter(item => clientIncidentPriority(item.report) !== 'critical')
    const ownFull = () => own().length >= 8 || priority !== 'critical' &&
      own().filter(item => clientIncidentPriority(item.report) !== 'critical').length >= CLIENT_INCIDENT_LIMITS.readingProducerQueue
    const full = () => ownFull() || queued().length >= CLIENT_INCIDENT_LIMITS.queue ||
      this.queueBytes - (replaced?.bytes ?? 0) + bytes > CLIENT_INCIDENT_LIMITS.queueBytes || priority !== 'critical' &&
      (lower().length >= CLIENT_INCIDENT_LIMITS.readingQueue ||
        lower().reduce((total, item) => total + item.bytes, 0) + bytes > CLIENT_INCIDENT_LIMITS.readingQueueBytes)
    while (full()) {
      const ownBudget = ownFull()
      const candidate = (item: Pending, index: number, desired: 'progress' | 'reading') => index >= (this.draining ? 1 : 0) &&
        item !== replaced && clientIncidentPriority(item.report) === desired &&
        (!ownBudget || item.producer.producerInstanceId === producer.producerInstanceId)
      let victim = priority === 'progress' ? -1 : this.queue.findIndex((item, index) => candidate(item, index, 'progress'))
      if (victim < 0 && priority === 'critical') victim = this.queue.findIndex((item, index) => candidate(item, index, 'reading'))
      if (victim < 0) break
      this.omitQueued(victim)
    }
    if (this.startup === 'unavailable' || full()) { this.counters.dropped++; return { accepted: false } }
    if (replaced) this.omitQueued(this.queue.indexOf(replaced))
    const pending = { logId, report, producer: structuredClone(producer), receivedAt: this.now(), bytes, key, digest: fingerprint }
    this.accepted.set(key, { logId: pending.logId, digest: fingerprint })
    this.queue.push(pending); this.queueBytes += bytes
    this.startDrain()
    return { accepted: true, ...(this.startup === 'ready' ? { logId: pending.logId } : {}) }
  }
  private startDrain(): void {
    if (this.draining) return
    const operation = this.drain()
    this.draining = operation
    void operation.finally(() => { if (this.draining === operation) this.draining = null; if (this.queue.length) this.startDrain() }).catch(() => {})
  }
  private async drain(): Promise<void> {
    await this.ready
    while (this.queue.length) {
      const critical = this.queue.findIndex(item => clientIncidentPriority(item.report) === 'critical')
      const reading = this.queue.findIndex(item => clientIncidentPriority(item.report) === 'reading')
      const next = critical >= 0 ? critical : reading >= 0 ? reading : 0
      if (next > 0) this.queue.unshift(this.queue.splice(next, 1)[0]!)
      const pending = this.queue[0]!
      try {
        const original = this.manifest?.entries.find(entry => entry.key === pending.key)
        if (original) { if (original.digest === pending.digest) this.counters.duplicates++; else this.counters.invalid++ }
        else if (this.startup === 'ready') await this.publish(pending)
        else this.counters.dropped++
      }
      catch { this.counters.writeFailures++ }
      finally {
        this.queue.shift(); this.queueBytes -= pending.bytes
        if (!this.manifest?.entries.some(entry => entry.key === pending.key)) this.accepted.delete(pending.key)
      }
    }
  }
  /** Bounded restart recovery for this owner's unpublished durableWriteFile temporary names. */
  private async cleanupTemporaryFiles(): Promise<void> {
    const directory = await opendir(this.directory)
    let entries = 0
    try {
      for await (const entry of directory) {
        if (++entries > CLIENT_INCIDENT_LIMITS.records * 2 + 8) { this.writeBlocked = true; this.counters.cleanupFailures++; break }
        if (!/^(?:index\.json|[1-9A-HJ-NP-Za-km-z]{12}\.candidate)\.[0-9]+\.(?:[1-9A-HJ-NP-Za-km-z]{12}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.tmp$/u.test(entry.name)) continue
        try { await (this.dependencies.remove ?? unlink)(join(this.directory, entry.name)) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.writeBlocked = true; this.counters.cleanupFailures++ }
        }
      }
    } finally { await directory.close().catch(() => {}) }
  }
  private async cleanupCandidate(logId: string): Promise<boolean> {
    try {
      await (this.dependencies.remove ?? unlink)(join(this.directory, logId + '.candidate'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.cleanupBlocked = logId; this.counters.cleanupFailures++; return false }
    }
    if (this.cleanupBlocked === logId) this.cleanupBlocked = null
    return true
  }
  private async publish(pending: Pending): Promise<void> {
    if (this.writeBlocked) { this.counters.dropped++; return }
    if (this.cleanupBlocked && !await this.cleanupCandidate(this.cleanupBlocked)) { this.counters.dropped++; return }
    const manifest = this.manifest!, authority = this.authority!
    if (manifest.entries.some(entry => entry.summary.recordRef.logId === pending.logId)) { this.counters.dropped++; return }
    try {
      await lstat(join(this.directory, pending.logId + '.json'))
      this.counters.dropped++; return
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const record = parseClientIncidentRecord({ kind: 'client-incident', logId: pending.logId, authority,
      receivedAt: pending.receivedAt, producer: pending.producer, report: pending.report })
    const content = JSON.stringify(record) + '\n', bytes = Buffer.byteLength(content)
    const expiredBefore = this.now() - CLIENT_INCIDENT_LIMITS.retentionMs
    const priority = clientIncidentPriority(pending.report)
    const entryPriority = (entry: Entry) => clientIncidentPriority(this.memory.get(entry.summary.recordRef.logId)?.report ?? entry.summary)
    const reading = () => manifest.entries.filter(entry => entryPriority(entry) !== 'critical')
    const progress = () => manifest.entries.filter(entry => entryPriority(entry) === 'progress')
    const readingOverBudget = () => priority !== 'critical' &&
      (reading().length >= CLIENT_INCIDENT_LIMITS.readingRecords ||
        reading().reduce((total, entry) => total + entry.bytes, 0) + bytes > CLIENT_INCIDENT_LIMITS.readingBytes)
    const progressOverBudget = () => priority === 'progress' &&
      (progress().length >= CLIENT_INCIDENT_LIMITS.readingProgressRecords ||
        progress().reduce((total, entry) => total + entry.bytes, 0) + bytes > CLIENT_INCIDENT_LIMITS.readingProgressBytes)
    while (manifest.entries.length && (manifest.entries.length >= CLIENT_INCIDENT_LIMITS.records ||
      manifest.entries.reduce((total, entry) => total + entry.bytes, 0) + bytes > CLIENT_INCIDENT_LIMITS.bytes ||
      manifest.entries[0]!.summary.receivedAt < expiredBefore || readingOverBudget() || progressOverBudget())) {
      let victim = 0
      if (manifest.entries[0]!.summary.receivedAt >= expiredBefore) {
        victim = manifest.entries.findIndex(entry => entryPriority(entry) === 'progress')
        if (victim < 0 && priority !== 'progress') victim = manifest.entries.findIndex(entry => entryPriority(entry) === 'reading')
        if (victim < 0 && priority === 'critical') victim = 0
        if (victim < 0) { this.counters.dropped++; return }
      }
      const oldest = manifest.entries[victim]!, logId = oldest.summary.recordRef.logId
      // Keep the indexed identity until its file is actually removed. A failed removal stops only
      // this diagnostic publication, so repeated failures cannot grow unindexed disk garbage.
      await unlink(join(this.directory, logId + '.json')).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
      manifest.entries.splice(victim, 1); this.memory.delete(logId); this.accepted.delete(oldest.key)
      manifest.evicted.push(logId); if (manifest.evicted.length > CLIENT_INCIDENT_LIMITS.records) manifest.evicted.shift()
      this.counters.evicted++
    }
    const summary: Summary = { recordRef: { domain: 'client.incident', logId: record.logId, authority, routeHostId: this.hostId },
      kind: record.report.kind, stage: record.report.stage, code: record.report.code,
      agentSessionId: record.report.agentSessionId, runId: record.report.runId, attemptId: record.report.attemptId,
      occurrenceId: record.report.occurrenceId, receivedAt: record.receivedAt, persistence: 'unconfirmed',
      ...(record.producer.kind === 'mobile-web' ? { producer: { kind: 'mobile-web' as const,
        devicePrincipalId: record.producer.devicePrincipalId, documentId: record.producer.documentId, buildId: record.producer.buildId,
        namespaceDigest: record.producer.namespaceDigest } } : {}) }
    const entry: Entry = { summary, sequence: manifest.revision + 1, bytes, key: pending.key, digest: pending.digest }
    manifest.entries.push(entry); this.memory.set(record.logId, record)
    // Reserve the immutable identity before publication. A crash after this fence leaves a visible
    // unconfirmed reference, never an unlimited set of orphan records hidden from discovery.
    await this.saveIndex()
    const candidate = join(this.directory, record.logId + '.candidate')
    try {
      await this.write(candidate, content)
      await link(candidate, join(this.directory, record.logId + '.json'))
      const directory = await open(this.directory, 'r')
      try { await directory.sync() } finally { await directory.close() }
      entry.summary.persistence = 'confirmed'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        manifest.entries = manifest.entries.filter(current => current !== entry)
        this.memory.delete(record.logId); this.accepted.delete(pending.key); this.counters.dropped++
      } else this.counters.writeFailures++
      if (error instanceof DurableWriteError && error.phase === 'after-replace') entry.summary.persistence = 'unconfirmed'
    } finally { await this.cleanupCandidate(record.logId) }
    if (!this.writeBlocked) await this.saveIndex()
  }
  /** Testing/shutdown may await owned writes; no user operation waits for this promise. */
  async flush(): Promise<void> { await this.ready; await this.draining }
  private coverage(): Counters {
    return { startup: this.startup, retainedCount: this.manifest?.entries.length ?? 0,
      retainedBytes: this.manifest?.entries.reduce((total, entry) => total + entry.bytes, 0) ?? 0,
      pendingWrites: this.queue.length, ...this.counters }
  }
  private result(target: AgentMuxClientIncidentTarget, code?: DiagnosticEvidenceIssueCode): DiagnosticEvidenceRead<AgentMuxClientIncidentTarget, AgentMuxClientIncidentRecord | AgentMuxClientIncidentPage> {
    return { target, recordRef: null, readAuthority: this.authority, authorityStatus: this.authority ? 'verified' : 'unavailable',
      availability: 'unavailable', data: null, persistence: null, scope: 'record', observedAt: null,
      readAt: this.now(), completeness: 'unknown', raw: { retention: 'not-retained', returned: 'withheld', truncated: false },
      issue: code ? { code, stage: 'read', causeCode: null } : null }
  }
  async read(target: AgentMuxClientIncidentTarget, bounds: { signal: AbortSignal; maxBytes: number }) {
    try { parseClientIncidentTarget(target) } catch { return this.result(target, 'DIAGNOSTIC_EVIDENCE_SOURCE_FORBIDDEN') }
    const unavailable = this.result(target, 'DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE')
    if (target.hostId !== this.hostId) return { ...unavailable, availability: 'forbidden' as const,
      issue: { code: 'DIAGNOSTIC_EVIDENCE_SOURCE_FORBIDDEN' as const, stage: 'read' as const, causeCode: null } }
    if (this.startup !== 'ready') {
      if (target.authority) return this.result(target, 'DIAGNOSTIC_EVIDENCE_AUTHORITY_UNAVAILABLE')
      if ('recent' in target) return { ...unavailable, availability: 'found' as const, scope: 'interval-observation' as const,
        data: { kind: 'client-incident-page' as const, items: [], nextCursor: null, coverage: this.coverage() },
        raw: { retention: 'unknown' as const, returned: 'withheld' as const, truncated: false } }
      return this.readOriginal(target, bounds)
    }
    if ('authority' in target && target.authority && (target.authority.id !== this.authority!.id || target.authority.kind !== this.authority!.kind)) return {
      ...unavailable, issue: { code: 'DIAGNOSTIC_EVIDENCE_AUTHORITY_MISMATCH' as const, stage: 'authority' as const, causeCode: null } }
    if ('recent' in target) return this.recent(target, bounds.maxBytes)
    const entry = this.manifest!.entries.find(item => item.summary.recordRef.logId === target.logId)
    if (!entry) return { ...this.result(target), availability: this.manifest!.evicted.includes(target.logId) ? 'evicted' as const : 'not-found' as const,
      completeness: this.manifest!.evicted.includes(target.logId) ? 'complete' as const : 'unknown' as const }
    const memory = this.memory.get(target.logId)
    if (memory) return this.found(target, memory, entry.summary.persistence, bounds.maxBytes)
    return this.readOriginal(target, bounds, entry)
  }
  private async readOriginal(target: Extract<AgentMuxClientIncidentTarget, { logId: string }>,
    bounds: { signal: AbortSignal; maxBytes: number }, entry?: Entry) {
    const unavailable = this.result(target, 'DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE')
    if (this.actualReaders >= CLIENT_INCIDENT_LIMITS.readers) return this.result(target, 'DIAGNOSTIC_EVIDENCE_SOURCE_BUSY')
    this.actualReaders++
    const operation = (async () => {
      try {
        const record = parseClientIncidentRecord(JSON.parse(await this.readFile(join(this.directory, target.logId + '.json'), CLIENT_INCIDENT_LIMITS.recordBytes)))
        if (record.logId !== target.logId || entry && (record.authority.id !== this.authority!.id || digest({ report: record.report, producer: record.producer }) !== entry.digest)) throw new Error('Diagnostic record identity changed.')
        const found = this.found(target, record, 'observed', bounds.maxBytes)
        return entry ? found : { ...found, readAuthority: null, authorityStatus: 'unavailable' as const, completeness: 'partial' as const,
          issue: { code: 'DIAGNOSTIC_EVIDENCE_AUTHORITY_UNAVAILABLE' as const, stage: 'authority' as const, causeCode: null } }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' && (!entry || entry.summary.persistence === 'unconfirmed')) return unavailable
        if (typeof code === 'string' && code !== 'ENOENT' && code !== 'CONTROL_PROTOCOL_ERROR')
          return this.result(target, 'DIAGNOSTIC_EVIDENCE_SOURCE_READ_FAILED')
        this.counters.corrupt++; return { ...this.result(target, 'DIAGNOSTIC_EVIDENCE_SOURCE_CORRUPT'), availability: 'corrupt' as const } }
      finally { this.actualReaders-- }
    })()
    return await this.observe(operation, bounds.signal, unavailable)
  }
  private found(target: AgentMuxClientIncidentTarget, record: AgentMuxClientIncidentRecord, persistence: Persistence, maxBytes: number) {
    if (Buffer.byteLength(JSON.stringify(record)) + 1024 > maxBytes) return this.result(target, 'DIAGNOSTIC_EVIDENCE_QUERY_BUDGET')
    return { ...this.result(target), recordRef: { domain: 'client.incident', logId: record.logId, authority: record.authority, routeHostId: this.hostId },
      availability: 'found' as const, data: structuredClone(record), persistence, observedAt: record.receivedAt,
      completeness: 'complete' as const, raw: { retention: 'retained' as const, returned: 'withheld' as const, truncated: false }, issue: null }
  }
  private recent(target: Extract<AgentMuxClientIncidentTarget, { recent: unknown }>, maxBytes: number) {
    const query = target.recent, scope = digest({ archiveId: this.manifest!.archiveId, hostId: this.hostId,
      limit: query.limit ?? 20, since: query.since ?? null, until: query.until ?? null,
      agentSessionId: query.agentSessionId ?? null, runId: query.runId ?? null, kind: query.kind ?? null,
      producer: query.producer ? [query.producer.kind, query.producer.devicePrincipalId, query.producer.documentId,
        Object.hasOwn(query.producer, 'buildId'), query.producer.buildId ?? null,
        Object.hasOwn(query.producer, 'namespaceDigest'), query.producer.namespaceDigest ?? null] : null })
    let highWater = this.manifest!.revision
    let before: { receivedAt: number; logId: string } | null = null
    if (query.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as { scope: string; highWater: number; before: { receivedAt: number; logId: string } }
        if (cursor.scope !== scope || !safeInt(cursor.highWater) || cursor.highWater > this.manifest!.revision || !cursor.before || !safeInt(cursor.before.receivedAt) || !ID.test(cursor.before.logId)) throw new Error('Invalid diagnostic cursor.')
        before = cursor.before; highWater = cursor.highWater
      } catch { return this.result(target, 'DIAGNOSTIC_EVIDENCE_AUTHORITY_MISMATCH') }
    }
    const selected = this.manifest!.entries.filter(entry => entry.sequence <= highWater && (!before || entry.summary.receivedAt < before.receivedAt || entry.summary.receivedAt === before.receivedAt && entry.summary.recordRef.logId < before.logId) &&
      (query.since === undefined || entry.summary.receivedAt >= query.since) && (query.until === undefined || entry.summary.receivedAt <= query.until) &&
      (!query.agentSessionId || entry.summary.agentSessionId === query.agentSessionId) && (!query.runId || entry.summary.runId === query.runId) &&
      (!query.kind || entry.summary.kind === query.kind) && (!query.producer || entry.summary.producer?.devicePrincipalId === query.producer.devicePrincipalId &&
        entry.summary.producer.documentId === query.producer.documentId && (!Object.hasOwn(query.producer, 'buildId') || entry.summary.producer.buildId === query.producer.buildId) &&
        (!Object.hasOwn(query.producer, 'namespaceDigest') || entry.summary.producer.namespaceDigest === query.producer.namespaceDigest)))
      .sort((a, b) => b.summary.receivedAt - a.summary.receivedAt || (a.summary.recordRef.logId < b.summary.recordRef.logId ? 1 : a.summary.recordRef.logId > b.summary.recordRef.logId ? -1 : 0))
    const items: Summary[] = [], limit = query.limit ?? 20
    for (const entry of selected.slice(0, limit)) {
      if (Buffer.byteLength(JSON.stringify(items)) + Buffer.byteLength(JSON.stringify(entry.summary)) + 2048 > maxBytes) break
      items.push(structuredClone(entry.summary))
    }
    const nextCursor = selected.length > items.length && items.length
      ? Buffer.from(JSON.stringify({ scope, highWater, before: { receivedAt: items.at(-1)!.receivedAt, logId: items.at(-1)!.recordRef.logId } })).toString('base64url') : null
    const data: AgentMuxClientIncidentPage = { kind: 'client-incident-page', items, nextCursor, coverage: this.coverage() }
    return { ...this.result(target), availability: 'found' as const, data, scope: 'interval-observation' as const,
      persistence: null, observedAt: this.now(), raw: { retention: 'not-retained' as const, returned: 'withheld' as const, truncated: false }, completeness: items.length < Math.min(selected.length, limit) ? 'partial' as const : 'complete' as const, issue: null }
  }
  private async observe<T>(operation: Promise<T>, signal: AbortSignal, unavailable: T): Promise<T> {
    if (signal.aborted) return unavailable
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined
    try { return await Promise.race([operation, new Promise<T>(resolve => {
      timer = setTimeout(() => resolve(unavailable), 200)
      abort = () => resolve(unavailable); signal.addEventListener('abort', abort, { once: true })
    })]) } finally { clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort) }
  }
}
