import { randomUUID } from 'node:crypto'
import { AgentMuxError } from '@agentmux/core'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, parseMoteContextObservation,
  type AgentMuxControlInspectMoteContextRequest, type AgentMuxControlResult } from '@agentmux/core/control'
import { unavailableDiagnosticEvidence, type AgentMuxMoteContextEvidencePort,
  type AgentMuxMoteContextEvidence, type AgentMuxMoteContextEvidenceTarget } from '@agentmux/core/diagnostic-evidence'
import type { DesktopLoadedRenderer } from '../shared/client-observation.js'

/** Same loaded Renderer/navigation owner as inspect.client, in a separate strict envelope. */
export async function inspectMoteContext(request: AgentMuxControlInspectMoteContextRequest, owner: {
  renderer(): DesktopLoadedRenderer | null
  generation(): number | null
  execute(request: AgentMuxControlInspectMoteContextRequest): Promise<AgentMuxControlResult>
}): Promise<AgentMuxControlResult> {
  const renderer = owner.renderer(), generation = owner.generation()
  if (!renderer || generation === null) throw new AgentMuxError('Loaded Mote context owner is unavailable.', 'CONTROL_UNAVAILABLE')
  const result = await owner.execute(request)
  if (owner.renderer() !== renderer || owner.generation() !== generation) {
    throw new AgentMuxError('Desktop navigated during Mote context observation.', 'CONTROL_UNAVAILABLE')
  }
  if (result.operation !== 'inspect.mote-context') throw new AgentMuxError('Mote context returned an unexpected operation.', 'CONTROL_PROTOCOL_ERROR')
  return { operation: 'inspect.mote-context', observation: parseMoteContextObservation(result.observation, request.target, request.includeRaw) }
}

/** Inject this original client source into the existing shared DiagnosticEvidenceQuery. */
export function moteContextEvidencePort(hostId: string,
  execute: (request: AgentMuxControlInspectMoteContextRequest) => Promise<AgentMuxControlResult>): AgentMuxMoteContextEvidencePort {
  return { hostId, async read(target, bounds) {
    const readAt = Date.now()
    const missing = (code: Parameters<typeof unavailableDiagnosticEvidence>[1]) => ({
      ...unavailableDiagnosticEvidence<AgentMuxMoteContextEvidenceTarget, AgentMuxMoteContextEvidence>(target, code, readAt),
      scope: 'point-observation' as const
    })
    bounds.signal.throwIfAborted()
    if (target.hostId !== hostId) return missing('DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE')
    // Reserve the read wrapper and repeated exact query target before requesting any raw over IPC.
    const maxBytes = bounds.maxBytes - Buffer.byteLength(JSON.stringify(target)) - 512
    if (maxBytes < 1) return missing('DIAGNOSTIC_EVIDENCE_QUERY_BUDGET')
    try {
      // The query ends caller waiting; this Promise holds the actual IPC slot until reply/disposal.
      const result = await execute({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: randomUUID(),
        operation: 'inspect.mote-context', target, includeRaw: bounds.includeRaw, maxBytes })
      if (result.operation !== 'inspect.mote-context') throw new AgentMuxError('Invalid Mote context operation.', 'CONTROL_PROTOCOL_ERROR')
      const observed = parseMoteContextObservation(result.observation, target, bounds.includeRaw)
      if (observed.issue) return { ...missing('DIAGNOSTIC_EVIDENCE_QUERY_BUDGET'), raw: observed.raw }
      if (!observed.data) return { ...missing('DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE'), availability: 'not-found', issue: null }
      const budgetOmission = observed.data.omissions.includes('raw-query-budget')
      return { target, recordRef: null, readAuthority: null, authorityStatus: 'unavailable', availability: 'found',
        data: observed.data, persistence: null, scope: 'point-observation', observedAt: null, readAt,
        completeness: budgetOmission ? 'partial' : 'complete', raw: observed.raw,
        issue: budgetOmission ? { code: 'DIAGNOSTIC_EVIDENCE_QUERY_BUDGET', stage: 'projection', causeCode: null } : null }
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : null
      if (code === 'CONTROL_PROTOCOL_ERROR') return { ...missing('DIAGNOSTIC_EVIDENCE_SOURCE_CORRUPT'), availability: 'corrupt' }
      return missing(code === 'CONTROL_UNAVAILABLE' ? 'DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE' : 'DIAGNOSTIC_EVIDENCE_SOURCE_READ_FAILED')
    }
  } }
}
