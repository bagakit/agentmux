import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { directoryIdentity, workspaceZoneId } from './space-identity.js'
import type { SpaceAuthorityRef, SpaceAuthoritySource } from './space-authority.js'
import type { AgentMuxSpaceFact, AgentMuxZoneFact } from './space-control.js'

/** Supplied only by the answering Host's original configuration reader. */
export type FolderSpaceResource = {
  id: string; hostId: string; path: string; name: string; repoPath?: string; branch?: string; kind?: string
}
export type FolderResourceIdentity = { hostId: string; workspacePath: string; projectRootPath: string }
export type FolderSpaceRegistration = { runtimeId: string; workspaceId: string; expectedResource: FolderResourceIdentity }
export type FolderSpaceReceipt = {
  reference: SpaceAuthorityRef; source: SpaceAuthoritySource; zoneId: string; workspaceId: string
  revision: number; diskDurability: 'confirmed'; created: boolean; resource: FolderResourceIdentity
}
/** Current exact object observation, never an ACK of an earlier unknown write. */
export type FolderSpaceRegistrationInspection = Omit<FolderSpaceReceipt, 'created' | 'diskDurability'>
export const SPACE_FOLDER_METHODS = { 'space.folder.register': 'long' } as const
export type SpaceFolderParams = { 'space.folder.register': FolderSpaceRegistration }
export type SpaceFolderResults = { 'space.folder.register': FolderSpaceReceipt }

function identity(value: unknown, label: string, code: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new AgentMuxError(`An exact original ${label} is required.`, code)
  return value
}
function resourceIdentity(value: unknown, code: string): FolderResourceIdentity {
  const p = rpcRecord(value, ['hostId', 'workspacePath', 'projectRootPath'], code)
  return { hostId: identity(p.hostId, 'resource Host', code), workspacePath: identity(p.workspacePath, 'Workspace path', code), projectRootPath: identity(p.projectRootPath, 'Project root', code) }
}
export function folderResourceIdentity(resource: FolderSpaceResource): FolderResourceIdentity {
  return { hostId: resource.hostId, workspacePath: resource.path, projectRootPath: resource.repoPath ?? resource.path }
}
export function parseFolderSpaceRegistration(value: unknown): FolderSpaceRegistration {
  const p = rpcRecord(value, ['runtimeId', 'workspaceId', 'expectedResource'])
  return { runtimeId: identity(p.runtimeId, 'Runtime', 'INVALID_CONTROL_REQUEST'), workspaceId: identity(p.workspaceId, 'Workspace', 'INVALID_CONTROL_REQUEST'), expectedResource: resourceIdentity(p.expectedResource, 'INVALID_CONTROL_REQUEST') }
}
export function parseFolderSpaceReceipt(value: unknown, input: FolderSpaceRegistration): FolderSpaceReceipt {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['reference', 'source', 'zoneId', 'workspaceId', 'revision', 'diskDurability', 'created', 'resource'], code)
  const ref = rpcRecord(p.reference, ['runtimeId', 'spaceId'], code), source = rpcRecord(p.source, ['runtimeId', 'ownerInstanceId'], code)
  identity(ref.spaceId, 'Space', code); identity(source.ownerInstanceId, 'Core instance', code); identity(p.zoneId, 'Zone', code)
  const resource = resourceIdentity(p.resource, code)
  if (resource.hostId !== input.expectedResource.hostId || resource.workspacePath !== input.expectedResource.workspacePath || resource.projectRootPath !== input.expectedResource.projectRootPath || ref.runtimeId !== input.runtimeId || source.runtimeId !== input.runtimeId || p.workspaceId !== input.workspaceId ||
      !Number.isSafeInteger(p.revision) || (p.revision as number) < 1 || p.diskDurability !== 'confirmed' || typeof p.created !== 'boolean') {
    throw new AgentMuxError('Folder registration belongs to another original resource or has no confirmed save.', code)
  }
  return value as FolderSpaceReceipt
}
/** Same identity and resource facts as Desktop bootstrap, without client layout or configuration writes. */
export function folderSpaceFacts(resource: FolderSpaceResource): { space: AgentMuxSpaceFact; zone: AgentMuxZoneFact } {
  const root = resource.repoPath ?? resource.path, spaceId = directoryIdentity(resource.hostId, root)
  return {
    space: { spaceId, kind: 'folder', name: resource.path === root ? resource.name : root.split(/[\\/]/).filter(Boolean).at(-1) ?? root,
      hostId: resource.hostId, directoryPath: root, projectId: spaceId },
    zone: { zoneId: workspaceZoneId(spaceId, resource.id), workspaceId: resource.id,
      kind: resource.kind === 'worktree' ? 'worktree' : 'directory', hostId: resource.hostId, directoryPath: resource.path, branch: resource.branch ?? null }
  }
}
