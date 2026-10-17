import { parseReadingDiagnosticRecord, type ReadingDiagnosticRecord, type ReadingDiagnosticScope } from './reading-diagnostic.js'
import { unavailableDiagnosticEvidence, type DiagnosticEvidenceRead } from '@agentmux/diagnostic-evidence'
import { AgentMuxError } from './errors.js'
import { deriveObjectId, mintObjectId } from './object-id.js'
import { createReadingDiagnosticRecorder, type ReadingDiagnosticRecorder } from './reading-diagnostic-recorder.js'
import { parseReadingDiagnosticFindParams, parseReadingDiagnosticTarget,
  READING_DIAGNOSTIC_MAX_FIND_BYTES, READING_DIAGNOSTIC_MAX_FIND_RESULTS,
  type ReadingDiagnosticExactTarget, type ReadingDiagnosticFindParams, type ReadingDiagnosticFindResult,
  type ReadingDiagnosticSummary } from './reading-diagnostic-query.js'

const MAX_RECORDS = 64, MAX_BYTES = 512 * 1024, MAX_ACTIVE = 32
const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))
/** Ephemeral observations from this one Core client. No IO, timer, source reads or durable-history claim. */
export class CoreReadingDiagnosticSource {
  private readonly instanceId = mintObjectId()
  private readonly authority = { kind: 'core-reading-observer', id: this.instanceId, lifetime: 'instance' as const }
  private readonly records: Array<{ serial: number; bytes: number; record: ReadingDiagnosticRecord }> = []
  private bytes = 0
  private serial = 0
  private evicted = 0
  private rejected = 0
  private active = 0

  begin(reference: { hostId: string; agentSessionId: string }, sourceHostId: string | null = null):
    { recorder: ReadingDiagnosticRecorder; end(): void } | undefined {
    if (this.active >= MAX_ACTIVE) { this.rejected++; return }
    try {
      const scope: ReadingDiagnosticScope = { hostId: reference.hostId, agentSessionId: reference.agentSessionId, runId: null, sourceHostId, owner: 'core', ownerInstanceId: this.instanceId,
        producerBuildId: null, consumerId: mintObjectId(), consumerKind: 'core-reader' }
      const recorder = createReadingDiagnosticRecorder(scope, { publish: record => this.retain(record) })
      this.active++
      let ended = false
      return { recorder, end: () => { if (!ended) { ended = true; this.active-- } } }
    } catch { this.rejected++; return }
  }
  private retain(input: ReadingDiagnosticRecord): void {
    const record = parseReadingDiagnosticRecord(input), bytes = size(record)
    if (bytes > MAX_BYTES || this.records.some(entry => entry.record.logId === record.logId)) { this.rejected++; return }
    // JSON metadata is detached again at the receiving owner; callers never receive these internal values.
    this.records.push({ serial: ++this.serial, bytes, record }); this.bytes += bytes
    while (this.records.length > MAX_RECORDS || this.bytes > MAX_BYTES) {
      this.bytes -= this.records.shift()!.bytes; this.evicted++
    }
  }
  read(input: ReadingDiagnosticExactTarget): DiagnosticEvidenceRead<ReadingDiagnosticExactTarget, ReadingDiagnosticRecord> {
    const target = parseReadingDiagnosticTarget(input)
    if (!('logId' in target)) throw new AgentMuxError('An exact original Core diagnostic reference is required.', 'INVALID_CONTROL_REQUEST')
    const missing = unavailableDiagnosticEvidence<ReadingDiagnosticExactTarget, ReadingDiagnosticRecord>(target, 'DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE')
    if (target.authority && (target.authority.kind !== this.authority.kind || target.authority.id !== this.authority.id))
      return { ...missing, issue: { code: 'DIAGNOSTIC_EVIDENCE_AUTHORITY_MISMATCH', stage: 'authority', causeCode: null } }
    const record = this.records.find(entry => entry.record.logId === target.logId)?.record
    if (!record || record.scope.hostId !== target.hostId) return { ...missing, availability: 'not-found', readAuthority: { ...this.authority }, authorityStatus: 'verified', issue: null }
    return { target, recordRef: { domain: 'reading.lifecycle', logId: record.logId, authority: { ...this.authority }, routeHostId: target.hostId },
      readAuthority: { ...this.authority }, authorityStatus: 'verified', availability: 'found', data: parseReadingDiagnosticRecord(record),
      persistence: 'observed', scope: 'record', observedAt: record.events.at(-1)?.wallMs ?? record.startedAt, readAt: Date.now(),
      completeness: record.coverage.overwritten || record.coverage.rejected || record.coverage.publicationFailures ? 'partial' : 'complete',
      raw: { retention: 'not-retained', returned: 'withheld', truncated: false }, issue: null }
  }
  find(input: ReadingDiagnosticFindParams): ReadingDiagnosticFindResult {
    const query = parseReadingDiagnosticFindParams(input)
    const { cursor, maxBytes: _maxBytes, limit: _limit, ...filter } = query
    const queryId = deriveObjectId('reading-query', JSON.stringify(filter))
    let before = this.serial + 1
    if (cursor) {
      try {
        const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
        if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== this.instanceId || parsed[1] !== queryId || !Number.isSafeInteger(parsed[2]) || parsed[2] < 1 || parsed[2] > this.serial + 1) throw Error()
        before = parsed[2]
      } catch { throw new AgentMuxError('The original diagnostic cursor belongs to another source or query.', 'INVALID_CONTROL_REQUEST') }
    }
    const records: ReadingDiagnosticSummary[] = []
    const result: ReadingDiagnosticFindResult = { query, availability: 'found', authority: { ...this.authority }, records, nextCursor: null,
      coverage: { retainedRecords: this.records.length, evictedRecords: this.evicted, rejectedRecords: this.rejected, examinedRecords: 0, complete: true }, issue: null }
    const limit = query.limit ?? READING_DIAGNOSTIC_MAX_FIND_RESULTS, maxBytes = query.maxBytes ?? READING_DIAGNOSTIC_MAX_FIND_BYTES
    for (let index = this.records.length - 1; index >= 0; index--) {
      const entry = this.records[index]!, record = entry.record, observedAt = record.events.at(-1)?.wallMs ?? record.startedAt
      if (entry.serial >= before) continue
      result.coverage.examinedRecords++
      if (record.scope.hostId !== query.hostId || query.agentSessionId !== undefined && record.scope.agentSessionId !== query.agentSessionId || query.runId !== undefined && record.scope.runId !== query.runId ||
        query.since !== undefined && observedAt < query.since || query.until !== undefined && observedAt > query.until) continue
      const nextCursor = Buffer.from(JSON.stringify([this.instanceId, queryId, entry.serial + 1])).toString('base64url')
      if (records.length >= limit) { result.nextCursor = nextCursor; result.coverage.complete = false; break }
      records.push({ reference: { domain: 'reading.lifecycle', logId: record.logId, authority: { ...this.authority }, routeHostId: query.hostId },
        scope: { ...record.scope }, trigger: record.trigger, observedAt, startedAt: record.startedAt, endedAt: record.endedAt,
        firstSequence: record.coverage.firstSequence, lastSequence: record.coverage.lastSequence, eventCount: record.events.length })
      if (size(result) + 512 > maxBytes) {
        records.pop(); result.nextCursor = nextCursor; result.coverage.complete = false
        if (!records.length) result.issue = 'query-budget'
        break
      }
    }
    return result
  }
}
