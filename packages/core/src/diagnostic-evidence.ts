import type { ReadingDiagnosticRecord } from './reading-diagnostic.js'
import type { AgentStartupDiagnosticTarget, AgentStartupDiagnosticData } from './startup-diagnostic.js'
export type * from './startup-diagnostic.js'
import type { ReadingDiagnosticTarget, ReadingDiagnosticFindResult } from './reading-diagnostic-query.js'
import type { PerformanceSceneEvidenceTarget, PerformanceSceneEvidence } from './performance-scene-evidence.js'
/** Public domain contracts. The portable mechanism owns no Core business payload. */
export * from '@agentmux/diagnostic-evidence'
import type { DiagnosticEvidenceAuthority, DiagnosticEvidenceBudget, DiagnosticEvidenceRead,
  DiagnosticEvidenceReport } from '@agentmux/diagnostic-evidence'
import type { DeliveryAttempt, DeliveryInputPhase } from './delivery-attempt.js'
import type { ToolkitPerformanceFailure, ToolkitPerformanceDiagnostics, ToolkitPerformanceIssue } from './toolkit-performance-failure.js'
import type { AgentMuxMoteContextEvidenceTarget, AgentMuxMoteContextEvidence } from './mote-context-observation.js'
export type { AgentMuxMoteContextEvidenceTarget, AgentMuxMoteContextEvidence } from './mote-context-observation.js'
import type { AgentMuxClientIncidentTarget, AgentMuxClientIncidentEvidence } from './client-incident.js'
export * from './client-incident.js'
import type { AgentMuxClientNotificationsTarget, AgentMuxClientNotificationsEvidence } from './client-notifications.js'
export * from './client-notifications.js'

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
export type AgentMuxToolkitFailureEvidenceTarget = { domain: 'toolkit.performance-failure'; hostId: string; executionId: string }
export type AgentMuxDiagnosticEvidenceTarget = AgentStartupDiagnosticTarget | ReadingDiagnosticTarget | PerformanceSceneEvidenceTarget | AgentMuxDeliveryEvidenceTarget | AgentMuxNativeEvidenceTarget | AgentMuxToolkitFailureEvidenceTarget | AgentMuxMoteContextEvidenceTarget | AgentMuxClientIncidentTarget | AgentMuxClientNotificationsTarget
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
export type AgentMuxToolkitFailureEvidence = {
  kind: 'toolkit-performance-failure'
  /** Original domain shape with text, stack and byte fragments withheld. */
  failure: ToolkitPerformanceFailure
  diagnostics: Pick<ToolkitPerformanceDiagnostics, 'captureEnabled' | 'failureEvidence' | 'droppedWrites' | 'persistence'> & {
    issue: Omit<ToolkitPerformanceIssue, 'message'> | null
    cleanupIssue: Omit<ToolkitPerformanceIssue, 'message'> | null
  }
  original: ToolkitPerformanceFailure | null
  coverage: 'latest-only'
  omissions: Array<'raw-query-budget'>
}
export type AgentMuxDiagnosticEvidenceData = AgentStartupDiagnosticData | ReadingDiagnosticRecord | ReadingDiagnosticFindResult | PerformanceSceneEvidence | AgentMuxDeliveryEvidence | AgentMuxToolkitFailureEvidence | AgentMuxMoteContextEvidence | AgentMuxClientIncidentEvidence | AgentMuxClientNotificationsEvidence
/** An existing client owner, injected by the host. Core owns no UI or source state. */
export type AgentMuxMoteContextEvidencePort = {
  hostId: string
  read(target: AgentMuxMoteContextEvidenceTarget, bounds: { signal: AbortSignal; maxBytes: number; includeRaw: boolean }):
    Promise<DiagnosticEvidenceRead<AgentMuxMoteContextEvidenceTarget, AgentMuxMoteContextEvidence>>
}
export type AgentMuxDiagnosticEvidenceRead = DiagnosticEvidenceRead<AgentMuxDiagnosticEvidenceTarget, AgentMuxDiagnosticEvidenceData>
export type AgentMuxDiagnosticEvidenceInspectParams = {
  /** Omit only to discover actual registered domain contracts, without reading any owner. */
  target?: AgentMuxDiagnosticEvidenceTarget
  includeRaw?: boolean
  includeRelated?: boolean
  budget?: Partial<DiagnosticEvidenceBudget>
}
export type AgentMuxDiagnosticEvidenceResult = DiagnosticEvidenceReport<AgentMuxDiagnosticEvidenceTarget, AgentMuxDiagnosticEvidenceData> & {
  capabilities: Array<{ domain: AgentMuxDiagnosticEvidenceTarget['domain']; target: 'log-id' | 'recent' | 'session-run' | 'execution-id' | 'mote-context' | 'capture-id' | 'reading-lifecycle' | 'notification-list' | 'notification-id'; raw: boolean; read: 'supported' | 'not-exposed' }>
}
export type AgentMuxDiagnosticAuthorityObservation = {
  authority: DiagnosticEvidenceAuthority | null
  status: 'verified' | 'unconfirmed' | 'unavailable'
  causeCode: string | null
}
