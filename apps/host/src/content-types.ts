import type { FileDocumentReadResult, FileNameListing, FileWriteContext, FileRestoreParams, FileUndoParams } from '@agentmux/core/files'
import type { NoteFileWitness } from '@agentmux/core/note-history'
import type { FileWorkspace } from './file-resource-model.js'
import type { OrdinaryFileWriteInput, OrdinaryFileWriteResult } from './ordinary-files.js'
import type { WorkspaceFileReadBudget } from './workspace-file-bytes.js'

/** Resource facts consumed by portable content owners; no screen or editor contract. */
export type WorkspaceRecord = FileWorkspace & { name?: string; branch?: string }
export type WorkspaceFileReadResult = FileDocumentReadResult
export type WorkspaceFileWriteInput = OrdinaryFileWriteInput
export type WorkspaceFileWriteResult = OrdinaryFileWriteResult
export type WorkspaceFileRestoreInput = Pick<FileRestoreParams, 'path' | 'noteId' | 'expectedRevision' | 'operationId' | 'eventId'>
export type WorkspaceFileUndoInput = Pick<FileUndoParams, 'path' | 'noteId' | 'expectedRevision' | 'operationId' | 'batchId' | 'batchLastEventId'>
export type WorkspaceDirectoryEntry = {
  name: string; path: string; isDirectory: boolean; isSymlink: boolean
  mtimeMs?: number; ignored?: boolean; linkTarget?: string; linkIssue?: 'unavailable'
}
export type WorkspaceFileDeleteExactInput = { path: string; expectedRevision: string; witness: NoteFileWitness; operationId: string }
export type WorkspaceFileDeleteExactResult = { status: 'deleted' } | { status: 'conflict' | 'unknown' | 'error'; code: string; message: string; retainedPath?: string }
export interface WorkspaceFiles<W extends FileWorkspace = WorkspaceRecord> {
  read(workspace: W, path: string, budget?: WorkspaceFileReadBudget): Promise<WorkspaceFileReadResult>
  readDirectory(workspace: W, path: string): Promise<WorkspaceDirectoryEntry[]>
  listFiles(workspace: W, path: string, limit?: number, options?: { signal?: AbortSignal }): Promise<FileNameListing>
  write(workspace: W, input: WorkspaceFileWriteInput, context?: FileWriteContext): Promise<WorkspaceFileWriteResult>
  writeBytes(workspace: W, input: { path: string; bytes: Uint8Array }): Promise<WorkspaceFileWriteResult>
  deleteExact(workspace: W, input: WorkspaceFileDeleteExactInput): Promise<WorkspaceFileDeleteExactResult>
}
