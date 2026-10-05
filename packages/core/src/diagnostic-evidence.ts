/** Public domain contracts. The portable mechanism owns no Core business payload. */
export * from '@agentmux/diagnostic-evidence'
import type { DiagnosticEvidenceAuthority, DiagnosticEvidenceBudget, DiagnosticEvidenceRead,
  DiagnosticEvidenceReport } from '@agentmux/diagnostic-evidence'
import type { DeliveryAttempt, DeliveryInputPhase } from './delivery-attempt.js'

export type AgentMuxDeliveryEvidenceTarget = {
  domain: 'delivery.client' | 'delivery.core'
  hostId: string
  logId: string
  /** A namespace constraint, independent of its subsequently observed lifetime. */
  authority?: Pick<DiagnosticEvidenceAuthority, 'kind' | 'id'>
}
export type AgentMuxNativeEvidenceTarget = {
  domain: 'native-recorder-failure'
  hostId: string
  agentSessionId: string
  runId: string
}
export type AgentMuxDiagnosticEvidenceTarget = AgentMuxDeliveryEvidenceTarget | AgentMuxNativeEvidenceTarget
export type AgentMuxDeliveryEvidence = {
  kind: 'delivery'
  source: 'client' | 'core'
  agentSessionId: string | null
  operationId: string | null
  hostId: string | null
  expectedRunId: string | null
  afterSubmissionId: string | null
  execution: 'default' | 'immediate' | null
  startedAt: number
  failedAt: number
  stage: string | null
  error: { code: string | null; causeCodes: string[]; controlFailure: DeliveryAttempt['error']['controlFailure'] | null }
  coreLogId: string | null
  observation: {
    source: 'core-session-projection'; observedAt: number; runId: string; submissionId: string | null
    admissionAcknowledged: boolean | null; payload: DeliveryInputPhase | null; submit: DeliveryInputPhase | null
  } | null
  reporter: { kind: 'user' | 'device'; receivedAt: number; routeHostId: string } | null
  /** Present only on explicit original-material reads. Never reconstruct unrecorded causes. */
  original: DeliveryAttempt | null
  missingEvidence: Array<{ source: 'native-recorder-first-failure'; availability: 'not-exposed' }>
}
export type AgentMuxDiagnosticEvidenceData = AgentMuxDeliveryEvidence
export type AgentMuxDiagnosticEvidenceRead = DiagnosticEvidenceRead<AgentMuxDiagnosticEvidenceTarget, AgentMuxDiagnosticEvidenceData>
export type AgentMuxDiagnosticEvidenceInspectParams = {
  /** Omit only to discover actual registered domain contracts, without reading any owner. */
  target?: AgentMuxDiagnosticEvidenceTarget
  includeRaw?: boolean
  includeRelated?: boolean
  budget?: Partial<DiagnosticEvidenceBudget>
}
export type AgentMuxDiagnosticEvidenceResult = DiagnosticEvidenceReport<AgentMuxDiagnosticEvidenceTarget, AgentMuxDiagnosticEvidenceData> & {
  capabilities: Array<{ domain: AgentMuxDiagnosticEvidenceTarget['domain']; target: 'log-id' | 'session-run'; raw: boolean; read: 'supported' | 'not-exposed' }>
}
export type AgentMuxDiagnosticAuthorityObservation = {
  authority: DiagnosticEvidenceAuthority | null
  status: 'verified' | 'unconfirmed' | 'unavailable'
  causeCode: string | null
}
