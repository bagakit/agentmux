import { AgentMuxError } from './errors.js'
import { parseFolderSpaceRegistration, type FolderSpaceRegistration, type FolderSpaceRegistrationInspection } from './space-folder.js'
import { readSpaceSnapshot } from './space-authority-stream.js'
import type { AgentMuxRpcClient } from './public-rpc-client.js'

/** Inspect an unknown registration using original public objects, without deriving
 * an opaque ID, choosing the first alias, or replaying registration. */
export async function inspectFolderSpaceRegistration(rpc: Pick<AgentMuxRpcClient, 'call' | 'subscribe'>, value: FolderSpaceRegistration,
  options: { signal?: AbortSignal } = {}): Promise<FolderSpaceRegistrationInspection | null> {
  const input = parseFolderSpaceRegistration(value), expected = input.expectedResource
  const { owner } = await rpc.call('runtime.owner.identity', { expectedRuntimeId: input.runtimeId }, options)
  if (owner.runtimeId !== input.runtimeId) throw new AgentMuxError('The original registration belongs to another Runtime. Keep its frozen request.', 'RUNTIME_OWNER_MISMATCH')
  const { catalog } = await rpc.call('space.ls', { target: {} }, options)
  const spaces = new Set(catalog.spaces.filter(space => space.kind === 'folder' && space.hostId === expected.hostId && space.directoryPath === expected.projectRootPath).map(space => space.spaceId))
  const zones = new Set(catalog.zones.filter(zone => zone.workspaceId === input.workspaceId && zone.hostId === expected.hostId && zone.directoryPath === expected.workspacePath).map(zone => zone.zoneId))
  const candidates = catalog.bindings.filter(binding => spaces.has(binding.spaceId) && zones.has(binding.zoneId))
  if (!candidates.length) return null
  if (candidates.length !== 1) throw new AgentMuxError('Several original Folder bindings match this resource. Keep the request and inspect these original Spaces before choosing one.',
    'SPACE_REGISTRATION_AMBIGUOUS', JSON.stringify(candidates))
  const candidate = candidates[0]!, reference = { runtimeId: input.runtimeId, spaceId: candidate.spaceId }
  const snapshot = await readSpaceSnapshot(rpc, reference, options)
  if (!snapshot.scope.space || snapshot.scope.space.kind !== 'folder' || snapshot.scope.space.hostId !== expected.hostId || snapshot.scope.space.directoryPath !== expected.projectRootPath ||
      !snapshot.scope.zones.some(zone => zone.zoneId === candidate.zoneId && zone.workspaceId === input.workspaceId && zone.hostId === expected.hostId && zone.directoryPath === expected.workspacePath) ||
      !snapshot.scope.bindings.some(binding => binding.spaceId === candidate.spaceId && binding.zoneId === candidate.zoneId)) return null
  return { reference, source: snapshot.source, zoneId: candidate.zoneId, workspaceId: input.workspaceId, revision: snapshot.revision, resource: { ...expected } }
}
