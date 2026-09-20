/** Captured from the owning Browser entry, never inferred from cwd or the script. */
export type BrowserResultContext = {
  workspaceId: string | null
  browserId: string
  operationId: string
  navigationId: string
}

// A maximal 64 KiB byte slice expands to ~87 KiB base64 JSON; continuation must stay inline.
export const BROWSER_RESULT_INLINE_BYTES = 128 * 1024
export const BROWSER_RESULT_MAX_BYTES = 8 * 1024 * 1024
export const BROWSER_RESULT_MAX_READ_BYTES = 64 * 1024

/** Durable JSON bytes, bound to the operation that actually produced them. */
export type BrowserResultArtifactReference = Omit<BrowserResultContext, 'workspaceId'> & {
  kind: 'browser-result-artifact'
  id: string
  workspaceId: string
  format: 'json'
  byteLength: number
  capturedAt: number
  maxReadBytes: number
}

export type BrowserResultReadOptions = { offset?: number; maxBytes?: number }
export type BrowserResultCurrentOwner = Pick<BrowserResultContext, 'workspaceId' | 'browserId'>
export type BrowserResultArtifactChunk = {
  reference: BrowserResultArtifactReference
  /** Byte slices may split UTF8 characters. Decode after joining the base64-decoded chunks. */
  encoding: 'base64'
  data: string
  offset: number
  returnedBytes: number
  totalBytes: number
  nextOffset: number | null
  /** Actual bytes read for this request, including integrity verification. */
  readCost: { metadataBytes: number; payloadBytes: number }
}
