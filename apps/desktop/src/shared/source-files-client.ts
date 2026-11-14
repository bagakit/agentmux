import type { AgentMuxRpcParams, AgentMuxRpcStreamEvent } from '@agentmux/core'
import type { FileMutationWatchOpening, FileMutationWatchParams } from '@agentmux/core/files'
import type { SourceFilesMethod, SourceFilesResolution, SourceFilesResult, SourceFilesSelection } from './source-files.js'
import type { SpaceMountSourceTarget } from './space-mount.js'
import type { SessionInputOperationResult } from './contracts.js'

export const SOURCE_FILES_EVENT = 'sourceFiles:event'
export type SourceFilesEvent = AgentMuxRpcStreamEvent<'file.mutation.watch'>
export type SourceFilesEventFrame = { token: string; sequence: number; event: SourceFilesEvent }
export type SourceFilesReader = { initial: FileMutationWatchOpening; start(): Promise<void>; dispose(): void }
type Cancellation = { onAbort?: (cancel: () => void) => () => void }
export type SourceFilesPreloadApi = {
  resolve(target: SpaceMountSourceTarget, selection: SourceFilesSelection, cancellation?: Cancellation): Promise<SessionInputOperationResult<SourceFilesResolution>>
  call<M extends SourceFilesMethod>(target: SpaceMountSourceTarget, method: M, params: AgentMuxRpcParams<M>, cancellation?: Cancellation): Promise<SessionInputOperationResult<SourceFilesResult<M>>>
  watch(target: SpaceMountSourceTarget, params: FileMutationWatchParams, listener: (event: SourceFilesEvent) => void | Promise<void>, cancellation?: Cancellation): Promise<SessionInputOperationResult<SourceFilesReader>>
}
export type SourceFilesApi = {
  resolve(target: SpaceMountSourceTarget, selection: SourceFilesSelection, signal?: AbortSignal): Promise<SourceFilesResolution>
  call<M extends SourceFilesMethod>(target: SpaceMountSourceTarget, method: M, params: AgentMuxRpcParams<M>, signal?: AbortSignal): Promise<SourceFilesResult<M>>
  watch(target: SpaceMountSourceTarget, params: FileMutationWatchParams, listener: (event: SourceFilesEvent) => void | Promise<void>, signal?: AbortSignal): Promise<SourceFilesReader>
}
