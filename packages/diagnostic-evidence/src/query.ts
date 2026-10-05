import type { DiagnosticEvidenceBudget, DiagnosticEvidenceIssue, DiagnosticEvidenceIssueCode, DiagnosticEvidenceRead,
  DiagnosticEvidenceReader, DiagnosticEvidenceRelation, DiagnosticEvidenceReport, DiagnosticEvidenceTarget } from './protocol.js'

/** Small evidence envelopes, not profiles, images or arbitrary domain history. */
export const DIAGNOSTIC_EVIDENCE_DEFAULT_BUDGET: Readonly<DiagnosticEvidenceBudget> = Object.freeze({
  maxReads: 8, maxDepth: 2, maxBytes: 128 * 1024, deadlineMs: 1500,
})
const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength

export function unavailableDiagnosticEvidence<TTarget, TData>(target: TTarget,
  code: DiagnosticEvidenceIssueCode, readAt = Date.now()): DiagnosticEvidenceRead<TTarget, TData> {
  return { target, recordRef: null, readAuthority: null, authorityStatus: 'unavailable',
    availability: code === 'DIAGNOSTIC_EVIDENCE_SOURCE_UNSUPPORTED' ? 'unsupported' : code === 'DIAGNOSTIC_EVIDENCE_SOURCE_FORBIDDEN' ? 'forbidden' : 'unavailable',
    data: null, persistence: null, scope: 'record', observedAt: null, readAt, completeness: 'unknown',
    raw: { retention: 'unknown', returned: 'unavailable', truncated: null },
    issue: { code, stage: 'query', causeCode: null } }
}

/** No registry, storage, polling or business control. Reuse one instance per service.
 * A timed-out non-cancellable read keeps its slot until its actual Promise settles.
 */
export class DiagnosticEvidenceQuery {
  private inFlight = 0
  constructor(private readonly maxInFlight = 8) {
    if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1) throw new RangeError('A diagnostic query needs a finite in-flight bound.')
  }

  async inspect<TTarget extends DiagnosticEvidenceTarget, TData>(target: TTarget,
    reader: DiagnosticEvidenceReader<TTarget, TData>, options: {
      signal?: AbortSignal
      budget?: Partial<DiagnosticEvidenceBudget>
      related?(read: DiagnosticEvidenceRead<TTarget, TData>): readonly TTarget[]
      relations?(reads: readonly DiagnosticEvidenceRead<TTarget, TData>[]): readonly DiagnosticEvidenceRelation[]
    } = {}): Promise<DiagnosticEvidenceReport<TTarget, TData>> {
    const limits = { ...DIAGNOSTIC_EVIDENCE_DEFAULT_BUDGET, ...options.budget }
    for (const [key, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value < (key === 'maxDepth' ? 0 : key === 'maxBytes' ? 4096 : 1) ||
          value > DIAGNOSTIC_EVIDENCE_DEFAULT_BUDGET[key as keyof DiagnosticEvidenceBudget]) {
        throw new RangeError('Diagnostic request budget must fit the service envelope.')
      }
    }
    if (byteLength(target) > 1024) throw new RangeError('Diagnostic targets must fit 1024 bytes.')
    const started = performance.now(), end = started + limits.deadlineMs
    const reads: DiagnosticEvidenceRead<TTarget, TData>[] = [], relations: DiagnosticEvidenceRelation[] = []
    const issues: DiagnosticEvidenceIssue[] = []
    // Reserve the bounded report, issues and budget envelope, including separators.
    const payloadBudget = limits.maxBytes - 2048
    const queue = [{ target, depth: 0 }], seen = new Set<string>()
    let usedBytes = 0, partial = false
    while (queue.length && reads.length < limits.maxReads) {
      const next = queue.shift()!, key = JSON.stringify(next.target)
      if (seen.has(key)) continue
      seen.add(key)
      const remaining = end - performance.now()
      const code = options.signal?.aborted ? 'DIAGNOSTIC_EVIDENCE_QUERY_CANCELLED' : remaining <= 0 ? 'DIAGNOSTIC_EVIDENCE_QUERY_DEADLINE'
        : this.inFlight >= this.maxInFlight ? 'DIAGNOSTIC_EVIDENCE_SOURCE_BUSY' : null
      let read: DiagnosticEvidenceRead<TTarget, TData>
      if (code) read = unavailableDiagnosticEvidence(next.target, code)
      else {
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        let cancel!: () => void
        const interruption = new Promise<DiagnosticEvidenceRead<TTarget, TData>>(resolve => {
          cancel = () => { controller.abort(); resolve(unavailableDiagnosticEvidence(next.target, 'DIAGNOSTIC_EVIDENCE_QUERY_CANCELLED')) }
          options.signal?.addEventListener('abort', cancel, { once: true })
          timer = setTimeout(() => { controller.abort(); resolve(unavailableDiagnosticEvidence(next.target, 'DIAGNOSTIC_EVIDENCE_QUERY_DEADLINE')) }, remaining)
        })
        this.inFlight++
        const operation = Promise.resolve().then(() => {
          // Cancellation can arrive between inspect() and this deferred invocation.
          if (options.signal?.aborted) return unavailableDiagnosticEvidence<TTarget, TData>(next.target, 'DIAGNOSTIC_EVIDENCE_QUERY_CANCELLED')
          if (controller.signal.aborted || performance.now() >= end) return unavailableDiagnosticEvidence<TTarget, TData>(next.target, 'DIAGNOSTIC_EVIDENCE_QUERY_DEADLINE')
          return reader.read(next.target, { signal: controller.signal, maxBytes: Math.max(0, payloadBudget - usedBytes) })
        })
          .catch(() => unavailableDiagnosticEvidence<TTarget, TData>(next.target, 'DIAGNOSTIC_EVIDENCE_SOURCE_READ_FAILED'))
          .finally(() => { this.inFlight-- })
        try { read = await Promise.race([operation, interruption]) }
        finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel) }
      }
      let bytes: number
      try { bytes = byteLength(read) }
      catch { read = unavailableDiagnosticEvidence(next.target, 'DIAGNOSTIC_EVIDENCE_SOURCE_CORRUPT'); bytes = byteLength(read) }
      if (usedBytes + bytes > payloadBudget) {
        read = unavailableDiagnosticEvidence(next.target, 'DIAGNOSTIC_EVIDENCE_QUERY_BUDGET')
        bytes = byteLength(read)
        // The root always has a structured outcome; later reads cannot erase it.
        if (reads.length && usedBytes + bytes > payloadBudget) { partial = true; break }
      }
      reads.push(read); usedBytes += bytes
      if (read.availability !== 'found' || read.completeness !== 'complete' || read.issue) partial = true
      if (read.availability === 'found' && options.related) {
        let related: readonly TTarget[] = []
        try { related = options.related(read) }
        catch { issues.push({ code: 'DIAGNOSTIC_EVIDENCE_SOURCE_PROJECTION_FAILED', stage: 'projection', causeCode: null }); partial = true }
        if (next.depth >= limits.maxDepth) { if (related.length) partial = true }
        else {
          for (const link of related.slice(0, limits.maxReads)) {
            try {
              if (byteLength(link) <= 1024) queue.push({ target: link, depth: next.depth + 1 })
              else partial = true
            } catch { partial = true }
          }
          if (related.length > limits.maxReads) partial = true
        }
      }
    }
    if (queue.length) partial = true
    try {
      const candidates = options.relations?.(reads) ?? []
      if (candidates.length > limits.maxReads * 2) partial = true
      for (const relation of candidates.slice(0, limits.maxReads * 2)) {
        const bytes = byteLength(relation)
        if (usedBytes + bytes > payloadBudget) { partial = true; break }
        relations.push(relation); usedBytes += bytes
      }
    } catch {
      issues.push({ code: 'DIAGNOSTIC_EVIDENCE_SOURCE_PROJECTION_FAILED', stage: 'projection', causeCode: null }); partial = true
    }
    const report: DiagnosticEvidenceReport<TTarget, TData> = { reads, relations, issues, completeness: partial ? 'partial' : 'complete',
      budget: { ...limits, usedReads: reads.length, usedBytes: 0, elapsedMs: Math.max(0, Math.floor(performance.now() - started)) } }
    // usedBytes describes this serialized report, not just the successful data.
    for (let i = 0; i < 4; i++) report.budget.usedBytes = byteLength(report)
    return report
  }
}
