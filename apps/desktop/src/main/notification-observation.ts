import { randomUUID } from 'node:crypto'
import { AgentMuxError } from '@agentmux/core'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, parseClientNotificationsObservation,
  type AgentMuxControlInspectNotificationsRequest, type AgentMuxControlResult } from '@agentmux/core/control'
import { unavailableDiagnosticEvidence, type AgentMuxClientNotificationsPort,
  type AgentMuxClientNotificationsEvidence, type AgentMuxClientNotificationsTarget } from '@agentmux/core/diagnostic-evidence'
import type { DesktopLoadedRenderer } from '../shared/client-observation.js'

/** Inspect the same attached document without selecting a window or opening its panel. */
export async function inspectNotifications(request: AgentMuxControlInspectNotificationsRequest, owner: {
  renderer(): DesktopLoadedRenderer | null
  generation(): number | null
  execute(request: AgentMuxControlInspectNotificationsRequest): Promise<AgentMuxControlResult>
}): Promise<AgentMuxControlResult> {
  const renderer = owner.renderer(), generation = owner.generation()
  if (!renderer || generation === null) throw new AgentMuxError('The notification document is unavailable.', 'CONTROL_UNAVAILABLE')
  const result = await owner.execute(request)
  if (owner.renderer() !== renderer || owner.generation() !== generation) {
    throw new AgentMuxError('The notification document changed during observation. Query its current owner again.', 'CONTROL_UNAVAILABLE')
  }
  if (result.operation !== 'inspect.notifications') throw new AgentMuxError('Unexpected notification observation operation.', 'CONTROL_PROTOCOL_ERROR')
  return { operation: result.operation, observation: parseClientNotificationsObservation(result.observation, request.target, request.includeRaw) }
}

/** The original client supplies this reader to the existing diagnostic query. */
export function clientNotificationsPort(hostId: string,
  execute: (request: AgentMuxControlInspectNotificationsRequest, signal?: AbortSignal) => Promise<AgentMuxControlResult>): AgentMuxClientNotificationsPort {
  return { hostId, async read(target, bounds) {
    const readAt = Date.now()
    const missing = (code: Parameters<typeof unavailableDiagnosticEvidence>[1]) => ({
      ...unavailableDiagnosticEvidence<AgentMuxClientNotificationsTarget, AgentMuxClientNotificationsEvidence>(target, code, readAt),
      scope: 'point-observation' as const
    })
    bounds.signal.throwIfAborted()
    if (target.hostId !== hostId) return missing('DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE')
    const maxBytes = bounds.maxBytes - Buffer.byteLength(JSON.stringify(target)) - 768
    if (maxBytes < 1) return missing('DIAGNOSTIC_EVIDENCE_QUERY_BUDGET')
    try {
      const result = await execute({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: randomUUID(),
        operation: 'inspect.notifications', target, includeRaw: bounds.includeRaw, maxBytes }, bounds.signal)
      if (result.operation !== 'inspect.notifications') throw new AgentMuxError('Unexpected notification observation operation.', 'CONTROL_PROTOCOL_ERROR')
      const observation = parseClientNotificationsObservation(result.observation, target, bounds.includeRaw)
      if (observation.issue) return { ...missing(observation.issue === 'query-budget'
        ? 'DIAGNOSTIC_EVIDENCE_QUERY_BUDGET' : 'DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE'), raw: observation.raw }
      if (!observation.data) return { ...missing('DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE'), availability: observation.availability, issue: null }
      const limited = observation.data.omissions.length > 0
      const partial = limited || observation.data.coverage.state === 'partial'
      return { target, recordRef: null, readAuthority: null, authorityStatus: 'unavailable', availability: 'found',
        data: observation.data, persistence: null, scope: 'point-observation', observedAt: null, readAt,
        completeness: partial ? 'partial' : 'complete', raw: observation.raw,
        issue: limited ? { code: 'DIAGNOSTIC_EVIDENCE_QUERY_BUDGET', stage: 'projection', causeCode: null } : null }
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : null
      if (code === 'CONTROL_PROTOCOL_ERROR') return { ...missing('DIAGNOSTIC_EVIDENCE_SOURCE_CORRUPT'), availability: 'corrupt' }
      return missing(code === 'CONTROL_UNAVAILABLE' ? 'DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE' : 'DIAGNOSTIC_EVIDENCE_SOURCE_READ_FAILED')
    }
  } }
}
