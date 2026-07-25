export type RejectedFileExplorerDirectoryLoad = {
  workspaceId: string
  path: string
}

let rejectedLoadListener: ((receipt: RejectedFileExplorerDirectoryLoad) => void) | null = null

export function observeRejectedFileExplorerDirectoryLoads(
  listener: (receipt: RejectedFileExplorerDirectoryLoad) => void
): () => void {
  rejectedLoadListener = listener
  return () => {
    if (rejectedLoadListener === listener) rejectedLoadListener = null
  }
}

export function recordRejectedFileExplorerDirectoryLoad(
  workspaceId: string,
  path: string
): void {
  rejectedLoadListener?.({ workspaceId, path })
}
