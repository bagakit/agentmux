import { unavailableDiagnosticEvidence, type DiagnosticEvidenceRead } from '@agentmux/diagnostic-evidence'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseRendererV8Target } from './renderer-v8-profile.js'
import { diagnosticCauseCode } from './delivery-evidence-reader.js'
import {
  parseRendererSceneInspection,
  rendererScenePhases,
  type RendererSceneInspection,
  type RendererPerformanceScene
} from './renderer-performance-scene.js'
export type PerformanceSceneEvidenceTarget = { domain: 'performance.scene'; hostId: string; captureId: string }
export type PerformanceSceneEvidence = {
  kind: 'performance-scene'
  captureId: string
  target: RendererPerformanceScene['target']
  status: RendererPerformanceScene['status']
  requestedAt: number
  finishedAt: number
  coverage: 'latest-only'
  material: { method: 'system.metrics.scene.inspect'; captureId: string }
  phases: Array<{
    status: 'completed' | 'failed' | 'unknown' | 'skipped'
    hasOriginal: boolean
    profileBytes: number | null
    issueCodes: Array<string | null>
  }>
}
/** Safe projection only: no frames, URLs, raw trace, free-text errors, hostname or fabricated journal authority. */
export async function readPerformanceSceneEvidence(
  target: PerformanceSceneEvidenceTarget,
  read: (input: { captureId: string }, signal: AbortSignal) => Promise<RendererSceneInspection>,
  bounds: { signal: AbortSignal; maxBytes: number }
): Promise<DiagnosticEvidenceRead<PerformanceSceneEvidenceTarget, PerformanceSceneEvidence>> {
  const inspection = parseRendererSceneInspection(await read({ captureId: target.captureId }, bounds.signal), {
    captureId: target.captureId
  })
  if (inspection.status !== 'available')
    return {
      ...unavailableDiagnosticEvidence<PerformanceSceneEvidenceTarget, PerformanceSceneEvidence>(
        target,
        'DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE'
      ),
      availability:
        inspection.status === 'absent' ? 'not-found' : inspection.status === 'mismatch' ? 'evicted' : 'unavailable'
    }
  const scene = inspection.scene!,
    data: PerformanceSceneEvidence = {
      kind: 'performance-scene',
      captureId: scene.captureId,
      target: scene.target,
      status: scene.status,
      requestedAt: scene.requestedAt,
      finishedAt: scene.finishedAt,
      coverage: 'latest-only',
      material: { method: 'system.metrics.scene.inspect', captureId: scene.captureId },
      phases: rendererScenePhases(scene).map((p) => {
        const r = p.result as {
          profileBytes?: number | null
          traceBytes?: number | null
          issues?: Array<{ code: string }>
        } | null
        return {
          status: p.status,
          hasOriginal: p.result !== null,
          profileBytes: r?.profileBytes ?? r?.traceBytes ?? null,
          issueCodes: [
            ...(p.issue ? [diagnosticCauseCode(p.issue.code)] : []),
            ...(r?.issues ?? []).map((i) => diagnosticCauseCode(i.code))
          ]
        }
      })
    }
  const result = {
    target,
    recordRef: null,
    readAuthority: null,
    authorityStatus: 'unconfirmed' as const,
    availability: 'found' as const,
    data,
    persistence: 'observed' as const,
    scope: 'artifact' as const,
    observedAt: scene.finishedAt,
    readAt: Date.now(),
    completeness: 'partial' as const,
    raw: { retention: 'retained' as const, returned: 'withheld' as const, truncated: false },
    issue: null
  }
  if (Buffer.byteLength(JSON.stringify(result)) > bounds.maxBytes)
    return unavailableDiagnosticEvidence(target, 'DIAGNOSTIC_EVIDENCE_QUERY_BUDGET')
  return result
}
export function parsePerformanceSceneEvidence(value: unknown, captureId: string): PerformanceSceneEvidence {
  const bad = (): never => {
    throw new AgentMuxError('Performance scene safe diagnostic projection is invalid.', 'CONTROL_PROTOCOL_ERROR')
  }
  const fields = (v: unknown, keys: string[]) => {
    const r = rpcRecord(v, keys, 'CONTROL_PROTOCOL_ERROR')
    if (Object.keys(r).length !== keys.length) bad()
    return r
  }
  const r = fields(value, [
    'kind',
    'captureId',
    'target',
    'status',
    'requestedAt',
    'finishedAt',
    'coverage',
    'material',
    'phases'
  ])
  parseRendererV8Target(r.target, 'CONTROL_PROTOCOL_ERROR')
  const material = fields(r.material, ['method', 'captureId'])
  if (
    r.kind !== 'performance-scene' ||
    r.captureId !== captureId ||
    r.coverage !== 'latest-only' ||
    !['completed', 'partial', 'failed', 'unknown'].includes(String(r.status)) ||
    typeof r.requestedAt !== 'number' ||
    !Number.isFinite(r.requestedAt) ||
    r.requestedAt < 0 ||
    typeof r.finishedAt !== 'number' ||
    !Number.isFinite(r.finishedAt) ||
    r.finishedAt < r.requestedAt ||
    material.method !== 'system.metrics.scene.inspect' ||
    material.captureId !== captureId ||
    !Array.isArray(r.phases) ||
    r.phases.length !== 7
  )
    bad()
  for (const item of r.phases as unknown[]) {
    const p = fields(item, ['status', 'hasOriginal', 'profileBytes', 'issueCodes'])
    if (
      !['completed', 'failed', 'unknown', 'skipped'].includes(String(p.status)) ||
      typeof p.hasOriginal !== 'boolean' ||
      (p.profileBytes !== null && (!Number.isSafeInteger(p.profileBytes) || Number(p.profileBytes) < 0)) ||
      !Array.isArray(p.issueCodes) ||
      p.issueCodes.length > 9 ||
      (p.issueCodes as unknown[]).some((c) => c !== null && diagnosticCauseCode(c) !== c)
    )
      bad()
  }
  return r as unknown as PerformanceSceneEvidence
}
