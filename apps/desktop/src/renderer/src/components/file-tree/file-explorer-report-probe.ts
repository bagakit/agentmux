export type RejectedFileExplorerDirectoryLoad = {
  workspaceId: string
  path: string
}

const rejectedLoadListeners = new Set<(receipt: RejectedFileExplorerDirectoryLoad) => void>()

export function observeRejectedFileExplorerDirectoryLoads(
  listener: (receipt: RejectedFileExplorerDirectoryLoad) => void
): () => void {
  rejectedLoadListeners.add(listener)
  return () => {
    rejectedLoadListeners.delete(listener)
  }
}

export function recordRejectedFileExplorerDirectoryLoad(
  workspaceId: string,
  path: string
): void {
  const receipt = { workspaceId, path }
  for (const listener of rejectedLoadListeners) listener(receipt)
}
