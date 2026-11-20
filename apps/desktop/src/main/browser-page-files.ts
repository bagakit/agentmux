import type { BrowserUploadPort, BrowserDownloadPort } from '@agentmux/browser/operations'
import { uploadBrowserFiles, type BrowserUploads, type BrowserUploadContext } from './browser-uploads.js'
import { waitForBrowserDownload, readBrowserDownload, type BrowserDownloads, type BrowserDownloadContext } from './browser-downloads.js'

/** The exact Workspace owners remain in Desktop; the transport-neutral kernel receives only authorized actions. */
export function browserUploadPort(input: { store: BrowserUploads; context(): Omit<BrowserUploadContext, 'target'> }): BrowserUploadPort {
  return { upload: (target, paths) => uploadBrowserFiles(input.store, { ...input.context(), target }, paths) }
}
export function browserDownloadPort(input: { store: BrowserDownloads; context(): BrowserDownloadContext; signal: AbortSignal }): BrowserDownloadPort {
  return { download: (trigger, options) => waitForBrowserDownload(input.store, input.context(), trigger, { ...options, signal: input.signal }),
    read: (reference, options) => { const owner = input.context(); return readBrowserDownload(input.store, reference, { workspaceId: owner.workspaceId, browserId: owner.browserId }, options) } }
}
