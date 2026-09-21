export type BrowserDownloadSource = {
  workspaceId: string | null
  browserId: string
  operationId: string
  navigationId: string
  url: string
}

export type BrowserDownloadReference = Omit<BrowserDownloadSource, 'workspaceId'> & {
  kind: 'browser-download-file'
  id: string
  workspaceId: string
  path: string
  revision: string
  byteLength: number
  filename: string
  mime: string
  capturedAt: number
}

export type BrowserDownloadReceipt = BrowserDownloadSource & {
  id: string
  status: 'waiting' | 'received' | 'in-progress' | 'completed' | 'cancelled' | 'failed'
  path: string
  filename: string | null
  mime: string | null
  receivedBytes: number
  totalBytes: number | null
  createdAt: number
  updatedAt: number
  warning?: string
  reference?: BrowserDownloadReference
}

export type BrowserDownloadReadOptions = { offset?: number; maxBytes?: number }
export type BrowserDownloadCurrentOwner = { workspaceId: string | null; browserId: string }
export type BrowserDownloadChunk = {
  reference: BrowserDownloadReference
  encoding: 'base64'
  data: string
  offset: number
  returnedBytes: number
  totalBytes: number
  revision: string
  nextOffset: number | null
  readCost: { payloadBytes: number }
}
