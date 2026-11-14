import type { WorkspaceFileByteRead } from '@agentmux/host/workspace-file-bytes'
import type { WorkspaceFilePreviewKind } from '@agentmux/editor-extensions/catalog'

export type WorkspaceFilePreviewReadOptions = { expectedRevision?: string; expectedResource?: { hostId: string; workspacePath: string } }

/** Kinds read as one bounded bytes snapshot. Audio and video stream through their playback lease. */
export type WorkspaceFileSnapshotKind = Exclude<WorkspaceFilePreviewKind, 'audio' | 'video' | 'book'>

export type WorkspaceFilePreviewResult =
  | { status: 'ready'; kind: WorkspaceFileSnapshotKind; mimeType: string; bytes: Uint8Array;
      revision: string; byteLength: number; readCost: WorkspaceFileByteRead['readCost'] }
  | { status: 'directory' }
  | { status: 'deleted'; message: string }
  | { status: 'too-large'; maxBytes: number; message: string }
  | { status: 'changed'; message: string }
  | { status: 'unsupported'; message: string }
  | { status: 'unavailable'; code: string; message: string }

/** Internal, operation-owned resources for a visible read-only file preview. */
export type WorkspacePreviewResourceRequest = { id: string; workspaceId: string; path: string; kind: 'data' | 'image' }
export type WorkspacePreviewResourceResult =
  | { kind: 'data'; content: string }
  | { kind: 'image'; bytes: Uint8Array; mimeType: string }
