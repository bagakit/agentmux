import { AgentMuxError, type AgentMuxRpcCallContext, type AgentMuxRpcClient, type AgentMuxRpcServiceOptions } from '@agentmux/core'
import { unavailableDiagnosticEvidence, type AgentMuxClientIncidentTarget, type AgentMuxClientIncidentEvidence,
  type AgentMuxClientIncidentPort, type DiagnosticEvidenceRead } from '@agentmux/core/diagnostic-evidence'
import { ClientIncidentArchive, readOriginalIncidentArchiveAuthority } from './client-incident-archive.js'
import { mobileWebReportOwner } from './mobile-web-report-owner.js'

/** One writer for new mobile observations. The original Main archive is never opened for writing. */
export function createHostMobileIncidents(options: { directory: string; originalMainDirectory?: string;
  desktop(context: AgentMuxRpcCallContext): Promise<Pick<AgentMuxRpcClient, 'call' | 'dispose'>> }) {
  const archive = new ClientIncidentArchive(options.directory)
  const clientIncidents: NonNullable<AgentMuxRpcServiceOptions['clientIncidents']> = context => {
    const port: AgentMuxClientIncidentPort = { hostId: archive.hostId, async read(target, bounds) {
      const unavailable = (code: Parameters<typeof unavailableDiagnosticEvidence>[1]) => unavailableDiagnosticEvidence<AgentMuxClientIncidentTarget, AgentMuxClientIncidentEvidence>(target, code)
      if (!target.authority) {
        if (!('recent' in target)) return unavailable('DIAGNOSTIC_EVIDENCE_AUTHORITY_UNVERIFIABLE')
        const local = await archive.read(target, bounds)
        // This interval describes this Host's known mobile archive only. The
        // original Main history was not observed, independent of Main liveness.
        return { ...local, completeness: local.availability === 'found' ? 'partial' : local.completeness,
          issue: local.issue ?? { code: 'DIAGNOSTIC_EVIDENCE_AUTHORITY_UNVERIFIABLE', stage: 'authority', causeCode: null } }
      }
      const original = archive.authority
      if (original && target.authority.kind === original.kind && target.authority.id === original.id) return await archive.read(target, bounds)
      if (!options.originalMainDirectory) return unavailable('DIAGNOSTIC_EVIDENCE_AUTHORITY_UNAVAILABLE')
      const signal = context.signal ? AbortSignal.any([context.signal, bounds.signal]) : bounds.signal
      try {
        signal.throwIfAborted(); await context.assertCurrent?.()
        let main
        try { main = await readOriginalIncidentArchiveAuthority(options.originalMainDirectory) }
        catch { return unavailable('DIAGNOSTIC_EVIDENCE_AUTHORITY_UNAVAILABLE') }
        signal.throwIfAborted(); await context.assertCurrent?.()
        if (main.kind !== target.authority.kind || main.id !== target.authority.id) return unavailable('DIAGNOSTIC_EVIDENCE_AUTHORITY_MISMATCH')
        if (bounds.maxBytes < 4096) return unavailable('DIAGNOSTIC_EVIDENCE_QUERY_BUDGET')
        const desktop = await options.desktop({ ...context, signal })
        try {
          const result = await desktop.call('system.diagnostics.inspect', { target, includeRaw: false, includeRelated: false,
            budget: { maxReads: 1, maxDepth: 0, maxBytes: Math.min(bounds.maxBytes, 128 * 1024) } }, { signal })
          signal.throwIfAborted(); await context.assertCurrent?.()
          // The public client validates the exact root target and native data.
          return result.reads[0]! as DiagnosticEvidenceRead<AgentMuxClientIncidentTarget, AgentMuxClientIncidentEvidence>
        } finally { await desktop.dispose() }
      } catch (error) {
        if (signal.aborted) return unavailable('DIAGNOSTIC_EVIDENCE_QUERY_CANCELLED')
        if (error instanceof AgentMuxError && error.code === 'CONTROL_PERMISSION_DENIED') return unavailable('DIAGNOSTIC_EVIDENCE_SOURCE_FORBIDDEN')
        return unavailable('DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE')
      }
    }, get authority() { return archive.authority } }
    return port
  }
  return { clientIncidents, mobileWebReports: mobileWebReportOwner(archive), flush: () => archive.flush() }
}
