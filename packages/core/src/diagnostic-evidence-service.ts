import { DiagnosticEvidenceQuery, DIAGNOSTIC_EVIDENCE_DEFAULT_BUDGET, unavailableDiagnosticEvidence,
  type DiagnosticEvidenceReader } from '@agentmux/diagnostic-evidence'
import { deliveryEvidenceReader, deliveryEvidenceRelations, relatedDeliveryEvidence } from './delivery-evidence-reader.js'
import type { AgentMuxRpcCoreClient, AgentMuxRpcServiceOptions } from './public-rpc-service.js'
import type { AgentMuxDiagnosticEvidenceData, AgentMuxDiagnosticEvidenceInspectParams,
  AgentMuxDiagnosticEvidenceResult, AgentMuxDiagnosticEvidenceTarget, AgentMuxDiagnosticAuthorityObservation } from './diagnostic-evidence.js'

export async function inspectDiagnosticEvidence(query: DiagnosticEvidenceQuery, params: AgentMuxDiagnosticEvidenceInspectParams,
  ports: AgentMuxRpcServiceOptions, caller: AgentMuxRpcCoreClient | undefined, signal?: AbortSignal): Promise<AgentMuxDiagnosticEvidenceResult> {
  const capabilities: AgentMuxDiagnosticEvidenceResult['capabilities'] = [
    ...(ports.deliveryAttempts ? [{ domain: 'delivery.client' as const, target: 'log-id' as const, raw: true, read: 'supported' as const }] : []),
    ...(ports.coreClients ? [{ domain: 'delivery.core' as const, target: 'log-id' as const, raw: true, read: 'supported' as const }] : []),
    { domain: 'native-recorder-failure', target: 'session-run', raw: false, read: 'not-exposed' },
  ]
  const complete = (report: Omit<AgentMuxDiagnosticEvidenceResult, 'capabilities'>): AgentMuxDiagnosticEvidenceResult => {
    const result = { ...report, capabilities }
    for (let i = 0; i < 4; i++) result.budget.usedBytes = Buffer.byteLength(JSON.stringify(result))
    return result
  }
  if (!params.target) return complete({ reads: [], relations: [], issues: [], completeness: 'complete',
    budget: { ...DIAGNOSTIC_EVIDENCE_DEFAULT_BUDGET, usedReads: 0, usedBytes: 0, elapsedMs: 0 } })
  const reader: DiagnosticEvidenceReader<AgentMuxDiagnosticEvidenceTarget, AgentMuxDiagnosticEvidenceData> = { async read(target, bounds) {
    const missing = (code: Parameters<typeof unavailableDiagnosticEvidence>[1]) => unavailableDiagnosticEvidence<AgentMuxDiagnosticEvidenceTarget, AgentMuxDiagnosticEvidenceData>(target, code)
    if (caller && target.hostId !== caller.hostId) return missing('DIAGNOSTIC_EVIDENCE_SOURCE_FORBIDDEN')
    if (target.domain === 'native-recorder-failure') return { ...missing('DIAGNOSTIC_EVIDENCE_SOURCE_NOT_EXPOSED'), availability: 'not-exposed', scope: 'point-observation' }
    if (target.domain === 'delivery.client') {
      const journal = ports.deliveryAttempts
      if (!journal || journal.hostId !== target.hostId) return missing('DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE')
      return deliveryEvidenceReader({ includeRaw: params.includeRaw === true,
        authority: () => journal.store.readJournalAuthority(), read: t => journal.store.read(t.logId) }).read(target, bounds)
    }
    // This borrows already-owned clients only. It never connects/probes a Runtime during inspection.
    const scopes = (await ports.coreClients?.() ?? []).filter(scope => scope.hostId === target.hostId && (!caller || scope.client === caller.client))
    if (scopes.length !== 1) return missing(scopes.length ? 'DIAGNOSTIC_EVIDENCE_SOURCE_CORRUPT' : 'DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE')
    const scope = scopes[0]!
    const authority = async (): Promise<AgentMuxDiagnosticAuthorityObservation> => {
      if (ports.diagnosticCoreAuthority) return ports.diagnosticCoreAuthority(scope)
      const identity = scope.client.runtimeOwnerIdentity?.()
      if (!identity || identity.availability !== 'connected') return { authority: null, status: 'unavailable', causeCode: null }
      return { authority: { kind: 'core-runtime', id: identity.runtimeId, lifetime: 'unknown' }, status: 'verified', causeCode: null }
    }
    return deliveryEvidenceReader({ includeRaw: params.includeRaw === true, authority,
      read: t => scope.client.readDeliveryAttempt(t.logId) }).read(target, bounds)
  } }
  return complete(await query.inspect(params.target, reader, {
    ...(signal ? { signal } : {}), ...(params.budget ? { budget: params.budget } : {}),
    ...(params.includeRelated === false ? {} : { related: relatedDeliveryEvidence }), relations: deliveryEvidenceRelations,
  }))
}
