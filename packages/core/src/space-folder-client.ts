import { AgentMuxError } from './errors.js'
import { parseFolderSpaceRegistration, type FolderSpaceRegistration, type FolderSpaceRegistrationInspection } from './space-folder.js'
import { readSpaceSnapshot } from './space-authority-stream.js'
import { directoryIdentity, workspaceZoneId } from './space-identity.js'
import type { AgentMuxRpcClient } from './public-rpc-client.js'

/** Read the exact binding owned by configured Folder registration. Other Zones
 * can display the same Workspace and are independent of this registration. */
export async function inspectFolderSpaceRegistration(rpc: Pick<AgentMuxRpcClient, 'call' | 'subscribe'>, value: FolderSpaceRegistration,
  options: { signal?: AbortSignal } = {}): Promise<FolderSpaceRegistrationInspection | null> {
  const input = parseFolderSpaceRegistration(value), expected = input.expectedResource
  const { owner } = await rpc.call('runtime.owner.identity', { expectedRuntimeId: input.runtimeId }, options)
  if (owner.runtimeId !== input.runtimeId) throw new AgentMuxError('The original registration belongs to another Runtime. Keep its frozen request.', 'RUNTIME_OWNER_MISMATCH')
  const spaceId = directoryIdentity(expected.hostId, expected.projectRootPath)
  const zoneId = workspaceZoneId(spaceId, input.workspaceId)
  const reference = { runtimeId: input.runtimeId, spaceId }
  const snapshot = await readSpaceSnapshot(rpc, reference, options)
  if (snapshot.scope.space?.kind !== 'folder' || snapshot.scope.space.projectId !== spaceId ||
      snapshot.scope.space.hostId !== expected.hostId || snapshot.scope.space.directoryPath !== expected.projectRootPath ||
      !snapshot.scope.zones.some(zone => zone.zoneId === zoneId && zone.workspaceId === input.workspaceId &&
        (zone.kind === 'directory' || zone.kind === 'worktree') && zone.hostId === expected.hostId && zone.directoryPath === expected.workspacePath) ||
      !snapshot.scope.bindings.some(binding => binding.spaceId === spaceId && binding.zoneId === zoneId)) return null
  return { reference, source: snapshot.source, zoneId, workspaceId: input.workspaceId, revision: snapshot.revision, resource: { ...expected } }
}
