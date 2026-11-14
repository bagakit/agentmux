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
/** A physical directory observation; this is neither a permission nor a publication grant. */
export type FolderDirectoryWitness = { realPath: string; device: string; inode: string }
export type FolderDirectoryResource = FolderResourceIdentity & { hostId: 'local'; witness: FolderDirectoryWitness }
export type FolderDirectoryInspectInput = { runtimeId: string; path: string; expectedResource?: FolderDirectoryResource }
export type FolderDirectoryRegistration = { runtimeId: string; directory: FolderDirectoryResource; workspaceId?: string }
export type FolderSpaceRegisterInput = FolderSpaceRegistration | FolderDirectoryRegistration
export type FolderSpaceReceipt = {
  reference: SpaceAuthorityRef; source: SpaceAuthoritySource; zoneId: string; workspaceId: string
  revision: number; diskDurability: 'confirmed'; created: boolean; resource: FolderResourceIdentity; directory?: FolderDirectoryResource
}
/** Current exact object observation, never an ACK of an earlier unknown write. */
export type FolderSpaceRegistrationInspection = Omit<FolderSpaceReceipt, 'created' | 'diskDurability'>
export type FolderDirectoryInspection = {
  source: SpaceAuthoritySource; resource: FolderDirectoryResource | null
  registrations: FolderSpaceRegistrationInspection[]; issue?: { code: string; message: string }
}
export const SPACE_FOLDER_METHODS = { 'space.folder.register': 'long', 'space.folder.inspect': 'long' } as const
export type SpaceFolderParams = { 'space.folder.register': FolderSpaceRegisterInput; 'space.folder.inspect': FolderDirectoryInspectInput }
export type SpaceFolderResults = { 'space.folder.register': FolderSpaceReceipt; 'space.folder.inspect': FolderDirectoryInspection }

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
export function parseFolderDirectoryResource(value: unknown, code = 'INVALID_CONTROL_REQUEST'): FolderDirectoryResource {
  const p = rpcRecord(value, ['hostId', 'workspacePath', 'projectRootPath', 'witness'], code)
  const resource = resourceIdentity({ hostId: p.hostId, workspacePath: p.workspacePath, projectRootPath: p.projectRootPath }, code)
  const w = rpcRecord(p.witness, ['realPath', 'device', 'inode'], code)
  if (resource.hostId !== 'local') throw new AgentMuxError('A new directory belongs to its original Source Files owner.', code)
  return { ...resource, hostId: 'local', witness: { realPath: identity(w.realPath, 'physical directory', code), device: identity(w.device, 'directory device', code), inode: identity(w.inode, 'directory inode', code) } }
}
export function parseFolderDirectoryInspectInput(value: unknown): FolderDirectoryInspectInput {
  const p = rpcRecord(value, ['runtimeId', 'path', 'expectedResource'])
  return { runtimeId: identity(p.runtimeId, 'Runtime', 'INVALID_CONTROL_REQUEST'), path: identity(p.path, 'directory path', 'INVALID_CONTROL_REQUEST'),
    ...(p.expectedResource === undefined ? {} : { expectedResource: parseFolderDirectoryResource(p.expectedResource) }) }
}
export function parseFolderSpaceRegisterInput(value: unknown): FolderSpaceRegisterInput {
  const p = rpcRecord(value, ['runtimeId', 'workspaceId', 'expectedResource', 'directory'])
  if (p.directory === undefined) return parseFolderSpaceRegistration(p)
  if (p.expectedResource !== undefined) throw new AgentMuxError('Choose one original Folder registration source.', 'INVALID_CONTROL_REQUEST')
  return { runtimeId: identity(p.runtimeId, 'Runtime', 'INVALID_CONTROL_REQUEST'), directory: parseFolderDirectoryResource(p.directory),
    ...(p.workspaceId === undefined ? {} : { workspaceId: identity(p.workspaceId, 'Workspace', 'INVALID_CONTROL_REQUEST') }) }
}
function sameResource(left: FolderResourceIdentity, right: FolderResourceIdentity): boolean {
  return left.hostId === right.hostId && left.workspacePath === right.workspacePath && left.projectRootPath === right.projectRootPath
}
function sameDirectory(left: FolderDirectoryResource, right: FolderDirectoryResource): boolean {
  return sameResource(left, right) && left.witness.realPath === right.witness.realPath && left.witness.device === right.witness.device && left.witness.inode === right.witness.inode
}
export function parseFolderSpaceReceipt(value: unknown, input: FolderSpaceRegisterInput): FolderSpaceReceipt {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['reference', 'source', 'zoneId', 'workspaceId', 'revision', 'diskDurability', 'created', 'resource', 'directory'], code)
  const ref = rpcRecord(p.reference, ['runtimeId', 'spaceId'], code), source = rpcRecord(p.source, ['runtimeId', 'ownerInstanceId'], code)
  identity(ref.spaceId, 'Space', code); identity(source.ownerInstanceId, 'Core instance', code); identity(p.zoneId, 'Zone', code); identity(p.workspaceId, 'Workspace', code)
  const resource = resourceIdentity(p.resource, code)
  const expected = 'directory' in input ? input.directory : input.expectedResource
  const directory = p.directory === undefined ? undefined : parseFolderDirectoryResource(p.directory, code)
  if (!sameResource(resource, expected) || directory !== undefined && !sameResource(directory, resource) || 'directory' in input && (!directory || !sameDirectory(directory, input.directory)) || ref.runtimeId !== input.runtimeId || source.runtimeId !== input.runtimeId || input.workspaceId !== undefined && p.workspaceId !== input.workspaceId ||
      !Number.isSafeInteger(p.revision) || (p.revision as number) < 1 || p.diskDurability !== 'confirmed' || typeof p.created !== 'boolean') {
    throw new AgentMuxError('Folder registration belongs to another original resource or has no confirmed save.', code)
  }
  return value as FolderSpaceReceipt
}
export function parseFolderDirectoryInspection(value: unknown, input: FolderDirectoryInspectInput): FolderDirectoryInspection {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['source', 'resource', 'registrations', 'issue'], code)
  const source = rpcRecord(p.source, ['runtimeId', 'ownerInstanceId'], code)
  if (source.runtimeId !== input.runtimeId) throw new AgentMuxError('The directory observation belongs to another original Source.', code)
  identity(source.ownerInstanceId, 'Core instance', code)
  const resource = p.resource === null ? null : parseFolderDirectoryResource(p.resource, code)
  if (resource && (resource.workspacePath !== input.path || input.expectedResource && !sameDirectory(resource, input.expectedResource))) throw new AgentMuxError('The observed directory differs from this original selection.', code)
  if (!Array.isArray(p.registrations) || resource === null && (p.registrations.length || p.issue === undefined)) throw new AgentMuxError('The original directory registrations are unconfirmed.', code)
  for (const item of p.registrations as unknown[]) {
    const r = rpcRecord(item, ['reference', 'source', 'zoneId', 'workspaceId', 'revision', 'resource', 'directory'], code)
    if (!resource) throw new AgentMuxError('A registration requires its original directory observation.', code)
    parseFolderSpaceReceipt({ ...r, created: false, diskDurability: 'confirmed' }, { runtimeId: input.runtimeId, workspaceId: identity(r.workspaceId, 'Workspace', code), expectedResource: resource })
  }
  if (p.issue !== undefined) { const issue = rpcRecord(p.issue, ['code', 'message'], code); identity(issue.code, 'directory issue code', code); identity(issue.message, 'directory issue', code) }
  return value as FolderDirectoryInspection
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
