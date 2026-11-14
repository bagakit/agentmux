import type { AgentMuxRpcParams, AgentMuxRpcResult } from '@agentmux/core'
import type { FileReadResource, FileReadParams } from '@agentmux/core/files'
import type { FolderDirectoryInspection, FolderDirectoryRegistration, FolderDirectoryResource, FolderSpaceRegistrationInspection } from '@agentmux/core/space-folder'
import type { SpaceMountRecord, SpaceMountSourceTarget } from './space-mount.js'

/** A carrier selection is separate from every original Source namespace below. */
export const SOURCE_FILES_METHODS = ['file.stat', 'file.read', 'file.list', 'file.write', 'file.restore', 'file.undo', 'file.create', 'file.mkdir', 'file.move', 'file.delete',
  'file.mutation.inspect', 'file.history', 'file.delete.snapshots'] as const
export type SourceFilesMethod = typeof SOURCE_FILES_METHODS[number]
export type SourceFilesCall<M extends SourceFilesMethod> = { method: M; params: AgentMuxRpcParams<M> }
/** carrierCurrent is a client observation; it never changes the original effect receipt. */
export type SourceFilesResult<M extends SourceFilesMethod> = { result: AgentMuxRpcResult<M>; carrierCurrent: boolean }
export type SourceFileReadLocation = { target: SpaceMountSourceTarget; resource: FileReadResource; query: Omit<FileReadParams, 'maxBytes'> }
export type SourceFilesLocator = { mount: SpaceMountRecord; resource: FileReadResource }
export type SourceFilesSelection = { kind: 'mount'; mount: SpaceMountRecord }
  | { kind: 'directory'; path: string; expectedResource?: FolderDirectoryResource; registration?: SpaceMountRecord }
export type SourceFilesResolution =
  | { status: 'located'; locator: SourceFilesLocator }
  | { status: 'registration-required'; registration: FolderDirectoryRegistration }
  | { status: 'selection-required'; registrations: FolderSpaceRegistrationInspection[]; issue?: FolderDirectoryInspection['issue'] }
  | { status: 'unconfirmed'; issue: { code: string; message: string } }

export function sourceFilesQuery(locator: Pick<SourceFilesLocator, 'resource'>, path: string) {
  return { zoneId: locator.resource.zoneId, path: path || '.', expectedResource: {
    hostId: locator.resource.hostId, workspaceId: locator.resource.workspaceId, workspacePath: locator.resource.workspacePath
  } }
}
function sourceEntryPath(root: string, path: string): string {
  const base = root === '.' ? '' : root
  return !path || path === '.' ? base : base ? base + '/' + path : path
}
/** A live Zone may change independently; its later path cannot replace the selected mapping. */
export function sourceFilesMappingMatches(locator: Pick<SourceFilesLocator, 'resource'>, resource: FileReadResource, path: string): boolean {
  const expected = sourceEntryPath(locator.resource.path, path)
  return ['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'logicalDirectory'].every(key =>
    resource[key as keyof typeof resource] === locator.resource[key as keyof typeof resource]) && (resource.path === '.' ? '' : resource.path) === expected
}

export function sourceTreeFileLocation(locator: SourceFilesLocator, path: string): SourceFileReadLocation {
  const { hostId, reference } = locator.mount
  return { target: { hostId, reference }, resource: { ...locator.resource, path: sourceEntryPath(locator.resource.path, path) || '.' },
    query: { ...sourceFilesQuery(locator, path), spaceId: reference.spaceId } }
}

/** Host ids inside a remote Runtime belong to its namespace. Its local filesystem maps to the carrier. */
export function sourceFileNativeHost(source: { target: { hostId: string }; resource: { hostId: string } }): string | undefined {
  if (source.target.hostId === 'local') return source.resource.hostId
  if (source.resource.hostId === 'local') return source.target.hostId
}

/** Confirm the original resource before handing its path to a Desktop native action. */
export async function originalNativeFileResource(source: SourceFileReadLocation,
  call: import('./source-files-client').SourceFilesApi['call'], purpose: 'directory' | 'entry' = 'entry'): Promise<FileReadResource> {
  const { result: observed, carrierCurrent } = await call(source.target, 'file.stat', source.query)
  if (!carrierCurrent || !observed.resource || observed.result.status !== 'observed' || !sourceFilesMappingMatches(source, observed.resource, '.'))
    throw new Error('The original Source file location could not be confirmed. Refresh its folder before retrying.')
  const kind = observed.result.observation.entry.kind
  if (purpose === 'directory' && kind !== 'directory') {
    if (kind === 'symlink') {
      const listing = await call(source.target, 'file.list', { ...source.query, mode: 'directory', limit: 1 })
      if (listing.carrierCurrent && listing.result.resource && sourceFilesMappingMatches(source, listing.result.resource, '.') &&
          listing.result.result.status === 'directory-listed') return observed.resource
    }
    throw new Error('The selected Source entry is no longer a confirmed directory. Refresh its folder before retrying.')
  }
  return observed.resource
}
