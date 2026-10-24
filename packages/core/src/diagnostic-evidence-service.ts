import { readReadingDiagnosticEvidence } from './reading-diagnostic-evidence.js'
import { parseStartupDiagnosticRead } from './startup-diagnostic.js'
import { readPerformanceSceneEvidence } from './performance-scene-evidence.js'
import { toolkitFailureEvidenceReader } from './toolkit-failure-evidence-reader.js'
import { rpcControlRequest } from './rpc-business-codec.js'
import { AgentMuxError } from './errors.js'
import { DiagnosticEvidenceQuery, DIAGNOSTIC_EVIDENCE_DEFAULT_BUDGET, unavailableDiagnosticEvidence,
  type DiagnosticEvidenceReader } from '@agentmux/diagnostic-evidence'
import { deliveryEvidenceReader, deliveryEvidenceRelations, relatedDeliveryEvidence } from './delivery-evidence-reader.js'
import { relatedClientIncidentEvidence } from './client-incident-evidence.js'
import type { AgentMuxRpcCoreClient, AgentMuxRpcServiceOptions } from './public-rpc-service.js'
import type { AgentMuxDiagnosticEvidenceData, AgentMuxDiagnosticEvidenceInspectParams,
  AgentMuxDiagnosticEvidenceResult, AgentMuxDiagnosticEvidenceTarget, AgentMuxDiagnosticAuthorityObservation } from './diagnostic-evidence.js'

export async function inspectDiagnosticEvidence(query: DiagnosticEvidenceQuery, params: AgentMuxDiagnosticEvidenceInspectParams,
  ports: Omit<AgentMuxRpcServiceOptions, 'clientIncidents'> & { clientIncidents?: import('./client-incident.js').AgentMuxClientIncidentPort }, caller: AgentMuxRpcCoreClient | undefined, signal?: AbortSignal): Promise<AgentMuxDiagnosticEvidenceResult> {
  const capabilities: AgentMuxDiagnosticEvidenceResult['capabilities'] = [
    ...(ports.coreClients ? [
      { domain: 'agent.startup' as const, target: 'log-id' as const, raw: true, read: 'supported' as const },
      { domain: 'agent.startup' as const, target: 'recent' as const, raw: false, read: 'supported' as const },
    ] : []),
    ...(ports.coreClients ? [{ domain: 'reading.lifecycle' as const, target: 'reading-lifecycle' as const, raw: false, read: 'supported' as const }] : []),
    ...(ports.deliveryAttempts ? [{ domain: 'delivery.client' as const, target: 'log-id' as const, raw: true, read: 'supported' as const }] : []),
    ...(ports.coreClients ? [{ domain: 'delivery.core' as const, target: 'log-id' as const, raw: true, read: 'supported' as const }] : []),
    ...(ports.toolkit ? [{ domain: 'toolkit.performance-failure' as const, target: 'execution-id' as const, raw: true, read: 'supported' as const }] : []),
    ...(ports.metrics?.inspectScene ? [{ domain: 'performance.scene' as const, target: 'capture-id' as const, raw: false, read: 'supported' as const }] : []),
    ...(ports.moteContext ? [{ domain: 'mote.context.client' as const, target: 'mote-context' as const, raw: true, read: 'supported' as const }] : []),
    ...(ports.clientIncidents ? [
      { domain: 'client.incident' as const, target: 'log-id' as const, raw: false, read: 'supported' as const },
      { domain: 'client.incident' as const, target: 'recent' as const, raw: false, read: 'supported' as const },
    ] : []),
    ...(ports.clientNotifications ? [
      { domain: 'client.notifications' as const, target: 'notification-list' as const, raw: true, read: 'supported' as const },
      { domain: 'client.notifications' as const, target: 'notification-id' as const, raw: true, read: 'supported' as const },
    ] : []),
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
    if (target.domain === 'agent.startup') {
      const scopes = (await ports.coreClients?.() ?? []).filter(scope => scope.hostId === target.hostId && (!caller || scope.client === caller.client))
      if (scopes.length !== 1) return missing(scopes.length ? 'DIAGNOSTIC_EVIDENCE_SOURCE_CORRUPT' : 'DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE')
      const client = scopes[0]!.client, local = { ...target, hostId: 'local' }
      const result = parseStartupDiagnosticRead('logId' in local
        ? await client.readAgentStartupDiagnostic({ target: local, includeRaw: params.includeRaw === true })
        : await client.findAgentStartupDiagnostics(local), local, params.includeRaw === true)
      // Route aliases never rewrite record-time Host, authority or producer facts.
      return { ...result, target, recordRef: result.recordRef ? { ...result.recordRef, routeHostId: target.hostId } : null,
        data: result.data?.kind === 'agent-startup-page' ? { ...result.data, items: result.data.items.map(item => ({
          ...item, recordRef: { ...item.recordRef, routeHostId: target.hostId } })) } : result.data }
    }
    if (target.domain === 'reading.lifecycle') {
      const scopes = (await ports.coreClients?.() ?? []).filter(scope => scope.hostId === target.hostId && (!caller || scope.client === caller.client))
      if (scopes.length !== 1) return missing(scopes.length ? 'DIAGNOSTIC_EVIDENCE_SOURCE_CORRUPT' : 'DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE')
      const client = scopes[0]!.client
      return readReadingDiagnosticEvidence(target, { hostId: target.hostId,
        read: async request => {
          const result = await client.readReadingDiagnostic({ ...request, hostId: 'local' })
          return { ...result, target: request, ...(result.recordRef ? { recordRef: { ...result.recordRef, routeHostId: request.hostId } } : {}) }
        }, find: async request => {
          const result = await client.findReadingDiagnostics({ ...request, hostId: 'local' })
          return { ...result, query: request, records: result.records.map(summary => ({ ...summary, reference: { ...summary.reference, routeHostId: request.hostId } })) }
        } }, bounds)
    }
    if (target.domain === 'client.incident') {
      const port = ports.clientIncidents
      if (!port) return missing('DIAGNOSTIC_EVIDENCE_SOURCE_UNSUPPORTED')
      if (port.hostId !== target.hostId) return missing('DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE')
      return port.read(target, bounds)
    }
    if (target.domain === 'client.notifications') {
      const port = ports.clientNotifications
      if (!port) return missing('DIAGNOSTIC_EVIDENCE_SOURCE_UNSUPPORTED')
      if (port.hostId !== target.hostId) return missing('DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE')
      return port.read(target, { ...bounds, includeRaw: params.includeRaw === true })
    }
    if (target.domain === 'performance.scene') {
      if (!ports.metrics?.inspectScene) return missing('DIAGNOSTIC_EVIDENCE_SOURCE_UNSUPPORTED')
      if (target.hostId !== 'local') return missing('DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE')
      return readPerformanceSceneEvidence(target, (input, signal) => ports.metrics!.inspectScene!(input, signal), bounds)
    }
    if (target.domain === 'mote.context.client') {
      const port = ports.moteContext
      if (!port) return missing('DIAGNOSTIC_EVIDENCE_SOURCE_UNSUPPORTED')
      if (port.hostId !== target.hostId) return missing('DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE')
      return port.read(target, { ...bounds, includeRaw: params.includeRaw === true })
    }
    if (target.domain === 'native-recorder-failure') return { ...missing('DIAGNOSTIC_EVIDENCE_SOURCE_NOT_EXPOSED'), availability: 'not-exposed', scope: 'point-observation' }
    if (target.domain === 'toolkit.performance-failure') {
      if (!ports.toolkit) return missing('DIAGNOSTIC_EVIDENCE_SOURCE_UNSUPPORTED')
      if (target.hostId !== (ports.deliveryAttempts?.hostId ?? 'local')) return missing('DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE')
      return toolkitFailureEvidenceReader(async (includeRaw, signal) => {
        const request = rpcControlRequest('toolkit.inspect', { toolId: 'performance', ...(includeRaw ? { includeFailureEvidence: true } : {}) })
        if (request.operation !== 'toolkit.get') throw new AgentMuxError('Toolkit diagnostic read must remain read-only.', 'CONTROL_PROTOCOL_ERROR')
        const result = await ports.toolkit!.execute(request, signal)
        if (result.operation !== 'toolkit.get' || result.snapshot.kind !== 'metrics') throw new AgentMuxError('Original Toolkit failure source is invalid.', 'CONTROL_PROTOCOL_ERROR')
        return result.snapshot.diagnostics
      }, params.includeRaw === true).read(target, bounds)
    }
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
    ...(params.includeRelated === false ? {} : { related: read => [...relatedDeliveryEvidence(read), ...relatedClientIncidentEvidence(read)] }),
    relations: deliveryEvidenceRelations,
  }))
}
