import type { AgentMuxDiagnosticEvidenceRead, AgentMuxDiagnosticEvidenceTarget } from './diagnostic-evidence.js'

/** A producer's original typed references are declarations, never inferred causes. */
export function relatedClientIncidentEvidence(read: AgentMuxDiagnosticEvidenceRead): AgentMuxDiagnosticEvidenceTarget[] {
  return read.target.domain === 'client.incident' && read.data && 'kind' in read.data && read.data.kind === 'client-incident'
    ? read.data.report.references : []
}
