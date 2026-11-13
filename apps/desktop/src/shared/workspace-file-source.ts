/** Private Renderer transport. Main keeps the original file identity and exact caller lifetime. */
export const WORKSPACE_FILE_SOURCE_CHUNK_BYTES = 1024 * 1024

export type WorkspaceFileSourceFailure = {
  status: 'deleted' | 'changed' | 'outside-workspace' | 'released' | 'cancelled' | 'unavailable' | 'directory'
  code: string
  message: string
}
export type WorkspaceFileSourceOpenResult = { status: 'ready'; id: string; size: number } | WorkspaceFileSourceFailure
export type WorkspaceFileSourceReadResult = { status: 'read'; bytes: Uint8Array } | WorkspaceFileSourceFailure
