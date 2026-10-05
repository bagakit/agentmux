import { unavailableDiagnosticEvidence, type DiagnosticEvidenceReader, type DiagnosticEvidenceRelation,
  type DiagnosticEvidenceRef } from '@agentmux/diagnostic-evidence'
import type { DeliveryAttempt, DeliveryAttemptLookup, DeliveryFailure } from './delivery-attempt.js'
import type { AgentMuxDeliveryEvidenceTarget, AgentMuxDeliveryEvidence, AgentMuxDiagnosticAuthorityObservation,
  AgentMuxDiagnosticEvidenceRead, AgentMuxDiagnosticEvidenceTarget } from './diagnostic-evidence.js'

/** Error text, unknown stage strings and prompt digests do not enter the default projection. */
export const DELIVERY_EVIDENCE_STAGES = ['operation', 'connection', 'validation', 'transport-preparation', 'input-coordination',
  'core-submit', 'queue-validation', 'ordered-queue', 'queue-preparation', 'queue-admission', 'receipt', 'prepare', 'condition', 'submit', 'send', 'transport', 'preparation', 'readiness'] as const
const stages = new Set<string>(DELIVERY_EVIDENCE_STAGES)
/** Only named public owner codes and selected I/O codes are safe in the default projection.
 * This is a projection policy, not a global error registry; unknown codes remain in originals. */
export const DELIVERY_EVIDENCE_SAFE_CODES = [
  'EIO', 'ENOSPC', 'EACCES', 'ENOENT', 'EDQUOT', 'EMFILE', 'ENFILE', 'EPIPE', 'ECONNRESET',
  'ECONNREFUSED', 'ETIMEDOUT', 'EEXIST', 'ENOTDIR', 'EISDIR', 'EROFS', 'EINVAL', 'ABORT_ERR',
  'AGENT_PROMPT_PREPARATION_FAILED', 'IMMEDIATE_TRANSPORT_UNCONFIRMED', 'AGENT_CAPABILITY_INVALID',
  'AGENT_DELIVERY_STATE_INVALID', 'AGENT_INTERACTION_UNCONFIRMED', 'AGENT_INTERACTION_UNSUPPORTED',
  'AGENT_MESSAGE_INITIAL_RUN_UNCONFIRMED', 'AGENT_MESSAGE_RECEIPT_UNCONFIRMED', 'AGENT_PROMPT_INPUT_UNCONFIRMED',
  'CTXMUX_INPUT_CURSOR_MISSING', 'INVALID_AGENT_PROMPT', 'INVALID_AGENT_PROVIDER', 'MESSAGE_RECIPIENT_MISMATCH',
  'MESSAGE_SENDER_MISMATCH', 'STALE_AGENT_SESSION', 'STALE_AGENT_SESSION_BINDING', 'UNKNOWN_AGENT_INTERACTION',
  'UNKNOWN_AGENT_SESSION', 'RUNTIME_UNAVAILABLE', 'CONTROL_UNAVAILABLE', 'CONTROL_PERMISSION_DENIED',
  'INVALID_CONTROL_REQUEST', 'DELIVERY_LOG_UNAVAILABLE', 'DELIVERY_LOG_CORRUPT', 'DELIVERY_LOG_CONFLICT',
] as const
export function diagnosticCauseCode(value: unknown): string | null {
  return (DELIVERY_EVIDENCE_SAFE_CODES as readonly unknown[]).includes(value) ? value as string : null
}
function truncatedFailure(error: DeliveryFailure): boolean {
  return error.truncated === true || (error.cause !== undefined && truncatedFailure(error.cause))
}
export function projectDeliveryEvidence(record: DeliveryAttempt, includeRaw: boolean): AgentMuxDeliveryEvidence {
  const causeCodes: string[] = []
  for (let error: DeliveryFailure | undefined = record.error; error; error = error.cause) {
    const code = diagnosticCauseCode(error.code)
    if (code) causeCodes.push(code)
  }
  return { kind: 'delivery', source: record.source, agentSessionId: record.agentSessionId,
    operationId: record.operationId, hostId: record.hostId, expectedRunId: record.expectedRunId,
    afterSubmissionId: record.afterSubmissionId, execution: record.execution, startedAt: record.startedAt,
    failedAt: record.failedAt, stage: stages.has(record.stage) ? record.stage : null,
    error: { code: diagnosticCauseCode(record.error.code), causeCodes, controlFailure: record.error.controlFailure ?? null },
    coreLogId: record.coreLogId ?? null, observation: record.observation ?? null,
    reporter: record.reporter ? { kind: record.reporter.kind, receivedAt: record.reporter.receivedAt,
      routeHostId: record.reporter.routeHostId } : null,
    original: includeRaw ? record : null,
    missingEvidence: record.source === 'core' ? [{ source: 'native-recorder-first-failure', availability: 'not-exposed' }] : [] }
}

/** The source supplies real authority separately; a metadata failure cannot erase a readable record. */
export function deliveryEvidenceReader(options: {
  read(target: AgentMuxDeliveryEvidenceTarget): Promise<DeliveryAttemptLookup>
  authority(target: AgentMuxDeliveryEvidenceTarget): Promise<AgentMuxDiagnosticAuthorityObservation>
  includeRaw: boolean
}): DiagnosticEvidenceReader<AgentMuxDeliveryEvidenceTarget, AgentMuxDeliveryEvidence> {
  return { async read(target, bounds) {
    const readAt = Date.now(), unavailable = unavailableDiagnosticEvidence<AgentMuxDeliveryEvidenceTarget, AgentMuxDeliveryEvidence>
    let identity: AgentMuxDiagnosticAuthorityObservation
    try { identity = await options.authority(target) }
    catch (error) { identity = { authority: null, status: 'unavailable', causeCode: diagnosticCauseCode((error as { code?: unknown })?.code) } }
    if (target.authority && (identity.status !== 'verified' || !identity.authority || identity.authority.kind !== target.authority.kind || identity.authority.id !== target.authority.id)) {
      const code = !identity.authority ? 'DIAGNOSTIC_EVIDENCE_AUTHORITY_UNAVAILABLE' : identity.status !== 'verified'
        ? 'DIAGNOSTIC_EVIDENCE_AUTHORITY_UNVERIFIABLE' : 'DIAGNOSTIC_EVIDENCE_AUTHORITY_MISMATCH'
      const value = unavailable(target, code, readAt)
      return { ...value, readAuthority: identity.authority, authorityStatus: identity.status,
        issue: { code, stage: 'authority', causeCode: identity.causeCode } }
    }
    bounds.signal.throwIfAborted()
    const lookup = await options.read(target)
    const record = lookup.record
    if (lookup.availability !== 'found' || !record) return { ...unavailable(target, 'DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE', readAt),
      availability: lookup.availability, readAuthority: identity.authority, authorityStatus: identity.status,
      issue: lookup.availability === 'not-found' ? null : { code: 'DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE', stage: 'read', causeCode: null } }
    if (record.source !== (target.domain === 'delivery.client' ? 'client' : 'core') || record.logId !== target.logId) {
      return { ...unavailable(target, 'DIAGNOSTIC_EVIDENCE_SOURCE_CORRUPT', readAt), availability: 'corrupt' }
    }
    return { target, recordRef: { domain: target.domain, logId: record.logId, authority: identity.authority, routeHostId: target.hostId },
      readAuthority: identity.authority, authorityStatus: identity.status, availability: 'found',
      data: projectDeliveryEvidence(record, options.includeRaw), persistence: lookup.persistence, scope: 'record',
      observedAt: record.failedAt, readAt, completeness: truncatedFailure(record.error) ? 'partial' : 'complete',
      raw: { retention: 'retained', returned: options.includeRaw ? 'included' : 'withheld', truncated: truncatedFailure(record.error) },
      issue: !identity.authority ? { code: 'DIAGNOSTIC_EVIDENCE_AUTHORITY_UNAVAILABLE', stage: 'authority', causeCode: identity.causeCode }
        : identity.status !== 'verified' ? { code: 'DIAGNOSTIC_EVIDENCE_AUTHORITY_UNVERIFIABLE', stage: 'authority', causeCode: identity.causeCode }
        : lookup.issue ? { code: 'DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE', stage: 'read', causeCode: null } : null }
  } }
}

export function relatedDeliveryEvidence(read: AgentMuxDiagnosticEvidenceRead): AgentMuxDiagnosticEvidenceTarget[] {
  if (read.target.domain !== 'delivery.client' || !read.data?.coreLogId || !read.data.hostId) return []
  return [{ domain: 'delivery.core', hostId: read.data.hostId, logId: read.data.coreLogId }]
}
export function deliveryEvidenceRelations(reads: readonly AgentMuxDiagnosticEvidenceRead[]): DiagnosticEvidenceRelation[] {
  const relations: DiagnosticEvidenceRelation[] = []
  for (const read of reads) {
    if (read.target.domain !== 'delivery.client' || !read.recordRef || !read.data?.coreLogId || !read.data.hostId) continue
    const data = read.data
    const target = reads.find(candidate => candidate.target.domain === 'delivery.core' &&
      candidate.target.hostId === data.hostId && candidate.target.logId === data.coreLogId)
    const to: DiagnosticEvidenceRef = target?.recordRef ?? { domain: 'delivery.core', logId: data.coreLogId!, authority: null, routeHostId: data.hostId }
    const original = target?.data
    const conflict = original && (['agentSessionId', 'operationId', 'expectedRunId', 'afterSubmissionId'] as const)
      .some(key => data[key] !== null && original[key] !== null && data[key] !== original[key])
    const verified = read.authorityStatus === 'verified' && target?.authorityStatus === 'verified' &&
      read.recordRef.authority !== null && target.recordRef?.authority !== null
    relations.push({ from: read.recordRef, to, declaredBy: read.recordRef, kind: 'reported-core-error',
      verification: conflict ? 'conflict' : original && verified ? 'target-matched' : !target ? 'declared' : 'unverifiable',
      basis: [{ kind: 'declared-reference', refs: [read.recordRef] },
        ...(target?.recordRef ? [{ kind: 'scoped-record-read' as const, refs: [target.recordRef] }] : []),
        ...(original && verified && !conflict ? [{ kind: 'compatible-constraints' as const, refs: [read.recordRef, target!.recordRef!] }] : [])] })
  }
  return relations
}
