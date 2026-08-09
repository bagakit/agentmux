import type { FileExplorerDirLoadReceipt } from './file-explorer-dir-load-tracker'

export type RejectedFileExplorerDirectoryLoad = {
  workspaceId: string
  path: string
  epoch: number
  operationId: number
  kind: 'rejected'
  observedAt: number
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
  receipt: FileExplorerDirLoadReceipt
): void {
  for (const listener of rejectedLoadListeners) listener(receipt)
}
