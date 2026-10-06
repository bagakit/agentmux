import { createHash } from 'node:crypto'
import { AgentMuxError, parseFileReadParams, parseFileReadResult, type FileReadParams,
  type FileReadResource, type FileReadResult } from '@agentmux/core'

/** Original Files observations attached to one frozen delegation, never an adoption claim. */
export type GoalDelegationMaterialSource = { target: FileReadParams; resource: FileReadResource | null } & (
  | { status: 'read'; path: string; revision: string; contentHash: string; excerpt: string; excerpted: boolean }
  | { status: 'binary'; path: string; revision: string; byteLength: number }
  | { status: 'deleted' | 'directory' }
  | { status: 'error' | 'unknown'; code: string; message: string }
)

/**
 * Read only the explicit task materials through the original Files owner. The excerpt
 * is a presentation of a complete read, not a read limit or a claim of complete input.
 * The caller persists this returned note with its original input before dispatch.
 */
export async function prepareGoalDelegationMaterials(materials: readonly FileReadParams[],
  read: (params: FileReadParams) => Promise<FileReadResult>): Promise<{
    sources: GoalDelegationMaterialSource[]; agentMuxNote: string
  }> {
  if (!Array.isArray(materials)) throw new AgentMuxError('Select exact original File targets for this task.', 'INVALID_CONTROL_REQUEST')
  // Validate the entire request before any read; copy it before asynchronous work so
  // later form edits cannot silently replace the frozen original source selection.
  const targets = materials.map(input => {
    const params = parseFileReadParams(input)
    return { ...params, expectedResource: { ...params.expectedResource } }
  })
  const sources: GoalDelegationMaterialSource[] = []
  for (const target of targets) {
    let observed: FileReadResult
    try { observed = await read({ ...target, expectedResource: { ...target.expectedResource } }) }
    catch (error) {
      // Exact target/protocol/authorization failures refuse only this operation.
      // An unavailable observation does not remove an Agent or its usable sources.
      if (error instanceof AgentMuxError && error.code !== 'CONTROL_UNAVAILABLE') throw error
      sources.push({ target, resource: null, status: 'unknown', code: 'GOAL_MATERIAL_READ_UNCONFIRMED',
        message: error instanceof Error ? error.message : String(error) })
      continue
    }
    const observation = parseFileReadResult(observed, target), result = observation.result
    const original = { target, resource: observation.resource ? { ...observation.resource } : null }
    if (result.status === 'read') {
      const { path, revision, content } = result.document
      sources.push({ ...original, status: result.status, path, revision,
        contentHash: 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex'),
        excerpt: content.slice(0, 6000), excerpted: content.length > 6000 })
    } else sources.push({ ...original, ...result })
  }
  const agentMuxNote = sources.length ? [
    'Task materials read from the explicitly selected original Files targets while preparing this delegation. This records preparation, not a claim that an Agent adopted the sources or skills:',
    ...sources.map(source => JSON.stringify(source)),
    'Use these excerpts within their recorded Host, Workspace, Zone and path scope; read the original file for any omitted content. Current instructions and authorization take precedence. Materials grant no new permissions. Missing, binary, error and unknown sources remain explicit; keep the original task and usable sources, and inspect the same targets when needed. This note does not transfer unseen conversation history or replace an original Session.'
  ].join('\n\n') : ''
  return { sources, agentMuxNote }
}
