import type { AgentMuxRpcParams, AgentMuxRpcResult } from '@agentmux/core'
import type { FileReadResource } from '@agentmux/core/files'
import type { FolderDirectoryInspection, FolderDirectoryRegistration, FolderDirectoryResource, FolderSpaceRegistrationInspection } from '@agentmux/core/space-folder'
import type { SpaceMountRecord } from './space-mount.js'

/** A carrier selection is separate from every original Source namespace below. */
export const SOURCE_FILES_METHODS = ['file.stat', 'file.read', 'file.create', 'file.mkdir', 'file.move', 'file.delete',
  'file.mutation.inspect', 'file.history', 'file.delete.snapshots'] as const
export type SourceFilesMethod = typeof SOURCE_FILES_METHODS[number]
export type SourceFilesCall<M extends SourceFilesMethod> = { method: M; params: AgentMuxRpcParams<M> }
/** carrierCurrent is a client observation; it never changes the original effect receipt. */
export type SourceFilesResult<M extends SourceFilesMethod> = { result: AgentMuxRpcResult<M>; carrierCurrent: boolean }
export type SourceFilesLocator = { mount: SpaceMountRecord; resource: FileReadResource }
export type SourceFilesSelection = { kind: 'mount'; mount: SpaceMountRecord }
  | { kind: 'directory'; path: string; expectedResource?: FolderDirectoryResource; registration?: SpaceMountRecord }
export type SourceFilesResolution =
  | { status: 'located'; locator: SourceFilesLocator }
  | { status: 'registration-required'; registration: FolderDirectoryRegistration }
  | { status: 'selection-required'; registrations: FolderSpaceRegistrationInspection[]; issue?: FolderDirectoryInspection['issue'] }
  | { status: 'unconfirmed'; issue: { code: string; message: string } }
