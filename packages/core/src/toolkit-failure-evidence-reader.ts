import { unavailableDiagnosticEvidence, type DiagnosticEvidenceReader } from '@agentmux/diagnostic-evidence'
import { parseToolkitPerformanceDiagnostics, type ToolkitPerformanceDiagnostics, type ToolkitPerformanceIssue } from './toolkit-performance-failure.js'
import type { AgentMuxToolkitFailureEvidenceTarget, AgentMuxToolkitFailureEvidence } from './diagnostic-evidence.js'

/** This domain's safe codes; arbitrary native/Provider code remains explicit original material. */
export const TOOLKIT_FAILURE_EVIDENCE_SAFE_CODES = ['EIO', 'ENOSPC', 'EACCES', 'ENOENT', 'EDQUOT', 'EMFILE', 'ENFILE',
  'EPIPE', 'ECONNRESET', 'ETIMEDOUT', 'EROFS', 'EINVAL', 'CONTROL_PROTOCOL_ERROR', 'CONTROL_FAILED',
  'CONTROL_UNAVAILABLE', 'CONTROL_CANCELLED', 'TOOLKIT_DIAGNOSTIC_SUPERSEDED'] as const
export const TOOLKIT_FAILURE_EVIDENCE_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGABRT', 'SIGKILL', 'SIGSEGV', 'SIGPIPE', 'SIGALRM', 'SIGTERM', 'SIGBUS'] as const
export const toolkitFailureEvidenceCode = (v: unknown): string | null =>
  (TOOLKIT_FAILURE_EVIDENCE_SAFE_CODES as readonly unknown[]).includes(v) ? v as string : null
const safeIssue = (value: ToolkitPerformanceIssue | null) => value === null ? null : {
  operation: value.operation, code: toolkitFailureEvidenceCode(value.code), phase: value.phase,
}

/** Borrow one original read-only get, never run/start/subscribe/capture or a second failure store. */
export function toolkitFailureEvidenceReader(get: (includeRaw: boolean, signal: AbortSignal) => Promise<ToolkitPerformanceDiagnostics>,
  includeRaw: boolean): DiagnosticEvidenceReader<AgentMuxToolkitFailureEvidenceTarget, AgentMuxToolkitFailureEvidence> {
  return { async read(target, bounds) {
    const readAt = Date.now(), missing = (code: Parameters<typeof unavailableDiagnosticEvidence>[1]) =>
      unavailableDiagnosticEvidence<AgentMuxToolkitFailureEvidenceTarget, AgentMuxToolkitFailureEvidence>(target, code, readAt)
    bounds.signal.throwIfAborted()
    const diagnostics = parseToolkitPerformanceDiagnostics(await get(includeRaw, bounds.signal)), original = diagnostics.lastFailure
    if (!original || original.executionId !== target.executionId) return { ...missing('DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE'),
      availability: diagnostics.issue?.operation === 'read-failure' ? 'unavailable' : 'not-found',
      issue: diagnostics.issue?.operation === 'read-failure' ? { code: 'DIAGNOSTIC_EVIDENCE_SOURCE_READ_FAILED', stage: 'read', causeCode: null } : null }
    const details = original.details
    const truncated = details.error.messageTruncated || details.error.stackTruncated ||
      (details.bytes?.omittedBytes ?? 0) > 0 || (details.diagnosticOutput ?? []).some(value => value.omittedBytes > 0)
    // Ordinary get withholds fragment metadata. Absence cannot prove untruncated raw.
    const rawTruncated = truncated ? true : includeRaw && diagnostics.failureEvidence === 'included' ? false : null
    const safe: AgentMuxToolkitFailureEvidence = { kind: 'toolkit-performance-failure',
      failure: { ...original, details: { ...details,
        error: { ...details.error, message: null, stack: null, code: toolkitFailureEvidenceCode(details.error.code) },
        bytes: null, diagnosticOutput: [], exit: details.exit ? { code: details.exit.code,
          signal: (TOOLKIT_FAILURE_EVIDENCE_SIGNALS as readonly unknown[]).includes(details.exit.signal) ? details.exit.signal : null } : null } },
      diagnostics: { captureEnabled: diagnostics.captureEnabled, failureEvidence: diagnostics.failureEvidence,
        droppedWrites: diagnostics.droppedWrites, persistence: diagnostics.persistence,
        issue: safeIssue(diagnostics.issue), cleanupIssue: safeIssue(diagnostics.cleanupIssue) },
      original: includeRaw && diagnostics.failureEvidence === 'included' ? original : null, coverage: 'latest-only', omissions: [] }
    const result = { target, recordRef: null, readAuthority: null, authorityStatus: 'unconfirmed' as const, availability: 'found' as const,
      data: safe, persistence: diagnostics.persistence === 'confirmed' ? 'confirmed' as const : diagnostics.persistence === 'observed-on-disk'
        ? 'observed' as const : diagnostics.persistence === 'pending' || diagnostics.persistence === 'unconfirmed' ? 'unconfirmed' as const : null,
      scope: 'record' as const, observedAt: original.recordedAt, readAt, completeness: truncated ? 'partial' as const : 'complete' as const,
      raw: { retention: diagnostics.failureEvidence === 'none' ? 'not-retained' as const : 'retained' as const,
        returned: safe.original ? 'included' as const : diagnostics.failureEvidence === 'none' ? 'unavailable' as const : 'withheld' as const, truncated: rawTruncated },
      issue: null as import('@agentmux/diagnostic-evidence').DiagnosticEvidenceIssue | null }
    // The source's 128KiB original is independently bounded; it may not fit this query's remaining envelope.
    if (safe.original && Buffer.byteLength(JSON.stringify(result)) > bounds.maxBytes) {
      safe.original = null; safe.omissions.push('raw-query-budget'); result.raw.returned = 'withheld'
      result.completeness = 'partial'; result.issue = { code: 'DIAGNOSTIC_EVIDENCE_QUERY_BUDGET', stage: 'projection', causeCode: null }
    }
    return result
  } }
}
