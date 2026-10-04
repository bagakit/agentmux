/** Explicit document compilation belongs to the original File and execution Host. */
export type FileBuildKind = 'latex' | 'typst'
export type FileBuildRequest = {
  id: string; kind: FileBuildKind; path: string; content: string
  resource: { hostId: string; path: string }
}
export type FileBuildSnapshot = {
  id: string; kind: FileBuildKind; workspaceId: string; path: string
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unavailable' | 'unknown'
  log: string; message: string | null; pdf?: Uint8Array
}
