import type { BrowserCdpSender } from './browser-page-snapshot.js'
import type { BrowserDownloadReadOptions, BrowserDownloadReference, BrowserDownloadReceipt, BrowserDownloadChunk } from './model/browser-download.js'

/** Workspace file owners supply these ports only with an actual authorized Workspace binding. */
export type BrowserUploadPort = { upload(target: { objectId: string; sendCommand: BrowserCdpSender }, paths: unknown): Promise<unknown> }
export type BrowserDownloadPort = {
  download(trigger: () => Promise<unknown>, options: { path: string; timeoutMs?: number; maxBytes?: number }): Promise<BrowserDownloadReceipt>
  read(reference: BrowserDownloadReference, options?: BrowserDownloadReadOptions): Promise<BrowserDownloadChunk>
}
export class BrowserUploadUnconfirmedError extends Error {
  constructor(cause: unknown) {
    super('Files may already be selected, but the upload action could not be confirmed. Check the original page before retrying; selected-file snapshots remain available until navigation or close.', { cause })
    this.name = 'BrowserUploadUnconfirmedError'
  }
}
