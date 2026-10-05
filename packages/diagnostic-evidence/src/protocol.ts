/** A record namespace, never a route, PID, reporter claim or occurrence producer. */
export type DiagnosticEvidenceAuthority = {
  kind: string
  id: string
  lifetime: 'durable' | 'instance' | 'unknown'
}
export type DiagnosticEvidenceRef = {
  domain: string
  logId: string
  authority: DiagnosticEvidenceAuthority | null
  routeHostId: string | null
}
export type DiagnosticEvidenceTarget = { domain: string }
export const DIAGNOSTIC_EVIDENCE_ISSUE_CODES = [
  'DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE', 'DIAGNOSTIC_EVIDENCE_SOURCE_READ_FAILED', 'DIAGNOSTIC_EVIDENCE_SOURCE_CORRUPT', 'DIAGNOSTIC_EVIDENCE_SOURCE_NOT_EXPOSED',
  'DIAGNOSTIC_EVIDENCE_SOURCE_UNSUPPORTED', 'DIAGNOSTIC_EVIDENCE_SOURCE_FORBIDDEN', 'DIAGNOSTIC_EVIDENCE_SOURCE_BUSY', 'DIAGNOSTIC_EVIDENCE_SOURCE_PROJECTION_FAILED', 'DIAGNOSTIC_EVIDENCE_AUTHORITY_UNAVAILABLE',
  'DIAGNOSTIC_EVIDENCE_AUTHORITY_MISMATCH', 'DIAGNOSTIC_EVIDENCE_AUTHORITY_UNVERIFIABLE', 'DIAGNOSTIC_EVIDENCE_QUERY_CANCELLED', 'DIAGNOSTIC_EVIDENCE_QUERY_DEADLINE', 'DIAGNOSTIC_EVIDENCE_QUERY_BUDGET',
] as const
export type DiagnosticEvidenceIssueCode = typeof DIAGNOSTIC_EVIDENCE_ISSUE_CODES[number]
/** Diagnostic issues do not replace a domain's primary failure or a transport error. */
export type DiagnosticEvidenceIssue = {
  code: DiagnosticEvidenceIssueCode
  stage: 'read' | 'authority' | 'projection' | 'query'
  causeCode: string | null
}
export const DIAGNOSTIC_EVIDENCE_AVAILABILITIES = [
  'found', 'not-found', 'unavailable', 'corrupt', 'evicted', 'expired',
  'not-exposed', 'unsupported', 'forbidden',
] as const
export type DiagnosticEvidenceRead<TTarget, TData> = {
  target: TTarget
  /** Null when no actual original record was acquired. Never mint an observation ID. */
  recordRef: DiagnosticEvidenceRef | null
  readAuthority: DiagnosticEvidenceAuthority | null
  authorityStatus: 'verified' | 'unconfirmed' | 'unavailable'
  availability: typeof DIAGNOSTIC_EVIDENCE_AVAILABILITIES[number]
  data: TData | null
  persistence: 'confirmed' | 'observed' | 'unconfirmed' | null
  scope: 'record' | 'point-observation' | 'interval-observation' | 'artifact'
  observedAt: number | null
  readAt: number
  completeness: 'complete' | 'partial' | 'unknown'
  raw: {
    retention: 'retained' | 'not-retained' | 'unknown'
    returned: 'included' | 'withheld' | 'unavailable'
    truncated: boolean | null
  }
  issue: DiagnosticEvidenceIssue | null
}
export interface DiagnosticEvidenceReader<TTarget, TData> {
  read(target: TTarget, bounds: { signal: AbortSignal; maxBytes: number }):
    Promise<DiagnosticEvidenceRead<TTarget, TData>>
}
export const DIAGNOSTIC_EVIDENCE_RELATION_KINDS = ['reported-core-error', 'owner-recorded-receipt', 'context'] as const
export const DIAGNOSTIC_EVIDENCE_BASIS_KINDS = [
  'declared-reference', 'scoped-record-read', 'compatible-constraints', 'owner-recorded-receipt', 'context-only',
] as const
export type DiagnosticEvidenceRelation = {
  from: DiagnosticEvidenceRef
  to: DiagnosticEvidenceRef
  declaredBy: DiagnosticEvidenceRef
  kind: typeof DIAGNOSTIC_EVIDENCE_RELATION_KINDS[number]
  verification: 'declared' | 'target-matched' | 'owner-confirmed' | 'unverifiable' | 'conflict'
  /** Finite kinds and original references only; no free text, prompts or credentials. */
  basis: Array<{ kind: typeof DIAGNOSTIC_EVIDENCE_BASIS_KINDS[number]; refs: DiagnosticEvidenceRef[] }>
}
export type DiagnosticEvidenceBudget = {
  maxReads: number
  maxDepth: number
  maxBytes: number
  deadlineMs: number
}
export type DiagnosticEvidenceReport<TTarget, TData> = {
  reads: DiagnosticEvidenceRead<TTarget, TData>[]
  relations: DiagnosticEvidenceRelation[]
  issues: DiagnosticEvidenceIssue[]
  completeness: 'complete' | 'partial'
  budget: DiagnosticEvidenceBudget & { usedReads: number; usedBytes: number; elapsedMs: number }
}
