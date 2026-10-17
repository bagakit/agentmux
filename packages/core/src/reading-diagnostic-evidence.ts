import type { ReadingDiagnosticRecord } from './reading-diagnostic.js'
import { unavailableDiagnosticEvidence, type DiagnosticEvidenceRead } from '@agentmux/diagnostic-evidence'
import type { ReadingDiagnosticEvidencePort, ReadingDiagnosticFindParams, ReadingDiagnosticFindResult,
  ReadingDiagnosticTarget } from './reading-diagnostic-query.js'
import { parseReadingDiagnosticFindResult } from './reading-diagnostic-query.js'

/** Compose the existing owner port; discovery never opens a conversation or changes its source. */
export async function readReadingDiagnosticEvidence(target: ReadingDiagnosticTarget, port: ReadingDiagnosticEvidencePort,
  bounds: { signal: AbortSignal; maxBytes: number }): Promise<DiagnosticEvidenceRead<ReadingDiagnosticTarget, ReadingDiagnosticRecord | ReadingDiagnosticFindResult>> {
  if ('logId' in target) return port.read(target, bounds)
  const query: ReadingDiagnosticFindParams = { hostId: target.hostId, ...target.recent,
    maxBytes: Math.min(bounds.maxBytes, 128 * 1024) }
  if (query.maxBytes! < 4096) return unavailableDiagnosticEvidence(target, 'DIAGNOSTIC_EVIDENCE_QUERY_BUDGET')
  const page = parseReadingDiagnosticFindResult(await port.find(query, bounds), query)
  const result = unavailableDiagnosticEvidence<ReadingDiagnosticTarget, ReadingDiagnosticRecord | ReadingDiagnosticFindResult>(target, 'DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE')
  if (page.availability !== 'found') return { ...result, availability: page.availability,
    issue: { code: page.availability === 'forbidden' ? 'DIAGNOSTIC_EVIDENCE_SOURCE_FORBIDDEN' : page.availability === 'unsupported' ? 'DIAGNOSTIC_EVIDENCE_SOURCE_UNSUPPORTED' : 'DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE', stage: 'read', causeCode: null } }
  return { target, recordRef: null, readAuthority: page.authority, authorityStatus: page.authority ? 'verified' : 'unavailable',
    availability: 'found', data: page, persistence: null, scope: 'interval-observation', observedAt: null, readAt: Date.now(),
    completeness: page.coverage.complete && !page.issue ? 'complete' : 'partial',
    raw: { retention: 'not-retained', returned: 'withheld', truncated: false }, issue: null }
}
