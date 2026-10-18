import { parseDemandEvidence, type DemandFileEvidence } from '@agentmux/demand/goals'
import { AgentMuxError } from './errors.js'
import { parseFileReadParams, parseFileReadResult, type FileReadParams, type FileReadResult } from './public-rpc-files.js'

/** Capture an address from the Files receipt, never from a Project or display context. */
export function captureGoalFileEvidence(target: FileReadParams, value: FileReadResult, location?: DemandFileEvidence['location']): DemandFileEvidence {
  const read = parseFileReadResult(value, parseFileReadParams(target))
  if (!read.resource) throw new AgentMuxError('The original file resource is unconfirmed. Keep the original reference and inspect that file.', 'FILE_RESOURCE_UNCONFIRMED')
  const result = read.result
  return parseDemandEvidence({ kind: 'file', resource: read.resource,
    revision: result.status === 'read' ? result.document.revision : result.status === 'binary' ? result.revision : null,
    ...(location ? { location } : {}) }) as DemandFileEvidence
}

export function goalFileEvidenceReadParams(value: DemandFileEvidence): FileReadParams {
  const evidence = parseDemandEvidence(value) as DemandFileEvidence, resource = evidence.resource
  const root = resource.workspacePath.replace(/\/+$/u, '') || '/', zone = resource.zonePath.replace(/\/+$/u, '') || '/'
  const directory = resource.logicalDirectory ?? (zone === root ? '' : zone.slice(root === '/' ? 1 : root.length + 1))
  return parseFileReadParams({ zoneId: resource.zoneId, path: directory ? resource.path.slice(directory.length + 1) : resource.path,
    expectedResource: { hostId: resource.hostId, workspaceId: resource.workspaceId, workspacePath: resource.workspacePath } })
}

/** Re-observe only this original resource. Changed bytes remain readable as current bytes. */
export async function readGoalFileEvidence(evidence: DemandFileEvidence, read: (params: FileReadParams) => Promise<FileReadResult>) {
  const target = goalFileEvidenceReadParams(evidence), observation = parseFileReadResult(await read(target), target)
  const current = observation.resource ? captureGoalFileEvidence(target, observation) : null
  if (current && (['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'path', 'logicalDirectory'] as const)
    .some(key => current.resource[key] !== evidence.resource[key]))
    throw new AgentMuxError('The original file resource mapping changed. The reported evidence is retained; inspect its exact original source.', 'FILE_RESOURCE_MISMATCH')
  const revision = current?.revision ?? null
  const version = revision === null ? 'unavailable' : evidence.revision === null ? 'unrecorded' : revision === evidence.revision ? 'same' : 'changed'
  return { target, observation, version } as const
}
