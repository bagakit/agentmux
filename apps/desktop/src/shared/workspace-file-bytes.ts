/** Main-owned byte transport. Text editor reads keep their existing document contract. */
export const WORKSPACE_FILE_MAX_BYTES = 16 * 1024 * 1024
export const WORKSPACE_FILE_MAX_READ_BYTES = 64 * 1024

export type WorkspaceFileByteReadOptions = {
  offset?: number
  maxBytes?: number
  expectedRevision?: string
}

export type WorkspaceFileByteRead = {
  bytes: Uint8Array
  totalBytes: number
  revision: string
  offset: number
  returnedBytes: number
  nextOffset: number | null
  /** Includes the complete bounded scan required to verify the revision. */
  readCost: { payloadBytes: number }
}
