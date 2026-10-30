import { appDocumentSourceAllows, type AppDocumentSources } from './workbench-document-sources.js'

type AppFrame = { url: string; detached: boolean; isDestroyed(): boolean }
type AppContents = { mainFrame: AppFrame; isDestroyed(): boolean }

/** Native identity and an original loader source are both necessary. Current URL is
 * observed only after the exact root frame matched; it never supplies its own authority. */
export function isAppDocumentSender(event: { sender: unknown; senderFrame: unknown }, contents: AppContents,
  sources: AppDocumentSources): boolean {
  try {
    if (event.sender !== contents || contents.isDestroyed()) return false
    const frame = contents.mainFrame
    return Boolean(frame && event.senderFrame === frame && !frame.detached && !frame.isDestroyed() &&
      appDocumentSourceAllows(sources, frame.url))
  } catch { return false }
}

export function assertAppDocumentSender(event: { sender: unknown; senderFrame: unknown }, contents: AppContents,
  sources: AppDocumentSources): void {
  if (!isAppDocumentSender(event, contents, sources)) throw new Error('Untrusted application main document sender')
}
